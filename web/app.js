/* Pluck Image Library: browse, filter and correct AI tags on Drive images. */
(() => {
  "use strict";

  const cfg = window.PLUCK_CONFIG || null;
  const demo = !cfg || new URLSearchParams(location.search).has("demo");
  const $ = (id) => document.getElementById(id);

  // How tags and fields are grouped in the sidebar. "any" groups match images with any ticked option;
  // "all" groups match images with every ticked option.
  const PRODUCT_TAGS = ["pluck shaker", "sachet"];
  // Image style, in the order shown (set once from library counts, most common first).
  const STYLE_TAGS = ["lifestyle", "text/graphic", "flat lay", "video still", "product shot"];
  const LABELS = {
    "pluck shaker": "Shaker", sachet: "Sachet / pouch", "text/graphic": "Graphic / text",
    "boxes & retail": "Boxes & retail", "product shot": "Studio product shot",
  };
  const TAG_RENAMES = { packaging: "boxes & retail" };              // older tag names
  const FLAVOUR_ALIASES = { pure: "Pure Organs", "pure organ": "Pure Organs" };
  const DESIGN_NAMES = { new: "current", old: "previous" };         // older label-design values
  const DESIGN_TEXT = {
    current: "current label", previous: "previous label", mixed: "current and previous labels",
    unknown: "label design can't be seen",
  };
  const PAGE = 120;

  const state = {
    images: [],          // all rows, newest added to Drive first
    urls: new Map(),     // thumb_path -> signed url
    previousVisit: null, // Date or null
    include: {},         // facet id -> Set of ticked option keys
    exclude: {},         // facet id -> Set of excluded option keys
    newOnly: false,
    media: "image",      // "image" or "video"
    draft: "",           // what's being typed in the search box right now
    searches: [],        // pinned searches: { text, on }
    shown: [],
    rendered: 0,
    viewerIndex: -1,
  };

  let sb = null;

  // ---------------------------------------------------------------- helpers
  const effectiveTags = (img) => {
    const hidden = new Set(img.hidden_tags || []);
    const out = [];
    for (const raw of [...(img.people || []), ...(img.tags || []), ...(img.manual_tags || [])]) {
      const t = TAG_RENAMES[raw] || raw;
      if (!hidden.has(raw) && !hidden.has(t) && !out.includes(t)) out.push(t);
    }
    return out;
  };
  const flavoursOf = (img) => [...new Set((img.flavours || []).map((f) => FLAVOUR_ALIASES[f.toLowerCase()] || f))];
  const designOf = (img) => DESIGN_NAMES[img.packaging] || img.packaging || "none";
  const label = (t) => LABELS[t] || t.charAt(0).toUpperCase() + t.slice(1);
  const isNew = (img) => state.previousVisit && new Date(img.first_seen_at) > state.previousVisit;
  const fmtDate = (s) =>
    s ? new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Unknown";
  const fmtWhen = (d) =>
    d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const showStatus = (msg) => { $("status").textContent = msg; $("status").hidden = !msg; };

  // ---------------------------------------------------------------- auth
  async function boot() {
    if (demo) return startDemo();
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    $("sign-in").onclick = () =>
      sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
    $("sign-out").onclick = $("sign-out-2").onclick = async () => { await sb.auth.signOut(); location.reload(); };

    const { data: { session } } = await sb.auth.getSession();
    if (!session) { $("gate-signin").hidden = false; return; }

    const email = session.user.email;
    $("account-email").textContent = email;
    $("account").hidden = false;

    const { data: allowed, error } = await sb.rpc("is_allowed");
    if (error) return showStatus(`Couldn't check your access: ${error.message}`);
    if (!allowed) { $("denied-email").textContent = email; $("gate-denied").hidden = false; return; }

    const { data: prev } = await sb.rpc("start_visit");
    state.previousVisit = prev ? new Date(prev) : null;

    showStatus("Loading images…");
    try {
      state.images = await loadImages();
      await signThumbs(state.images.map((i) => i.thumb_path));
    } catch (e) {
      return showStatus(`Couldn't load images: ${e.message}`);
    }
    showStatus("");
    start();
  }

  async function loadImages() {
    let cols =
      "id,name,folder_path,mime_type,drive_url,drive_created_at,first_seen_at,description,tags,manual_tags,hidden_tags,flavours,packaging,is_render,thumb_path,people";
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("images").select(cols)
        .eq("removed", false).not("thumb_path", "is", null)
        .order("drive_created_at", { ascending: false, nullsFirst: false }).order("id")
        .range(from, from + 999);
      if (error && cols.endsWith(",people") && /people/.test(error.message || "")) {
        cols = cols.replace(",people", "");  // face search columns not added yet
        from -= 1000;
        continue;
      }
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }

  async function signThumbs(paths) {
    const todo = paths.filter((p) => p && !state.urls.has(p));
    for (let i = 0; i < todo.length; i += 500) {
      const { data, error } = await sb.storage.from("thumbs").createSignedUrls(todo.slice(i, i + 500), 60 * 60 * 6);
      if (error) throw error;
      for (const r of data) if (r.signedUrl) state.urls.set(r.path, r.signedUrl);
    }
  }

  // ---------------------------------------------------------------- demo
  async function startDemo() {
    $("account-email").textContent = "Demo data";
    $("account").hidden = false;
    $("sign-out").hidden = true;
    if (!window.PLUCK_DEMO) {
      await new Promise((resolve) => {
        const s = el("script", { src: "demo-data.js", onload: resolve, onerror: resolve });
        document.body.append(s);
      });
    }
    const data = window.PLUCK_DEMO || [];
    if (!data.length) return showStatus("This copy isn't connected to the library yet. See README: Step 5.");
    state.images = data;
    for (const i of data) state.urls.set(i.thumb_path, i.thumb_path);
    state.previousVisit = new Date(Date.now() - 1000 * 60 * 60 * 20);
    start();
  }

  // ---------------------------------------------------------------- filtering
  const mediaOf = (img) => ((img.mime_type || "").startsWith("video/") ? "video" : "image");

  // Builds the sidebar groups from what's in the library. Each option has test(img) for ticking and,
  // where different, exTest(img) for excluding.
  function buildFacets() {
    const has = (t) => (img) => effectiveTags(img).includes(t);
    const allTags = new Set();
    const allFlavours = new Set();
    const allPeople = new Set();
    for (const i of state.images) {
      for (const p of i.people || []) allPeople.add(p);
      for (const t of effectiveTags(i)) allTags.add(t);
      for (const f of flavoursOf(i)) allFlavours.add(f);
    }
    const HIDDEN = ["boxes & retail", "behind the scenes"];  // still tagged, just not offered as filters
    const shotTags = [...allTags].filter((t) =>
      !PRODUCT_TAGS.includes(t) && !STYLE_TAGS.includes(t) && !allPeople.has(t) && !HIDDEN.includes(t));
    const definite = (d) => (img) => [d, "mixed"].includes(designOf(img));
    const facets = [
      {
        id: "product", title: "Pluck product", mode: "any",
        options: [
          ...PRODUCT_TAGS.map((t) => ({ key: t, label: label(t), test: has(t) })),
          { key: "none", label: "No Pluck product", test: (i) => !PRODUCT_TAGS.some((t) => effectiveTags(i).includes(t)) },
        ],
      },
      {
        id: "people", title: "People", mode: "any",
        options: [...allPeople].sort().map((p) => ({ key: p, label: p, test: has(p) })),
      },
      {
        id: "design", title: "Packaging (front only)", mode: "any",
        note: "Judged from the front of the pack only. Items showing the back or side can’t be told apart, so they appear under both.",
        options: ["current", "previous"].map((d) => ({
          key: d,
          label: d === "current" ? "Current packaging" : "Old packaging",
          test: (i) => [d, "mixed", "unknown"].includes(designOf(i)),
          exTest: definite(d),
        })),
      },
      {
        id: "flavour", title: "Flavour", mode: "any",
        options: [...allFlavours].sort().map((f) => ({ key: f, label: f, test: (i) => flavoursOf(i).includes(f) })),
      },
      {
        id: "shot", title: "In the shot", mode: "all", sortByCount: true,
        options: shotTags.map((t) => ({ key: t, label: label(t), test: has(t) })),
      },
      {
        id: "style", title: "Image style", mode: "all",
        options: [
          ...STYLE_TAGS.slice(0, 3).filter((t) => allTags.has(t)).map((t) => ({ key: t, label: label(t), test: has(t) })),
          { key: "render", label: "Render / mockup", test: (i) => i.is_render === true },
          ...STYLE_TAGS.slice(3).filter((t) => allTags.has(t)).map((t) => ({ key: t, label: label(t), test: has(t) })),
        ],
      },
    ];
    for (const f of facets) {
      f.byKey = new Map(f.options.map((o) => [o.key, o]));
      state.include[f.id] ||= new Set();
      state.exclude[f.id] ||= new Set();
    }
    state.facets = facets;
  }

  function matches(img, skip) {
    if (mediaOf(img) !== state.media) return false;
    if (state.newOnly && !isNew(img)) return false;
    for (const f of state.facets) {
      const inc = state.include[f.id];
      if (f.id !== skip && inc.size) {
        const hits = [...inc].map((k) => f.byKey.get(k)).filter(Boolean).map((o) => o.test(img));
        if (hits.length && (f.mode === "any" ? !hits.some(Boolean) : !hits.every(Boolean))) return false;
      }
      for (const k of state.exclude[f.id]) {
        const o = f.byKey.get(k);
        if (o && (o.exTest || o.test)(img)) return false;
      }
    }
    const terms = [...state.searches.filter((q) => q.on).map((q) => q.text), state.draft].filter(Boolean);
    if (terms.length) {
      const hay = [img.name, img.description, img.folder_path, ...effectiveTags(img).map(label), ...flavoursOf(img)]
        .join(" ").toLowerCase();
      for (const term of terms) for (const word of term.split(/\s+/)) if (word && !hay.includes(word)) return false;
    }
    return true;
  }

  // A row is off, included (ticked) or excluded (dash, red, crossed out).
  function renderChecks(container, items, selected, excluded) {
    container.replaceChildren(
      ...items.map(({ key, label, count }) => {
        const on = selected.has(key);
        const out = excluded.has(key);
        const zero = !on && !out && count === 0;
        const box = el("input", { type: "checkbox", checked: on || out, disabled: zero });
        box.indeterminate = out;
        box.setAttribute("aria-label", out ? `${label}: excluded. Click to stop excluding` : label);
        box.onchange = () => {
          if (out) excluded.delete(key);
          else toggle(selected, key);
          refresh();
        };
        const no = el("button", { type: "button", className: "exclude", textContent: "Exclude", disabled: zero });
        no.setAttribute("aria-label", `Exclude ${label}`);
        no.onclick = () => { selected.delete(key); excluded.add(key); refresh(); };
        return el("div", { className: "check" + (zero ? " zero" : "") + (out ? " excluded" : "") + (on ? " included" : "") },
          el("label", {}, box, el("span", { className: "label", textContent: label })),
          out ? null : no,
          el("span", { className: "n", textContent: out ? "excluded" : count }));
      })
    );
  }

  function renderSearches() {
    const box = $("search-list");
    box.hidden = !state.searches.length;
    $("search-list-items").replaceChildren(
      ...state.searches.map((q, i) => {
        const tick = el("input", { type: "checkbox", checked: q.on });
        tick.setAttribute("aria-label", `Use search "${q.text}"`);
        tick.onchange = () => { q.on = tick.checked; refresh(); };
        const x = el("button", { type: "button", className: "remove", textContent: "×" });
        x.setAttribute("aria-label", `Remove search "${q.text}"`);
        x.onclick = () => { state.searches.splice(i, 1); refresh(); };
        return el("div", { className: "check search-item" + (q.on ? "" : " off") },
          el("label", {}, tick, el("span", { className: "label", textContent: `“${q.text}”` })), x);
      })
    );
  }

  function toggle(set, key) { set.has(key) ? set.delete(key) : set.add(key); }

  function refresh() {
    state.shown = state.images.filter((i) => matches(i));

    // Sidebar groups. "any" groups count against everything except their own ticks; "all" groups
    // count within the current result.
    const sections = [];
    for (const f of state.facets) {
      const inc = state.include[f.id], exc = state.exclude[f.id];
      const base = f.mode === "any" ? state.images.filter((i) => matches(i, f.id)) : state.shown;
      let items = f.options.map((o) => ({ key: o.key, label: o.label, count: base.filter(o.test).length }));
      if (f.sortByCount) {
        const pinned = (k) => (inc.has(k) || exc.has(k) ? 1 : 0);
        items.sort((a, b) => pinned(b.key) - pinned(a.key) || b.count - a.count || a.label.localeCompare(b.label));
      }
      if (!items.length) continue;
      const list = el("div", { className: "checks" });
      renderChecks(list, items, inc, exc);
      sections.push(el("section", { className: "facet" },
        el("h2", { className: "facet-title" }, f.title,
          el("span", { className: "facet-mode", textContent: f.mode === "any" ? "any of" : "all of" })),
        f.note ? el("p", { className: "hint facet-note", textContent: f.note }) : null,
        list));
    }
    $("facets").replaceChildren(...sections);

    renderSearches();
    const nImages = state.images.filter((i) => mediaOf(i) === "image").length;
    $("media-image-n").textContent = nImages.toLocaleString();
    $("media-video-n").textContent = (state.images.length - nImages).toLocaleString();
    $("media-image").setAttribute("aria-pressed", state.media === "image");
    $("media-video").setAttribute("aria-pressed", state.media === "video");
    const total = state.media === "image" ? nImages : state.images.length - nImages;
    const picked = (o) => Object.values(o).reduce((n, set) => n + set.size, 0);
    const active = picked(state.include) + picked(state.exclude) +
      state.searches.filter((q) => q.on).length + (state.newOnly ? 1 : 0) + (state.draft ? 1 : 0);
    $("clear-filters").hidden = !active;
    $("filters-count").textContent = active ? ` (${active})` : "";
    $("result-count").textContent =
      `${state.shown.length.toLocaleString()} of ${total.toLocaleString()} ${state.media === "image" ? "images" : "videos"}`;
    $("empty").hidden = state.shown.length > 0;
    $("empty").textContent = state.media === "video" && total === 0
      ? "No videos yet. The library only reads images from Drive for now; videos will appear here once video support is added."
      : `No ${state.media === "image" ? "images" : "videos"} match these filters.`;

    $("grid").replaceChildren();
    state.rendered = 0;
    renderMore();
  }

  function card(img, index) {
    const b = el("button", { type: "button", className: "card" });
    b.setAttribute("aria-label", img.description || img.name);
    const frame = el("div", { className: "frame" + (img.is_render ? " render" : "") },
      el("img", { src: state.urls.get(img.thumb_path) || "", alt: "", loading: "lazy", decoding: "async" }));
    b.append(frame);
    if (isNew(img)) b.append(el("span", { className: "badge-new", textContent: "NEW" }));
    b.append(el("span", { className: "name", textContent: img.name }));
    b.onclick = () => openViewer(index);
    return b;
  }

  function renderMore() {
    const end = Math.min(state.rendered + PAGE, state.shown.length);
    const frag = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i++) frag.append(card(state.shown[i], i));
    $("grid").append(frag);
    state.rendered = end;
  }

  // ---------------------------------------------------------------- new strip
  function renderNewStrip() {
    const fresh = state.images.filter(isNew);
    const strip = $("new-strip");
    if (!state.previousVisit) {
      strip.hidden = false;
      $("new-title").textContent = "Welcome. From your next visit, new images will show up here.";
      $("new-toggle").hidden = true;
      $("new-row").hidden = true;
      return;
    }
    if (!fresh.length) { strip.hidden = true; return; }
    strip.hidden = false;
    $("new-title").textContent =
      `${fresh.length} new since your last visit (${fmtWhen(state.previousVisit)})`;
    document.title = `(${fresh.length}) Pluck Library`;
    $("new-row").replaceChildren(
      ...fresh.slice(0, 30).map((img) => {
        const b = el("button", { type: "button" },
          el("img", { src: state.urls.get(img.thumb_path) || "", alt: img.description || img.name, loading: "lazy" }));
        b.onclick = () => openViewer(fresh.indexOf(img), fresh);
        return b;
      })
    );
    $("new-toggle").onclick = () => {
      state.newOnly = !state.newOnly;
      $("new-toggle").setAttribute("aria-pressed", state.newOnly);
      $("new-toggle").textContent = state.newOnly ? "Showing only new" : "Show only new";
      refresh();
    };
  }

  // ---------------------------------------------------------------- viewer
  let viewerList = [];

  function openViewer(index, list) {
    viewerList = list || state.shown;
    state.viewerIndex = index;
    fillViewer();
    if (!$("viewer").open) $("viewer").showModal();
  }

  function fillViewer() {
    const img = viewerList[state.viewerIndex];
    if (!img) return;
    $("v-img").src = state.urls.get(img.thumb_path) || "";
    $("v-img").alt = img.description || img.name;
    $("v-name").textContent = img.name;
    $("v-desc").textContent = img.description || "";
    $("v-folder").textContent = img.folder_path || "";
    $("v-added").textContent = fmtDate(img.drive_created_at);
    const d = designOf(img);
    $("v-type").textContent = (img.is_render ? "Render / mockup" : "Real photo") + (DESIGN_TEXT[d] ? ` · ${DESIGN_TEXT[d]}` : "");
    $("v-flavours").textContent = flavoursOf(img).join(", ") || "None visible";
    $("v-drive").href = img.drive_url || "#";
    $("v-prev").hidden = state.viewerIndex <= 0;
    $("v-next").hidden = state.viewerIndex >= viewerList.length - 1;
    $("v-saved").textContent = "";

    const manual = new Set(img.manual_tags || []);
    $("v-tags").replaceChildren(
      ...effectiveTags(img).map((t) => {
        const x = el("button", { type: "button", className: "x", textContent: "×" });
        x.setAttribute("aria-label", `Remove tag ${t}`);
        x.onclick = () => removeTag(img, t);
        return el("span", { className: "chip" + (manual.has(t) ? " manual" : "") }, label(t), x);
      })
    );

    const known = new Set();
    for (const i of state.images) for (const t of effectiveTags(i)) known.add(t);
    $("tag-options").replaceChildren(...[...known].sort().map((t) => el("option", { value: t, label: label(t) })));
  }

  async function saveTags(img, manual, hidden) {
    const before = { manual_tags: img.manual_tags, hidden_tags: img.hidden_tags };
    img.manual_tags = manual;
    img.hidden_tags = hidden;
    fillViewer();
    if (demo) { $("v-saved").textContent = "Saved (demo only)"; return; }
    const { error } = await sb.from("images").update({ manual_tags: manual, hidden_tags: hidden }).eq("id", img.id);
    if (error) {
      Object.assign(img, before);
      fillViewer();
      $("v-saved").textContent = `Couldn't save: ${error.message}`;
    } else {
      $("v-saved").textContent = "Saved for everyone";
    }
  }

  function removeTag(img, tag) {
    const manual = (img.manual_tags || []).filter((t) => t !== tag);
    const hidden = [...(img.tags || []), ...(img.people || [])].includes(tag)
      ? [...new Set([...(img.hidden_tags || []), tag])]
      : img.hidden_tags || [];
    saveTags(img, manual, hidden);
  }

  function addTag(img, raw) {
    const tag = raw.trim().toLowerCase();
    if (!tag || effectiveTags(img).includes(tag)) return;
    const hidden = (img.hidden_tags || []).filter((t) => t !== tag);
    const manual = [...(img.tags || []), ...(img.people || [])].includes(tag)
      ? img.manual_tags || [] : [...(img.manual_tags || []), tag];
    saveTags(img, manual, hidden);
  }

  function step(delta) {
    const next = state.viewerIndex + delta;
    if (next < 0 || next >= viewerList.length) return;
    state.viewerIndex = next;
    fillViewer();
  }

  // ---------------------------------------------------------------- wiring
  function start() {
    $("app").hidden = false;
    buildFacets();
    renderNewStrip();
    refresh();

    let t;
    $("search").oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => { state.draft = e.target.value.trim().toLowerCase(); refresh(); }, 150);
    };
    for (const m of ["image", "video"]) {
      $(`media-${m}`).onclick = () => { if (state.media !== m) { state.media = m; refresh(); } };
    }
    $("search-form").onsubmit = (e) => {
      e.preventDefault();
      const text = $("search").value.trim().toLowerCase();
      if (text && !state.searches.some((q) => q.text === text)) state.searches.push({ text, on: true });
      $("search").value = "";
      state.draft = "";
      refresh();
    };
    $("filters-toggle").onclick = () => {
      const open = document.body.classList.toggle("filters-open");
      $("filters-toggle").setAttribute("aria-expanded", open);
    };
    document.addEventListener("click", (e) => {
      if (document.body.classList.contains("filters-open") &&
          !$("sidebar").contains(e.target) && !$("filters-toggle").contains(e.target)) $("filters-done").click();
    });
    $("filters-done").onclick = () => {
      document.body.classList.remove("filters-open");
      $("filters-toggle").setAttribute("aria-expanded", "false");
    };
    $("clear-filters").onclick = () => {
      state.searches = []; state.draft = "";
      for (const set of [...Object.values(state.include), ...Object.values(state.exclude)]) set.clear();
      state.newOnly = false;
      $("search").value = "";
      $("new-toggle").setAttribute("aria-pressed", "false");
      $("new-toggle").textContent = "Show only new";
      refresh();
    };

    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.rendered < state.shown.length) renderMore();
    }, { rootMargin: "800px" }).observe($("sentinel"));

    $("v-close").onclick = () => $("viewer").close();
    $("v-prev").onclick = () => step(-1);
    $("v-next").onclick = () => step(1);
    $("viewer").addEventListener("click", (e) => { if (e.target === $("viewer")) $("viewer").close(); });
    $("viewer").addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    });
    $("viewer").addEventListener("close", () => { buildFacets(); refresh(); });
    $("v-add-form").onsubmit = (e) => {
      e.preventDefault();
      addTag(viewerList[state.viewerIndex], $("v-add").value);
      $("v-add").value = "";
    };
  }

  boot();
})();
