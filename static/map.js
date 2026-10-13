// ── map ───────────────────────────────────────────────────────────────────────
const THEME_COLOURS = ["#b08a55", "#6f9a78", "#8a78b5", "#c0745a", "#5a8fae", "#b5749a", "#959a52", "#4f9e9a", "#a86f45", "#7f8798", "#9e5f6e", "#6b8f4f"];
const mapState = { data: null, layout: null, show: { session: true, memory: true, job: true, similar: true }, view: null, selected: null };
try { Object.assign(mapState.show, JSON.parse(localStorage.getItem("mapShow") || "{}")); } catch (e) {}

function seeded(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function nodeRadius(n) {
  if (n.kind === "session") return Math.min(19, 7 + 2.6 * Math.log2(1 + n.weight / 4));
  if (n.kind === "job") return Math.min(13, 5 + 1.6 * Math.log2(1 + n.weight));
  return 4.5;
}
function ageDays(iso) { return iso ? (Date.now() - new Date(iso)) / 864e5 : 999; }
function recency(n) { const d = ageDays(n.date); return d < 21 ? 1 : d < 60 ? 0.72 : 0.42; }

function layoutMap(data) {
  const rand = seeded(7), themes = data.themes, byId = new Map(data.nodes.map(n => [n.id, n]));
  // order themes round the circle so themes with many links sit next to each other
  const tIndex = new Map(themes.map((t, i) => [t.id, i])), w = themes.map(() => themes.map(() => 0));
  for (const l of [...data.links, ...data.similar]) {
    const a = tIndex.get(byId.get(l.a)?.theme), b = tIndex.get(byId.get(l.b)?.theme);
    if (a != null && b != null && a !== b) { w[a][b] += l.score || 1; w[b][a] += l.score || 1; }
  }
  const order = [0], left = new Set(themes.map((_, i) => i).slice(1));
  while (left.size) {
    const last = order[order.length - 1];
    let best = [...left][0];
    for (const c of left) if (w[last][c] > w[last][best]) best = c;
    order.push(best); left.delete(best);
  }
  // give each theme room in proportion to how much is in it
  const est = new Map(themes.map(t => {
    const area = t.items.reduce((s, id) => { const r = nodeRadius(byId.get(id)) + (byId.get(id).kind === "session" ? 30 : 11); return s + r * r; }, 0);
    return [t.id, Math.sqrt(area) * 1.25 + 34];
  }));
  const total = order.reduce((s, ti) => s + est.get(themes[ti].id) * 2, 0);
  const R = Math.max(240, total * 1.12 / (2 * Math.PI)), anchors = new Map();
  let acc = 0;
  order.forEach(ti => {
    const t = themes[ti], share = est.get(t.id) * 2 / total;
    const ang = (acc + share / 2) * Math.PI * 2 - Math.PI / 2; acc += share;
    const pull = t.status === "parked" ? 1.08 : t.status === "active" ? 0.94 : 1;   // active themes sit a little nearer the centre
    anchors.set(t.id, { x: Math.cos(ang) * R * pull, y: Math.sin(ang) * R * pull });
  });
  const nodes = data.nodes.map(n => {
    const a = anchors.get(n.theme);
    return { ...n, r: nodeRadius(n), x: a.x + (rand() - .5) * 80, y: a.y + (rand() - .5) * 80, vx: 0, vy: 0 };
  });
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  // similarity pulls items together inside a theme; across themes it only nudges (the lines still show it)
  const springs = data.similar.map(l => {
    const a = idx.get(l.a), b = idx.get(l.b);
    if (a == null || b == null) return null;
    const same = nodes[a].theme === nodes[b].theme;
    return { a, b, k: same ? 0.03 + l.score * 0.05 : 0.002, len: same ? 48 : 200 };
  }).filter(Boolean);
  for (let tick = 0, alpha = 1; tick < 450; tick++, alpha *= 0.991) {
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i], a = anchors.get(p.theme);
      p.vx += (a.x - p.x) * 0.035 * alpha; p.vy += (a.y - p.y) * 0.035 * alpha;
      for (let j = i + 1; j < nodes.length; j++) {
        const q = nodes[j]; let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2), min = p.r + q.r + (p.kind === "session" || q.kind === "session" ? 24 : 8);
        let f = (p.theme === q.theme ? 220 : 1400) / d2;
        if (d < min) f += (min - d) * 0.3;
        dx /= d; dy /= d;
        p.vx -= dx * f * alpha; p.vy -= dy * f * alpha; q.vx += dx * f * alpha; q.vy += dy * f * alpha;
      }
    }
    for (const s of springs) {
      const p = nodes[s.a], q = nodes[s.b], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
      const f = (d - s.len) * s.k * alpha;
      p.vx += dx / d * f; p.vy += dy / d * f; q.vx -= dx / d * f; q.vy -= dy / d * f;
    }
    for (const p of nodes) { p.vx *= 0.6; p.vy *= 0.6; p.x += p.vx; p.y += p.vy; }
  }
  const halos = themes.map((t, i) => {
    const members = nodes.filter(n => n.theme === t.id);
    const cx = members.reduce((s, n) => s + n.x, 0) / members.length, cy = members.reduce((s, n) => s + n.y, 0) / members.length;
    const dists = members.map(n => Math.hypot(n.x - cx, n.y - cy) + n.r).sort((a, b) => a - b);
    const r = Math.max(46, dists[Math.floor((dists.length - 1) * 0.9)] + 22);
    return { ...t, cx, cy, r, colour: THEME_COLOURS[i % THEME_COLOURS.length] };
  });
  return { nodes, idx, halos, colour: new Map(halos.map(h => [h.id, h.colour])) };
}

// memory notes are often named like file slugs: "tone-of-voice-rules" → "Tone of voice rules"
function tidyMap(m) {
  for (const n of m.nodes) if (n.kind === "memory" && !/\s/.test(n.title)) {
    const t = n.title.replace(/^(project|feedback|user|reference)[-_]/, "").replace(/[-_]+/g, " ");
    n.title = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return m;
}

async function showMap(focus) {
  const main = $("#mapholder");
  if (!mapState.data) {
    main.innerHTML = '<div class="welcome" style="color:var(--ink)"><span class="spin"></span></div>';
    const res = await api("/api/map");
    if (!res.map) {
      main.innerHTML = `<div class="welcome" style="color:var(--ink)">No map yet.<br><br><button class="btn primary" id="build">Build my map</button>
        <p class="muted" style="font-family:var(--sans)">One Claude call on your plan, about a minute.</p></div>`;
      $("#build").onclick = rebuildMap;
      if (res.status === "running") pollMap();
      return;
    }
    mapState.data = tidyMap(res.map);
    mapState.layout = layoutMap(mapState.data);
  }
  $("#n-map").textContent = mapState.data.themes.length;
  renderMap();
  if (focus) selectNode(focus);
}

async function rebuildMap() {
  await api("/api/map/rebuild", { method: "POST" });
  const btn = $("#build") || $("#rebuild");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Building…'; }
  pollMap();
}
async function pollMap() {
  await new Promise(r => setTimeout(r, 4000));
  const res = await api("/api/map");
  if (res.status === "running") return pollMap();
  if (res.status?.startsWith?.("error")) { const b = $("#build") || $("#rebuild"); if (b) b.outerHTML = `<span style="color:var(--orange)">${esc(res.status)}</span>`; return; }
  mapState.data = tidyMap(res.map); mapState.layout = layoutMap(mapState.data); mapState.view = null;
  $("#n-map").textContent = res.map.themes.length;
  if (state.view === "map") renderMap();
}

function renderMap() {
  const { data, layout } = mapState, show = mapState.show, main = $("#mapholder");
  const byId = new Map(layout.nodes.map(n => [n.id, n]));
  const visible = n => show[n.kind];
  const built = new Date(data.built);
  main.innerHTML = `<div class="mapwrap">
    <svg id="mapsvg"><g id="vp"></g></svg>
    <div class="maphead">
      <div class="centre">${esc(data.centre)}</div>
      <div class="controls">
        <label><input type="checkbox" data-show="session" ${show.session ? "checked" : ""}> Conversations</label>
        <label><input type="checkbox" data-show="memory" ${show.memory ? "checked" : ""}> Memories</label>
        <label><input type="checkbox" data-show="job" ${show.job ? "checked" : ""}> Automated jobs</label>
        <label><input type="checkbox" data-show="similar" ${show.similar ? "checked" : ""}> Similarity lines</label>
        <button class="btn" id="rebuild" style="margin-top:4px">Rebuild map</button>
        <span class="muted" style="font-size:11.5px">Built ${fmtShort(built.toISOString())}, ${fmtTime(built.toISOString())}</span>
      </div>
    </div>
    <div class="maplegend">
      <span><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="var(--ink-3)"/></svg>conversation</span>
      <span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="none" stroke="var(--ink-3)" stroke-width="2"/></svg>memory</span>
      <span><svg width="12" height="12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="var(--ink-3)"/></svg>automated job</span>
      <span><svg width="22" height="10"><path d="M1 5 Q11 -2 21 5" fill="none" stroke="var(--s-agent)" stroke-width="1.6" stroke-dasharray="4 3"/></svg>connection Claude noticed</span>
      <span>brighter = more recent</span>
    </div>
    <div class="tip" hidden></div>
    <aside class="mappanel" hidden></aside>
  </div>`;
  const vp = $("#vp"), parts = [];
  for (const h of layout.halos) {
    if (!layout.nodes.some(n => n.theme === h.id && visible(n))) continue;
    parts.push(`<circle cx="${h.cx}" cy="${h.cy}" r="${h.r}" fill="${h.colour}" fill-opacity="${h.status === "parked" ? 0.04 : 0.09}" stroke="${h.colour}" stroke-opacity=".25" ${h.status === "parked" ? 'stroke-dasharray="5 5"' : ""} data-theme="${h.id}" class="halo"/>`);
  }
  if (show.similar) for (const l of data.similar) {
    const a = byId.get(l.a), b = byId.get(l.b);
    if (a && b && visible(a) && visible(b)) parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--ink-3)" stroke-opacity="${a.theme === b.theme ? 0.14 + l.score * 0.5 : 0.045}" stroke-width="${0.6 + l.score * 2}" data-a="${a.id}" data-b="${b.id}" class="edge"/>`);
  }
  for (const l of data.links) {
    const a = byId.get(l.a), b = byId.get(l.b);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, k = 0.18;
    parts.push(`<path d="M${a.x},${a.y} Q${mx - (b.y - a.y) * k},${my + (b.x - a.x) * k} ${b.x},${b.y}" fill="none" stroke="var(--s-agent)" stroke-width="1.5" stroke-dasharray="5 4" stroke-opacity=".8" data-a="${a.id}" data-b="${b.id}" class="edge xlink"/>`);
  }
  for (const n of layout.nodes) {
    if (!visible(n)) continue;
    const c = layout.colour.get(n.theme), o = recency(n);
    const shape = n.kind === "memory"
      ? `<circle r="${n.r}" fill="var(--cream)" stroke="${c}" stroke-width="2"/>`
      : n.kind === "job"
        ? `<rect x="${-n.r}" y="${-n.r}" width="${n.r * 2}" height="${n.r * 2}" rx="3" fill="${c}"/>`
        : `<circle r="${n.r}" fill="${c}" stroke="var(--cream)" stroke-width="2"/>`;
    const label = n.kind === "session" ? `<text x="${n.r + 5}" y="4">${esc(n.title.length > 38 ? n.title.slice(0, 37) + "…" : n.title)}</text>` : "";
    parts.push(`<g class="mapnode" data-id="${n.id}" transform="translate(${n.x},${n.y})" opacity="${o}">${shape}${label}</g>`);
  }
  for (const h of layout.halos) {
    if (!layout.nodes.some(n => n.theme === h.id && visible(n))) continue;
    const size = Math.max(15, Math.min(22, 12 + h.items.length / 3));
    parts.push(`<text class="themelabel" data-theme="${h.id}" x="${h.cx}" y="${h.cy - h.r - 10}" text-anchor="middle" font-size="${size}" fill="${h.colour}">${esc(h.name)}<tspan class="st" x="${h.cx}" dy="${-size - 2}" fill="var(--ink-3)">${h.status.toUpperCase()}</tspan></text>`);
  }
  vp.innerHTML = parts.join("");

  // fit to screen, then pan / zoom
  const svg = $("#mapsvg"), box = svg.getBoundingClientRect();
  if (!mapState.view) {
    const xs = layout.halos.flatMap(h => [h.cx - h.r, h.cx + h.r]), ys = layout.halos.flatMap(h => [h.cy - h.r - 50, h.cy + h.r]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min(box.width / (maxX - minX + 80), (box.height - 130) / (maxY - minY + 60), 1.6);
    mapState.view = { s, x: box.width / 2 - (minX + maxX) / 2 * s, y: 70 + (box.height - 70) / 2 - (minY + maxY) / 2 * s };
  }
  const apply = () => vp.setAttribute("transform", `translate(${mapState.view.x},${mapState.view.y}) scale(${mapState.view.s})`);
  apply();
  svg.addEventListener("wheel", e => {
    e.preventDefault();
    const v = mapState.view, f = Math.exp(-e.deltaY * 0.0015), ns = Math.min(5, Math.max(0.2, v.s * f));
    const r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    v.x = px - (px - v.x) * ns / v.s; v.y = py - (py - v.y) * ns / v.s; v.s = ns; apply();
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, vx: mapState.view.x, vy: mapState.view.y, moved: false, target: e.target }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener("pointermove", e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; svg.classList.add("drag"); }
      mapState.view.x = drag.vx + dx; mapState.view.y = drag.vy + dy; apply();
    }
    const g = e.target.closest?.(".mapnode"), tip = $(".tip");
    if (g && !drag?.moved) {
      const n = byId.get(g.dataset.id), r = $(".mapwrap").getBoundingClientRect();
      tip.innerHTML = `<b>${esc(n.title)}</b><div class="muted">${{ session: "Conversation", memory: "Memory", job: "Automated job" }[n.kind]} · ${fmtShort(n.date)}</div>`;
      tip.style.left = (e.clientX - r.left + 14) + "px"; tip.style.top = (e.clientY - r.top + 14) + "px"; tip.hidden = false;
    } else tip.hidden = true;
  });
  svg.addEventListener("pointerup", e => {
    svg.classList.remove("drag");
    const moved = drag?.moved, target = drag?.target || e.target; drag = null;
    if (moved) return;
    const g = target.closest?.(".mapnode"), t = target.closest?.("[data-theme]");
    if (g) selectNode(g.dataset.id);
    else if (t) selectTheme(t.dataset.theme);
    else clearSelection();
  });
  main.querySelectorAll("[data-show]").forEach(cb => cb.onchange = () => {
    mapState.show[cb.dataset.show] = cb.checked;
    try { localStorage.setItem("mapShow", JSON.stringify(mapState.show)); } catch (e) {}
    renderMap();
  });
  $("#rebuild").onclick = rebuildMap;
  if (mapState.selected) (mapState.selected.startsWith("t") && !byId.has(mapState.selected) ? selectTheme : selectNode)(mapState.selected);
}

function highlight(ids) {
  document.querySelectorAll(".mapnode").forEach(g => g.classList.toggle("dim", !!ids && !ids.has(g.dataset.id)));
  document.querySelectorAll(".edge").forEach(e => e.classList.toggle("dim", !!ids && !(ids.has(e.dataset.a) && ids.has(e.dataset.b))));
}
function clearSelection() { mapState.selected = null; highlight(null); const p = $(".mappanel"); if (p) p.hidden = true; }

function selectNode(id) {
  const { data, layout } = mapState, byId = new Map(layout.nodes.map(n => [n.id, n])), n = byId.get(id);
  if (!n) return;
  mapState.selected = id;
  const theme = layout.halos.find(h => h.id === n.theme);
  const xl = data.links.filter(l => l.a === id || l.b === id).map(l => ({ other: byId.get(l.a === id ? l.b : l.a), why: l.why }));
  const sim = data.similar.filter(l => l.a === id || l.b === id).sort((a, b) => b.score - a.score).map(l => ({ other: byId.get(l.a === id ? l.b : l.a) }));
  highlight(new Set([id, ...xl.map(x => x.other.id), ...sim.map(x => x.other.id)]));
  const item = x => `<button class="lk" data-node="${x.other.id}"><span class="dot" style="background:${layout.colour.get(x.other.theme)}"></span>${esc(x.other.title)}${x.why ? `<span class="why">${esc(x.why)}</span>` : ""}</button>`;
  const kindLabel = { session: "Conversation", memory: "Memory", job: "Automated job" }[n.kind];
  const open = n.kind === "session" ? `<button class="btn primary" data-open="#/s/${n.ref}">Open conversation</button>`
    : n.kind === "job" ? `<button class="btn" data-open="#/s/${n.ref}">Open the latest run</button>` : "";
  const p = $(".mappanel");
  p.innerHTML = `<button class="x" aria-label="Close">×</button>
    <span class="chip">${kindLabel}</span><button class="chip" style="border:0;cursor:pointer" data-themebtn="${theme.id}"><span class="dot" style="background:${theme.colour}"></span>${esc(theme.name)}</button>
    <h2>${esc(n.title)}</h2>
    <div class="muted">${n.kind === "job" ? `${plural(n.runs, "run")} · ${fmtShort(n.first)} – ${fmtShort(n.date)}` : (n.kind === "memory" ? "Updated " : "Last active ") + fmtDay(n.date)} · ${esc(n.project)}</div>
    <p style="margin:12px 0">${esc(n.gist)}</p>
    ${n.topics?.length ? `<div>${n.topics.map(t => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
    ${n.kind === "memory" && n.body ? `<details style="margin-top:10px"><summary class="muted" style="cursor:pointer">Full note</summary><div class="md" style="margin-top:8px">${md(n.body)}</div></details>` : ""}
    <div class="row" style="margin-top:14px">${open}</div>
    ${xl.length ? `<h3>Connections Claude noticed</h3>${xl.map(item).join("")}` : ""}
    ${sim.length ? `<h3>Similar</h3>${sim.map(item).join("")}` : ""}`;
  p.hidden = false;
  bindPanel(p);
}

function selectTheme(tid) {
  const { data, layout } = mapState, h = layout.halos.find(x => x.id === tid);
  if (!h) return;
  mapState.selected = tid;
  const members = layout.nodes.filter(n => n.theme === tid).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const ids = new Set(members.map(n => n.id));
  highlight(ids);
  const outward = data.links.filter(l => ids.has(l.a) !== ids.has(l.b));
  const byId = new Map(layout.nodes.map(n => [n.id, n]));
  const groups = [["session", "Conversations"], ["job", "Automated jobs"], ["memory", "Memories"]];
  const p = $(".mappanel");
  p.innerHTML = `<button class="x" aria-label="Close">×</button>
    <span class="chip"><span class="dot" style="background:${h.colour}"></span>Theme · ${esc(h.status)}</span>
    <h2>${esc(h.name)}</h2><p style="margin:8px 0">${esc(h.blurb)}</p>
    ${groups.map(([k, label]) => { const xs = members.filter(n => n.kind === k); return xs.length ? `<h3>${label} · ${xs.length}</h3>` +
      xs.map(n => `<button class="lk" data-node="${n.id}">${esc(n.title)}<span class="why">${fmtShort(n.date)}</span></button>`).join("") : ""; }).join("")}
    ${outward.length ? `<h3>Reaches into other themes</h3>` + outward.map(l => { const o = byId.get(ids.has(l.a) ? l.b : l.a);
      return `<button class="lk" data-node="${o.id}"><span class="dot" style="background:${layout.colour.get(o.theme)}"></span>${esc(o.title)}<span class="why">${esc(l.why)}</span></button>`; }).join("") : ""}`;
  p.hidden = false;
  bindPanel(p);
}

function bindPanel(p) {
  p.querySelector(".x").onclick = clearSelection;
  p.querySelectorAll("[data-node]").forEach(b => b.onclick = () => selectNode(b.dataset.node));
  p.querySelectorAll("[data-themebtn]").forEach(b => b.onclick = () => selectTheme(b.dataset.themebtn));
  p.querySelectorAll("[data-open]").forEach(b => b.onclick = () => go(b.dataset.open));
}

