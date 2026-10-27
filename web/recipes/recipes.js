/* Pluck Recipe Explorer: the "Recipes/Use Cases" Drive folder as recipes, creators and collections,
   each with its photos and videos. Recipe details come from tagger/recipes.py (table recipe_sets);
   photos and videos come from the main library's images table, matched by folder path. */
(() => {
  "use strict";

  const cfg = window.PLUCK_CONFIG || null;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  const FLAVOUR_ALIASES = { pure: "Pure Organs", "pure organ": "Pure Organs", "pluck original": "Original", "habernero lime": "Habanero Lime" };
  const FACETS = [
    { id: "has", title: "Has" },
  ];
  const HAS = { photos: "Photos", videos: "Videos", doc: "Recipe doc" };
  const TABS = { recipes: "recipes", creators: "creators", collections: "collections", media: "photos and videos" };

  const state = {
    sets: [], byId: new Map(), root: null,
    media: [], urls: new Map(),
    tab: "recipes", coll: null, q: "", include: {},
  };
  let sb = null;
  const PREF_KEY = "pluck-recipes-prefs";
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } })();
  prefs.rView = prefs.rView || "tiles"; prefs.rSort = prefs.rSort || "name"; prefs.cSort = prefs.cSort || "name";
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} };
  const SORTS = {
    recipes: { name: "Name A–Z", newest: "Date created (newest)", oldest: "Date created (oldest)", collection: "Collection", photos: "Most photos", videos: "Most videos" },
    collections: { name: "Name A–Z", recipes: "Most recipes", photos: "Most photos", videos: "Most videos", newest: "Newest" },
  };

  // ---------------------------------------------------------------- helpers
  const cap = (s) => s.replace(/(^|[\s/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const norm = (s) => String(s || "").trim().toLowerCase();
  const flavourName = (f) => FLAVOUR_ALIASES[norm(f)] || cap(norm(f));
  const isVideo = (m) => (m.mime_type || "").startsWith("video/");
  const showStatus = (msg) => { $("status").textContent = msg; $("status").hidden = !msg; };
  const driveFolder = (id) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
  const thumb = (m) => state.urls.get(m.thumb_path) || "";

  // Values of one facet for a recipe (display form, de-duplicated).
  function valuesOf(r, facet) {
    if (facet === "creator") return r._creator ? [r._creator] : [];
    if (facet === "has") return [r._photos.length && "photos", r._videos.length && "videos", r.doc_url && "doc"].filter(Boolean);
    if (facet === "flavours") return [...new Set((r.flavours || []).map(flavourName))];
    return [...new Set((r[facet] || []).map((v) => cap(norm(v))).filter((v) => v && v !== "None"))];
  }
  const label = (facet, v) => (facet === "has" ? HAS[v] : v);

  // ---------------------------------------------------------------- data
  async function loadAll() {
    const sets = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("recipe_sets").select("*").order("folder_path").range(from, from + 999);
      if (error) throw error;
      sets.push(...data);
      if (data.length < 1000) break;
    }
    if (!sets.length) return false;
    const root = sets.find((s) => s.depth === 0);
    state.root = root ? root.folder_path : sets[0].folder_path.split("/").slice(0, -1).join("/");

    const cols = "id,name,folder_path,mime_type,drive_url,drive_created_at,first_seen_at,description,tags,manual_tags,hidden_tags,thumb_path";
    const media = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("images").select(cols)
        .eq("removed", false).not("thumb_path", "is", null)
        .like("folder_path", `${state.root.replace(/[%_]/g, "\\$&")}%`)
        .order("drive_created_at", { ascending: false, nullsFirst: false }).range(from, from + 999);
      if (error) throw error;
      media.push(...data);
      if (data.length < 1000) break;
    }
    state.sets = sets;
    state.media = media;
    link();
    await signThumbs(media.map((m) => m.thumb_path));
    return true;
  }

  // Work out each folder's media, its real owner (skipping "part" sub-folders) and inherited creator.
  function link() {
    const byPath = new Map();
    state.byId = new Map();
    for (const s of state.sets) {
      s._all = []; s._kids = [];
      byPath.set(s.folder_path, s);
      state.byId.set(s.id, s);
    }
    for (const s of state.sets) {
      const p = state.byId.get(s.parent_id);
      if (p) p._kids.push(s);
    }
    const owner = (s) => { while (s && s.kind === "part" && state.byId.get(s.parent_id)) s = state.byId.get(s.parent_id); return s; };
    for (const m of state.media) {
      const parts = (m.folder_path || "").split("/");
      for (let i = parts.length; i > 0; i--) {
        const s = byPath.get(parts.slice(0, i).join("/"));
        if (s) s._all.push(m);
      }
      let deepest = null;
      for (let i = parts.length; i > 0 && !deepest; i--) deepest = byPath.get(parts.slice(0, i).join("/"));
      m._owner = owner(deepest);
    }
    for (const s of state.sets) {
      s._photos = s._all.filter((m) => !isVideo(m));
      s._videos = s._all.filter(isVideo);
      let creator = s.creator || null;
      for (let p = state.byId.get(s.parent_id); p && !creator; p = state.byId.get(p.parent_id)) {
        if (p.kind === "creator") creator = p.title || p.name;
      }
      if (s.kind === "creator") creator = s.title || s.name;
      s._creator = creator ? creator.trim() : null;
      s._title = s.title || s.name;
      const good = s._photos.find((m) => !(m.tags || []).includes("text/graphic")) || s._photos[0] || s._videos[0];
      s._hero = good || null;
      s._text = norm([s._title, s.name, s._creator, s.summary, ...(s.ingredients || []), ...(s.flavours || []),
        ...(s.proteins || []), ...(s.meal || []), ...(s.diet || []), ...(s.method || []), ...(s.season || [])].join(" "));
    }
    // The same recipe can live in several folders (doc in one, photos or videos in another): merge them.
    const key = (t) => norm(t).replace(/\((enk|for approval)\)|\benk\b|\bpluck\b|[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const same = new Map();
    for (const r of state.sets.filter((x) => x.kind === "recipe")) {
      const k = key(r._title);
      if (!same.has(k)) same.set(k, []);
      same.get(k).push(r);
    }
    for (const list of same.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b._all.length - a._all.length || !!b.doc_url - !!a.doc_url);
      const main = list[0];
      for (const o of list.slice(1)) {
        o._mergedInto = main;
        main._all = [...new Set([...main._all, ...o._all])];
        main.doc_url = main.doc_url || o.doc_url;
        main._creator = main._creator || o._creator;
        main.summary = main.summary || o.summary;
        for (const f of ["flavours", "proteins", "meal", "diet", "ingredients", "method", "season"]) main[f] = [...new Set([...(main[f] || []), ...(o[f] || [])])];
        main._folders = [...(main._folders || [main.id]), o.id];
        main._text += " " + o._text;
      }
      main._photos = main._all.filter((m) => !isVideo(m));
      main._videos = main._all.filter(isVideo);
      main._hero = main._photos.find((m) => !(m.tags || []).includes("text/graphic")) || main._photos[0] || main._videos[0] || null;
    }
    for (const m of state.media) if (m._owner && m._owner._mergedInto) m._owner = m._owner._mergedInto;
    for (const s of state.sets) {
      let c = null;
      for (let p = state.byId.get(s.parent_id); p && !c; p = state.byId.get(p.parent_id)) if ((p.kind === "collection" || p.kind === "creator") && p.depth > 0) c = p;
      s._coll = c;
      const ids = s._folders || [s.id];
      const made = ids.map((id) => Date.parse((state.byId.get(id) || {}).drive_created_at || "") || 0).filter(Boolean);
      s._created = made.length ? Math.min(...made) : 0;
      s._newest = s._created || Math.max(0, ...s._all.map((m) => Date.parse(m.drive_created_at || 0) || 0));
    }
  }

  async function signThumbs(paths) {
    const todo = [...new Set(paths.filter((p) => p && !state.urls.has(p)))];
    for (let i = 0; i < todo.length; i += 500) {
      const { data, error } = await sb.storage.from("thumbs").createSignedUrls(todo.slice(i, i + 500), 60 * 60 * 6);
      if (error) throw error;
      for (const r of data) if (r.signedUrl) state.urls.set(r.path, r.signedUrl);
    }
  }

  // ---------------------------------------------------------------- filtering
  const recipes = () => state.sets.filter((s) => s.kind === "recipe" && !s._mergedInto);

  function passes(r, skipFacet) {
    if (state.q) {
      const words = norm(state.q).split(/\s+/).filter(Boolean);
      if (!words.every((w) => r._text.includes(w))) return false;
    }
    for (const f of FACETS) {
      if (f.id === skipFacet) continue;
      const want = state.include[f.id];
      if (!want || !want.size) continue;
      const have = valuesOf(r, f.id);
      if (!have.some((v) => want.has(v))) return false;
    }
    return true;
  }
  const anyFilter = () => !!state.q || Object.values(state.include).some((s) => s.size);

  // ---------------------------------------------------------------- sidebar
  function renderFacets() {
    const box = $("facets");
    const usesFacets = state.tab === "recipes" || !!state.coll;
    $("side").classList.toggle("muted", !usesFacets);
    box.replaceChildren();
    box.hidden = !usesFacets;
    for (const f of FACETS) {
      const counts = new Map();
      for (const r of recipes()) {
        if (!passes(r, f.id)) continue;
        for (const v of valuesOf(r, f.id)) counts.set(v, (counts.get(v) || 0) + 1);
      }
      const chosen = state.include[f.id] || new Set();
      for (const v of chosen) if (!counts.has(v)) counts.set(v, 0);
      if (!counts.size) continue;
      const opts = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const many = opts.length > 8;
      const group = el("details", { className: "facet", open: f.id !== "creator" || chosen.size > 0 });
      group.append(el("summary", {}, el("span", { textContent: f.title }), chosen.size ? el("span", { className: "facet-n", textContent: chosen.size }) : null));
      const list = el("div", { className: "facet-opts" });
      opts.forEach(([v, n], i) => {
        const id = `f-${f.id}-${i}`;
        const row = el("label", { className: "opt" + (many && i >= 8 && !chosen.has(v) ? " extra" : "") , htmlFor: id });
        const cb = el("input", { type: "checkbox", id, checked: chosen.has(v) });
        cb.onchange = () => toggle(f.id, v);
        row.append(cb, el("span", { className: "opt-label", textContent: label(f.id, v) }), el("span", { className: "opt-n", textContent: n }));
        list.append(row);
      });
      if (many) {
        const more = el("button", { type: "button", className: "link-btn more", textContent: `Show all ${opts.length}` });
        more.onclick = () => { list.classList.toggle("all"); more.textContent = list.classList.contains("all") ? "Show fewer" : `Show all ${opts.length}`; };
        list.append(more);
      }
      group.append(list);
      box.append(group);
    }
    $("clear").hidden = !anyFilter() || !usesFacets;
  }

  function toggle(facet, v, only = false) {
    const s = state.include[facet] || (state.include[facet] = new Set());
    if (only) { for (const k of Object.keys(state.include)) state.include[k].clear(); s.add(v); }
    else if (s.has(v)) s.delete(v); else s.add(v);
    render();
  }

  function renderActive() {
    const box = $("active");
    box.replaceChildren();
    if (state.q) {
      const c = el("button", { type: "button", className: "chip on", textContent: `“${state.q}” ×` });
      c.onclick = () => { state.q = ""; $("q").value = ""; render(); };
      box.append(c);
    }
    for (const f of FACETS) for (const v of state.include[f.id] || []) {
      const c = el("button", { type: "button", className: "chip on", textContent: `${label(f.id, v)} ×` });
      c.onclick = () => toggle(f.id, v);
      box.append(c);
    }
  }

  // ---------------------------------------------------------------- views
  function render() {
    for (const b of $("tabs").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.tab === state.tab);
    renderFacets();
    renderActive();
    renderNew();
    io.disconnect();
    io._more = null;
    document.querySelectorAll(".sentinel").forEach((n) => n.remove());
    const view = $("view");
    view.replaceChildren();
    view.className = "";
    if (state.tab === "recipes") return renderRecipes(view);
    if (state.coll) { renderControls(null); return renderCollection(view, state.byId.get(state.coll)); }
    return renderGroups(view, "collection");
  }

  function renderControls(which) {
    const box = $("controls");
    box.replaceChildren();
    if (!which) return;
    const key = which === "recipes" ? "rSort" : "cSort";
    const sel = el("select", { id: "sort" });
    sel.setAttribute("aria-label", "Sort");
    for (const [k, v] of Object.entries(SORTS[which])) sel.append(el("option", { value: k, textContent: v, selected: prefs[key] === k }));
    sel.onchange = () => { prefs[key] = sel.value; savePrefs(); render(); };
    box.append(el("label", { className: "sort" }, el("span", { textContent: "Sort" }), sel));
    if (which === "recipes") {
      const seg = el("div", { className: "seg" });
      for (const [k, v] of [["tiles", "Tiles"], ["list", "List"]]) {
        const b = el("button", { type: "button", textContent: v });
        b.setAttribute("aria-pressed", prefs.rView === k);
        b.onclick = () => { prefs.rView = k; savePrefs(); render(); };
        seg.append(b);
      }
      box.append(seg);
    }
  }

  const byName = (a, b) => a._title.localeCompare(b._title);
  // Every recipe inside a folder, at any depth (merged duplicates count once).
  const recipesIn = (c) => {
    const out = new Set();
    const walk = (s) => { for (const k of s._kids) { if (k.kind === "recipe") out.add(k._mergedInto || k); else walk(k); } };
    walk(c);
    return [...out];
  };
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
  function sortRecipes(list) {
    const k = prefs.rSort;
    if (k === "newest") return list.sort((a, b) => b._newest - a._newest || byName(a, b));
    if (k === "oldest") return list.sort((a, b) => (a._newest || Infinity) - (b._newest || Infinity) || byName(a, b));
    if (k === "photos") return list.sort((a, b) => b._photos.length - a._photos.length || byName(a, b));
    if (k === "videos") return list.sort((a, b) => b._videos.length - a._videos.length || byName(a, b));
    if (k === "collection") return list.sort((a, b) => (a._coll ? 0 : 1) - (b._coll ? 0 : 1) || (a._coll ? a._coll._title : "").localeCompare(b._coll ? b._coll._title : "") || byName(a, b));
    return list.sort(byName);
  }

  function renderRecipes(view) {
    renderControls("recipes");
    const list = sortRecipes(recipes().filter((r) => passes(r)));
    $("count").textContent = `${list.length} of ${recipes().length} recipes`;
    view.className = prefs.rView === "list" ? "rows" : "cards";
    if (!list.length) return view.append(el("p", { className: "empty", textContent: "No recipes match. Try removing a filter." }));
    if (prefs.rView === "list") {
      view.append(el("div", { className: "row-head" }, el("span"), el("span", { textContent: "Recipe" }), el("span", { textContent: "Files" }), el("span", { textContent: "Date created" }), el("span")));
    }
    let lastColl;
    for (const r of list) {
      if (prefs.rSort === "collection" && r._coll !== lastColl) {
        lastColl = r._coll;
        view.append(el("h3", { className: "group-head", textContent: r._coll ? r._coll._title : "Not in a collection" }));
      }
      view.append(prefs.rView === "list" ? recipeRow(r) : recipeCard(r));
    }
  }

  function recipeRow(r) {
    const b = el("button", { type: "button", className: "row recipe-row" });
    const t = el("div", { className: "row-thumb" });
    if (r._hero) t.append(el("img", { src: thumb(r._hero), alt: "", loading: "lazy" }));
    else t.append(el("span", { className: "doc-ico small" }));
    const text = el("div", { className: "row-text" });
    text.append(el("h3", { textContent: r._title }));
    const sub = [r._creator, r._coll && `in ${r._coll._title}`].filter(Boolean).join(" · ");
    if (sub) text.append(el("p", { className: "row-sub", textContent: sub }));
    const tags = el("div", { className: "mini" });
    for (const f of valuesOf(r, "flavours").slice(0, 2)) tags.append(el("span", { className: "pill flavour", textContent: f }));
    for (const p of valuesOf(r, "proteins").slice(0, 1)) tags.append(el("span", { className: "pill", textContent: p }));
    for (const m of valuesOf(r, "meal").slice(0, 1)) tags.append(el("span", { className: "pill", textContent: m }));
    text.append(tags);
    b.append(t, text, el("p", { className: "row-meta right", textContent: countsText(r) }),
      el("p", { className: "row-date", textContent: fmtDate(r._created) }), el("span", { className: "chev", textContent: "›" }));
    if (isNew(r)) text.firstChild.append(el("span", { className: "new-badge", textContent: "NEW" }));
    b.onclick = () => openSheet(r.id);
    return b;
  }

  function heroImg(s, cls = "hero") {
    const box = el("div", { className: cls });
    if (s._hero) box.append(el("img", { src: thumb(s._hero), alt: "", loading: "lazy" }));
    else box.append(el("span", { className: "no-img", textContent: s.doc_url ? "Recipe doc only" : "No photos yet" }));
    if (s._hero && isVideo(s._hero)) box.append(el("span", { className: "play-dot", textContent: "▶" }));
    return box;
  }

  function recipeCard(r) {
    const b = el("button", { type: "button", className: "card" });
    b.append(heroImg(r));
    const body = el("div", { className: "card-body" });
    body.append(el("h3", { textContent: r._title }));
    if (r._creator) body.append(el("p", { className: "by", textContent: r._creator }));
    const tags = el("div", { className: "mini" });
    for (const f of valuesOf(r, "flavours").slice(0, 2)) tags.append(el("span", { className: "pill flavour", textContent: f }));
    for (const p of valuesOf(r, "proteins").slice(0, 1)) tags.append(el("span", { className: "pill", textContent: p }));
    for (const m of valuesOf(r, "meal").slice(0, 1)) tags.append(el("span", { className: "pill", textContent: m }));
    body.append(tags);
    body.append(el("p", { className: "counts", textContent: countsText(r) }));
    if (r._created) body.append(el("p", { className: "counts", textContent: `Created ${fmtDate(r._created)}` }));
    b.append(body);
    if (isNew(r)) b.append(el("span", { className: "new-badge", textContent: "NEW" }));
    b.onclick = () => (r.kind !== "recipe" ? (closeSheet(), openCollection(r.id)) : openSheet(r.id));
    return b;
  }

  const countsText = (s) => [
    s._photos.length ? `${s._photos.length} photo${s._photos.length === 1 ? "" : "s"}` : "",
    s._videos.length ? `${s._videos.length} video${s._videos.length === 1 ? "" : "s"}` : "",
    s.doc_url ? "recipe doc" : "",
  ].filter(Boolean).join(" · ") || "No media yet";

  function groupsOf(kind) {
    if (kind === "collection") return state.sets.filter((s) => (s.kind === "collection" || s.kind === "creator") && s.depth > 0 && !s._mergedInto && (s._all.length || s._kids.length));
    // Creators: creator folders, plus anyone named as the creator of recipes elsewhere.
    const map = new Map();
    for (const s of state.sets.filter((x) => x.kind === "creator")) map.set(norm(s._title), { set: s, name: s._title, recipes: [] });
    for (const r of recipes()) {
      if (!r._creator) continue;
      const k = norm(r._creator);
      if (!map.has(k)) map.set(k, { set: null, name: r._creator, recipes: [] });
      map.get(k).recipes.push(r);
    }
    return [...map.values()];
  }

  function renderGroups(view, kind) {
    const q = norm(state.q);
    let groups = groupsOf(kind);
    if (kind === "creator") {
      groups = groups.filter((g) => !q || norm(g.name).includes(q) || g.recipes.some((r) => r._text.includes(q)));
      groups.sort((a, b) => b.recipes.length - a.recipes.length || a.name.localeCompare(b.name));
      $("count").textContent = `${groups.length} creators`;
    } else {
      groups = groups.filter((s) => !q || s._text.includes(q));
      renderControls("collections");
      const nr = (c) => recipesIn(c).length;
      const k = prefs.cSort;
      groups.sort(k === "recipes" ? (a, b) => nr(b) - nr(a) || byName(a, b)
        : k === "photos" ? (a, b) => b._photos.length - a._photos.length || byName(a, b)
        : k === "videos" ? (a, b) => b._videos.length - a._videos.length || byName(a, b)
        : k === "newest" ? (a, b) => b._newest - a._newest || byName(a, b) : byName);
      $("count").textContent = `${groups.length} collections`;
    }
    view.className = "rows";
    if (!groups.length) return view.append(el("p", { className: "empty", textContent: "Nothing matches." }));
    for (const g of groups) {
      const name = kind === "creator" ? g.name : g._title;
      const media = kind === "creator" ? [...new Set([...(g.set ? g.set._all : []), ...g.recipes.flatMap((r) => r._all)])] : g._all;
      const rs = kind === "creator"
        ? [...new Set([...g.recipes, ...(g.set ? g.set._kids.filter((k) => k.kind === "recipe" && !k._mergedInto) : [])])]
        : recipesIn(g);
      const b = el("button", { type: "button", className: "row coll-row" });
      b.append(el("div", { className: "big-count" + (rs.length ? "" : " zero") },
        el("strong", { textContent: rs.length }), el("span", { textContent: rs.length === 1 ? "recipe" : "recipes" })));
      const text = el("div", { className: "row-text" });
      text.append(el("h3", { textContent: name }));
      const nP = media.filter((m) => !isVideo(m)).length, nV = media.length - nP;
      text.append(el("p", { className: "row-meta", textContent: [
        nP ? `${nP} photo${nP === 1 ? "" : "s"}` : "", nV ? `${nV} video${nV === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" · ") || "No photos or videos" }));
      if (rs.length) text.append(el("p", { className: "row-sub", textContent: rs.slice(0, 4).map((r) => r._title).join(", ") + (rs.length > 4 ? ` and ${rs.length - 4} more` : "") }));
      b.append(text);
      const strip = el("div", { className: "strip" });
      const pics = media.filter((m) => !isVideo(m));
      (pics.length ? pics : media).slice(0, 5).forEach((m) => strip.append(el("img", { src: thumb(m), alt: "", loading: "lazy" })));
      b.append(strip, el("span", { className: "chev", textContent: "›" }));
      if (kind !== "creator" && isNew(g)) text.firstChild.append(el("span", { className: "new-badge", textContent: "NEW" }));
      b.onclick = () => (kind === "creator" ? openCreator(g) : openCollection(g.id));
      view.append(b);
    }
  }

  function openCollection(id) {
    state.tab = "collections";
    state.coll = id;
    history.replaceState(null, "", `#c=${encodeURIComponent(id)}`);
    render();
    window.scrollTo({ top: 0 });
  }

  function renderCollection(view, c) {
    if (!c) { state.coll = null; return render(); }
    view.className = "coll";
    const back = el("button", { type: "button", className: "link-btn back", textContent: "‹ All collections" });
    back.onclick = () => { state.coll = null; history.replaceState(null, "", location.pathname); render(); };
    const head = el("header", { className: "coll-head" });
    head.append(back, el("h2", { textContent: c._title }));
    if (c.summary) head.append(el("p", { className: "summary", textContent: c.summary }));
    head.append(el("div", { className: "actions" }, el("a", { className: "btn small", href: driveFolder(c.id), target: "_blank", rel: "noopener", textContent: "Open folder in Drive" })));
    view.append(head);
    // Everything inside, at any depth, that's a recipe or a sub-collection.
    const inside = [];
    const walk = (s) => { for (const k of s._kids) { if (k.kind === "part") walk(k); else if (!k._mergedInto) inside.push(k); } };
    walk(c);
    const rs = inside.filter((k) => k.kind === "recipe" && passes(k));
    const subs = inside.filter((k) => k.kind !== "recipe");
    const parts = [rs.length ? `${rs.length} recipe${rs.length === 1 ? "" : "s"}` : "", `${c._photos.length} photos`, `${c._videos.length} videos`].filter(Boolean);
    $("count").textContent = "";
    head.insertBefore(el("p", { className: "row-meta", textContent: parts.join(" · ") }), head.querySelector(".actions"));
    if (subs.length) {
      const sec = el("section", { className: "coll-sec" }, el("h3", {}, "Folders", el("span", { className: "n", textContent: subs.length })));
      const list = el("div", { className: "rows" });
      for (const k of subs) {
        const b = el("button", { type: "button", className: "row" });
        b.append(el("div", { className: "row-text" }, el("h3", { textContent: k._title }), el("p", { className: "row-meta", textContent: countsText(k) })));
        const strip = el("div", { className: "strip" });
        k._all.filter((m) => !isVideo(m)).slice(0, 5).forEach((m) => strip.append(el("img", { src: thumb(m), alt: "", loading: "lazy" })));
        b.append(strip, el("span", { className: "chev", textContent: "›" }));
        b.onclick = () => openCollection(k.id);
        list.append(b);
      }
      sec.append(list);
      view.append(sec);
    }
    if (rs.length) {
      const sec = el("section", { className: "coll-sec" }, el("h3", {}, "Recipes", el("span", { className: "n", textContent: rs.length })));
      const cards = el("div", { className: "cards" });
      rs.sort((a, b) => (b._all.length > 0) - (a._all.length > 0) || a._title.localeCompare(b._title)).forEach((r) => cards.append(recipeCard(r)));
      sec.append(cards);
      view.append(sec);
    }
    // Loose photos and videos that sit in the collection itself rather than in a recipe.
    const loose = c._all.filter((m) => m._owner === c);
    const hasF = state.include.has || new Set();
    const showP = !hasF.size || hasF.has("photos"), showV = !hasF.size || hasF.has("videos");
    for (const [title, list] of [["Videos", showV ? loose.filter(isVideo) : []], ["Photos", showP ? loose.filter((m) => !isVideo(m)) : []]]) {
      if (!list.length) continue;
      const sec = el("section", { className: "coll-sec" }, el("h3", {}, title, el("span", { className: "n", textContent: list.length })));
      const grid = el("div", { className: "media-grid" });
      list.forEach((m) => grid.append(mediaTile(m, list)));
      sec.append(grid);
      view.append(sec);
    }
    if (!rs.length && !subs.length && !loose.length) view.append(el("p", { className: "empty", textContent: "Nothing in this collection matches." }));
  }

  let mediaList = [];
  function renderMedia(view) {
    const ok = new Set(recipes().filter((r) => passes(r)).map((r) => r.id));
    const filtered = anyFilter();
    mediaList = state.media.filter((m) => {
      if (!filtered) return true;
      for (let s = m._owner; s; s = state.byId.get(s.parent_id)) if (ok.has(s.id)) return true;
      return false;
    });
    $("count").textContent = `${mediaList.length} of ${state.media.length} photos and videos${filtered ? " from matching recipes" : ""}`;
    view.className = "media-grid";
    if (!mediaList.length) return view.append(el("p", { className: "empty", textContent: "No photos or videos match." }));
    let shown = 0;
    const more = () => {
      const frag = document.createDocumentFragment();
      for (const m of mediaList.slice(shown, shown + 120)) frag.append(mediaTile(m, mediaList));
      shown += 120;
      view.append(frag);
    };
    more();
    io.disconnect();
    if (shown < mediaList.length) {
      const sentinel = el("div", { className: "sentinel" });
      view.after(sentinel);
      io.observe(sentinel);
      io._more = () => { more(); if (shown >= mediaList.length) { io.disconnect(); sentinel.remove(); } };
    }
  }
  const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && io._more) io._more(); }, { rootMargin: "800px" });

  function mediaTile(m, list) {
    const b = el("button", { type: "button", className: "tile" });
    b.append(el("img", { src: thumb(m), alt: m.description || m.name, loading: "lazy" }));
    if (isVideo(m)) b.append(el("span", { className: "play-dot", textContent: "▶" }));
    b.onclick = () => openLightbox(list, list.indexOf(m));
    return b;
  }

  // ---------------------------------------------------------------- recipe / collection sheet
  function related(r) {
    const score = (o) => {
      let n = 0;
      for (const f of ["flavours", "proteins", "meal", "diet", "method"]) {
        const a = new Set(valuesOf(r, f));
        n += valuesOf(o, f).filter((v) => a.has(v)).length * (f === "flavours" ? 2 : 1);
      }
      if (r._creator && r._creator === o._creator) n += 1;
      return n;
    };
    return recipes().filter((o) => o !== r).map((o) => [o, score(o)]).filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1] || (b[0]._all.length > 0) - (a[0]._all.length > 0)).slice(0, 6).map(([o]) => o);
  }

  function factRow(name, facet, r) {
    const vals = valuesOf(r, facet);
    if (!vals.length) return null;
    const cell = el("dd", { className: "chips" });
    for (const v of vals) {
      const c = el("button", { type: "button", className: "chip", textContent: v, title: `Show all recipes: ${v}` });
      c.onclick = () => { closeSheet(); state.tab = "recipes"; toggle(facet, v, true); };
      cell.append(c);
    }
    return [el("dt", { textContent: name }), cell];
  }

  function mediaSection(title, list) {
    if (!list.length) return null;
    const sec = el("section", { className: "s-media" });
    sec.append(el("h3", {}, title, el("span", { className: "n", textContent: list.length })));
    const grid = el("div", { className: "media-grid small" });
    for (const m of list) grid.append(mediaTile(m, list));
    sec.append(grid);
    return sec;
  }

  function openSheet(id, push = true) {
    let s = state.byId.get(id);
    if (!s) return;
    if (s._mergedInto) s = s._mergedInto;
    id = s.id;
    if (push) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    const body = $("sheet-body");
    body.replaceChildren();
    const head = el("header", { className: "s-head" });
    head.append(heroImg(s, "s-hero"));
    const info = el("div", { className: "s-info" });
    info.append(el("p", { className: "kicker", textContent: s.kind === "recipe" ? "Recipe" : s.kind === "creator" ? "Creator" : "Collection" }));
    info.append(el("h2", { id: "s-title", textContent: s._title }));
    if (s._creator && s.kind !== "creator") {
      const by = el("button", { type: "button", className: "link-btn by", textContent: `by ${s._creator}` });
      by.onclick = () => { const g = groupsOf("creator").find((x) => norm(x.name) === norm(s._creator)); if (g) openCreator(g); };
      info.append(by);
    }
    if (s.summary) info.append(el("p", { className: "summary", textContent: s.summary }));
    const facts = el("dl", { className: "facts" });
    const add = (row) => row && facts.append(...row);
    add(factRow("Pluck flavour", "flavours", s));
    add(factRow("Protein", "proteins", s));
    add(factRow("Meal", "meal", s));
    add(factRow("Diet", "diet", s));
    add(factRow("Method", "method", s));
    add(factRow("Occasion", "season", s));
    if (s.prep_minutes) facts.append(el("dt", { textContent: "Time" }), el("dd", { textContent: `${s.prep_minutes} min` }));
    if (s.servings) facts.append(el("dt", { textContent: "Serves" }), el("dd", { textContent: s.servings }));
    if (facts.childElementCount) info.append(facts);
    if ((s.ingredients || []).length) {
      const ing = el("div", { className: "ingredients" });
      ing.append(el("span", { className: "label", textContent: "Key ingredients" }));
      const chips = el("div", { className: "chips" });
      for (const i of s.ingredients) {
        const c = el("button", { type: "button", className: "chip", textContent: i, title: `Find other recipes with ${i}` });
        c.onclick = () => { closeSheet(); state.tab = "recipes"; for (const k of Object.keys(state.include)) state.include[k].clear(); state.q = i; $("q").value = i; render(); };
        chips.append(c);
      }
      ing.append(chips);
      info.append(ing);
    }
    const actions = el("div", { className: "actions" });
    actions.append(el("a", { className: "btn", href: driveFolder(s.id), target: "_blank", rel: "noopener", textContent: "Open folder in Drive" }));
    info.append(actions);
    head.append(info);
    body.append(head);

    const kidsRecipes = s._kids.filter((k) => k.kind === "recipe" || k.kind === "collection");
    if (kidsRecipes.length) {
      const sec = el("section", { className: "s-media" });
      sec.append(el("h3", {}, "Inside", el("span", { className: "n", textContent: kidsRecipes.length })));
      const row = el("div", { className: "cards compact" });
      kidsRecipes.forEach((k) => row.append(recipeCard(k)));
      sec.append(row);
      body.append(sec);
    }
    if (s.doc_url) {
      const sec = el("section", { className: "s-media" });
      sec.append(el("h3", {}, "Recipe doc", el("span", { className: "n", textContent: 1 })));
      const grid = el("div", { className: "media-grid small" });
      const a = el("a", { className: "tile doc-tile", href: s.doc_url, target: "_blank", rel: "noopener", title: "Open the recipe doc" });
      a.append(el("span", { className: "doc-ico" }), el("span", { className: "doc-name", textContent: s._title }), el("span", { className: "doc-open", textContent: "Open doc ↗" }));
      grid.append(a);
      sec.append(grid);
      body.append(sec);
    }
    const sec1 = mediaSection("Photos", s._photos);
    const sec2 = mediaSection("Videos", s._videos);
    if (sec2) body.append(sec2);
    if (sec1) body.append(sec1);
    if (!s._all.length && !kidsRecipes.length && !s.doc_url) body.append(el("p", { className: "empty", textContent: "Nothing in this folder yet." }));

    if (s.kind === "recipe") {
      const rel = related(s);
      if (rel.length) {
        const sec = el("section", { className: "s-media" });
        sec.append(el("h3", { textContent: "More like this" }));
        const row = el("div", { className: "cards compact" });
        rel.forEach((o) => row.append(recipeCard(o)));
        sec.append(row);
        body.append(sec);
      }
    }
    if (!$("sheet").open) $("sheet").showModal();
    body.scrollTop = 0;
    $("sheet").scrollTop = 0;
  }

  function openCreator(g) {
    if (g.set) return openSheet(g.set.id);
    history.replaceState(null, "", location.pathname);
    const body = $("sheet-body");
    body.replaceChildren();
    const head = el("header", { className: "s-head solo" });
    const info = el("div", { className: "s-info" });
    info.append(el("p", { className: "kicker", textContent: "Creator" }), el("h2", { id: "s-title", textContent: g.name }));
    const btn = el("button", { type: "button", className: "btn", textContent: "Filter recipes by this creator" });
    btn.onclick = () => { closeSheet(); state.tab = "recipes"; toggle("creator", g.name, true); };
    info.append(el("div", { className: "actions" }, btn));
    head.append(info);
    body.append(head);
    const sec = el("section", { className: "s-media" });
    sec.append(el("h3", {}, "Recipes", el("span", { className: "n", textContent: g.recipes.length })));
    const row = el("div", { className: "cards compact" });
    g.recipes.forEach((r) => row.append(recipeCard(r)));
    sec.append(row);
    body.append(sec);
    const all = [...new Set(g.recipes.flatMap((r) => r._all))];
    const v = mediaSection("Videos", all.filter(isVideo));
    const p = mediaSection("Photos", all.filter((m) => !isVideo(m)));
    if (v) body.append(v);
    if (p) body.append(p);
    if (!$("sheet").open) $("sheet").showModal();
  }

  function closeSheet() {
    if ($("sheet").open) $("sheet").close();
  }

  // ---------------------------------------------------------------- lightbox
  let lb = { list: [], i: 0 };
  let player = null;
  function openLightbox(list, i) {
    lb = { list, i };
    fillLightbox();
    if (!$("lightbox").open) $("lightbox").showModal();
  }
  function fillLightbox() {
    const m = lb.list[lb.i];
    if (!m) return;
    const box = $("l-media");
    box.replaceChildren();
    if (isVideo(m)) {
      const b = el("button", { type: "button", className: "lb-play" });
      b.setAttribute("aria-label", "Play video");
      b.append(el("img", { src: thumb(m), alt: "" }), el("span", { className: "big-play" }), el("span", { className: "lb-play-label", textContent: "Play video (opens a small player window)" }));
      b.onclick = () => playVideo(m, b.querySelector("img"));
      box.append(b);
    } else {
      box.append(el("img", { src: thumb(m), alt: m.description || m.name }));
    }
    $("l-name").textContent = m.name;
    const o = m._owner;
    $("l-where").replaceChildren();
    if (o && o.depth > 0) {
      const a = el("button", { type: "button", className: "link-btn", textContent: `From: ${o._title}` });
      a.onclick = () => { $("lightbox").close(); openSheet(o.id); };
      $("l-where").append(a);
    }
    $("l-drive").href = m.drive_url || `https://drive.google.com/file/d/${encodeURIComponent(m.id)}/view`;
    $("l-prev").hidden = lb.i <= 0;
    $("l-next").hidden = lb.i >= lb.list.length - 1;
  }
  function playVideo(m, poster) {
    const portrait = poster && poster.naturalHeight > poster.naturalWidth;
    const h = Math.min(screen.availHeight - 80, portrait ? 860 : 560);
    const w = portrait ? Math.round(h * 9 / 16) : Math.min(screen.availWidth - 80, Math.round(h * 16 / 9));
    const left = Math.round((screen.availLeft || 0) + (screen.availWidth - w) / 2);
    const top = Math.round((screen.availTop || 0) + (screen.availHeight - h) / 2);
    const url = `https://drive.google.com/file/d/${encodeURIComponent(m.id)}/preview`;
    player = window.open(url, "pluck-player", `popup,width=${w},height=${h},left=${left},top=${top}`);
    if (player) player.focus();
    else window.open(url.replace("/preview", "/view"), "_blank", "noopener");
  }

  // ---------------------------------------------------------------- what's new (per person, until dismissed)
  let since = null;  // everything first seen after this time is "new" for this person
  const seenAt = (x) => Date.parse((x && x.first_seen_at) || 0) || 0;
  const isNew = (x) => !!since && (seenAt(x) > since || (x._folders || []).some((id) => seenAt(state.byId.get(id)) > since));

  async function loadSince(uid) {
    const { data, error } = await sb.from("recipe_seen").select("dismissed_at").eq("user_id", uid).maybeSingle();
    if (error) return null;  // not set up yet: no "new" strip
    if (data) return new Date(data.dismissed_at);
    await sb.from("recipe_seen").insert({ user_id: uid, dismissed_at: new Date().toISOString() });  // first visit: nothing new yet
    return null;
  }

  function renderNew() {
    const box = $("new");
    if (!since) { box.hidden = true; return; }
    const rs = recipes().filter(isNew);
    const cs = groupsOf("collection").filter(isNew);
    const ms = state.media.filter((m) => seenAt(m) > since);
    if (!rs.length && !cs.length && !ms.length) { box.hidden = true; return; }
    box.hidden = false;
    const bits = [
      rs.length && `${rs.length} new recipe${rs.length === 1 ? "" : "s"}`,
      cs.length && `${cs.length} new collection${cs.length === 1 ? "" : "s"}`,
      ms.length && `${ms.length} new photo${ms.length === 1 ? "" : "s"} & videos`,
    ].filter(Boolean);
    $("new-title").textContent = `${bits.join(", ")} since ${since.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
    const row = $("new-items");
    row.replaceChildren();
    const item = (kind, title, go) => {
      const b = el("button", { type: "button", className: "new-item" }, el("span", { className: "kind", textContent: kind }), el("span", { textContent: title }));
      b.onclick = go;
      row.append(b);
    };
    for (const c of cs) item("Collection", c._title, () => openCollection(c.id));
    for (const r of rs) item("Recipe", r._title, () => openSheet(r.id));
    const owners = [...new Set(ms.map((m) => m._owner).filter((o) => o && o.depth > 0 && !rs.includes(o) && !cs.includes(o)))];
    for (const o of owners.slice(0, 12)) {
      const n = ms.filter((m) => m._owner === o).length;
      item(`${n} new file${n === 1 ? "" : "s"}`, o._title, () => (o.kind === "recipe" ? openSheet(o.id) : openCollection(o.id)));
    }
  }

  async function dismissNew(uid) {
    const now = new Date();
    await sb.from("recipe_seen").upsert({ user_id: uid, dismissed_at: now.toISOString() });
    since = null;
    render();
  }

  // ---------------------------------------------------------------- wiring
  function start() {
    $("app").hidden = false;
    $("tabs").hidden = false;
    for (const b of $("tabs").querySelectorAll("button")) {
      b.onclick = () => { state.tab = b.dataset.tab; state.coll = null; history.replaceState(null, "", location.pathname); render(); window.scrollTo({ top: 0 }); };
    }
    let t;
    $("q").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 150); };
    $("clear").onclick = () => { state.q = ""; $("q").value = ""; state.include = {}; render(); };
    $("s-close").onclick = closeSheet;
    $("sheet").addEventListener("close", () => { history.replaceState(null, "", state.coll ? `#c=${encodeURIComponent(state.coll)}` : location.pathname); });
    $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
    $("l-close").onclick = () => $("lightbox").close();
    $("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) $("lightbox").close(); });
    $("lightbox").addEventListener("close", () => { if (player && !player.closed) player.close(); });
    $("l-prev").onclick = () => { lb.i--; fillLightbox(); };
    $("l-next").onclick = () => { lb.i++; fillLightbox(); };
    document.addEventListener("keydown", (e) => {
      if (!$("lightbox").open) return;
      if (e.key === "ArrowLeft" && lb.i > 0) { lb.i--; fillLightbox(); }
      if (e.key === "ArrowRight" && lb.i < lb.list.length - 1) { lb.i++; fillLightbox(); }
    });
    render();
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith("c=") && state.byId.has(h.slice(2))) openCollection(h.slice(2));
    else if (h && state.byId.has(h)) openSheet(h, false);
  }

  async function boot() {
    if (!cfg) return showStatus("This copy isn't connected to the library.");
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    $("sign-in").onclick = () =>
      sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname + location.hash } });
    $("sign-out").onclick = $("sign-out-2").onclick = async () => { await sb.auth.signOut(); location.reload(); };
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { $("gate-signin").hidden = false; return; }
    $("account-email").textContent = session.user.email;
    $("account").hidden = false;
    const { data: allowed, error } = await sb.rpc("is_allowed");
    if (error) return showStatus(`Couldn't check your access: ${error.message}`);
    if (!allowed) { $("denied-email").textContent = session.user.email; $("gate-denied").hidden = false; return; }
    showStatus("Loading recipes…");
    try {
      if (!(await loadAll())) return showStatus("The recipes haven't been read yet. They'll appear after the next update.");
    } catch (e) {
      return showStatus(`Couldn't load recipes: ${e.message}`);
    }
    since = await loadSince(session.user.id);
    $("new-dismiss").onclick = () => dismissNew(session.user.id);
    showStatus("");
    start();
  }

  boot();
})();
