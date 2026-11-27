import { createI18n } from "/shared/i18n.js";
import { mountPlanner } from "/shared/planner.js?v=4";
import { DICT } from "./lang.js";

// Контакты: поменять на настоящие в одном месте
const WHATSAPP = "37250000101";

// Расстояния по дороге от Таллинна (км), паром — отдельной доплатой
const ROUTES = [
  { id: "riga", km: 310 }, { id: "kaunas", km: 570 }, { id: "vilnius", km: 600 },
  { id: "helsinki", km: 90, ferry: 280, north: true },
  { id: "warsaw", km: 1030 }, { id: "poznan", km: 1290 }, { id: "berlin", km: 1590 }, { id: "hamburg", km: 1870 },
];
// Откуда: насколько ближе/дальше к югу (Рига) и сколько до парома в Таллинне
const ORIGINS = {
  tallinn: { south: 0, toPort: 0 }, tartu: { south: -65, toPort: 185 },
  parnu: { south: -130, toPort: 130 }, narva: { south: 120, toPort: 210 },
};
const RATE_FULL = 1.45, MIN_FULL = 450, RATE_PALLET = 0.07, MIN_PART = 90;

const $ = (id) => document.getElementById(id);
const i18n = createI18n(DICT);
const t = i18n.t;
const fmt = (n) => new Intl.NumberFormat(i18n.lang).format(Math.round(n / 10) * 10);
const waLink = (text) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;

function trip(routeId, originId, load, pallets) {
  const r = ROUTES.find((x) => x.id === routeId);
  const o = ORIGINS[originId];
  const km = r.north ? r.km + o.toPort : Math.max(60, r.km + o.south);
  const ferry = r.ferry || 0;
  const price = load === "full"
    ? Math.max(MIN_FULL, km * RATE_FULL) + ferry
    : Math.max(MIN_PART, km * RATE_PALLET * pallets) + (ferry ? 40 * Math.ceil(pallets / 6) : 0);
  return { r, originId, km, ferry, price, days: Math.max(1, Math.ceil(km / 650)) };
}

function render() {
  const load = document.querySelector('input[name="load"]:checked').value;
  const pallets = Number($("pallets").value);
  $("pallets-wrap").hidden = load !== "part";
  $("pallets-val").textContent = pallets;
  const tr = trip($("to").value, $("from").value, load, pallets);
  $("r-from").textContent = t(`city.${tr.originId}`);
  $("r-to").textContent = t(`city.${tr.r.id}`);
  $("r-km").textContent = t("km", { n: tr.km }) + (tr.ferry ? t("ferry") : "");
  $("r-days").textContent = t("days", { n: tr.days });
  $("r-price").textContent = fmt(tr.price);
  document.querySelectorAll(".exit").forEach((b) => b.classList.toggle("is-active", b.dataset.id === tr.r.id));
  return { tr, load, pallets };
}

function fillSelects() {
  const from = $("from").value || "tallinn", to = $("to").value || "riga";
  $("from").innerHTML = Object.keys(ORIGINS).map((id) => `<option value="${id}">${t(`city.${id}`)}</option>`).join("");
  $("to").innerHTML = ROUTES.map((r) => `<option value="${r.id}">${t(`city.${r.id}`)}</option>`).join("");
  $("from").value = from;
  $("to").value = to;
}

function renderRoad() {
  $("road").innerHTML = ROUTES.map((r) => {
    const tr = trip(r.id, "tallinn", "full", 0);
    return `<li><button type="button" class="exit" data-id="${r.id}">
      <b>${t(`city.${r.id}`)}</b><span>${t("km", { n: tr.km })}${r.ferry ? t("ferry") : ""}<small>${t("days", { n: tr.days })}</small></span><em>${t("calc.fromPrice")} ${fmt(tr.price)} €</em>
    </button></li>`;
  }).join("");
}

$("road").addEventListener("click", (e) => {
  const btn = e.target.closest(".exit");
  if (!btn) return;
  $("from").value = "tallinn";
  $("to").value = btn.dataset.id;
  render();
  $("calc").scrollIntoView({ behavior: "smooth", block: "center" });
});

$("calc").addEventListener("input", render);
$("calc").addEventListener("submit", (e) => {
  e.preventDefault();
  const { tr, load, pallets } = render();
  const what = load === "full" ? t("wa.full") : t("wa.part", { n: pallets });
  window.open(waLink(t("wa.trip", { from: t(`city.${tr.originId}`), to: t(`city.${tr.r.id}`), what, price: fmt(tr.price) })), "_blank", "noopener");
});

// ---------- 3D-загрузка полуприцепа ----------
const P = (id, w, d, h, kg, stack = true, tilt = false) => ({ id, w, d, h, kg, stack, tilt, name: () => t(`pr.${id}`) });
const planner = mountPlanner($("planner"), {
  lang: i18n.lang,
  vehicle: {
    // Внутренние размеры еврофуры: 13,6 × 2,48 × 2,7 м; паллеты ставим с зазором 1 см
    kind: "semi", L: 1360, W: 248, H: 270, payload: 24000, deck: 120, front: 3.4,
    clearance: 1, ldm: true,
  },
  colors: {
    body: 0xf4f5f2, edge: 0x15191d, floor: 0x8a8f94, cab: 0xf7f7f5,
    cargo: [0xd2a86a, 0x0e6b43, 0x6c8fb3, 0xc9653f, 0x8b7bb8, 0x5a6470],
  },
  presets: [
    P("euro", 120, 80, 150, 500, false), P("fin", 120, 100, 150, 600, false), P("half", 80, 60, 100, 250),
    P("ibc", 120, 100, 116, 1000, false), P("bag", 90, 90, 110, 800, false), P("box", 60, 40, 40, 15, true, true),
  ],
  start: [["euro", 18], ["ibc", 4]],
});
$("plan-send").addEventListener("click", () => {
  const len = (() => {
    const bar = document.querySelector(".pbar__val");
    return bar ? bar.textContent.split(" ")[0] : "?";
  })();
  window.open(waLink(t("wa.plan", { list: planner.summary(), len })), "_blank", "noopener");
});

// ---------- Язык ----------
function setupWa() {
  document.querySelectorAll("[data-wa]").forEach((a) => {
    a.href = waLink(t("wa.hello"));
    a.target = "_blank";
    a.rel = "noopener";
  });
}

i18n.onChange((lang) => {
  fillSelects();
  renderRoad();
  render();
  setupWa();
  planner.setLang(lang);
});
i18n.start();
