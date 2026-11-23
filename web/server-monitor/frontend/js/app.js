"use strict";

/* =========================================================
   Server Monitor — фронтенд
   ========================================================= */

const REFRESH_INTERVAL = 5000;
const HISTORY_POINTS = 120; // 120 × 5 с = 10 минут
const API_HEADERS = { "X-Requested-With": "server-monitor" };

const $ = (id) => document.getElementById(id);

const state = {
  history: { cpu: [], ram: [], temp: [] },
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

/* ---------- Мини-графики ---------- */

function pushHistory(key, value) {
  const list = state.history[key];
  list.push(Number(value) || 0);
  if (list.length > HISTORY_POINTS) list.shift();
}

function renderSpark(svg, values, min = 0, max = 100) {
  if (!svg) return;
  if (values.length < 2) {
    svg.innerHTML = "";
    return;
  }
  const n = HISTORY_POINTS - 1;
  const offset = n - (values.length - 1);
  const y = (v) => 28 - ((Math.min(Math.max(v, min), max) - min) / (max - min)) * 26 - 1;
  const points = values.map((v, i) => `${(((offset + i) / n) * 100).toFixed(2)},${y(v).toFixed(2)}`);
  const firstX = ((offset / n) * 100).toFixed(2);
  svg.innerHTML =
    `<path class="area" d="M${firstX},28 L${points.join(" L")} L100,28 Z"></path>` +
    `<path class="line" d="M${points.join(" L")}"></path>`;
}

/* ---------- Системные карточки ---------- */

function renderSystem(data) {
  const cpu = data.cpu || {};
  pushHistory("cpu", cpu.percent);
  setText($("cpu-value"), `${fmtNumber(cpu.percent)} %`);
  $("cpu-bar").style.width = `${cpu.percent}%`;
  setLevel($("card-cpu"), level(cpu.percent, 70, 90));
  renderSpark($("cpu-spark"), state.history.cpu);
  const avg = state.history.cpu.reduce((a, b) => a + b, 0) / state.history.cpu.length;
  setText($("cpu-meta"), `${(cpu.model || "CPU").replace(/\s+CPU\s+@.*/, "").replace(/\(R\)|\(TM\)/g, "")} · ${cpu.cores} потоков\nСреднее за период: ${fmtNumber(avg)} %`);

  const mem = data.memory || {};
  pushHistory("ram", mem.percent);
  setText($("ram-value"), `${fmtNumber(mem.percent)} %`);
  $("ram-bar").style.width = `${mem.percent}%`;
  setLevel($("card-ram"), level(mem.percent, 75, 90));
  renderSpark($("ram-spark"), state.history.ram);
  setText($("ram-meta"), `${fmtBytes(mem.used)} из ${fmtBytes(mem.total)}\nДоступно: ${fmtBytes(mem.available)}`);

  const temp = data.temperature;
  if (temp) {
    pushHistory("temp", temp.celsius);
    setText($("temp-value"), `${fmtNumber(temp.celsius)} °C`);
    $("temp-bar").style.width = `${Math.min(temp.celsius, 100)}%`;
    setLevel($("card-temp"), level(temp.celsius, 70, 85));
    renderSpark($("temp-spark"), state.history.temp, 20, 100);
    const others = (temp.zones || [])
      .filter((z) => z.label !== temp.label)
      .map((z) => z.celsius);
    const board = others.length ? `\nМатеринская плата: ${fmtNumber(Math.max(...others))} °C` : "";
    setText($("temp-meta"), `${temp.is_cpu ? "Процессор" : "Самый горячий датчик"} (${temp.label})${board}`);
  } else {
    setText($("temp-value"), "н/д");
    setText($("temp-meta"), "Датчики температуры не найдены");
  }

  const uptime = data.uptime || {};
  setText($("uptime-value"), fmtDuration(uptime.seconds));
  const bootDate = new Date((data.timestamp - uptime.seconds) * 1000);
  setText($("uptime-meta"), `Запущен ${fmtDate(bootDate)}`);
}

function renderDisks(data) {
  const disks = [];
  if (data.disk && data.disk.total) disks.push({ ...data.disk, title: "Системный диск" });
  for (const disk of data.storage_disks || []) {
    disks.push({ ...disk, title: `Диск ${disk.mount}` });
  }

  const html = disks.map((disk) => {
    const lvl = level(disk.percent, 80, 90);
    const nominal = disk.nominal_total ? ` · ${fmtBytes(disk.nominal_total)}` : "";
    return `
      <article class="card ${lvl}">
        <div class="card__head">
          <span class="card__label">${esc(disk.title)}</span>
          <span class="card__tag" title="Устройство">${esc(disk.device)}</span>
        </div>
        <div class="card__value">${fmtNumber(disk.percent)} %</div>
        <div class="bar"><div class="bar__fill" style="width:${Number(disk.percent) || 0}%"></div></div>
        <p class="card__meta">Свободно <b>${fmtBytes(disk.free)}</b> из ${fmtBytes(disk.total)}
${esc(disk.model)}${nominal}</p>
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

const stackKey = (s) => (s.kind === "compose" ? `compose:${s.project}` : `standalone:${s.name}`);

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

function renderStackRow(s) {
  const key = stackKey(s);
  const busy = state.busy.has(key) || state.pending.has(key);
  const st = busy ? { label: "Выполняется операция", cls: "busy" } : (STACK_STATES[s.status] || { label: "Неизвестно", cls: "stopped" });
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
      </div>
      <div class="stack__cell stack__cell--count">
        <span class="stack__label">Контейнеры</span>
        <div>
          <div class="stack__count"><span class="${bad ? "is-bad" : ""}">${s.running_count}/${s.container_count}</span> <span class="stack__state ${bad ? "is-bad" : ""}">· ${esc(st.label.toLowerCase())}</span></div>
          ${services}
        </div>
      </div>
      <div class="stack__cell stack__cell--link"><span class="stack__label">Адрес</span>${renderLink(s)}</div>
      <div class="stack__cell stack__cell--ports"><span class="stack__label">Порты</span>${renderPorts(s.ports)}</div>
      <div class="stack__actions">
        <button type="button" class="icon-btn ${allRunning ? "icon-btn--stop" : "icon-btn--start"} ${busy ? "is-busy" : ""}"
          data-action="toggle" ${data} title="${esc(toggleTitle)}" aria-label="${esc(toggleTitle)}" ${locked ? "disabled" : ""}>
          ${allRunning ? ICONS.power : ICONS.play}
        </button>
        <button type="button" class="icon-btn" data-action="restart" ${data}
          title="Перезапустить ${esc(name)}" aria-label="Перезапустить ${esc(name)}" ${locked ? "disabled" : ""}>
          ${ICONS.restart}
        </button>
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

function renderStackDetails(s, containers, data) {
  const names = new Set(s.container_names || []);
  const members = containers.filter((c) => names.has(c.name));
  const cards = members.map(renderContainerCard);
  if (members.some((c) => c.name === "amnezia-awg2")) cards.push(renderAmneziaCard(data.amnezia));
  if (members.some((c) => c.name.toLowerCase().includes("plex"))) cards.push(renderPlexCard(data.plex));
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

  // Сводка
  const running = stacks.filter((s) => s.status === "running").length;
  const stopped = stacks.filter((s) => s.status === "stopped").length;
  const problems = stacks.length - running - stopped;
  patch($("docker-summary"), [
    `<span class="chip chip--ok">${running} ${plural(running, ["работает", "работают", "работают"])}</span>`,
    stopped ? `<span class="chip chip--off">${stopped} ${plural(stopped, ["остановлен", "остановлены", "остановлены"])}</span>` : "",
    problems ? `<span class="chip chip--bad">${problems} ${plural(problems, ["требует", "требуют", "требуют"])} внимания</span>` : "",
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
    patch(el.querySelector(".stack__main"), renderStackRow(s));
    const details = el.querySelector(".stack__details");
    details.hidden = !open;
    if (open) patch(details, renderStackDetails(s, containers, data));
  });
}

/* ---------- Загрузка данных ---------- */

let lastData = null;

function setConnection(ok) {
  const conn = $("conn");
  conn.classList.toggle("is-ok", ok);
  conn.classList.toggle("is-error", !ok);
  $("dashboard").classList.toggle("is-stale", !ok && state.lastOk !== null);
  const time = state.lastOk ? state.lastOk.toLocaleTimeString("ru-RU") : "";
  setText($("conn-text"), ok ? `Онлайн · ${time}` : time ? `Нет связи · данные на ${time}` : "Нет связи с сервером");
}

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
  fetchMetrics();
  state.timer = setInterval(fetchMetrics, REFRESH_INTERVAL);
}

// В фоновой вкладке не опрашиваем сервер, при возвращении — сразу обновляем.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearInterval(state.timer);
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

startPolling();
