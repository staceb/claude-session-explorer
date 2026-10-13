// Second Brain: the dashboard. Plain JS, no dependencies. map.js (the mind map) uses the helpers defined here.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = (p, opt) => fetch(p, opt).then(r => r.json());
const post = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const state = { view: "overview", open: null, showTools: false, query: "", sessKind: "real" };
try { state.showTools = localStorage.getItem("showTools") === "1"; } catch (e) {}

// ── formatting ────────────────────────────────────────────────────────────────
const fmtDay = iso => iso ? new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
const fmtShort = iso => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const plural = (n, w) => `${(n ?? 0).toLocaleString()} ${n === 1 ? w : w.endsWith("y") ? w.slice(0, -1) + "ies" : w + "s"}`;
const titleOf = s => s.title || (s.first_prompt || "Untitled").split("\n")[0].slice(0, 90);
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}
function ago(iso) {
  if (!iso) return "";
  const m = (Date.now() - new Date(iso)) / 6e4;
  if (m < 2) return "just now";
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 60 / 24)} days ago`;
}
function openFor(etime) {   // ps etime: [[dd-]hh:]mm:ss
  const d = etime.includes("-") ? +etime.split("-")[0] : 0;
  if (d) return `${d} day${d === 1 ? "" : "s"}`;
  const p = etime.split("-").pop().split(":").map(Number);
  return p.length === 3 ? `${p[0]} h` : `${p[0]} min`;
}
function duration(a, b) {
  const m = Math.round((new Date(b) - new Date(a)) / 60000);
  if (!(m >= 0)) return "";
  if (m < 60) return `${m} min`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `active ${fmtShort(a)} – ${fmtShort(b)}`;
}
const tokTotal = s => (s.tok_in || 0) + (s.tok_cw || 0) + (s.tok_cr || 0) + (s.tok_out || 0);

function inline(s) {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function md(src) {
  const lines = esc(src).split("\n"), out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${buf.join("\n")}</code></pre>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`); continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "")));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map(x => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (/^&gt;\s?/.test(l)) { const buf = []; while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(inline(lines[i++].replace(/^&gt;\s?/, ""))); out.push(`<blockquote>${buf.join("<br>")}</blockquote>`); continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|&gt;|\s*\|)/.test(lines[i])) buf.push(inline(lines[i++]));
    if (!buf.length) buf.push(inline(lines[i++]));
    out.push(`<p>${buf.join("<br>")}</p>`);
  }
  return out.join("");
}
const spinner = '<div class="welcome"><span class="spin"></span></div>';

// ── routing ───────────────────────────────────────────────────────────────────
function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
window.addEventListener("hashchange", route);
function setTab(view) {
  state.view = view;
  $$(".tab").forEach(t => t.classList.toggle("on", t.dataset.view === view));
}
$$(".tab").forEach(t => t.onclick = () => { $("#q").value = ""; state.query = ""; go("#/" + t.dataset.view); });
async function route() {
  const [, kind, a, b] = decodeURIComponent(location.hash.slice(1)).split("/");
  closeDrawer();
  window.scrollTo(0, 0);
  if (kind === "s") { setTab("sessions"); return viewSessions(state.sessKind, a, b ? +b : null); }
  if (kind === "search") { setTab(""); return viewSearch(a || ""); }
  const view = ["overview", "map", "sessions", "agents", "installed", "memory"].includes(kind) ? kind : "overview";
  setTab(view);
  if (view === "overview") return viewOverview();
  if (view === "map") return viewMap(a);
  if (view === "sessions") return viewSessions(a || state.sessKind);
  if (view === "agents") return viewAgents();
  if (view === "installed") return viewInstalled(a);
  if (view === "memory") return viewMemory();
}

// ── charts ────────────────────────────────────────────────────────────────────
const SERIES = [["conversations", "Your conversations", "var(--s-conv)"], ["agents", "Agents", "var(--s-agent)"], ["automated", "Automated & background", "var(--s-auto)"]];
function legendHtml() {
  return `<div class="legend">${SERIES.map(([, l, c]) => `<span><span class="dot" style="background:${c}"></span>${l}</span>`).join("")}</div>`;
}
function weeklyChart(rows) {
  const weeks = [...new Set(rows.map(r => r.week))];
  const W = 760, H = 330, x0 = 46, y0 = 14, plotH = 276, bw = (W - x0 - 10) / weeks.length;
  const totals = weeks.map(w => rows.filter(r => r.week === w).reduce((s, r) => s + r.tokens, 0));
  const max = Math.max(1, ...totals), step = niceStep(max);
  const y = v => y0 + plotH - v / (Math.ceil(max / step) * step) * plotH;
  const grid = [];
  for (let v = 0; v <= Math.ceil(max / step) * step; v += step)
    grid.push(`<line x1="${x0}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#e7dcc3"/><text x="${x0 - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6b7d74">${fmtTok(v)}</text>`);
  const bars = weeks.map((w, i) => {
    let acc = 0;
    const segs = SERIES.map(([k, label, c]) => {
      const r = rows.find(r => r.week === w && r.kind === k), v = r ? r.tokens : 0;
      if (!v) return "";
      const yt = y(acc + v), yb = y(acc); acc += v;
      return `<rect x="${x0 + i * bw + 2}" y="${yt}" width="${Math.max(2, bw - 4)}" height="${Math.max(0, yb - yt)}" fill="${c}" stroke="#fbf5e6" stroke-width="2" rx="2"><title>Week of ${fmtShort(w)} · ${label}: ${fmtTok(v)} tokens</title></rect>`;
    }).join("");
    const d = new Date(w), lab = i === 0 || new Date(weeks[i - 1]).getMonth() !== d.getMonth()
      ? `<text x="${x0 + i * bw + 2}" y="${H - 20}" font-size="11" fill="#6b7d74">${d.toLocaleDateString("en-GB", { month: "short" })}</text>` : "";
    return segs + lab;
  }).join("");
  const last = totals.length - 1;
  const lastLabel = totals[last] ? `<text x="${x0 + last * bw + bw / 2}" y="${y(totals[last]) - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="#10261c">${fmtTok(totals[last])}</text>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens per week by source" width="100%">${grid.join("")}${bars}${lastLabel}</svg>`;
}
function niceStep(max) {
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
function barList(items, { value, label, meta, onclick, colour = "var(--ink)" }) {
  const max = Math.max(1, ...items.map(value));
  return `<div class="list">${items.map((it, i) => `<div class="item" data-i="${i}">
    <div class="t">${esc(label(it))}</div><div class="v">${fmtTok(value(it))}</div><div class="m">${meta(it)}</div>
    <div class="bar" style="width:${Math.max(1, value(it) / max * 100)}%;background:${colour}"></div></div>`).join("")}</div>`;
}
function bindList(root, items, fn) { $$(".item[data-i]", root).forEach(el => el.onclick = () => fn(items[+el.dataset.i])); }

// ── overview ──────────────────────────────────────────────────────────────────
async function viewOverview() {
  const main = $("#main");
  main.innerHTML = spinner;
  const o = await api("/api/overview");
  if (state.view !== "overview") return;
  const m = o.months, change = m.last_month ? Math.round((m.this_month - m.last_month) / m.last_month * 100) : null;
  const open = o.running, working = open.filter(r => r.status === "busy").length, mem = open.reduce((s, r) => s + r.memory_mb, 0);
  const t = o.triggers || {}, inst = o.installed;
  main.innerHTML = `<div class="grid">
    <div class="tile t-mint c3 link" data-go="#/sessions/requests"><h3>Tokens in ${esc(m.this_label)}</h3><div class="big">${fmtTok(m.this_month)}</div>
      <div class="note">${change == null ? "" : `${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}% vs ${esc(m.last_label)} (${fmtTok(m.last_month)})`}</div></div>
    <div class="tile t-yellow c3 link" data-go="#/sessions/running"><h3>Open right now</h3><div class="big">${open.length}<small>sessions</small></div>
      <div class="note">${working} working · using ${(mem / 1024).toFixed(1)} GB of memory</div></div>
    <div class="tile t-orange c3 link" data-go="#/agents"><h3>Agent runs</h3><div class="big">${o.counts.agent_runs}</div>
      <div class="note">${t.claude || 0} on Claude's own call · ${t.you || 0} you asked for · ${t.agent || 0} launched by agents${o.agents_running ? ` · ${o.agents_running} running` : ""}</div></div>
    <div class="tile t-pink c3 link" data-go="#/installed"><h3>Loaded before you type</h3><div class="big">${fmtTok(inst.loaded_tokens)}<small>tokens</small></div>
      <div class="note">${inst.skills_loaded} skills (${inst.skills_unused} never used) · ${inst.connectors} connectors · ${inst.jobs_failing ? `${inst.jobs_failing} broken jobs` : `${inst.jobs} jobs`}</div></div>

    <div class="tile c8"><h2>Tokens per week</h2><p class="sub">Every API call in your transcripts, including cache re-reads. Hover a bar for its parts.</p>
      ${legendHtml()}${weeklyChart(o.weekly)}</div>
    <div class="tile t-forest c4"><h2>Open right now</h2><p class="sub">Claude Code sessions still running in a terminal</p><div id="ov-running"></div></div>

    <div class="tile t-paper c5"><h2>Heaviest sessions</h2><p class="sub">Last 30 days, including the agents each one launched</p><div id="ov-heavy"></div></div>
    <div class="tile t-teal c4 link" data-go="#/map"><h3>Your map</h3>${o.map ? `<h2 style="font-size:19px;line-height:1.3">${esc(o.map.centre)}</h2>
      <div style="margin-top:12px">${o.map.themes.map(th => `<span class="chip" style="background:${th.status === "active" ? "var(--paper)" : "rgba(16,38,28,.1)"}">${esc(th.name)} · ${esc(th.status)}</span>`).join("")}</div>` : "<p>No map yet: open the Map tab to build it.</p>"}</div>
    <div class="tile t-sky c3 link" data-go="#/memory"><h3>Memory</h3><div class="big">${o.memory_notes}<small>notes</small></div>
      <div class="note">What Claude remembers about you and your projects${inst.archived ? ` · ${inst.archived} items archived` : ""}</div></div>
  </div>`;
  $$("[data-go]", main).forEach(el => el.onclick = () => go(el.dataset.go));
  const runEl = $("#ov-running"), shown = open.slice(0, 6);
  runEl.innerHTML = shown.length ? `<div class="list">${shown.map((r, i) => `<div class="item" data-i="${i}"><div class="t">${esc(r.title || r.cwd)}</div>
    <div class="v"><span class="chip ${r.status === "busy" ? "run" : ""}">${r.status === "busy" ? "working" : esc(r.status)}</span></div>
    <div class="m">${esc(r.project)} · open ${openFor(r.open_for)} · ${r.memory_mb} MB</div></div>`).join("")}</div>
    ${open.length > shown.length ? `<p class="muted" style="margin:10px 0 0">+ ${open.length - shown.length} more in Sessions → Open now</p>` : ""}` : '<p class="muted">Nothing open.</p>';
  bindList(runEl, shown, r => r.session_id && go("#/s/" + r.session_id));
  const heavy = $("#ov-heavy");
  heavy.innerHTML = barList(o.heaviest, { value: h => h.tokens, label: h => h.title, meta: h => `${esc(h.project)} · ${h.kind === "auto" ? "automated" : "conversation"} · ${ago(h.ended)}` });
  bindList(heavy, o.heaviest, h => go("#/s/" + h.id));
}

// ── map ───────────────────────────────────────────────────────────────────────
function viewMap(focus) {
  $("#main").innerHTML = '<div class="tile maptile" id="mapholder"></div>';
  showMap(focus);
}

// ── sessions ──────────────────────────────────────────────────────────────────
const SESS_TABS = [["real", "Conversations"], ["auto", "Automated"], ["running", "Open now"], ["requests", "Heaviest requests"]];
async function viewSessions(kind, openId, seq) {
  state.sessKind = kind || "real";
  const main = $("#main");
  if (!$("#sesslist") || main.dataset.kind !== state.sessKind) {
    main.dataset.kind = state.sessKind;
    main.innerHTML = `<div class="split"><div class="tile t-paper" id="sesslist-tile">
      <div class="seg" style="margin-bottom:12px">${SESS_TABS.map(([k, l]) => `<button data-k="${k}" class="${k === state.sessKind ? "on" : ""}">${l}</button>`).join("")}</div>
      <div id="sesslist">${spinner}</div></div><div id="detail"><div class="tile"><div class="empty">Pick a session to open it.</div></div></div></div>`;
    $$(".seg button", main).forEach(b => b.onclick = () => go("#/sessions/" + b.dataset.k));
    await renderSessionList();
  }
  if (openId) openSession(openId, seq);
}
async function renderSessionList() {
  const el = $("#sesslist"), k = state.sessKind;
  if (k === "running") {
    const rows = await api("/api/running");
    el.innerHTML = rows.length ? `<div class="list">${rows.map((r, i) => `<div class="item" data-i="${i}"><div class="t">${esc(r.title || r.cwd)}</div>
      <div class="v"><span class="chip ${r.status === "busy" ? "run" : ""}">${r.status === "busy" ? "working" : esc(r.status)}</span></div>
      <div class="m">${esc(r.project)} · open ${openFor(r.open_for)} · ${r.memory_mb} MB · ${fmtTok(r.tokens)} tokens · pid ${r.pid}</div></div>`).join("")}</div>
      <p class="muted" style="margin-top:12px">To close one, switch to its terminal window and type <code>/exit</code>. Its conversation stays saved.</p>` : '<div class="empty">Nothing open.</div>';
    bindList(el, rows, r => r.session_id && go("#/s/" + r.session_id));
    return;
  }
  if (k === "requests") {
    const rows = await api("/api/turns");
    el.innerHTML = `<p class="muted" style="margin-top:0">Each of your messages, with every API call and agent it set off.</p>` +
      barList(rows, { value: r => r.tokens + r.agent_tokens, label: r => (r.text || "(no text)").split("\n")[0].slice(0, 110),
        meta: r => `${esc(r.session)} · ${fmtShort(r.ts)} · ${plural(r.calls, "call")}${r.agent_tokens ? ` · agents ${fmtTok(r.agent_tokens)}` : ""}` });
    bindList(el, rows, r => go(`#/s/${r.session_id}/${r.seq}`));
    return;
  }
  const rows = await api("/api/sessions?kind=" + k);
  if (k === "auto") {
    const jobs = new Map();
    for (const s of rows) { if (!jobs.has(s.job)) jobs.set(s.job, []); jobs.get(s.job).push(s); }
    const sorted = [...jobs.entries()].sort((a, b) => b[1][0].started.localeCompare(a[1][0].started));
    el.innerHTML = sorted.map(([job, runs], i) => {
      const tok = runs.reduce((s, r) => s + tokTotal(r), 0);
      return `<div style="border-top:1px solid rgba(16,38,28,.1);padding:8px 0"><button class="btn light" style="width:100%;text-align:left;background:none;padding:4px 0" data-job="${i}">
        <b>${esc(job)}…</b><br><span class="muted">${plural(runs.length, "run")} · ${fmtShort(runs.at(-1).started)} – ${fmtShort(runs[0].started)} · ${fmtTok(tok)} tokens</span></button>
        <div hidden>${barList(runs, { value: tokTotal, label: r => fmtDay(r.started) + " " + fmtTime(r.started), meta: r => esc(r.title || r.project) })}</div></div>`;
    }).join("") || '<div class="empty">No automated runs.</div>';
    $$("[data-job]", el).forEach(b => b.onclick = () => { const box = b.nextElementSibling; box.hidden = !box.hidden; });
    sorted.forEach(([, runs], i) => bindList($$("[data-job]", el)[i].nextElementSibling, runs, r => go("#/s/" + r.id)));
    return;
  }
  const max = Math.max(1, ...rows.map(tokTotal));
  el.innerHTML = rows.length ? `<div class="list">${rows.map((s, i) => `<div class="item" data-i="${i}"><div class="t">${esc(titleOf(s))}</div><div class="v">${fmtTok(tokTotal(s))}</div>
    <div class="m">${esc(s.project)} · ${fmtShort(s.started)}${s.ended && fmtShort(s.ended) !== fmtShort(s.started) ? " – " + fmtShort(s.ended) : ""} · ${plural(s.n_user, "message")}${s.summary ? "" : " · not summarised"}</div>
    <div class="bar" style="width:${Math.max(1, tokTotal(s) / max * 100)}%;background:var(--s-conv)"></div></div>`).join("")}</div>` : '<div class="empty">No conversations yet.</div>';
  bindList(el, rows, s => go("#/s/" + s.id));
}

async function openSession(id, seq) {
  state.open = id;
  const box = $("#detail");
  box.innerHTML = `<div class="tile">${spinner}</div>`;
  const s = await api("/api/session/" + id);
  if (state.open !== id) return;
  if (s.error) { box.innerHTML = '<div class="tile"><div class="empty">Session not found.</div></div>'; return; }
  const tk = s.tokens;
  box.innerHTML = `<div class="grid">
    <div class="tile t-paper c12">${s.parent_id ? `<p class="muted" style="margin:0 0 6px"><a href="#/s/${s.parent_id}">← the session that launched this agent</a></p>` : ""}
      <h2 style="font-size:28px">${esc(s.agent_label || titleOf(s))}</h2>
      <div class="muted">${fmtDay(s.started)}, ${fmtTime(s.started)} · ${duration(s.started, s.ended)} · ${esc(s.project)} · ${plural(s.n_user, "message")} from you · ${plural(s.n_tools, "tool call")}${s.model ? " · mostly " + esc(s.model.replace("claude-", "")) : ""}</div></div>
    <div class="tile t-mint c3"><h3>Tokens</h3><div class="big" style="font-size:40px">${fmtTok(tk.total)}</div><div class="note">all of it, this session</div></div>
    <div class="tile t-yellow c3"><h3>New</h3><div class="big" style="font-size:40px">${fmtTok(tk.new)}</div><div class="note">sent fresh or written to cache</div></div>
    <div class="tile t-sky c3"><h3>Re-read</h3><div class="big" style="font-size:40px">${fmtTok(tk.reread)}</div><div class="note">history re-read from cache each turn</div></div>
    <div class="tile t-pink c3"><h3>Written by Claude</h3><div class="big" style="font-size:40px">${fmtTok(tk.output)}</div><div class="note">${s.agent_tokens ? `+ ${fmtTok(s.agent_tokens)} in its agents` : "output tokens"}</div></div>
    <div class="tile c12" id="summary"></div>
    ${s.turns.length > 1 ? `<div class="tile t-paper c12"><h2>Heaviest requests in this session</h2><p class="sub">Click one to jump to it</p><div id="turns"></div></div>` : ""}
    <div class="tile c12"><div class="section-head"><h2>Conversation</h2><label class="muted" style="cursor:pointer"><input type="checkbox" id="tools" ${state.showTools ? "checked" : ""}> Show tool calls</label></div><div id="transcript"></div></div>
  </div>`;
  renderSummary(s);
  if (s.turns.length > 1) {
    const top = [...s.turns].sort((a, b) => (b.tokens + b.agent_tokens) - (a.tokens + a.agent_tokens)).slice(0, 6);
    $("#turns").innerHTML = barList(top, { value: t => t.tokens + t.agent_tokens, label: t => (t.text || "(no text)").split("\n")[0].slice(0, 120),
      meta: t => `${fmtDay(t.ts)} ${fmtTime(t.ts)} · ${plural(t.calls, "call")}${t.agent_tokens ? ` · agents ${fmtTok(t.agent_tokens)}` : ""}` });
    bindList($("#turns"), top, t => jumpTo(t.seq));
  }
  renderTranscript(s);
  $("#tools").onchange = e => { state.showTools = e.target.checked; try { localStorage.setItem("showTools", state.showTools ? "1" : "0"); } catch (x) {} renderTranscript(s); };
  if (seq != null) jumpTo(seq);
}
function jumpTo(seq) {
  const target = document.getElementById("m" + seq) || $$("[data-seqs]").find(g => g.dataset.seqs.split(",").includes(String(seq)));
  if (target) { target.scrollIntoView({ block: "center" }); target.classList.add("flash"); setTimeout(() => target.classList.remove("flash"), 2500); }
}
function renderSummary(s) {
  const el = $("#summary"), x = s.summary;
  const list = (h, arr) => arr?.length ? `<h3 style="margin-top:12px">${h}</h3><ul>${arr.map(i => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
  const subs = s.subagents.length ? `<h3 style="margin-top:14px">Agents it launched · ${s.subagents.length}</h3><div class="list">${s.subagents.map((a, i) =>
    `<div class="item" data-sub="${a.id}"><div class="t">${esc(a.agent_label || a.id)}</div><div class="v">${fmtTok(a.tokens)}</div><div class="m">${esc(a.agent_type || "")} · ${plural(a.n_tools, "step")}</div></div>`).join("")}</div>` : "";
  const running = s.job_status === "running";
  const action = s.kind === "subagent" ? "" : `<div class="row" style="margin-top:14px">
    <button class="btn" id="summ" ${running ? "disabled" : ""}>${running ? '<span class="spin"></span> Summarising…' : x ? "Summarise again" : "Summarise this session"}</button>
    <span class="muted">${x ? `By ${esc(s.summary_model)}${s.summary_stale ? " · the session has continued since" : ""}` : "Uses Claude on your plan · about a minute"}</span>
    ${s.job_status?.startsWith?.("error") ? `<span class="muted" style="color:#b44">${esc(s.job_status)}</span>` : ""}</div>`;
  el.innerHTML = x ? `<p class="lede" style="margin-top:0">${esc(x.summary)}</p>
      ${x.topics?.length ? `<div>${x.topics.map(t => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="summary-cols"><div>${list("Decisions", x.decisions)}${list("Made", x.outputs)}</div><div>${list("About you", x.about_you)}${list("Still open", x.open_threads)}</div></div>${subs}${action}`
    : `${s.first_prompt ? `<h3>${s.kind === "auto" ? "Prompt" : "How it started"}</h3><p class="lede" style="margin-top:0">${esc(s.first_prompt.slice(0, 600))}${s.first_prompt.length > 600 ? "…" : ""}</p>` : ""}${subs}${action}`;
  $$("[data-sub]", el).forEach(b => b.onclick = () => go("#/s/" + b.dataset.sub));
  const btn = $("#summ");
  if (btn) btn.onclick = async () => { await post("/api/summarise/" + s.id); s.job_status = "running"; renderSummary(s); pollSummary(s.id); };
  if (running) pollSummary(s.id);
}
async function pollSummary(id) {
  await new Promise(r => setTimeout(r, 4000));
  if (state.open !== id) return;
  const s = await api("/api/session/" + id);
  if (s.job_status === "running") return pollSummary(id);
  if (state.open === id) renderSummary(s);
}
function renderTranscript(s) {
  const el = $("#transcript"), out = [], msgs = s.messages;
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === "tool") {
      const group = [];
      while (i < msgs.length && msgs[i].role === "tool") group.push(msgs[i++]);
      const names = [...new Set(group.map(g => g.tool_name))].slice(0, 4).join(", ");
      out.push(state.showTools ? `<div class="steps" data-seqs="${group.map(g => g.seq).join(",")}">${group.map(stepHtml).join("")}</div>`
        : `<div class="steps" data-seqs="${group.map(g => g.seq).join(",")}"><button data-expand>▸ ${plural(group.length, "step")} · ${esc(names)}</button><div hidden></div></div>`);
      continue;
    }
    if (m.role === "command") out.push(`<div class="cmd" id="m${m.seq}">/${esc(m.text.replace(/^\//, ""))}</div>`);
    else if (m.role === "user") out.push(`<div class="msg user" id="m${m.seq}"><div class="who">You · ${fmtTime(m.ts)}</div><div class="body">${esc(m.text)}</div></div>`);
    else out.push(`<div class="msg assistant" id="m${m.seq}"><div class="who">Claude</div><div class="body md">${md(m.text)}</div></div>`);
    i++;
  }
  el.innerHTML = out.join("") || '<div class="empty">No messages.</div>';
  const bySeq = new Map(msgs.map(m => [m.seq, m]));
  $$("[data-expand]", el).forEach(b => b.onclick = () => {
    const box = b.nextElementSibling;
    if (!box.innerHTML) box.innerHTML = b.parentElement.dataset.seqs.split(",").map(x => stepHtml(bySeq.get(+x))).join("");
    box.hidden = !box.hidden; b.textContent = (box.hidden ? "▸ " : "▾ ") + b.textContent.slice(2); bindSteps(box, bySeq);
  });
  bindSteps(el, bySeq);
}
const stepHtml = m => `<div class="step"><button data-step="${m.seq}"><b>${esc(m.tool_name)}</b>${esc(m.text)}</button><div hidden></div></div>`;
function bindSteps(root, bySeq) {
  $$("[data-step]:not([data-bound])", root).forEach(b => {
    b.dataset.bound = 1;
    b.onclick = () => { const box = b.nextElementSibling; if (!box.innerHTML) box.innerHTML = `<pre>${esc(bySeq.get(+b.dataset.step).detail || "")}</pre>`; box.hidden = !box.hidden; };
  });
}

// ── agents ────────────────────────────────────────────────────────────────────
const TRIGGER = { you: "You asked", claude: "Claude's own call", agent: "Another agent", scripted: "A script", unknown: "Unknown" };
let agentData = null;
async function viewAgents() {
  const main = $("#main");
  main.innerHTML = spinner;
  agentData = await api("/api/agents");
  if (state.view !== "agents") return;
  const a = agentData, t = a.triggers, tok = a.runs.reduce((s, r) => s + r.tokens.total, 0);
  const defs = a.definitions.filter(d => d.status === "installed");
  main.innerHTML = `<div class="grid">
    <div class="tile t-orange c3"><h3>Agent runs</h3><div class="big">${a.runs.length}</div><div class="note">${fmtTok(tok)} tokens across ${plural(a.parents.length, "session")}</div></div>
    <div class="tile t-yellow c3"><h3>Running now</h3><div class="big">${a.running.length}</div><div class="note">${a.running.length ? a.running.map(r => esc(r.description)).join(", ") : "No agent is working right now"}</div></div>
    <div class="tile t-mint c3"><h3>Your agents</h3><div class="big">${new Set(defs.map(d => d.name)).size}</div><div class="note">${[...new Set(defs.map(d => d.name))].map(esc).join(", ") || "none defined"}</div></div>
    <div class="tile t-pink c3"><h3>Who launched them</h3><div style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:14px;margin-top:6px">
      ${Object.keys(TRIGGER).filter(k => t[k]).map(k => `<b style="font-size:20px;font-variant-numeric:tabular-nums">${t[k]}</b><span style="align-self:center">${TRIGGER[k]}</span>`).join("")}</div></div>
    <div class="tile c12"><div class="section-head"><div><h2>Every agent, and where it came from</h2>
      <p class="sub" style="margin:0">Left: sessions that launched agents. Right: each kind of agent, sized by tokens used, one dot per run. Click anything.</p></div>
      <div class="legend" style="margin:0"><span><span class="dot" style="background:var(--s-conv)"></span>Your agents</span><span><span class="dot" style="background:var(--s-muted)"></span>Built into Claude Code</span>
      <span><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="none" stroke="#10261c" stroke-dasharray="2 2"/></svg> never run</span><span><span class="dot" style="background:var(--yellow);border-radius:50%"></span>running now</span></div></div>
      <div id="constellation" style="overflow-x:auto"></div></div>
    <div class="tile t-paper c12"><div class="section-head"><h2>Agent definitions</h2><span class="muted">Files that define your own agents. Archive moves one to ~/claude-archive.</span></div>
      <div class="cards">${a.definitions.map(defCard).join("")}</div></div>
  </div>`;
  $("#constellation").innerHTML = constellation(a);
  bindConstellation();
  bindManage(main, () => viewAgents());
}
function defCard(d) {
  const status = d.status === "installed" ? '<span class="chip ok">installed</span>' : d.status === "archived" ? '<span class="chip off">archived</span>' : '<span class="chip warn">file deleted</span>';
  const act = d.status === "installed" ? `<button class="btn light" data-archive="agent" data-path="${esc(d.path)}" data-name="${esc(d.name)}">Archive</button>`
    : d.status === "archived" ? `<button class="btn light" data-restore="${esc(d.archive_id)}">Restore</button>` : "";
  return `<div class="card ${d.status === "installed" ? "" : "dim"}"><div class="t">${esc(d.name)}</div><div>${status}<span class="chip">${esc(d.where)}</span></div>
    <div class="d">${esc(d.description || "No description")}</div>
    <div class="stats">${d.model ? `<span><b>${esc(d.model)}</b>model</span>` : ""}${d.created_in ? `<span><b>${fmtShort(d.created_in.ts)}</b>created in <a href="#/s/${d.created_in.id}">${esc((d.created_in.title || "a session").slice(0, 30))}</a></span>` : ""}</div>
    <div class="acts">${act}<span class="muted" style="font-size:11.5px;word-break:break-all">${esc(d.path)}</span></div></div>`;
}
function constellation(a) {
  const types = a.types, parents = [...a.parents].sort((x, y) => y.last.localeCompare(x.last));
  const W = 1040, colX = 290, cols = 3, cellW = (W - colX - 40) / cols, cellH = 190;
  const rowsN = Math.ceil(types.length / cols), H = Math.max(parents.length * 46 + 40, rowsN * cellH + 30);
  const maxTok = Math.max(1, ...types.map(t => t.tokens));
  const pos = new Map();
  types.forEach((t, i) => {
    const r = t.runs ? 16 + 40 * Math.sqrt(t.tokens / maxTok) : 13;
    pos.set(t.name, { cx: colX + 60 + (i % cols) * cellW + cellW / 2 - 30, cy: 30 + Math.floor(i / cols) * cellH + cellH / 2 - 16, r });
  });
  const pY = new Map(parents.map((p, i) => [p.id, 30 + i * 46 + (H - 40 - parents.length * 46) / 2]));
  const links = [];
  for (const p of parents) for (const t of types) {
    const n = a.runs.filter(r => r.parent_id === p.id && r.type === t.name).length;
    if (!n) continue;
    const q = pos.get(t.name), y = pY.get(p.id) + 14;
    links.push(`<path class="clink" data-p="${p.id}" data-t="${esc(t.name)}" d="M${colX - 12},${y} C${colX + 80},${y} ${q.cx - q.r - 80},${q.cy} ${q.cx - q.r},${q.cy}" fill="none" stroke="#10261c" stroke-opacity=".18" stroke-width="${1 + Math.sqrt(n) * 1.6}"><title>${esc(p.title)} → ${esc(t.name)}: ${plural(n, "run")}</title></path>`);
  }
  const pills = parents.map(p => {
    const y = pY.get(p.id);
    return `<g class="cnode" data-parent="${p.id}" style="cursor:pointer"><rect x="0" y="${y}" width="${colX - 12}" height="30" rx="7" fill="${p.kind === "auto" ? "#d7f0e6" : "#dbe8f8"}"/>
      <text x="10" y="${y + 19}" font-size="12.5" fill="#10261c">${esc((p.title || "").slice(0, 30))}${(p.title || "").length > 30 ? "…" : ""}</text>
      <text x="${colX - 20}" y="${y + 19}" font-size="11.5" text-anchor="end" fill="#3c5248">${p.runs}</text><title>${esc(p.title)} · ${plural(p.runs, "agent run")} · ${fmtTok(p.tokens)} tokens</title></g>`;
  }).join("");
  const planets = types.map(t => {
    const q = pos.get(t.name), fill = t.kind === "yours" ? "var(--s-conv)" : "var(--s-muted)";
    const runs = a.runs.filter(r => r.type === t.name);
    const maxRun = Math.max(1, ...runs.map(r => r.tokens.total));
    const moons = runs.map((r, i) => {
      const ring = Math.floor(i / 24), k = i % 24, n = Math.min(24, runs.length - ring * 24);
      const ang = (k / n) * Math.PI * 2 - Math.PI / 2, rr = q.r + 10 + ring * 9;
      const mr = 2.2 + 3.3 * Math.sqrt(r.tokens.total / maxRun);
      return `<circle class="moon" data-run="${r.id}" cx="${q.cx + Math.cos(ang) * rr}" cy="${q.cy + Math.sin(ang) * rr}" r="${mr}" fill="${r.running ? "var(--yellow)" : "#10261c"}" fill-opacity="${r.running ? 1 : .55}" stroke="${r.running ? "#10261c" : "none"}" style="cursor:pointer"><title>${esc(r.description || r.type)} · ${fmtShort(r.started)} · ${fmtTok(r.tokens.total)} tokens · ${TRIGGER[r.trigger]}</title></circle>`;
    }).join("");
    const body = t.runs ? `<circle r="${q.r}" cx="${q.cx}" cy="${q.cy}" fill="${fill}" stroke="#fbf5e6" stroke-width="2"/>`
      : `<circle r="${q.r}" cx="${q.cx}" cy="${q.cy}" fill="none" stroke="${t.kind === "yours" ? "var(--s-conv)" : "#10261c"}" stroke-width="2" stroke-dasharray="3 3"/>`;
    const ringOut = q.r + 14 + Math.floor(Math.max(0, runs.length - 1) / 24) * 9;
    return `<g class="cnode" data-type="${esc(t.name)}" style="cursor:pointer">${body}${moons}
      <text x="${q.cx}" y="${q.cy + ringOut + 14}" text-anchor="middle" font-size="13.5" font-weight="600" fill="#10261c">${esc(t.name)}</text>
      <text x="${q.cx}" y="${q.cy + ringOut + 30}" text-anchor="middle" font-size="11.5" fill="#3c5248">${t.runs ? `${plural(t.runs, "run")} · ${fmtTok(t.tokens)}` : t.status === "definition not found" ? "definition missing" : "never run"}</text>
      <title>${esc(t.name)}</title></g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" style="min-width:760px" role="img" aria-label="Agents and the sessions that launched them">
    <text x="0" y="16" font-size="11" letter-spacing="1" fill="#6b7d74">SESSIONS THAT LAUNCHED AGENTS</text>${links.join("")}${pills}${planets}</svg>`;
}
function bindConstellation() {
  const svg = $("#constellation svg");
  if (!svg) return;
  svg.addEventListener("click", e => {
    const moon = e.target.closest(".moon"), node = e.target.closest(".cnode");
    if (moon) return agentRunDrawer(moon.dataset.run);
    if (node?.dataset.type) return agentTypeDrawer(node.dataset.type);
    if (node?.dataset.parent) return agentParentDrawer(node.dataset.parent);
  });
  svg.addEventListener("mouseover", e => {
    const node = e.target.closest(".cnode");
    $$(".clink", svg).forEach(l => l.setAttribute("stroke-opacity", !node ? .18 : (l.dataset.t === node.dataset.type || l.dataset.p === node.dataset.parent) ? .6 : .06));
  });
  svg.addEventListener("mouseleave", () => $$(".clink", svg).forEach(l => l.setAttribute("stroke-opacity", .18)));
}
function runRows(runs) {
  return `<div class="list">${runs.map(r => `<div class="item" data-run="${r.id}"><div class="t">${esc(r.description || r.type)}</div><div class="v">${fmtTok(r.tokens.total)}</div>
    <div class="m">${fmtShort(r.started)} · ${esc(r.type)} · ${TRIGGER[r.trigger]}${r.running ? " · running" : ""}</div></div>`).join("")}</div>`;
}
function agentTypeDrawer(name) {
  const a = agentData, t = a.types.find(x => x.name === name), runs = a.runs.filter(r => r.type === name).sort((x, y) => (y.started || "").localeCompare(x.started || ""));
  const d = t.definition, trig = {};
  runs.forEach(r => trig[r.trigger] = (trig[r.trigger] || 0) + 1);
  openDrawer(`<span class="chip" style="background:${t.kind === "yours" ? "#dbe8f8" : "#ece6d6"}">${t.kind === "yours" ? "Your agent" : t.kind === "fork" ? "Fork (a copy of the session)" : t.kind === "built-in" ? "Built into Claude Code" : "Definition not found"}</span>
    <h2>${esc(name)}</h2>${d?.description ? `<p>${esc(d.description)}</p>` : ""}
    <div class="row" style="gap:18px;margin:10px 0"><div><div class="big" style="font-size:30px;font-weight:600">${t.runs}</div><span class="muted">runs</span></div>
      <div><div class="big" style="font-size:30px;font-weight:600">${fmtTok(t.tokens)}</div><span class="muted">tokens</span></div>
      ${t.last ? `<div><div style="font-size:16px;font-weight:600;margin-top:8px">${ago(t.last)}</div><span class="muted">last run</span></div>` : ""}</div>
    ${Object.keys(trig).length ? `<h3>Who launched it</h3>${Object.entries(trig).map(([k, n]) => `<span class="chip">${TRIGGER[k]} · ${n}</span>`).join("")}` : ""}
    ${d ? `<h3>Definition</h3><div class="muted">${esc(d.path)}${d.model ? ` · model ${esc(d.model)}` : ""}${d.tools ? ` · tools ${esc(d.tools)}` : ""}</div>
      ${d.created_in ? `<div class="muted">Created ${fmtShort(d.created_in.ts)} in <a href="#/s/${d.created_in.id}">${esc(d.created_in.title || "a session")}</a></div>` : ""}` : ""}
    ${runs.length ? `<h3>Runs · newest first</h3>${runRows(runs)}` : `<p class="muted">Never run yet.</p>`}`);
}
function agentParentDrawer(pid) {
  const a = agentData, p = a.parents.find(x => x.id === pid), runs = a.runs.filter(r => r.parent_id === pid).sort((x, y) => (x.started || "").localeCompare(y.started || ""));
  openDrawer(`<span class="chip">${p.kind === "auto" ? "Automated run" : "Conversation"}</span><h2>${esc(p.title)}</h2>
    <p class="muted">${esc(p.project)} · ${plural(p.runs, "agent run")} · ${fmtTok(p.tokens)} tokens in agents</p>
    <div class="row"><button class="btn" data-open="#/s/${pid}">Open session</button></div><h3>Agents it launched</h3>${runRows(runs)}`);
}
function agentRunDrawer(id) {
  const r = agentData.runs.find(x => x.id === id);
  openDrawer(`<span class="chip">${esc(r.type)}</span>${r.running ? '<span class="chip run">running</span>' : ""}<h2>${esc(r.description || r.type)}</h2>
    <p class="muted">${fmtDay(r.started)} ${fmtTime(r.started)} · ${duration(r.started, r.ended)} · ${plural(r.steps, "step")}${r.model ? " · " + esc(r.model.replace("claude-", "")) : ""}</p>
    <h3>Launched by</h3><p style="margin:0">${TRIGGER[r.trigger]}${r.trigger === "claude" ? ": your message didn't mention agents" : ""}</p>
    <h3>Tokens</h3><div class="row" style="gap:16px">${[["total", "total"], ["new", "new"], ["reread", "re-read"], ["output", "written"]].map(([k, l]) => `<div><b style="font-size:18px">${fmtTok(r.tokens[k])}</b><div class="muted">${l}</div></div>`).join("")}</div>
    <div class="row" style="margin-top:16px"><button class="btn" data-open="#/s/${r.id}">Open its transcript</button>
      <button class="btn light" data-open="#/s/${r.parent_id}${r.turn_seq != null ? "/" + r.turn_seq : ""}">See the message that launched it</button></div>`);
}
function openDrawer(html) {
  let d = $("#drawer");
  if (!d) { d = document.createElement("aside"); d.id = "drawer"; d.className = "drawer"; document.body.appendChild(d); }
  d.innerHTML = `<button class="x" aria-label="Close">×</button>` + html;
  d.hidden = false;
  $(".x", d).onclick = closeDrawer;
  $$("[data-open]", d).forEach(b => b.onclick = () => go(b.dataset.open));
  $$("[data-run]", d).forEach(b => b.onclick = () => agentRunDrawer(b.dataset.run));
}
function closeDrawer() { const d = $("#drawer"); if (d) d.hidden = true; }
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDrawer(); closeModal(); } });

// ── installed ─────────────────────────────────────────────────────────────────
async function viewInstalled() {
  const main = $("#main");
  main.innerHTML = spinner;
  const d = await api("/api/installed");
  if (state.view !== "installed") return;
  const s = d.summary, loaded = d.skills.filter(x => x.loaded), other = d.skills.filter(x => !x.loaded && !x.archived), archived = d.skills.filter(x => x.archived);
  const skillTok = loaded.reduce((t, x) => t + x.context_tokens, 0);
  main.innerHTML = `<div class="grid">
    <div class="tile t-mint c3"><h3>Loaded before you type</h3><div class="big">${fmtTok(s.loaded_tokens)}<small>tokens</small></div><div class="note">${s.skills_global} skill descriptions + your memory index, in a home-folder session. Projects add their own.</div></div>
    <div class="tile t-yellow c3"><h3>Skills</h3><div class="big">${s.skills_loaded}</div><div class="note">${s.skills_unused} never used · ${s.skills_not_loaded} sitting where Claude Code never looks</div></div>
    <div class="tile t-orange c3"><h3>Connectors & MCP</h3><div class="big">${s.connectors}</div><div class="note">${d.mcp.filter(m => !m.used && !m.archived).length} never used</div></div>
    <div class="tile t-pink c3"><h3>Scheduled jobs</h3><div class="big">${s.jobs}</div><div class="note">${s.jobs_failing ? `${s.jobs_failing} broken or not loaded` : "all fine"}</div></div>

    ${section("Skills", `${loaded.length} loaded, about ${fmtTok(skillTok)} tokens of descriptions in every session. Usage counts come from Claude Code's own records.`,
      loaded.sort((a, b) => b.used - a.used).map(skillCard).join(""))}
    ${other.length ? section("Not loaded", "These sit in folders Claude Code doesn't read, so they cost nothing and do nothing.", other.map(skillCard).join(""), true) : ""}
    ${section("Connectors and MCP servers", "Claude Code sends each one's tool names into every session; full descriptions load only when used.", d.mcp.filter(m => !m.archived).sort((a, b) => b.used - a.used).map(mcpCard).join(""))}
    ${section("Scheduled jobs", "Things on your Mac set to run Claude on a timer.", d.jobs.filter(j => !j.archived).map(jobCard).join("") || '<p class="muted">None.</p>')}
    ${section("Memory and instructions", "Read at the start of every session in that project.", d.memory.map(memCard).join(""))}
    ${section("Your agents", "Full picture in the Agents tab.", d.agents.filter(a => a.status === "installed").map(defCard).join(""))}
    ${d.plugins.length ? section("Plugins", "", d.plugins.map(p => `<div class="card"><div class="t">${esc(p.name)}</div><div>${p.enabled ? '<span class="chip ok">enabled</span>' : '<span class="chip off">disabled</span>'}<span class="chip">${esc(p.marketplace)}</span></div><div class="stats"><span><b>${esc(p.version || "")}</b>version</span><span><b>${fmtShort(p.installed)}</b>installed</span></div></div>`).join("")) : ""}
    ${archived.length || d.mcp.some(m => m.archived) || d.jobs.some(j => j.archived) ? section("Archive", "Moved to ~/claude-archive. Restore puts each back where it was.",
      [...archived.map(skillCard), ...d.mcp.filter(m => m.archived).map(mcpCard), ...d.jobs.filter(j => j.archived).map(jobCard)].join(""), true) : ""}
  </div>`;
  bindManage(main, () => viewInstalled());
  $$("[data-go]", main).forEach(el => el.onclick = () => go(el.dataset.go));
}
function section(title, sub, cards, dim) {
  return `<div class="tile ${dim ? "t-paper" : ""} c12"><div class="section-head"><div><h2>${title}</h2>${sub ? `<p class="sub" style="margin:0">${sub}</p>` : ""}</div></div><div class="cards">${cards}</div></div>`;
}
function skillCard(x) {
  const act = x.archived ? `<button class="btn light" data-restore="${esc(x.archive_id)}">Restore</button>`
    : x.manageable ? `<button class="btn light" data-archive="skill" data-path="${esc(x.path)}" data-name="${esc(x.name)}">Archive</button>` : `<span class="muted" style="font-size:11.5px">managed by ${esc(x.source.replace("synced from ", ""))}</span>`;
  return `<div class="card ${x.loaded ? "" : "dim"}"><div class="t">${esc(x.name)}</div><div><span class="chip">${esc(x.source)}</span>${x.note ? `<span class="chip warn">${esc(x.note)}</span>` : ""}${x.loaded && !x.used ? '<span class="chip off">never used</span>' : ""}</div>
    <div class="d">${esc(x.description || "No description")}</div>
    <div class="stats"><span><b>${x.used || 0}</b>times used</span>${x.last_used ? `<span><b>${fmtShort(x.last_used)}</b>last used</span>` : ""}<span><b>${x.context_tokens ? "≈ " + x.context_tokens : "0"}</b>tokens / session</span>${x.installed ? `<span><b>${fmtShort(x.installed)}</b>added</span>` : ""}</div>
    <div class="acts">${act}</div></div>`;
}
function mcpCard(m) {
  const act = m.archived ? `<button class="btn light" data-restore="${esc(m.archive_id)}">Restore</button>`
    : m.manageable ? `<button class="btn light" data-archive="mcp" data-name="${esc(m.name)}" data-scope="${esc(m.manage_scope)}" data-project="${esc(m.project || "")}">Archive</button>`
    : `<span class="muted" style="font-size:11.5px">Disconnect in claude.ai → Settings → Connectors</span>`;
  return `<div class="card ${m.archived ? "dim" : ""}"><div class="t">${esc(m.name)}</div><div><span class="chip">${esc(m.kind)}</span><span class="chip">${esc(m.scope)}</span>${!m.used && !m.archived ? '<span class="chip off">never used</span>' : ""}</div>
    <div class="d">${esc(m.target || "")}</div>
    <div class="stats"><span><b>${m.used || 0}</b>tool calls</span>${m.last_used ? `<span><b>${fmtShort(m.last_used)}</b>last used</span>` : ""}</div><div class="acts">${act}</div></div>`;
}
function jobCard(j) {
  const chip = { failing: '<span class="chip warn">failing</span>', "not loaded": '<span class="chip off">not loaded</span>', running: '<span class="chip run">running</span>', ok: '<span class="chip ok">ok</span>', archived: '<span class="chip off">archived</span>' }[j.state] || "";
  const act = j.archived ? `<button class="btn light" data-restore="${esc(j.archive_id)}">Restore</button>`
    : j.manageable ? `<button class="btn light" data-archive="job" data-path="${esc(j.path)}" data-name="${esc(j.name)}">Unload &amp; archive</button>` : `<span class="muted" style="font-size:11.5px">Edit with <code>crontab -e</code></span>`;
  return `<div class="card ${j.archived ? "dim" : ""}"><div class="t">${esc(j.name)}</div><div>${chip}<span class="chip">${esc(j.kind)}</span></div>
    <div class="d">${esc(j.script || "")}</div>
    <div class="stats"><span><b>${esc(j.schedule || "")}</b>schedule</span>${j.exit_code && j.exit_code !== "0" ? `<span><b>${esc(j.exit_code)}</b>last exit code</span>` : ""}</div>
    ${j.last_log ? `<div class="d" style="font-family:var(--mono);font-size:11.5px;margin-top:6px">${esc(j.last_log)}</div>` : ""}<div class="acts">${act}</div></div>`;
}
function memCard(m) {
  return `<div class="card"><div class="t">${esc(m.name)}</div><div><span class="chip">${esc(m.kind)}</span></div><div class="d">${esc(m.path)}</div>
    <div class="stats">${m.notes != null ? `<span><b>${m.notes}</b>notes</span>` : ""}<span><b>≈ ${m.context_tokens}</b>tokens / session</span>${m.updated ? `<span><b>${fmtShort(new Date(m.updated * 1000).toISOString())}</b>updated</span>` : ""}</div>
    ${m.kind === "memory" ? `<div class="acts"><button class="btn light" data-go="#/memory">Open memory</button></div>` : ""}</div>`;
}

// archive / restore, with a confirmation step (the page can't use confirm())
function bindManage(root, refresh) {
  $$("[data-archive]", root).forEach(b => b.onclick = () => {
    const kind = b.dataset.archive, name = b.dataset.name;
    const what = { skill: "This skill folder moves to ~/claude-archive/skills. Claude Code stops loading it from your next session.",
      agent: "This agent file moves to ~/claude-archive/agents. Claude stops being able to launch it.",
      job: "The job is unloaded from launchd and its plist moves to ~/claude-archive/jobs. It won't run again until restored.",
      mcp: "Its settings are saved in ~/claude-archive, then it's removed with `claude mcp remove`. New sessions won't load it." }[kind];
    modal(`<h2>Archive ${esc(name)}?</h2><p>${esc(what)}</p><p class="muted">Nothing is deleted. Restore puts it back exactly as it was.</p>`, "Archive", async () => {
      const r = await post("/api/manage", { action: "archive", kind, path: b.dataset.path, name, scope: b.dataset.scope, project: b.dataset.project || null });
      if (r.error) throw new Error(r.error);
      refresh();
    });
  });
  $$("[data-restore]", root).forEach(b => b.onclick = async () => {
    b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    const r = await post("/api/manage", { action: "restore", id: b.dataset.restore });
    if (r.error) { b.disabled = false; b.textContent = "Restore"; modal(`<h2>Couldn't restore</h2><p>${esc(r.error)}</p>`); return; }
    refresh();
  });
}
function modal(html, okLabel, onOk) {
  closeModal();
  const m = document.createElement("div");
  m.className = "modal"; m.id = "modal";
  m.innerHTML = `<div class="box">${html}<p class="err" style="color:#b44"></p><div class="row" style="justify-content:flex-end;margin-top:10px">
    <button class="btn light" data-cancel>${onOk ? "Cancel" : "Close"}</button>${onOk ? `<button class="btn danger" data-ok>${okLabel}</button>` : ""}</div></div>`;
  document.body.appendChild(m);
  $("[data-cancel]", m).onclick = closeModal;
  m.onclick = e => { if (e.target === m) closeModal(); };
  const ok = $("[data-ok]", m);
  if (ok) ok.onclick = async () => {
    ok.disabled = true; ok.innerHTML = '<span class="spin"></span>';
    try { await onOk(); closeModal(); } catch (e) { $(".err", m).textContent = e.message; ok.disabled = false; ok.textContent = okLabel; }
  };
}
function closeModal() { $("#modal")?.remove(); }

// ── memory ────────────────────────────────────────────────────────────────────
async function viewMemory() {
  const main = $("#main");
  main.innerHTML = spinner;
  const mems = await api("/api/memory");
  if (state.view !== "memory") return;
  const byType = {};
  for (const m of mems) (byType[m.type || "other"] ||= []).push(m);
  const colours = { user: "t-mint", feedback: "t-yellow", project: "t-sky", reference: "t-pink", other: "t-paper" };
  main.innerHTML = `<div class="grid">${["user", "feedback", "project", "reference", "other"].filter(t => byType[t]).map(t => `
    <div class="tile ${colours[t]} c3"><h3>${t}</h3><div class="big">${byType[t].length}</div><div class="note">${{ user: "about you", feedback: "how you want Claude to work", project: "ongoing work", reference: "where things live", other: "other notes" }[t]}</div></div>`).join("")}
    <div class="tile c12"><h2>Everything Claude remembers</h2><p class="sub">Newest first. Each note links to the session that wrote it.</p>
    <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">${mems.slice().sort((a, b) => b.modified - a.modified).map(m => `
      <div class="card"><div class="t">${esc(tidyName(m.name))}</div><div><span class="chip">${esc(m.type || "note")}</span><span class="chip">${esc(m.project)}</span></div>
      <div class="d">${esc(m.description)}</div>
      <details><summary class="muted" style="cursor:pointer;margin-top:6px">Full note</summary><div class="md" style="font-size:13px">${md(m.body)}</div></details>
      <div class="stats"><span><b>${fmtShort(new Date(m.modified * 1000).toISOString())}</b>updated</span>${m.sources.length ? `<span><b><a href="#/s/${m.sources[0].session_id}">${esc((m.sources[0].title || "a session").slice(0, 28))}</a></b>written in</span>` : ""}</div></div>`).join("")}
    </div></div></div>`;
}
const tidyName = n => /\s/.test(n) ? n : (t => t.charAt(0).toUpperCase() + t.slice(1))(n.replace(/^(project|feedback|user|reference)[-_]/, "").replace(/[-_]+/g, " "));

// ── search ────────────────────────────────────────────────────────────────────
let searchTimer;
$("#q").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => q ? go("#/search/" + encodeURIComponent(q)) : go("#/overview"), 250);
});
async function viewSearch(q) {
  state.query = q;
  if ($("#q").value.trim() !== q) $("#q").value = q;
  const main = $("#main");
  main.innerHTML = spinner;
  const [mine, auto] = await Promise.all([api(`/api/search?kind=real&q=${encodeURIComponent(q)}`), api(`/api/search?kind=auto&q=${encodeURIComponent(q)}`)]);
  if (state.query !== q) return;
  const hl = s => esc(s.replace(/\*\*|__|`/g, "")).replace(/\x01/g, "<mark>").replace(/\x02/g, "</mark>");
  const block = (rows, label, cls) => `<div class="tile ${cls} c6"><h2>${label}</h2><p class="sub">${rows.length}${rows.length === 150 ? "+" : ""} matches</p>
    <div class="list">${rows.map(r => `<div class="item" data-sid="${r.session_id}" data-seq="${r.seq}"><div class="t" style="font-weight:400">${hl(r.snip)}</div>
    <div class="m">${r.role === "user" ? "You" : "Claude"} · ${fmtDay(r.started)} · ${esc(r.title || r.project)}</div></div>`).join("") || '<p class="muted">Nothing here.</p>'}</div></div>`;
  main.innerHTML = `<div class="grid">${block(mine, "In your conversations", "t-paper")}${block(auto, "In automated runs", "")}</div>`;
  $$("[data-sid]", main).forEach(b => b.onclick = () => go(`#/s/${b.dataset.sid}/${b.dataset.seq}`));
}

// ── update button ─────────────────────────────────────────────────────────────
const BUSY = ["indexing", "summarising", "map"];
$("#update").onclick = async () => { showUpdate(await post("/api/update")); pollUpdate(); };
function showUpdate(u) {
  const busy = BUSY.includes(u.stage), btn = $("#update");
  btn.disabled = busy;
  btn.innerHTML = busy ? '<span class="spin"></span> Updating…' : "↻ Update";
  $("#updstatus").innerHTML = u.stage === "idle" ? "" : `<span style="${u.stage === "error" ? "color:var(--orange)" : ""}">${esc(u.detail || "")}</span>`;
}
async function pollUpdate() {
  await new Promise(r => setTimeout(r, 2000));
  const u = await api("/api/update");
  showUpdate(u);
  if (BUSY.includes(u.stage)) return pollUpdate();
  if (u.stage === "done") { mapState.data = null; mapState.view = null; await loadCounts(); route(); }
}
async function loadCounts() {
  const st = await api("/api/stats");
  $("#n-sessions").textContent = st.real || 0;
  $("#n-agents").textContent = st.subagent || 0;
  $("#n-memory").textContent = st.memories || 0;
  $("#navnote").textContent = `${st.summarised || 0} of ${st.real || 0} conversations summarised`;
}

// ── background picker ─────────────────────────────────────────────────────────
function setGround(g) {
  document.documentElement.dataset.ground = g;
  if (["sun", "tangerine", "bubblegum", "lime"].includes(g)) document.documentElement.dataset.bright = "";
  else delete document.documentElement.dataset.bright;
  try { localStorage.setItem("ground", g); } catch (e) {}
  $$(".grounds button").forEach(b => b.classList.toggle("on", b.dataset.ground === g));
}
$$(".grounds button").forEach(b => b.onclick = () => setGround(b.dataset.ground));
setGround(document.documentElement.dataset.ground || "ink");

// ── start ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadCounts();
  route();
  const u = await api("/api/update");
  showUpdate(u);
  if (BUSY.includes(u.stage)) pollUpdate();
})();
