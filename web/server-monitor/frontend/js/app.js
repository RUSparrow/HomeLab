"use strict";

/* =========================================================
   Server Monitor — фронтенд
   ========================================================= */

const REFRESH_INTERVAL = 5000;
const HISTORY_REFRESH = 30000;
const RANGE_LABELS = { "1h": "1 ч", "6h": "6 ч", "24h": "24 ч" };
const API_HEADERS = { "X-Requested-With": "server-monitor" };

const $ = (id) => document.getElementById(id);
let lastData = null;

const state = {
  history: null,             // ответ /api/history
  range: "1h",
  historyTimer: null,
  serverIp: "",
  expanded: new Set(),      // раскрытые стеки
  busy: new Set(),          // стеки, для которых идёт запрос
  pending: new Map(),       // ожидание целевого состояния после команды
  stackOrder: "",
  lastOk: null,
  timer: null,
  inFlight: false,
};

/* ---------- Форматирование ---------- */

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));

function fmtBytes(bytes) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = Number(bytes) || 0;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(".", ",")} ${units[i]}`;
}

/** Склонение: plural(1, ["работает", "работают", "работают"]). */
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function fmtNumber(value, digits = 1) {
  return Number(value).toFixed(digits).replace(".", ",");
}

/** «78 д 13 ч», «5 ч 12 мин», «3 мин» — две старшие единицы. */
function fmtDuration(seconds) {
  let s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return "—";
  const parts = [];
  const units = [[86400, "д"], [3600, "ч"], [60, "мин"], [1, "с"]];
  for (const [size, label] of units) {
    if (s >= size) {
      parts.push(`${Math.floor(s / size)} ${label}`);
      s %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

function fmtAgo(unixSeconds) {
  if (!unixSeconds) return "никогда";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (diff < 60) return "только что";
  return `${fmtDuration(diff)} назад`;
}

function fmtDate(date) {
  return date.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

/** Ссылки строятся бэкендом от LAN-адреса; подставляем адрес, по которому открыта панель. */
function localizeUrl(url) {
  if (!url || !state.serverIp) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === state.serverIp && location.hostname) {
      parsed.hostname = location.hostname;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function level(percent, warn, crit) {
  if (percent >= crit) return "lvl-crit";
  if (percent >= warn) return "lvl-warn";
  return "lvl-ok";
}

function setLevel(card, cls) {
  card.classList.remove("lvl-ok", "lvl-warn", "lvl-crit");
  card.classList.add(cls);
}

/** Меняет innerHTML только при реальном изменении — не сбивает выделение и hover. */
function patch(el, html) {
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/* ---------- История и мини-графики ---------- */

function loadRange() {
  try {
    const saved = localStorage.getItem("sm-range");
    if (saved && RANGE_LABELS[saved]) state.range = saved;
  } catch {
    // localStorage может быть недоступен — работаем с периодом по умолчанию
  }
}

async function fetchHistory() {
  try {
    const res = await fetch(`/api/history?range=${state.range}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.history = await res.json();
    if (lastData) renderSystem(lastData);
  } catch (err) {
    console.error("History fetch error:", err);
  }
}

function setRange(range) {
  state.range = range;
  try { localStorage.setItem("sm-range", range); } catch { /* не критично */ }
  document.querySelectorAll(".range__btn[data-range]").forEach((b) => b.classList.toggle("is-active", b.dataset.range === range));
  document.querySelectorAll("[data-range-label]").forEach((el) => { el.textContent = RANGE_LABELS[range]; });
  fetchHistory();
}

/** Серия из истории + текущее значение в конце. null — пропуски (сервер был выключен). */
function seriesWithNow(field, now) {
  const line = state.history?.series?.[field] ? [...state.history.series[field]] : [];
  if (now != null && line.length) line[line.length - 1] = now;
  return line;
}

function sparkPath(values, min, max) {
  const n = Math.max(values.length - 1, 1);
  const y = (v) => 28 - ((Math.min(Math.max(v, min), max) - min) / (max - min || 1)) * 26 - 1;
  const segments = [];
  let current = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push([((i / n) * 100).toFixed(2), y(v).toFixed(2)]);
    }
  });
  if (current.length) segments.push(current);
  return segments;
}

function renderSpark(svg, values, min = 0, max = 100, cls = "") {
  if (!svg) return;
  const segments = sparkPath(values, min, max).filter((seg) => seg.length > 1);
  if (!segments.length) {
    svg.innerHTML = "";
    return;
  }
  let html = "";
  for (const seg of segments) {
    const pts = seg.map(([x, y]) => `${x},${y}`).join(" L");
    if (!cls) html += `<path class="area" d="M${seg[0][0]},28 L${pts} L${seg[seg.length - 1][0]},28 Z"></path>`;
    html += `<path class="line ${cls}" d="M${pts}"></path>`;
  }
  return html;
}

function setSpark(svg, html) {
  if (svg && html !== undefined) patch(svg, html || "");
}

/** «Ср. 12,3 % · пик 61 %» за выбранный период. */
function statsLine(field, unit, digits = 1, format = null) {
  const st = state.history?.stats?.[field];
  if (!st) return "Собираю историю…";
  const f = format || ((v) => `${fmtNumber(v, digits)}${unit}`);
  const covered = state.history.covered_seconds;
  const partial = covered && covered < state.history.seconds * 0.9 ? ` (за ${fmtDuration(covered)})` : "";
  return `Ср. <b>${f(st.avg)}</b> · пик <b>${f(st.max)}</b>${partial}`;
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec == null) return "—";
  const bits = bytesPerSec * 8;
  if (bits >= 1e6) return `${fmtNumber(bits / 1e6, bits >= 1e8 ? 0 : 1)} Мбит/с`;
  if (bits >= 1e3) return `${fmtNumber(bits / 1e3, 0)} Кбит/с`;
  return `${Math.round(bits)} бит/с`;
}

function cpuName(model) {
  return (model || "CPU").replace(/\(R\)|\(TM\)/g, "").replace(/\s+CPU\s+@.*/, "").replace(/\s+/g, " ").trim();
}

/* ---------- Системные карточки ---------- */

function renderSystem(data) {
  const cpu = data.cpu || {};
  setText($("cpu-value"), `${fmtNumber(cpu.percent)} %`);
  $("cpu-bar").style.width = `${cpu.percent}%`;
  setLevel($("card-cpu"), level(cpu.percent, 70, 90));
  setSpark($("cpu-spark"), renderSpark($("cpu-spark"), seriesWithNow("cpu", cpu.percent)));
  const load = (cpu.load_avg || []).map((v) => fmtNumber(v, 2)).join(" / ");
  patch($("cpu-meta"), `${esc(cpuName(cpu.model))} · ${cpu.physical_cores || "?"} ядра / ${cpu.cores} потоков<br>${statsLine("cpu", " %")}${load ? `<br>Load avg: ${load}` : ""}`);

  const mem = data.memory || {};
  setText($("ram-value"), `${fmtNumber(mem.percent)} %`);
  $("ram-bar").style.width = `${mem.percent}%`;
  setLevel($("card-ram"), level(mem.percent, 75, 90));
  setSpark($("ram-spark"), renderSpark($("ram-spark"), seriesWithNow("ram", mem.percent)));
  patch($("ram-meta"), `${fmtBytes(mem.used)} из ${fmtBytes(mem.total)} · доступно ${fmtBytes(mem.available)}<br>${statsLine("ram", " %")}`);

  const temp = data.temperature;
  if (temp) {
    setText($("temp-value"), `${fmtNumber(temp.celsius)} °C`);
    $("temp-bar").style.width = `${Math.min(temp.celsius, 100)}%`;
    setLevel($("card-temp"), level(temp.celsius, 70, 85));
    setSpark($("temp-spark"), renderSpark($("temp-spark"), seriesWithNow("temp", temp.celsius), 20, 100));
    const cores = (temp.cores || []).map((c, i) => `<span title="Ядро ${i}">${Math.round(c)}°</span>`).join("");
    const extra = [
      temp.board != null ? `плата ${fmtNumber(temp.board)} °C` : "",
      temp.crit ? `предел ${Math.round(temp.crit)} °C` : "",
    ].filter(Boolean).join(" · ");
    patch($("temp-meta"),
      `${temp.is_cpu ? esc(cpuName(temp.label)) : `Датчик ${esc(temp.label)}`}${extra ? ` · ${extra}` : ""}` +
      `<br>${statsLine("temp", " °C")}` +
      (cores ? `<div class="cores" title="Температура по ядрам">${cores}</div>` : ""));
  } else {
    setText($("temp-value"), "н/д");
    setText($("temp-meta"), "Датчики температуры не найдены");
  }

  const net = data.network || {};
  patch($("net-value"), `<span class="rx">↓ ${fmtRate(net.rx)}</span><span class="tx">↑ ${fmtRate(net.tx)}</span>`);
  const rx = seriesWithNow("rx", net.rx);
  const tx = seriesWithNow("tx", net.tx);
  const maxNet = Math.max(1, ...rx.filter((v) => v != null), ...tx.filter((v) => v != null));
  const netSvg = $("net-spark");
  setSpark(netSvg, (renderSpark(netSvg, rx, 0, maxNet) || "") + (renderSpark(netSvg, tx, 0, maxNet, "tx") || ""));
  const link = net.link_mbit ? ` · ${net.link_mbit >= 1000 ? `${net.link_mbit / 1000} Гбит/с` : `${net.link_mbit} Мбит/с`}` : "";
  setText($("net-hint"), `${net.interface || "eno1"}${link}`);
  const vpn = net.vpn || {};
  patch($("net-meta"), `Ср. ↓ <b>${fmtRate(state.history?.stats?.rx?.avg)}</b> · ↑ <b>${fmtRate(state.history?.stats?.tx?.avg)}</b>` +
    `<br>Пик ↓ ${fmtRate(state.history?.stats?.rx?.max)} · ↑ ${fmtRate(state.history?.stats?.tx?.max)}` +
    (vpn.rx != null ? `<br>Из них VPN ↓ <b>${fmtRate(vpn.rx)}</b> · ↑ <b>${fmtRate(vpn.tx)}</b>` : ""));
  renderSpeedtest(data.speedtest || {});

  const uptime = data.uptime || {};
  setText($("uptime-value"), fmtDuration(uptime.seconds));
  const bootDate = new Date((data.timestamp - uptime.seconds) * 1000);
  setText($("uptime-meta"), `Запущен ${fmtDate(bootDate)}`);
}

function renderSpeedtest(st) {
  const ok = st.last_ok;
  const last = st.last;
  const btn = $("inet-run");
  btn.disabled = !!st.running;
  setText(btn, st.running ? "Идёт замер…" : "Замерить");
  if (ok) {
    patch($("inet-value"), `<span class="rx">↓ ${fmtRate(ok.down_bps / 8)}</span><span class="tx">↑ ${fmtRate(ok.up_bps / 8)}</span>`);
    setText($("inet-hint"), ok.colo ? `узел ${ok.colo}` : "Cloudflare");
    const hist = st.history || [];
    const max = Math.max(1, ...hist.map((r) => Math.max(r[1], r[2])));
    const svg = $("inet-spark");
    setSpark(svg, hist.length > 1 ? (renderSpark(svg, hist.map((r) => r[1]), 0, max) || "") + (renderSpark(svg, hist.map((r) => r[2]), 0, max, "tx") || "") : "");
  } else {
    setText($("inet-value"), st.running ? "замер…" : "—");
  }
  const every = st.interval ? `каждые ${Math.round(st.interval / 3600)} ч` : "";
  const failed = last && last.error ? `<br><span class="is-bad">Последний замер не удался: нет связи</span>` : "";
  patch($("inet-meta"), ok
    ? `Пинг <b>${fmtNumber(ok.ping_ms)} мс</b> · джиттер ${fmtNumber(ok.jitter_ms)} мс<br>Замер ${fmtAgo(ok.ts)} · ${every}${failed}`
    : `Замеров ещё не было · ${every}${failed}`);
}

function renderDisks(data) {
  const disks = [];
  if (data.disk && data.disk.total) disks.push({ ...data.disk, title: "Системный диск" });
  for (const disk of data.storage_disks || []) {
    disks.push({ ...disk, title: `Диск ${disk.mount}` });
  }

  const html = disks.map((disk) => {
    const smart = disk.smart || {};
    const smartBad = smart.healthy === false;
    const lvl = smartBad ? "lvl-crit" : level(disk.percent, 80, 90);
    const nominal = disk.nominal_total ? ` · ${fmtBytes(disk.nominal_total)}` : "";
    const health = smart.healthy == null ? "" :
      `<span class="badge badge--${smartBad ? "bad" : "ok"}" title="Самодиагностика диска">${smartBad ? "SMART: ошибка" : "SMART в норме"}</span>`;
    const facts = [
      smart.temperature != null ? `${Math.round(smart.temperature)} °C` : "",
      smart.power_on_hours ? `наработка ${fmtDuration(smart.power_on_hours * 3600).replace(/ \d+ ч$/, "")} (${Math.round(smart.power_on_hours).toLocaleString("ru-RU")} ч)` : "",
    ].filter(Boolean).join(" · ");
    return `
      <article class="card ${lvl}">
        <div class="card__head">
          <span class="card__label">${esc(disk.title)}</span>
          <span class="card__tag" title="Устройство">${esc(disk.device)}</span>
        </div>
        <div class="card__value">${fmtNumber(disk.percent)} %</div>
        <div class="bar"><div class="bar__fill" style="width:${Number(disk.percent) || 0}%"></div></div>
        <p class="card__meta">Свободно <b>${fmtBytes(disk.free)}</b> из ${fmtBytes(disk.total)}<br>${esc(disk.model)}${nominal}</p>
        <div class="card__stats">${health}${facts ? `<span>${facts}</span>` : ""}</div>
      </article>`;
  }).join("");

  patch($("disks"), html || '<p class="muted">Диски не найдены</p>');
}

/* ---------- Docker ---------- */

const STACK_STATES = {
  running: { label: "Работает", cls: "running" },
  partial: { label: "Меняет состояние", cls: "partial" },
  stopped: { label: "Остановлен", cls: "stopped" },
  mixed: { label: "Часть контейнеров остановлена", cls: "mixed" },
  unhealthy: { label: "Проверка здоровья не пройдена", cls: "unhealthy" },
};

const CONTAINER_STATES = {
  running: ["Работает", "ok"],
  exited: ["Остановлен", "off"],
  created: ["Создан", "off"],
  paused: ["Приостановлен", "warn"],
  restarting: ["Перезапускается", "warn"],
  removing: ["Удаляется", "warn"],
  dead: ["Сбой", "bad"],
};

const HEALTH_STATES = {
  healthy: ["в норме", "ok"],
  unhealthy: ["ошибка", "bad"],
  starting: ["проверяется", "warn"],
};

const ICONS = {
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
};

const stackKey = (s) => (s.kind === "compose" ? `compose:${s.project}` : `${s.kind}:${s.name}`);

/** Сведения о сервисе: по имени стека, затем по любому его контейнеру. */
function stackInsight(s, data) {
  const all = data?.insights || {};
  if (all[s.name]) return all[s.name];
  for (const name of s.container_names || []) {
    if (all[name]) return all[name];
  }
  return null;
}

/** Состояние стека с учётом «выключен — и это нормально». */
function stackState(s, insight, busy) {
  if (busy) return { label: "Выполняется операция", cls: "busy" };
  if (s.status === "stopped" && insight?.expected_stopped) {
    return { label: s.name === "clamav" ? "Запускается по расписанию" : "Выключен", cls: "idle", idle: true };
  }
  return STACK_STATES[s.status] || { label: "Неизвестно", cls: "stopped" };
}

function renderInsightLine(insight) {
  if (!insight?.summary) return "";
  return `<div class="insight insight--${esc(insight.level)}" title="${esc(insight.summary)}"><span>${esc(insight.summary)}</span></div>`;
}

function renderInsightCard(insight) {
  if (!insight || (!insight.facts?.length && !insight.items?.length)) return "";
  const levelText = { ok: "Всё в порядке", warn: "Есть замечания", bad: "Проблема", idle: "Выключен" }[insight.level] || "";
  const badge = { ok: "ok", warn: "warn", bad: "bad", idle: "off" }[insight.level] || "off";
  const facts = (insight.facts || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const items = insight.items?.length ? `<div class="dcard__items">${insight.items.map((i) => `<span>${esc(i)}</span>`).join("")}</div>` : "";
  return `
    <article class="dcard dcard--wide dcard--insight is-${esc(insight.level)}">
      <div class="dcard__head">
        <div class="dcard__title"><span>${esc(insight.summary)}</span></div>
        <span class="badge badge--${badge}">${levelText}</span>
      </div>
      ${facts ? `<dl class="kv">${facts}</dl>` : ""}
      ${items}
    </article>`;
}

function renderLink(s) {
  if (s.link_url) {
    const url = localizeUrl(s.link_url);
    const label = s.link_label === s.link_url ? url.replace(/^https?:\/\//, "") : s.link_label;
    return `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  }
  if (s.link_label) {
    return `<code class="link" data-copy="${esc(s.link_label)}" title="Нажмите, чтобы скопировать">${esc(s.link_label)}</code>`;
  }
  return '<span class="muted">—</span>';
}

function renderPorts(ports) {
  const items = String(ports || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!items.length) return '<span class="muted">—</span>';
  return `<div class="ports">${items.map((item) => {
    const [port, proto = "tcp"] = item.split("/");
    return `<span class="port" data-copy="${esc(port)}" title="Скопировать порт">${esc(port)}<i>${esc(proto)}</i></span>`;
  }).join("")}</div>`;
}

function renderStackRow(s, insight) {
  const key = stackKey(s);
  const busy = state.busy.has(key) || state.pending.has(key);
  const st = stackState(s, insight, busy);
  const isHost = s.kind === "host";
  const allRunning = Number(s.running_count) === Number(s.container_count);
  const locked = busy || s.status === "partial";
  const open = state.expanded.has(key);
  const name = s.name || s.project || "Без имени";
  const bad = ["mixed", "unhealthy"].includes(s.status);

  const services = s.container_count > 1 ? `<div class="stack__services">${esc((s.services || []).join(", "))}</div>` : "";

  const toggleTitle = allRunning ? `Выключить ${name}` : `Включить ${name}`;
  const data = `data-key="${esc(key)}" data-kind="${esc(s.kind)}" data-name="${esc(name)}" data-project="${esc(s.project || "")}"`;

  return `
    <div class="stack__row">
      <div class="stack__cell stack__cell--name">
        <div class="stack__name">
          <span class="dot dot--${st.cls}" title="${esc(st.label)}"></span>
          <b data-copy="${esc(name)}" title="${esc(name)}">${esc(name)}</b>
        </div>
        ${s.description ? `<div class="stack__desc">${esc(s.description)}</div>` : ""}
        ${renderInsightLine(insight)}
      </div>
      <div class="stack__cell stack__cell--count">
        <span class="stack__label">Контейнеры</span>
        <div>
          <div class="stack__count">${isHost ? '<span class="kind-tag">служба</span>' : `<span class="${bad ? "is-bad" : ""}">${s.running_count}/${s.container_count}</span>`} <span class="stack__state ${bad ? "is-bad" : ""}">· ${esc(st.label.toLowerCase())}</span></div>
          ${services}
        </div>
      </div>
      <div class="stack__cell stack__cell--link"><span class="stack__label">Адрес</span>${renderLink(s)}</div>
      <div class="stack__cell stack__cell--ports"><span class="stack__label">Порты</span>${renderPorts(s.ports)}</div>
      <div class="stack__actions">
        ${isHost ? "" : `<button type="button" class="icon-btn ${allRunning ? "icon-btn--stop" : "icon-btn--start"} ${busy ? "is-busy" : ""}"
          data-action="toggle" ${data} title="${esc(toggleTitle)}" aria-label="${esc(toggleTitle)}" ${locked ? "disabled" : ""}>
          ${allRunning ? ICONS.power : ICONS.play}
        </button>
        <button type="button" class="icon-btn" data-action="restart" ${data}
          title="Перезапустить ${esc(name)}" aria-label="Перезапустить ${esc(name)}" ${locked ? "disabled" : ""}>
          ${ICONS.restart}
        </button>`}
        <button type="button" class="icon-btn icon-btn--details" data-action="details" data-key="${esc(key)}"
          title="${open ? "Скрыть подробности" : "Подробнее"}" aria-expanded="${open}">
          ${ICONS.chevron}
        </button>
      </div>
    </div>`;
}

function renderContainerCard(c) {
  const [stateLabel, stateCls] = CONTAINER_STATES[c.status] || [c.status || "неизвестно", "off"];
  const health = HEALTH_STATES[c.health];
  return `
    <article class="dcard">
      <div class="dcard__head">
        <div class="dcard__title"><span data-copy="${esc(c.name)}">${esc(c.name)}</span></div>
        <span class="badge badge--${stateCls}">${esc(stateLabel)}</span>
      </div>
      <dl class="kv">
        <dt>Образ</dt><dd><code data-copy="${esc(c.image)}">${esc(c.image || "—")}</code></dd>
        <dt>Работает</dt><dd>${c.status === "running" ? esc(fmtDuration(c.uptime_seconds)) : "—"}</dd>
        <dt>Healthcheck</dt><dd>${health ? `<span class="badge badge--${health[1]}">${health[0]}</span>` : '<span class="muted">не настроен</span>'}</dd>
        <dt>ID</dt><dd><code data-copy="${esc(c.id)}">${esc(c.id)}</code></dd>
        <dt>Порты</dt><dd>${esc(c.ports || "—")}</dd>
        ${c.restart_count ? `<dt>Перезапусков</dt><dd><span class="badge badge--warn">${esc(c.restart_count)}</span> (автоматических)</dd>` : ""}
        ${c.status !== "running" && c.exit_code != null && c.exit_code !== 0 ? `<dt>Код выхода</dt><dd>${esc(c.exit_code)}</dd>` : ""}
      </dl>
    </article>`;
}

function renderPlexCard(plex) {
  if (!plex || !plex.found) {
    return '<article class="dcard dcard--wide"><p class="muted">Plex Media Server не найден</p></article>';
  }
  const running = plex.status === "running";
  const web = plex.web || {};
  const webUrl = localizeUrl(`http://${state.serverIp}:${web.port || 32400}/web`);
  return `
    <article class="dcard dcard--wide">
      <div class="dcard__head">
        <div class="dcard__title"><span>Plex Media Server</span></div>
        <span class="badge badge--${running ? "ok" : "off"}">${running ? "Работает" : "Остановлен"}</span>
      </div>
      <dl class="kv">
        <dt>Источник</dt><dd>${plex.source === "systemd" ? `служба ${esc(plex.service)}` : `контейнер ${esc(plex.service)}`}</dd>
        <dt>Работает</dt><dd>${running ? esc(fmtDuration(plex.uptime?.seconds)) : "—"}</dd>
        <dt>Веб-интерфейс</dt><dd>${web.available
          ? `<span class="badge badge--ok">доступен</span> <a class="link" href="${esc(webUrl)}" target="_blank" rel="noopener noreferrer">открыть</a>`
          : '<span class="badge badge--bad">недоступен</span>'}</dd>
        ${plex.pid ? `<dt>PID</dt><dd>${esc(plex.pid)}</dd>` : ""}
      </dl>
    </article>`;
}

function renderAmneziaCard(vpn) {
  if (!vpn || !vpn.available) {
    return `<article class="dcard dcard--wide"><p class="muted">Amnezia VPN недоступна: ${esc(vpn?.error || "нет данных")}</p></article>`;
  }
  const peers = vpn.peers || [];
  const rows = peers.map((p) => {
    const status = p.online ? ["running", "активен"] : p.handshake ? ["stopped", "нет активности"] : ["stopped", "не подключался"];
    const key = p.public_key || "";
    return `
      <div class="peer">
        <div class="peer__name">
          <span class="dot dot--${status[0]}" title="${status[1]}"></span>
          <div><b>${esc(p.name)}</b><small><code data-copy="${esc(key)}" title="Скопировать публичный ключ">${esc(key.slice(0, 12))}…</code></small></div>
        </div>
        <div>${esc(p.ip)}<small>${esc(p.endpoint || "endpoint неизвестен")}</small></div>
        <div>${esc(status[1])}<small>${esc(fmtAgo(p.handshake))}</small></div>
        <div><span class="rx">↓ ${fmtBytes(p.received_bytes)}</span> · <span class="tx">↑ ${fmtBytes(p.sent_bytes)}</span></div>
      </div>`;
  }).join("");

  return `
    <article class="dcard dcard--wide">
      <div class="dcard__head">
        <div class="dcard__title"><span>VPN-клиенты</span></div>
        <span class="dcard__sub">${vpn.online_count ?? peers.filter((p) => p.online).length} из ${vpn.count} активны · ${esc(vpn.interface)} · ${esc(vpn.port)}/udp · работает ${esc(fmtDuration(vpn.uptime?.seconds))}</span>
      </div>
      <div class="peers">${rows || '<p class="muted">Клиенты не настроены</p>'}</div>
    </article>`;
}

function renderStackDetails(s, containers, data, insight) {
  const names = new Set(s.container_names || []);
  const members = containers.filter((c) => names.has(c.name));
  const cards = [renderInsightCard(insight)];
  if (s.kind === "host" && s.name === "plex") cards.push(renderPlexCard(data.plex));
  if (members.some((c) => c.name === "amnezia-awg2")) cards.push(renderAmneziaCard(data.amnezia));
  cards.push(...members.map(renderContainerCard));
  return `<div class="details-grid">${cards.join("") || '<p class="muted">Подробности недоступны</p>'}</div>`;
}

function resolvePending(stacks) {
  const now = Date.now();
  for (const s of stacks) {
    const key = stackKey(s);
    const p = state.pending.get(key);
    if (!p) continue;
    const elapsed = now - p.startedAt;
    const verb = { start: "Запуск", stop: "Остановка", restart: "Перезапуск" }[p.action];

    if (s.status === p.targetStatus && elapsed > (p.action === "restart" ? 5000 : 1500)) {
      state.pending.delete(key);
      toast(`${verb} выполнен: ${p.name}`);
    } else if (
      elapsed > 600000 ||
      (p.action !== "stop" && elapsed > 30000 && ["stopped", "unhealthy", "mixed"].includes(s.status))
    ) {
      state.pending.delete(key);
      toast(`${verb} не подтвердился: ${p.name}`, false);
    }
  }
}

function renderDocker(data) {
  const docker = data.docker || {};
  const list = $("stacks");
  const errorEl = $("docker-error");

  if (!docker.available) {
    patch(list, '<p class="muted" style="padding:16px">Docker недоступен</p>');
    state.stackOrder = "";
    patch($("docker-summary"), "");
    errorEl.hidden = false;
    errorEl.textContent = docker.error || "Не удалось подключиться к Docker";
    return;
  }
  errorEl.hidden = true;

  const stacks = Array.isArray(docker.stacks) ? docker.stacks : [];
  const containers = Array.isArray(docker.containers) ? docker.containers : [];
  resolvePending(stacks);

  // Сводка: «требуют внимания» — сбой контейнера или проблема по сведениям сервиса.
  const insightsBy = new Map(stacks.map((s) => [stackKey(s), stackInsight(s, data)]));
  let running = 0, idle = 0, stopped = 0, attention = 0;
  for (const s of stacks) {
    const ins = insightsBy.get(stackKey(s));
    if (s.status === "running") running += 1;
    else if (s.status === "stopped" && ins?.expected_stopped) idle += 1;
    else if (s.status === "stopped") stopped += 1;
    if (["mixed", "unhealthy"].includes(s.status) || ["bad", "warn"].includes(ins?.level)) attention += 1;
  }
  patch($("docker-summary"), [
    `<span class="chip chip--ok">${running} ${plural(running, ["работает", "работают", "работают"])}</span>`,
    idle ? `<span class="chip chip--off" title="Выключены намеренно или запускаются по расписанию">${idle} в ожидании</span>` : "",
    stopped ? `<span class="chip chip--off">${stopped} ${plural(stopped, ["остановлен", "остановлены", "остановлены"])}</span>` : "",
    attention ? `<span class="chip chip--bad">${attention} ${plural(attention, ["требует", "требуют", "требуют"])} внимания</span>` : "",
  ].join(""));

  if (!stacks.length) {
    patch(list, '<p class="muted" style="padding:16px">Контейнеры не найдены</p>');
    state.stackOrder = "";
    return;
  }

  // Каркас строк пересоздаём только при изменении состава стеков.
  const order = stacks.map(stackKey).join("|");
  if (order !== state.stackOrder) {
    list.innerHTML = stacks.map((s) => `
      <div class="stack" data-stack="${esc(stackKey(s))}">
        <div class="stack__main"></div>
        <div class="stack__details" hidden></div>
      </div>`).join("");
    list._html = null;
    state.stackOrder = order;
  }

  const elements = list.querySelectorAll(":scope > .stack");
  stacks.forEach((s, i) => {
    const el = elements[i];
    const key = stackKey(s);
    const open = state.expanded.has(key);
    el.classList.toggle("is-open", open);
    const insight = insightsBy.get(key);
    patch(el.querySelector(".stack__main"), renderStackRow(s, insight));
    const details = el.querySelector(".stack__details");
    details.hidden = !open;
    if (open) patch(details, renderStackDetails(s, containers, data, insight));
  });
}

/* ---------- Загрузка данных ---------- */

/** Перезапускает CSS-анимацию: класс снимается и ставится заново. */
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function setConnection(ok) {
  const conn = $("conn");
  conn.classList.toggle("is-ok", ok);
  conn.classList.toggle("is-error", !ok);
  conn.classList.remove("is-late");
  $("dashboard").classList.toggle("is-stale", !ok && state.lastOk !== null);
  if (ok) {
    // Живой индикатор: волна от точки и полоска до следующего обновления
    replay(conn, "is-tick");
    replay($("stacks"), "is-tick");
  }
  renderConnText();
}

function renderConnText() {
  const conn = $("conn");
  if (!state.lastOk) return setText($("conn-text"), conn.classList.contains("is-error") ? "Нет связи с сервером" : "Подключение…");
  const ago = Math.round((Date.now() - state.lastOk) / 1000);
  const time = state.lastOk.toLocaleTimeString("ru-RU");
  if (conn.classList.contains("is-error")) return setText($("conn-text"), `Нет связи · данные на ${time}`);
  // Ответ задерживается дольше трёх циклов — сервер жив, но данные не свежие
  const late = ago * 1000 > REFRESH_INTERVAL * 3;
  conn.classList.toggle("is-late", late);
  setText($("conn-text"), late ? `Задержка · данные ${fmtAgoShort(ago)}` : `Онлайн · ${ago < 2 ? "только что" : fmtAgoShort(ago)}`);
  conn.title = `Последнее обновление: ${time}. Данные обновляются каждые ${REFRESH_INTERVAL / 1000} с.`;
}

function fmtAgoShort(sec) {
  return sec < 60 ? `${sec} с назад` : `${Math.floor(sec / 60)} мин назад`;
}

setInterval(() => { if (!document.hidden) renderConnText(); }, 1000);

async function fetchMetrics() {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const res = await fetch("/api/metrics", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastData = data;
    state.serverIp = data.server_ip || state.serverIp;
    state.lastOk = new Date();
    document.body.classList.remove("is-loading");
    setText($("host-name"), `${data.hostname || ""}${data.server_ip ? ` · ${data.server_ip}` : ""}`);
    renderSystem(data);
    renderDisks(data);
    renderDocker(data);
    setConnection(true);
  } catch (err) {
    console.error("Metrics fetch error:", err);
    setConnection(false);
  } finally {
    state.inFlight = false;
  }
}

function startPolling() {
  clearInterval(state.timer);
  clearInterval(state.historyTimer);
  fetchMetrics();
  fetchHistory();
  state.timer = setInterval(fetchMetrics, REFRESH_INTERVAL);
  state.historyTimer = setInterval(fetchHistory, HISTORY_REFRESH);
}

// В фоновой вкладке не опрашиваем сервер, при возвращении — сразу обновляем.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(state.timer);
    clearInterval(state.historyTimer);
  }
  else startPolling();
});

/* ---------- Уведомления и копирование ---------- */

let toastTimer = null;
function toast(message, ok = true) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("is-error", !ok);
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), ok ? 3000 : 5000);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // http-страница в LAN: clipboard API недоступен, используем старый способ.
    const area = document.createElement("textarea");
    area.value = value;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) return toast("Не удалось скопировать", false);
  }
  toast(`Скопировано: ${value}`);
}

/* ---------- Действия ---------- */

async function dockerAction(button) {
  const key = button.dataset.key;
  if (state.busy.has(key) || state.pending.has(key)) return;
  const restarting = button.dataset.action === "restart";
  state.busy.add(key);
  if (lastData) renderDocker(lastData);

  try {
    const res = await fetch("/api/docker/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...API_HEADERS },
      body: JSON.stringify({
        kind: button.dataset.kind,
        name: button.dataset.name,
        project: button.dataset.project,
        action: restarting ? "restart" : "toggle",
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`);
    const action = result.action || "start";
    state.pending.set(key, {
      targetStatus: result.target_status || (action === "stop" ? "stopped" : "running"),
      action,
      name: button.dataset.name,
      startedAt: Date.now(),
    });
    toast(result.message || `${button.dataset.name}: команда отправлена`);
  } catch (err) {
    toast(err.message || "Не удалось изменить состояние", false);
  } finally {
    state.busy.delete(key);
    await fetchMetrics();
  }
}

$("stacks").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) {
    if (button.disabled) return;
    if (button.dataset.action === "details") {
      const key = button.dataset.key;
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      if (lastData) renderDocker(lastData);
    } else {
      dockerAction(button);
    }
    return;
  }

  if (event.target.closest("a")) return;
  const copyEl = event.target.closest("[data-copy]");
  if (copyEl && copyEl.dataset.copy && copyEl.dataset.copy !== "—") {
    // Не мешаем выделять текст мышью.
    if (String(window.getSelection())) return;
    copyText(copyEl.dataset.copy);
  }
});

$("inet-run").addEventListener("click", async () => {
  const btn = $("inet-run");
  btn.disabled = true;
  setText(btn, "Идёт замер…");
  try {
    const res = await fetch("/api/speedtest/run", { method: "POST", headers: API_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast("Замер запущен, займёт около 20 секунд");
  } catch (err) {
    toast("Не удалось запустить замер", false);
    btn.disabled = false;
  }
});

$("update-project").addEventListener("click", async () => {
  const button = $("update-project");
  button.disabled = true;
  button.textContent = "Запуск…";
  try {
    const res = await fetch("/api/actions/update", { method: "POST", headers: API_HEADERS });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    if (data.status !== "started") throw new Error(data.message || "Обновление не запущено");
    location.href = "/update-status";
  } catch (err) {
    toast(`Не удалось запустить обновление: ${err.message}`, false);
    button.disabled = false;
    button.textContent = "Обновить проект";
  }
});

$("pricefinder-link").href = `${location.protocol}//${location.hostname}:8082`;
$("textcheck-link").href = `${location.protocol}//${location.hostname}:8084`;

document.querySelectorAll(".range__btn[data-range]").forEach((btn) => {
  btn.addEventListener("click", () => setRange(btn.dataset.range));
});
loadRange();
setRange(state.range);
startPolling();


/* ---------- Графики Grafana (встроенные дашборды) ---------- */

const GRAFANA_PORT = 3000;
// Высота дашборда на широком экране; на телефоне Grafana ставит панели
// в одну колонку, поэтому там окно фиксированной высоты с прокруткой.
const DASHBOARDS = {
  server: { uid: "homelab-server", height: 1640 },
  containers: { uid: "homelab-containers", height: 1060 },
  services: { uid: "homelab-services", height: 1180, minRange: "24h" },
  logs: { uid: "homelab-logs", height: 1040, maxRange: "6h" },
};
const RANGE_ORDER = ["1h", "6h", "24h"];

const charts = { dash: "server", loaded: false };

function grafanaUrl(dash, embed) {
  const cfg = DASHBOARDS[dash];
  let range = state.range;
  if (cfg.minRange && RANGE_ORDER.indexOf(range) < RANGE_ORDER.indexOf(cfg.minRange)) range = cfg.minRange;
  if (cfg.maxRange && RANGE_ORDER.indexOf(range) > RANGE_ORDER.indexOf(cfg.maxRange)) range = cfg.maxRange;
  const base = `${location.protocol}//${location.hostname}:${GRAFANA_PORT}/d/${cfg.uid}`;
  const params = new URLSearchParams({ from: `now-${range}`, to: "now", theme: "dark" });
  if (embed) params.set("kiosk", "");
  return `${base}?${params.toString().replace("kiosk=", "kiosk")}`;
}

function renderCharts() {
  const frame = document.getElementById("charts-frame");
  const open = document.getElementById("charts-open");
  if (!frame) return;
  open.href = grafanaUrl(charts.dash, false);
  if (!charts.loaded) return;
  const mobile = window.matchMedia("(max-width: 768px)").matches;
  let iframe = frame.querySelector("iframe");
  if (!iframe) {
    frame.innerHTML = "";
    iframe = document.createElement("iframe");
    iframe.title = "Графики Grafana";
    frame.appendChild(iframe);
  }
  iframe.style.height = mobile ? "80vh" : `${DASHBOARDS[charts.dash].height}px`;
  const url = grafanaUrl(charts.dash, true);
  if (iframe.dataset.src !== url) {
    iframe.dataset.src = url;
    iframe.src = url;
  }
}

function setupCharts() {
  const frame = document.getElementById("charts-frame");
  if (!frame) return;
  try {
    const saved = localStorage.getItem("sm-dash");
    if (saved && DASHBOARDS[saved]) charts.dash = saved;
  } catch { /* не критично */ }

  const tabs = document.querySelectorAll("#chart-tabs [data-dash]");
  const markTabs = () => tabs.forEach((b) => {
    const active = b.dataset.dash === charts.dash;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
  tabs.forEach((btn) => btn.addEventListener("click", () => {
    charts.dash = btn.dataset.dash;
    try { localStorage.setItem("sm-dash", charts.dash); } catch { /* не критично */ }
    charts.loaded = true;
    markTabs();
    renderCharts();
  }));
  markTabs();

  // Grafana тяжёлая — грузим её, только когда раздел появился на экране.
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      charts.loaded = true;
      renderCharts();
      io.disconnect();
    }
  }, { rootMargin: "300px" });
  io.observe(frame);
  renderCharts();

  // Переключатель периода наверху страницы действует и на графики.
  document.querySelectorAll(".range__btn[data-range]").forEach((b) =>
    b.addEventListener("click", () => setTimeout(renderCharts, 0)));
}

setupCharts();
