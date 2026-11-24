"use strict";

// Контакты: поменять на настоящие в одном месте
const WHATSAPP = "37250000101";

// Расстояния по дороге от Таллинна (км), паром — отдельной доплатой
const ROUTES = [
  { id: "riga",      name: "Рига",      km: 310 },
  { id: "kaunas",    name: "Каунас",    km: 570 },
  { id: "vilnius",   name: "Вильнюс",   km: 600 },
  { id: "helsinki",  name: "Хельсинки", km: 90,  ferry: 280, north: true },
  { id: "warsaw",    name: "Варшава",   km: 1030 },
  { id: "poznan",    name: "Познань",   km: 1290 },
  { id: "berlin",    name: "Берлин",    km: 1590 },
  { id: "hamburg",   name: "Гамбург",   km: 1870 },
];
// Откуда: насколько дальше/ближе к югу (Рига) и сколько до парома в Таллинне
const ORIGINS = {
  tallinn: { name: "Таллинн", south: 0,    toPort: 0 },
  tartu:   { name: "Тарту",   south: -65,  toPort: 185 },
  parnu:   { name: "Пярну",   south: -130, toPort: 130 },
  narva:   { name: "Нарва",   south: 120,  toPort: 210 },
};
const RATE_FULL = 1.45, MIN_FULL = 450, RATE_PALLET = 0.07, MIN_PART = 90;

const $ = (id) => document.getElementById(id);
const fmt = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(n / 10) * 10);

function trip(routeId, originId, load, pallets) {
  const r = ROUTES.find((x) => x.id === routeId);
  const o = ORIGINS[originId];
  const km = r.north ? r.km + o.toPort : Math.max(60, r.km + o.south);
  const ferry = r.ferry || 0;
  const price = load === "full"
    ? Math.max(MIN_FULL, km * RATE_FULL) + ferry
    : Math.max(MIN_PART, km * RATE_PALLET * pallets) + (ferry ? 40 * Math.ceil(pallets / 6) : 0);
  const days = Math.max(1, Math.ceil(km / 650));
  return { r, o, km, ferry, price, days };
}

function daysText(n) { return n === 1 ? "1 день в пути" : `${n} ${n < 5 ? "дня" : "дней"} в пути`; }

function render() {
  const load = document.querySelector('input[name="load"]:checked').value;
  const pallets = Number($("pallets").value);
  $("pallets-wrap").hidden = load !== "part";
  $("pallets-val").textContent = pallets;
  const t = trip($("to").value, $("from").value, load, pallets);
  $("r-from").textContent = t.o.name;
  $("r-to").textContent = t.r.name;
  $("r-km").textContent = `${t.km} км${t.ferry ? " + паром" : ""}`;
  $("r-days").textContent = daysText(t.days);
  $("r-price").textContent = fmt(t.price);
  document.querySelectorAll(".exit").forEach((b) => b.classList.toggle("is-active", b.dataset.id === t.r.id));
  return { t, load, pallets };
}

function waLink(text) { return `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`; }

// Списки городов
$("to").innerHTML = ROUTES.map((r) => `<option value="${r.id}">${r.name}</option>`).join("");
$("road").innerHTML = ROUTES.map((r) => {
  const t = trip(r.id, "tallinn", "full", 0);
  return `<li><button type="button" class="exit" data-id="${r.id}">
    <b>${r.name}</b><span>${t.km} км${r.ferry ? " + паром" : ""}<small>${daysText(t.days)}</small></span><em>от ${fmt(t.price)} €</em>
  </button></li>`;
}).join("");

document.querySelectorAll(".exit").forEach((btn) => btn.addEventListener("click", () => {
  $("from").value = "tallinn";
  $("to").value = btn.dataset.id;
  render();
  $("calc").scrollIntoView({ behavior: "smooth", block: "center" });
}));

$("calc").addEventListener("input", render);
$("calc").addEventListener("submit", (e) => {
  e.preventDefault();
  const { t, load, pallets } = render();
  const what = load === "full" ? "вся фура" : `догруз, ${pallets} пал.`;
  window.open(waLink(`Здравствуйте! Нужен рейс ${t.o.name} → ${t.r.name} (${what}). Ориентир с сайта: от ${fmt(t.price)} €. Когда сможете подать машину?`), "_blank", "noopener");
});

document.querySelectorAll("[data-wa]").forEach((a) => {
  a.href = waLink("Здравствуйте! Хочу заказать перевозку фурой.");
  a.target = "_blank";
  a.rel = "noopener";
});

render();
