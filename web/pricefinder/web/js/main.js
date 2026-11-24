const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const resultsDescription = document.getElementById("results-description");
const resultsCount = document.getElementById("results-count");
const emptyState = document.getElementById("empty-state");
const offers = document.getElementById("offers");
const searchButton = searchForm.querySelector('button[type="submit"]');
const monitorLink = document.getElementById("monitor-link");

let currentSearch = 0;

if (monitorLink) {
  monitorLink.href = `${window.location.protocol}//${window.location.hostname}:8080`;
}

document.querySelectorAll("[data-query]").forEach((button) => {
  button.addEventListener("click", () => {
    searchInput.value = button.dataset.query;
    searchInput.focus();
  });
});

const stages = [
  { title: "Подготавливаем поиск", description: "Задача поставлена в очередь." },
  { title: "Ищем магазины", description: "Опрашиваем поисковик по магазинам разных стран." },
  { title: "Проверяем страницы", description: "Открываем найденные страницы и ищем цены." },
  { title: "Сохраняем результаты", description: "Записываем предложения в базу." },
  { title: "Готово", description: "Формируем список." },
];

const STAGE_INDEX = { queued: 0, search: 1, pages: 2, save: 3, done: 4 };

/** Реальный прогресс из бота: поиск 0–40 %, страницы 40–90 %, сохранение 95 %. */
function applyProgress(progress) {
  if (!progress) return;
  const index = STAGE_INDEX[progress.stage] ?? 0;
  updateStage(index);

  const ratio = progress.total ? progress.done / progress.total : 0;
  const percent = progress.stage === "search" ? 40 * ratio
    : progress.stage === "pages" ? 40 + 50 * ratio
    : progress.stage === "save" ? 95
    : progress.stage === "done" ? 100 : 2;

  const bar = document.getElementById("pf-progress-bar");
  const label = document.getElementById("pf-progress-percent");
  const description = document.getElementById("pf-stage-description");
  if (bar) {
    bar.style.width = `${percent.toFixed(0)}%`;
    bar.parentElement.setAttribute("aria-valuenow", percent.toFixed(0));
  }
  if (label) label.textContent = `${percent.toFixed(0)} %`;
  if (description && progress.total) {
    if (progress.stage === "search") {
      description.textContent = `Поисковых запросов: ${progress.done} из ${progress.total} · найдено ссылок: ${progress.found ?? 0}`;
    } else if (progress.stage === "pages") {
      description.textContent = `Проверено страниц: ${progress.done} из ${progress.total} · с ценой: ${progress.priced ?? 0}`;
    }
  }
}

function makeGearSvg(teeth) {
  const points = [];
  const profile = [
    [-0.50, 39], [-0.32, 39], [-0.24, 47],
    [0.24, 47], [0.32, 39], [0.50, 39],
  ];

  for (let tooth = 0; tooth < teeth; tooth++) {
    for (const [offset, radius] of profile) {
      const angle = (tooth + offset) * Math.PI * 2 / teeth - Math.PI / 2;
      points.push(
        `${(50 + Math.cos(angle) * radius).toFixed(3)},` +
        `${(50 + Math.sin(angle) * radius).toFixed(3)}`
      );
    }
  }

  const outer = `M ${points.join(" L ")} Z`;
  const hole = "M 50 38 A 12 12 0 1 0 50 62 A 12 12 0 1 0 50 38";

  return `<svg class="pf-gear-svg" viewBox="0 0 100 100" aria-hidden="true">
    <path d="${outer} ${hole}" fill="currentColor" fill-rule="evenodd"
      stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function createLoadingView(query) {
  emptyState.replaceChildren();
  emptyState.classList.add("pf-loading");

  const gears = document.createElement("div");
  gears.className = "pf-gears";
  gears.setAttribute("aria-hidden", "true");

  [
    ["pf-gear pf-gear--large", 12],
    ["pf-gear pf-gear--small", 8],
    ["pf-gear pf-gear--medium", 6],
  ].forEach(([className, teeth]) => {
    const gear = document.createElement("span");
    gear.className = className;
    gear.innerHTML = makeGearSvg(teeth);
    gears.appendChild(gear);
  });

  const title = document.createElement("h3");
  title.className = "pf-loading__title";
  title.id = "pf-stage-title";
  title.textContent = stages[0].title;

  const description = document.createElement("p");
  description.className = "pf-loading__description";
  description.id = "pf-stage-description";
  description.textContent = stages[0].description;

  const queryLabel = document.createElement("div");
  queryLabel.className = "pf-loading__query";

  const queryCaption = document.createElement("span");
  queryCaption.textContent = "Запрос";

  const queryValue = document.createElement("strong");
  queryValue.textContent = query;
  queryLabel.append(queryCaption, queryValue);

  const progressHeader = document.createElement("div");
  progressHeader.className = "pf-progress__header";

  const progressLabel = document.createElement("span");
  progressLabel.textContent = "Состояние поиска";

  const progressPercent = document.createElement("strong");
  progressPercent.id = "pf-progress-percent";
  progressPercent.textContent = "В процессе";

  progressHeader.append(progressLabel, progressPercent);

  const progressTrack = document.createElement("div");
  progressTrack.className = "pf-progress__track";
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-label", "Поиск выполняется");
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", "100");
  progressTrack.setAttribute("aria-valuenow", "0");

  const progressBar = document.createElement("div");
  progressBar.className = "pf-progress__bar";
  progressBar.id = "pf-progress-bar";
  progressBar.style.width = "0%";
  progressTrack.appendChild(progressBar);

  const stageList = document.createElement("div");
  stageList.className = "pf-stages";
  stageList.id = "pf-stages";

  stages.forEach((stage, index) => {
    const row = document.createElement("div");
    row.className = "pf-stage";
    row.dataset.stage = index;

    const marker = document.createElement("span");
    marker.className = "pf-stage__marker";
    marker.textContent = String(index + 1);

    const label = document.createElement("span");
    label.className = "pf-stage__label";
    label.textContent = stage.title;

    const status = document.createElement("span");
    status.className = "pf-stage__status";
    status.textContent = "Ожидание";

    row.append(marker, label, status);
    stageList.appendChild(row);
  });

  const notice = document.createElement("p");
  notice.className = "pf-loading__notice";
  notice.textContent =
    "Выполняется запрос к поисковому серверу. Некоторые сайты могут блокировать автоматический поиск.";

  emptyState.append(
    gears, title, description, queryLabel,
    progressHeader, progressTrack, stageList, notice
  );
  emptyState.hidden = false;
  updateStage(0);
}

function updateStage(index) {
  const stage = stages[index];
  const title = document.getElementById("pf-stage-title");
  const description = document.getElementById("pf-stage-description");
  if (!title || !description) return;

  title.textContent = stage.title;
  description.textContent = stage.description;

  document.querySelectorAll(".pf-stage").forEach((row, rowIndex) => {
    const marker = row.querySelector(".pf-stage__marker");
    const status = row.querySelector(".pf-stage__status");
    row.classList.remove("is-active", "is-complete");

    if (rowIndex < index) {
      row.classList.add("is-complete");
      marker.textContent = "✓";
      status.textContent = "Пройдено";
    } else if (rowIndex === index) {
      row.classList.add("is-active");
      marker.textContent = "↻";
      status.textContent = "В процессе";
    } else {
      marker.textContent = String(rowIndex + 1);
      status.textContent = "Ожидание";
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showMessage(titleText, messageText, symbol = "i") {
  emptyState.classList.remove("pf-loading");
  emptyState.replaceChildren();

  const icon = document.createElement("div");
  icon.className = "empty-state__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = symbol;

  const heading = document.createElement("h3");
  heading.textContent = titleText;

  const message = document.createElement("p");
  message.textContent = messageText;

  emptyState.append(icon, heading, message);
  emptyState.hidden = false;
}

function renderOffers(items) {
  offers.replaceChildren();

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "offer";

    const details = document.createElement("div");
    details.className = "offer__details";

    const store = document.createElement("div");
    store.className = "offer__store";
    store.textContent = item.store || "Источник не указан";

    const title = document.createElement("div");
    title.className = "offer__title";
    title.textContent = item.title || "Название товара не указано";

    const status = document.createElement("div");
    status.className = "offer__status";
    if (item.in_stock === true) {
      status.textContent = "В наличии";
    } else if (item.in_stock === false) {
      status.textContent = "Нет в наличии";
    } else {
      status.textContent = "Наличие не подтверждено";
    }

    details.append(store, title, status);

    const right = document.createElement("div");
    right.className = "offer__right";

    const price = document.createElement("div");
    price.className = "offer__price";

    if (item.price !== null && item.price !== undefined && item.price !== "") {
      const numericPrice = Number(item.price);
      price.textContent = Number.isFinite(numericPrice)
        ? formatPrice(numericPrice, item.currency)
        : "Цена не указана";
    } else {
      price.textContent = "Цена не указана";
    }

    right.appendChild(price);

    if (item.price_eur != null && item.currency && item.currency.toUpperCase() !== "EUR") {
      const eur = document.createElement("div");
      eur.className = "offer__eur";
      eur.textContent = `≈ ${formatPrice(item.price_eur, "EUR")}`;
      right.appendChild(eur);
    }

    if (item.price != null && item.confirmed === false) {
      card.classList.add("offer--unconfirmed");
      const note = document.createElement("div");
      note.className = "offer__note";
      note.textContent = "Цена найдена в тексте страницы — проверьте на сайте";
      details.appendChild(note);
    }

    if (item.url) {
      try {
        const url = new URL(item.url, window.location.origin);
        if (url.protocol === "https:" || url.protocol === "http:") {
          const link = document.createElement("a");
          link.className = "offer__link";
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "Открыть магазин";
          right.appendChild(link);
        }
      } catch {
        // Не показываем ссылку, если адрес некорректен.
      }
    }

    card.append(details, right);
    offers.appendChild(card);
  }
}

function formatPrice(value, currency) {
  const code = String(currency || "").toUpperCase();
  try {
    if (/^[A-Z]{3}$/.test(code)) {
      return new Intl.NumberFormat("ru-RU", { style: "currency", currency: code }).format(value);
    }
  } catch {
    // Неизвестный код валюты — покажем как есть.
  }
  const number = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return code ? `${number} ${code}` : number;
}

function formatCount(count) {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  let word = "предложений";
  if (n > 10 && n < 20) word = "предложений";
  else if (last === 1) word = "предложение";
  else if (last >= 2 && last <= 4) word = "предложения";
  return `${count} ${word}`;
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.message || `Ошибка HTTP ${response.status}`);
  }
  return data;
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const query = searchInput.value.trim();
  if (query.length < 2) {
    searchInput.focus();
    return;
  }

  const runId = ++currentSearch;
  offers.replaceChildren();
  resultsCount.textContent = "Поиск…";
  resultsDescription.textContent = `Запрос: «${query}»`;
  resultsDescription.setAttribute("aria-live", "polite");

  searchButton.disabled = true;
  searchInput.disabled = true;
  searchButton.classList.add("is-searching");
  createLoadingView(query);

  try {
    const startResponse = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const started = await readJson(startResponse);

    if (!started.id) {
      throw new Error("Сервер не вернул идентификатор задачи поиска.");
    }

    let job;

    while (runId === currentSearch) {
      await sleep(1500);

      const response = await fetch(
        `/api/search/${encodeURIComponent(started.id)}`,
        { cache: "no-store" }
      );
      job = await readJson(response);

      if (job.status === "completed" || job.status === "failed") break;

      applyProgress(job.progress);
    }

    if (runId !== currentSearch) return;

    if (!job || job.status === "failed") {
      throw new Error(job?.message || "Поиск завершился с ошибкой.");
    }

    const found = Array.isArray(job.offers) ? job.offers : [];
    renderOffers(found);
    emptyState.classList.remove("pf-loading");

    if (found.length > 0) {
      emptyState.hidden = true;
    } else {
      showMessage(
        "Предложения не найдены",
        job.message || "По этому запросу сервер не вернул предложений. Попробуйте другое название товара.",
        "!"
      );
    }

    resultsCount.textContent = formatCount(found.length);
    loadHistory();

    if (job.log) {
      console.info("PriceFinder search log:", job.log);
    }
  } catch (error) {
    if (runId !== currentSearch) return;

    console.error("PriceFinder search failed:", error);
    offers.replaceChildren();
    resultsCount.textContent = "Ошибка поиска";
    showMessage(
      "Не удалось выполнить поиск",
      error.message || "Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.",
      "!"
    );
  } finally {
    if (runId === currentSearch) {
      searchButton.disabled = false;
      searchInput.disabled = false;
      searchButton.classList.remove("is-searching");
    }
  }
});


/* ---------- Недавние запросы ---------- */

const historyBox = document.getElementById("history");
const historyItems = document.getElementById("history-items");

async function showSavedOffers(item) {
  ++currentSearch;
  searchInput.value = item.query;
  resultsDescription.textContent = `Запрос: «${item.query}» · сохранённые результаты`;
  try {
    const data = await readJson(await fetch(`/api/products/${item.product_id}/offers`, { cache: "no-store" }));
    renderOffers(data.offers || []);
    resultsCount.textContent = formatCount(data.count || 0);
    if (data.count) {
      emptyState.hidden = true;
    } else {
      showMessage("Предложений нет", "Нажмите «Найти», чтобы поискать заново.", "!");
    }
    document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showMessage("Не удалось загрузить результаты", error.message, "!");
  }
}

async function loadHistory() {
  if (!historyBox) return;
  try {
    const items = await readJson(await fetch("/api/history", { cache: "no-store" }));
    historyItems.replaceChildren();
    for (const item of items) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "query-chip query-chip--history";
      const price = item.min_price != null ? ` · от ${formatPrice(item.min_price, item.currency)}` : "";
      chip.textContent = `${item.query}${price}`;
      chip.title = `${formatCount(item.offers)} — показать сохранённые результаты`;
      chip.addEventListener("click", () => showSavedOffers(item));
      historyItems.appendChild(chip);
    }
    historyBox.hidden = items.length === 0;
  } catch {
    historyBox.hidden = true;
  }
}

loadHistory();
