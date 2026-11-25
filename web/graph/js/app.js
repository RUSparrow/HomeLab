// Живой 3D-граф HomeLab. Данные — graphify-out/graph.json, который
// пересобирает служба graphify-watch при каждом изменении кода.
// Страница раз в несколько секунд проверяет файл и вплетает изменения
// в уже нарисованный граф, не сбрасывая раскладку.

const DATA_URL = "/data/graph.json";
const POLL_MS = 8000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Проекты: по папке файла ----------
const PROJECTS = [
  ["web/server-monitor", "Server Monitor", "#fbb26a"],
  ["web/pricefinder", "PriceFinder", "#5fd1c1"],
  ["web/textcheck", "Проверка текста", "#ff7a9c"],
  ["web/cargo", "Грузоперевозки", "#8fb3ff"],
  ["web/business-card", "Сайт-визитка", "#c3a6ff"],
  ["web/graph", "Этот граф", "#eaeaec"],
  ["web/gateway", "Веб-шлюз", "#d7d8db"],
  ["monitoring", "Мониторинг", "#ed700a"],
  ["tools", "Инструменты", "#aef151"],
  ["security", "Безопасность", "#ff5a5f"],
  ["vpn", "VPN и DNS", "#4ed16a"],
  ["media", "Медиа", "#f7d774"],
  ["games", "Игры", "#7ad3ff"],
  ["ansible", "Ansible", "#e59866"],
];
const OTHER = ["", "Документы и прочее", "#878b91"];
const COMMUNITY_PALETTE = ["#fbb26a", "#5fd1c1", "#ff7a9c", "#8fb3ff", "#c3a6ff", "#aef151", "#ed700a", "#7ad3ff", "#f7d774", "#4ed16a", "#e59866", "#ff5a5f", "#d7d8db", "#9fa8ff"];

const RELATION = {
  contains: "содержит", calls: "вызывает", references: "ссылается", rationale_for: "объясняет",
  indirect_call: "вызывает косвенно", method: "метод", imports_from: "импортирует из", imports: "импортирует",
  inherits: "наследует", defines: "определяет",
};
const KIND = { code: "Код", document: "Документ", rationale: "Пояснение", image: "Изображение", paper: "Статья" };

function projectOf(file = "") {
  return PROJECTS.find(([p]) => file.startsWith(p + "/") || file === p) || OTHER;
}

// ---------- Состояние ----------
let colorMode = "project";
let selected = null;          // выбранный узел
let hovered = null;
let isolate = null;           // ключ легенды, который оставили видимым
let flash = new Map();        // id → время появления (новые узлы мигают)
let lastModified = null;
let firstLoad = true;
const neighbors = new Map();  // id → Set(id)
const linksOf = new Map();    // id → [link]

// ---------- Цвета ----------
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(hex, k, to = [14, 14, 17]) {
  const c = hexToRgb(hex);
  return `rgb(${c.map((v, i) => Math.round(v * (1 - k) + to[i] * k)).join(",")})`;
}
function baseColor(n) {
  if (colorMode === "community") return COMMUNITY_PALETTE[n.community % COMMUNITY_PALETTE.length];
  return projectOf(n.source_file)[2];
}
function legendKey(n) { return colorMode === "community" ? `c${n.community}` : projectOf(n.source_file)[1]; }

function focusSet() {
  const f = selected || hovered;
  if (!f) return null;
  const s = new Set(neighbors.get(f.id) || []);
  s.add(f.id);
  return s;
}

function nodeColor(n) {
  const t = flash.get(n.id);
  if (t && performance.now() - t < 6000) return "#ffffff";
  const f = focusSet();
  if (f && !f.has(n.id)) return mix(baseColor(n), 0.82);
  if (isolate && legendKey(n) !== isolate) return mix(baseColor(n), 0.86);
  return baseColor(n);
}

function linkColor(l) {
  const f = selected || hovered;
  if (f && (l.source.id === f.id || l.target.id === f.id)) return "#fbb26a";
  if (f) return "rgba(120,124,130,0.06)";
  if (isolate) return "rgba(120,124,130,0.08)";
  return l.confidence === "INFERRED" ? "rgba(195,166,255,0.35)" : "rgba(170,174,180,0.28)";
}

// ---------- Граф ----------
const graph = ForceGraph3D({ controlType: "orbit" })($("graph"))
  .backgroundColor("#0e0e11")
  .showNavInfo(false)
  .nodeId("id")
  .nodeVal((n) => 1 + Math.min(10, n._deg * 0.6))
  .nodeRelSize(2.4)
  .nodeOpacity(0.95)
  .nodeResolution(14)
  .nodeLabel((n) => `<div class="tip"><b>${esc(n.label)}</b><span>${esc(n.source_file || "")}${n.source_location ? " · " + esc(n.source_location) : ""}</span></div>`)
  .nodeColor(nodeColor)
  .linkColor(linkColor)
  .linkOpacity(1)
  .linkWidth((l) => ((selected || hovered) && (l.source.id === (selected || hovered).id || l.target.id === (selected || hovered).id) ? 0.5 : 0))
  .linkDirectionalParticles((l) => {
    if (!flowOn) return 0;
    const f = selected || hovered;
    if (f) return l.source.id === f.id || l.target.id === f.id ? 3 : 0;   // поток только у выбранного
    return l.relation === "calls" || l.relation === "indirect_call" ? 1 : 0;
  })
  .linkDirectionalParticleWidth(1.6)
  .linkDirectionalParticleSpeed(0.006)
  .linkDirectionalParticleColor(() => "#fbb26a")
  .onNodeHover((n) => { hovered = n || null; $("graph").style.cursor = n ? "pointer" : "grab"; refreshStyles(); })
  .onNodeClick((n) => select(n, true))
  .onBackgroundClick(() => select(null))
  .d3VelocityDecay(0.3)
  .cooldownTime(reduceMotion ? 3000 : 12000);

graph.d3Force("charge").strength(-60);
graph.d3Force("link").distance((l) => (l.relation === "contains" ? 18 : 34));

let flowOn = !reduceMotion;
const controls = graph.controls();
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = 0.35;
controls.enableDamping = true;

function refreshStyles() {
  graph.nodeColor(graph.nodeColor()).linkColor(graph.linkColor()).linkWidth(graph.linkWidth()).linkDirectionalParticles(graph.linkDirectionalParticles());
}

window.addEventListener("resize", () => graph.width(innerWidth).height(innerHeight));

// ---------- Выбор узла ----------
function select(n, fly = false) {
  selected = n || null;
  refreshStyles();
  const box = $("info");
  if (!n) { box.hidden = true; return; }
  controls.autoRotate = false;
  $("t-rotate").setAttribute("aria-pressed", "false");
  const [, project, color] = projectOf(n.source_file);
  $("i-kind").textContent = KIND[n.file_type] || "Узел";
  $("i-title").textContent = n.label;
  $("i-file").textContent = n.source_file ? `${n.source_file}${n.source_location ? " · " + n.source_location : ""}` : "";
  $("i-project").innerHTML = `<i style="background:${color}"></i>${esc(project)}`;
  $("i-degree").textContent = n._deg;

  const groups = {};
  for (const l of linksOf.get(n.id) || []) {
    const out = l.source.id === n.id;
    const other = out ? l.target : l.source;
    const key = out ? (RELATION[l.relation] || l.relation) : `← ${RELATION[l.relation] || l.relation}`;
    (groups[key] ||= []).push(other);
  }
  $("i-links").innerHTML = Object.entries(groups).map(([rel, list]) => `
    <p class="info__rel">${esc(rel)} <span>${list.length}</span></p>
    <ul>${list.slice(0, 40).map((o) => `<li><button type="button" data-id="${esc(o.id)}"><i style="background:${baseColor(o)}"></i>${esc(o.label)}</button></li>`).join("")}</ul>`).join("");
  box.hidden = false;
  box.scrollTop = 0;

  if (fly) flyTo(n);
}

function flyTo(n, again = true) {
  const d = 150 + Math.min(200, n._deg * 8);
  const r = Math.hypot(n.x, n.y, n.z) || 1;
  const k = 1 + d / r;
  const at = { x: n.x, y: n.y, z: n.z };
  graph.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, at, reduceMotion ? 0 : 1400);
  // Свежий узел ещё может «ехать» в раскладке — догоняем его
  if (again) setTimeout(() => {
    if (selected === n && Math.hypot(n.x - at.x, n.y - at.y, n.z - at.z) > 15) flyTo(n, false);
  }, 1600);
}

$("i-links").addEventListener("click", (e) => {
  const b = e.target.closest("[data-id]");
  if (!b) return;
  const n = graph.graphData().nodes.find((x) => x.id === b.dataset.id);
  if (n) select(n, true);
});
$("info-close").addEventListener("click", () => select(null));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { select(null); $("results").hidden = true; } });

// ---------- Поиск ----------
const search = $("search");
search.addEventListener("input", () => {
  const q = search.value.trim().toLowerCase();
  const box = $("results");
  if (q.length < 2) { box.hidden = true; return; }
  const hits = graph.graphData().nodes
    .filter((n) => n.label.toLowerCase().includes(q) || (n.source_file || "").toLowerCase().includes(q))
    .sort((a, b) => (a.label.toLowerCase().startsWith(q) ? -1 : 0) - (b.label.toLowerCase().startsWith(q) ? -1 : 0) || b._deg - a._deg)
    .slice(0, 8);
  box.innerHTML = hits.length
    ? hits.map((n) => `<li><button type="button" role="option" data-id="${esc(n.id)}"><i style="background:${baseColor(n)}"></i><b>${esc(n.label)}</b><span>${esc(n.source_file || "")}</span></button></li>`).join("")
    : `<li class="results__empty">Ничего не нашлось</li>`;
  box.hidden = false;
});
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("results").querySelector("button")?.click(); }
  if (e.key === "ArrowDown") { e.preventDefault(); $("results").querySelector("button")?.focus(); }
});
$("results").addEventListener("click", (e) => {
  const b = e.target.closest("[data-id]");
  if (!b) return;
  const n = graph.graphData().nodes.find((x) => x.id === b.dataset.id);
  $("results").hidden = true;
  if (n) select(n, true);
});

// ---------- Легенда ----------
function renderLegend() {
  const counts = new Map();
  for (const n of graph.graphData().nodes) {
    const key = legendKey(n);
    const cur = counts.get(key) || { key, n: 0, color: baseColor(n), name: colorMode === "community" ? (n.community_name || `Сообщество ${n.community}`) : key };
    cur.n++;
    counts.set(key, cur);
  }
  const items = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, colorMode === "community" ? 14 : 20);
  $("legend").innerHTML = items.map((it) => `<li><button type="button" data-key="${esc(it.key)}" aria-pressed="${isolate === it.key}"><i style="background:${it.color}"></i><span>${esc(it.name)}</span><b>${it.n}</b></button></li>`).join("");
  $("show-all").hidden = !isolate;
}

$("legend").addEventListener("click", (e) => {
  const b = e.target.closest("[data-key]");
  if (!b) return;
  isolate = isolate === b.dataset.key ? null : b.dataset.key;
  select(null);
  renderLegend();
  refreshStyles();
  if (isolate) {
    const nodes = graph.graphData().nodes.filter((n) => legendKey(n) === isolate);
    graph.zoomToFit(reduceMotion ? 0 : 1000, 60, (n) => nodes.includes(n));
  }
});
$("show-all").addEventListener("click", () => { isolate = null; renderLegend(); refreshStyles(); graph.zoomToFit(800, 40); });

document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => {
  colorMode = b.dataset.color;
  isolate = null;
  document.querySelectorAll("[data-color]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  renderLegend();
  refreshStyles();
  if (selected) select(selected);
}));

// ---------- Панель вида ----------
function toggle(id, fn) {
  const b = $(id);
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    fn(on);
  });
}
$("t-rotate").setAttribute("aria-pressed", String(controls.autoRotate));
$("t-flow").setAttribute("aria-pressed", String(flowOn));
toggle("t-rotate", (on) => { controls.autoRotate = on; });
toggle("t-flow", (on) => { flowOn = on; refreshStyles(); });
toggle("t-labels", (on) => { labelsOn = on; labelLayer.hidden = !on; if (on) drawLabels(); });
$("t-fit").addEventListener("click", () => { select(null); graph.zoomToFit(reduceMotion ? 0 : 900, 40); });

// ---------- Подписи главных узлов (HTML поверх сцены) ----------
let labelsOn = false;
const labelLayer = document.createElement("div");
labelLayer.className = "labels";
labelLayer.hidden = true;
document.body.appendChild(labelLayer);
function drawLabels() {
  if (!labelsOn) return;
  const top = [...graph.graphData().nodes].sort((a, b) => b._deg - a._deg).slice(0, 40);
  const placed = [];
  const html = [];
  for (const n of top) {
    const p = graph.graph2ScreenCoords(n.x || 0, n.y || 0, n.z || 0);
    if (p.x < -50 || p.y < -20 || p.x > innerWidth + 50 || p.y > innerHeight + 20) continue;
    const w = n.label.length * 6.5 + 12;
    // Не рисуем подпись, если место уже занято более важным узлом
    if (placed.some((q) => Math.abs(q.x - p.x) < (q.w + w) / 2 && Math.abs(q.y - p.y) < 18)) continue;
    placed.push({ x: p.x, y: p.y, w });
    html.push(`<span style="transform:translate(${p.x.toFixed(0)}px,${(p.y - 14).toFixed(0)}px)">${esc(n.label)}</span>`);
    if (placed.length >= 22) break;
  }
  labelLayer.innerHTML = html.join("");
  requestAnimationFrame(drawLabels);
}

// ---------- Данные и живое обновление ----------
function prepare(raw) {
  const nodes = raw.nodes.map((n) => ({ ...n }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = (raw.links || raw.edges || [])
    .filter((l) => ids.has(l.source) && ids.has(l.target) && l.source !== l.target)
    .map((l) => ({ source: l.source, target: l.target, relation: l.relation, confidence: l.confidence }));
  return { nodes, links, commit: raw.built_at_commit };
}

function index(data) {
  neighbors.clear();
  linksOf.clear();
  for (const n of data.nodes) { n._deg = 0; neighbors.set(n.id, new Set()); linksOf.set(n.id, []); }
  for (const l of data.links) {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    neighbors.get(s)?.add(t);
    neighbors.get(t)?.add(s);
    linksOf.get(s)?.push(l);
    linksOf.get(t)?.push(l);
  }
  for (const n of data.nodes) n._deg = neighbors.get(n.id).size;
}

function merge(next) {
  const cur = graph.graphData();
  const old = new Map(cur.nodes.map((n) => [n.id, n]));
  const now = performance.now();
  let added = 0;
  const nodes = next.nodes.map((n) => {
    const o = old.get(n.id);
    if (o) return Object.assign(o, n, { x: o.x, y: o.y, z: o.z, vx: o.vx, vy: o.vy, vz: o.vz });
    added++;
    flash.set(n.id, now);
    // Новый узел появляется рядом с соседом, а не в центре
    const near = next.links.find((l) => l.source === n.id || l.target === n.id);
    const anchor = near && old.get(near.source === n.id ? near.target : near.source);
    if (anchor) Object.assign(n, { x: anchor.x + Math.random() * 10 - 5, y: anchor.y + Math.random() * 10 - 5, z: anchor.z + Math.random() * 10 - 5 });
    return n;
  });
  const removed = cur.nodes.length - (nodes.length - added);
  const linkKey = (l) => `${typeof l.source === "object" ? l.source.id : l.source}|${typeof l.target === "object" ? l.target.id : l.target}|${l.relation}`;
  const oldLinks = new Set(cur.links.map(linkKey));
  const addedLinks = next.links.filter((l) => !oldLinks.has(linkKey(l))).length;
  const data = { nodes, links: next.links };
  index(data);
  graph.graphData(data);
  return { added, removed, addedLinks, removedLinks: cur.links.length - (next.links.length - addedLinks) };
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 10, b = Math.abs(n) % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

function renderStats(data) {
  $("s-nodes").textContent = data.nodes.length;
  $("s-links").textContent = data.links.length;
  $("s-files").textContent = new Set(data.nodes.map((n) => n.source_file).filter(Boolean)).size;
}

let builtAt = null, commit = "";
function renderLive(state = "ok") {
  const live = $("live");
  live.dataset.state = state;
  if (state === "error") { $("live-text").textContent = "Нет связи с сервером, пробую снова…"; return; }
  if (!builtAt) return;
  const sec = Math.round((Date.now() - builtAt) / 1000);
  const ago = sec < 60 ? "только что" : sec < 3600 ? `${Math.round(sec / 60)} мин назад` : sec < 86400 ? `${Math.round(sec / 3600)} ч назад` : `${Math.round(sec / 86400)} дн назад`;
  $("live-text").textContent = `Обновлён ${ago}${commit ? ` · коммит ${commit.slice(0, 7)}` : ""}`;
}
setInterval(() => renderLive($("live").dataset.state), 15000);

function pushFeed(text) {
  const li = document.createElement("li");
  li.innerHTML = `<time>${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time>${esc(text)}`;
  const feed = $("feed");
  feed.prepend(li);
  while (feed.children.length > 4) feed.lastChild.remove();
  setTimeout(() => li.classList.add("is-old"), 12000);
}

async function load() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-cache", headers: lastModified ? { "If-Modified-Since": lastModified } : {} });
    if (res.status === 304) { renderLive("ok"); return; }
    if (!res.ok) throw new Error(res.status);
    lastModified = res.headers.get("Last-Modified");
    builtAt = lastModified ? Date.parse(lastModified) : Date.now();
    const next = prepare(await res.json());
    commit = next.commit || "";
    if (firstLoad) {
      index(next);
      graph.graphData(next);
      firstLoad = false;
      // Один выразительный момент: облёт графа после раскладки
      setTimeout(() => graph.zoomToFit(reduceMotion ? 0 : 2200, 30), reduceMotion ? 0 : 2600);
    } else {
      const d = merge(next);
      const parts = [];
      if (d.added) parts.push(`+${d.added} ${plural(d.added, "узел", "узла", "узлов")}`);
      if (d.removed > 0) parts.push(`−${d.removed} ${plural(d.removed, "узел", "узла", "узлов")}`);
      if (d.removedLinks > 0 && !d.addedLinks) parts.push(`−${d.removedLinks} ${plural(d.removedLinks, "связь", "связи", "связей")}`);
      if (d.addedLinks) parts.push(`+${d.addedLinks} ${plural(d.addedLinks, "связь", "связи", "связей")}`);
      pushFeed(parts.length ? `Граф обновился: ${parts.join(", ")}` : "Граф пересобран, структура та же");
      if (d.added) setTimeout(refreshStyles, 6100);
    }
    renderStats(next);
    renderLegend();
    renderLive("ok");
    refreshStyles();
  } catch {
    renderLive("error");
  }
}

load();
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
