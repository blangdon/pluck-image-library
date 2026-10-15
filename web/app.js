/* Pluck Image Library: browse, filter and correct AI tags on Drive images. */
(() => {
  "use strict";

  const cfg = window.PLUCK_CONFIG || null;
  const demo = !cfg || new URLSearchParams(location.search).has("demo");
  const $ = (id) => document.getElementById(id);

  const TYPE_FILTERS = [
    { id: "photo", label: "Real photos", test: (i) => i.is_render === false },
    { id: "render", label: "Renders & mockups", test: (i) => i.is_render === true },
    { id: "new-pack", label: "New packaging", test: (i) => i.packaging === "new" || i.packaging === "mixed" },
    { id: "old-pack", label: "Old packaging", test: (i) => i.packaging === "old" || i.packaging === "mixed" },
  ];
  const PAGE = 120;

  const state = {
    images: [],          // all rows, newest first
    urls: new Map(),     // thumb_path -> signed url
    previousVisit: null, // Date or null
    tags: new Set(),
    flavours: new Set(),
    types: new Set(),
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
    for (const t of [...(img.tags || []), ...(img.manual_tags || [])]) {
      if (!hidden.has(t) && !out.includes(t)) out.push(t);
    }
    return out;
  };
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
    const cols =
      "id,name,folder_path,mime_type,drive_url,drive_created_at,first_seen_at,description,tags,manual_tags,hidden_tags,flavours,packaging,is_render,thumb_path";
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("images").select(cols)
        .eq("removed", false).not("thumb_path", "is", null)
        .order("first_seen_at", { ascending: false }).order("id")
        .range(from, from + 999);
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

  function matches(img, skip) {
    if (mediaOf(img) !== state.media) return false;
    if (state.newOnly && !isNew(img)) return false;
    if (skip !== "tags") {
      const t = effectiveTags(img);
      for (const want of state.tags) if (!t.includes(want)) return false;
    }
    if (skip !== "flavours" && state.flavours.size) {
      if (!(img.flavours || []).some((f) => state.flavours.has(f))) return false;
    }
    if (skip !== "types") {
      for (const id of state.types) if (!TYPE_FILTERS.find((f) => f.id === id).test(img)) return false;
    }
    const terms = [...state.searches.filter((q) => q.on).map((q) => q.text), state.draft].filter(Boolean);
    if (terms.length) {
      const hay = [img.name, img.description, img.folder_path, ...effectiveTags(img), ...(img.flavours || [])]
        .join(" ").toLowerCase();
      for (const term of terms) for (const word of term.split(/\s+/)) if (word && !hay.includes(word)) return false;
    }
    return true;
  }

  function renderChecks(containerId, items, selected, onToggle) {
    $(containerId).replaceChildren(
      ...items.map(({ key, label, count }) => {
        const on = selected.has(key);
        const box = el("input", { type: "checkbox", checked: on, disabled: !on && count === 0 });
        box.onchange = () => { onToggle(key); refresh(); };
        return el("label", { className: "check" + (!on && count === 0 ? " zero" : "") },
          box, el("span", { className: "label", textContent: label }), el("span", { className: "n", textContent: count }));
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

    // Tag chips: counts within the current result (tags combine with AND).
    const tagCounts = new Map();
    for (const i of state.images) for (const t of effectiveTags(i)) tagCounts.set(t, 0);
    for (const i of state.shown) for (const t of effectiveTags(i)) tagCounts.set(t, tagCounts.get(t) + 1);
    const tagItems = [...tagCounts.keys()]
      .sort((a, b) => (tagCounts.get(b) - tagCounts.get(a)) || a.localeCompare(b))
      .map((t) => ({ key: t, label: t, count: tagCounts.get(t) }));
    renderChecks("tag-chips", tagItems, state.tags, (k) => toggle(state.tags, k));

    // Flavour chips combine with OR, so count against everything but the flavour filter.
    const base = state.images.filter((i) => matches(i, "flavours"));
    const flav = new Map();
    for (const i of state.images) for (const f of i.flavours || []) flav.set(f, 0);
    for (const i of base) for (const f of i.flavours || []) flav.set(f, flav.get(f) + 1);
    const flavItems = [...flav.keys()].sort().map((f) => ({ key: f, label: f, count: flav.get(f) }));
    renderChecks("flavour-chips", flavItems, state.flavours, (k) => toggle(state.flavours, k));

    const typeItems = TYPE_FILTERS.map((f) => ({ key: f.id, label: f.label, count: state.shown.filter(f.test).length }));
    renderChecks("type-chips", typeItems, state.types, (k) => toggle(state.types, k));

    renderSearches();
    const nImages = state.images.filter((i) => mediaOf(i) === "image").length;
    $("media-image-n").textContent = nImages.toLocaleString();
    $("media-video-n").textContent = (state.images.length - nImages).toLocaleString();
    $("media-image").setAttribute("aria-pressed", state.media === "image");
    $("media-video").setAttribute("aria-pressed", state.media === "video");
    const total = state.media === "image" ? nImages : state.images.length - nImages;
    const active = state.tags.size + state.flavours.size + state.types.size +
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
    $("v-type").textContent =
      (img.is_render ? "Render / mockup" : "Real photo") +
      (img.packaging ? ` · ${img.packaging === "mixed" ? "old and new" : img.packaging} packaging` : "");
    $("v-flavours").textContent = (img.flavours || []).join(", ") || "None visible";
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
        return el("span", { className: "chip" + (manual.has(t) ? " manual" : "") }, t, x);
      })
    );

    const known = new Set();
    for (const i of state.images) for (const t of effectiveTags(i)) known.add(t);
    $("tag-options").replaceChildren(...[...known].sort().map((t) => el("option", { value: t })));
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
    const hidden = (img.tags || []).includes(tag)
      ? [...new Set([...(img.hidden_tags || []), tag])]
      : img.hidden_tags || [];
    saveTags(img, manual, hidden);
  }

  function addTag(img, raw) {
    const tag = raw.trim().toLowerCase();
    if (!tag || effectiveTags(img).includes(tag)) return;
    const hidden = (img.hidden_tags || []).filter((t) => t !== tag);
    const manual = (img.tags || []).includes(tag) ? img.manual_tags || [] : [...(img.manual_tags || []), tag];
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
      state.tags.clear(); state.flavours.clear(); state.types.clear(); state.searches = []; state.draft = "";
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
    $("viewer").addEventListener("close", () => { if (state.tags.size || state.types.size) refresh(); });
    $("v-add-form").onsubmit = (e) => {
      e.preventDefault();
      addTag(viewerList[state.viewerIndex], $("v-add").value);
      $("v-add").value = "";
    };
  }

  boot();
})();
