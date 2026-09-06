const REFRESH_INTERVAL = 3000;
const API_URL = "/api/metrics";
const UPDATE_API_URL = "/api/actions/update";

const $ = (id) => document.getElementById(id);

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function setProgressBar(barEl, percent) {
  barEl.style.width = `${percent}%`;
  barEl.classList.remove("progress__bar--warn", "progress__bar--danger");
  if (percent >= 90) {
    barEl.classList.add("progress__bar--danger");
  } else if (percent >= 70) {
    barEl.classList.add("progress__bar--warn");
  }
}

function diskMeta(disk) {
  const nominal = disk.nominal_total ? ` · ${formatBytes(disk.nominal_total)}` : "";
  return `${formatBytes(disk.used)} / ${formatBytes(disk.total)}\n${disk.model}${nominal}`;
}

function renderStorageDisks(disks) {
  const container = $("storage-disks");
  container.replaceChildren();

  for (const disk of disks) {
    const card = document.createElement("article");
    card.className = "metric-card";

    const header = document.createElement("div");
    header.className = "metric-card__header";
    const icon = document.createElement("span");
    icon.className = "metric-card__icon";
    icon.textContent = disk.device.toUpperCase();
    header.append(icon);

    const value = document.createElement("div");
    value.className = "metric-card__value";
    value.textContent = `${disk.percent}%`;

    const progress = document.createElement("div");
    progress.className = "progress";
    const bar = document.createElement("div");
    bar.className = "progress__bar";
    setProgressBar(bar, disk.percent);
    progress.append(bar);

    const meta = document.createElement("p");
    meta.className = "metric-card__meta";
    meta.textContent = diskMeta(disk);
    card.append(header, value, progress, meta);
    container.append(card);
  }
}

function statusBadgeClass(status) {
  const map = {
    running: "status-badge--running",
    exited: "status-badge--exited",
    stopped: "status-badge--stopped",
    paused: "status-badge--paused",
    restarting: "status-badge--restarting",
  };
  return map[status] || "";
}

function updateConnection(ok) {
  const dot = $("status-dot");
  const label = $("connection-status");
  dot.classList.toggle("status-dot--ok", ok);
  dot.classList.toggle("status-dot--error", !ok);
  label.textContent = ok ? "Онлайн" : "Ошибка подключения";
}

function renderPlex(plex) {
  const grid = $("plex-grid");
  const empty = $("plex-empty");
  const badge = $("plex-status-badge");

  const web = plex.web || {};
  $("plex-port").textContent = web.port || 32400;

  if (!plex.found) {
    grid.hidden = true;
    empty.hidden = false;
    badge.textContent = "не найден";
    badge.className = "status-badge status-badge--exited";
    return;
  }

  grid.hidden = false;
  empty.hidden = true;

  const status = plex.status || "stopped";
  const isRunning = status === "running";

  badge.textContent = status;
  badge.className = `status-badge ${statusBadgeClass(isRunning ? "running" : "stopped")}`;

  $("plex-service").textContent = plex.service || "plexmediaserver.service";
  $("plex-status").textContent = isRunning ? "running" : "stopped";
  $("plex-uptime").textContent = isRunning ? plex.uptime.formatted : "—";

  if (web.available) {
    $("plex-web").innerHTML = '<span class="plex-web--ok">Доступен</span>';
  } else {
    $("plex-web").innerHTML = '<span class="plex-web--fail">Недоступен</span>';
  }

  const pid = plex.systemd?.main_pid;
  $("plex-pid").textContent = pid && pid > 0 ? pid : "—";
}

function renderWireguard(wg) {
  const badge = $("wireguard-status");
  const count = $("wireguard-count");
  const tbody = $("wireguard-tbody");


  if (!wg || !wg.available) {
    badge.textContent = "ошибка";
    badge.className = "status-badge status-badge--exited";

    count.textContent = "—";

    tbody.innerHTML = `
      <tr>
        <td colspan="4">
          WireGuard недоступен
        </td>
      </tr>
    `;
    return;
  }


  badge.textContent = "running";
  badge.className = "status-badge status-badge--running";


  count.textContent = wg.count;


  if (!wg.peers.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4">
          Нет подключенных клиентов
        </td>
      </tr>
    `;
    return;
  }


tbody.innerHTML = wg.peers.map(peer => {

  const shortKey =
    peer.public_key
      ? peer.public_key.substring(0, 12) + "..."
      : "—";

  const name = peer.name || "peer";

  const status = peer.online
    ? '<span class="wg-online">● ONLINE</span>'
    : '<span class="wg-offline">● OFFLINE</span>';

  return `
    <tr>
      <td>
        <b>${name}</b><br>
        <code>${shortKey}</code>
      </td>

      <td>
        ${status}
        <br>
        <small>
          ${peer.endpoint || "Нет подключения"}
        </small>
        <br>
        <small>
          ${peer.ip || ""}
        </small>
      </td>

      <td>
        ${
          peer.handshake && peer.handshake !== 0
            ? formatHandshake(peer.handshake)
            : "—"
        }
      </td>

      <td>
        <span class="wg-rx">
          ↓ RX ${formatBytes(peer.received_bytes || 0)}
        </span>
        <br>
        <span class="wg-tx">
          ↑ TX ${formatBytes(peer.sent_bytes || 0)}
        </span>
      </td>
    </tr>
  `;

}).join("");
}

function renderMetrics(data) {
  const cpu = data.cpu;
  $("cpu-value").textContent = `${cpu.percent}%`;
  setProgressBar($("cpu-bar"), cpu.percent);
  $("cpu-meta").textContent = `${cpu.cores} ядер · ${cpu.model}`;

  $("cpu-meta").textContent = `${cpu.model}\n${cpu.cores} cores`;

  const mem = data.memory;
  $("ram-value").textContent = `${mem.percent}%`;
  setProgressBar($("ram-bar"), mem.percent);
  $("ram-meta").textContent = `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`;

  const disk = data.disk;
  $("disk-value").textContent = `${disk.percent}%`;
  setProgressBar($("disk-bar"), disk.percent);
  $("disk-meta").textContent = `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`;

  $("disk-meta").textContent = diskMeta(disk);

  renderStorageDisks(data.storage_disks || []);

  $("uptime-value").textContent = data.uptime.formatted;

  const temp = data.temperature;
  if (temp) {
    $("temp-value").textContent = `${temp.celsius}°C`;
  } else {
    $("temp-value").textContent = "N/A";
  }

  renderPlex(data.plex || { found: false });
  renderWireguard(data.wireguard || {});

  const docker = data.docker;
  const tbody = $("docker-tbody");
  const errorEl = $("docker-error");

  $("docker-count").textContent = docker.available ? docker.total : "—";

  if (!docker.available) {
    tbody.innerHTML = `<tr><td colspan="4" class="docker-table__empty">Docker недоступен</td></tr>`;
    errorEl.hidden = false;
    errorEl.textContent = docker.error || "Не удалось подключиться к Docker";
    return;
  }

  errorEl.hidden = true;

  if (!docker.containers.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="docker-table__empty">Контейнеры не найдены</td></tr>`;
    return;
  }

  tbody.innerHTML = docker.containers
    .map(
      (c) => `
      <tr>
        <td>${c.name}</td>
        <td><span class="status-badge ${statusBadgeClass(c.status)}">${c.status}</span></td>
        <td>${c.image}</td>
        <td><code>${c.id}</code></td>
      </tr>`
    )
    .join("");
}

function updateTimestamp() {
  const now = new Date();
  $("last-updated").textContent = `Обновлено: ${now.toLocaleTimeString("ru-RU")}`;
}

async function fetchMetrics() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderMetrics(data);
    updateConnection(true);
    updateTimestamp();
  } catch (err) {
    updateConnection(false);
    console.error("Metrics fetch error:", err);
  }
}

function formatHandshake(timestamp) {
  if (!timestamp || timestamp === 0) {
    return "—";
  }

  const diff = Math.floor(Date.now() / 1000 - timestamp);

  if (diff < 60) {
    return `${diff} сек назад`;
  }

  if (diff < 3600) {
    return `${Math.floor(diff / 60)} мин назад`;
  }

  if (diff < 86400) {
    return `${Math.floor(diff / 3600)} ч назад`;
  }

  return `${Math.floor(diff / 86400)} дн назад`;
}

async function updateProject() {
  const button = $("update-project");
  button.disabled = true;
  button.textContent = "Запуск...";

  try {
    const res = await fetch(UPDATE_API_URL, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== "started") throw new Error("Update was not started");
    window.location.href = "/update-status";
  } catch (err) {
    console.error("Project update error:", err);
    alert("Не удалось запустить обновление");
    button.disabled = false;
    button.textContent = "Обновить проект";
  }
}

$("update-project").addEventListener("click", updateProject);
fetchMetrics();
setInterval(fetchMetrics, REFRESH_INTERVAL);
