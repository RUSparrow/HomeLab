"use strict";

const WHATSAPP = "37250000202";
const PRICE = { van: 35, mover: 22, floor: 10, assembly: 25 };
const CAPACITY = 13; // м³

// Объём в кузове с учётом пустот при укладке, м³
const ITEMS = [
  { id: "box",     name: "Коробка",            v: 0.08 },
  { id: "sofa",    name: "Диван",              v: 2.0 },
  { id: "chair",   name: "Кресло",             v: 0.8 },
  { id: "bed",     name: "Кровать двуспальная", v: 1.4 },
  { id: "mattr",   name: "Матрас",             v: 0.6 },
  { id: "ward",    name: "Шкаф",               v: 1.6 },
  { id: "dresser", name: "Комод",              v: 0.6 },
  { id: "fridge",  name: "Холодильник",        v: 0.9 },
  { id: "washer",  name: "Стиральная машина",  v: 0.45 },
  { id: "table",   name: "Стол",               v: 0.6 },
  { id: "seat",    name: "Стул",               v: 0.15 },
  { id: "tv",      name: "Телевизор",          v: 0.25 },
  { id: "bike",    name: "Велосипед",          v: 0.5 },
  { id: "bag",     name: "Сумка или мешок",    v: 0.12 },
];

const $ = (id) => document.getElementById(id);
const counts = {};
let floors = 0;

const euro = (n) => `${Math.round(n)} €`;
const m3 = (n) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const waLink = (text) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;

// ---------- Калькулятор ----------
function quote() {
  const hours = Number($("hours").value);
  const movers = Number(document.querySelector('input[name="movers"]:checked').value);
  const assembly = $("assembly").checked;
  const total = hours * PRICE.van + hours * movers * PRICE.mover + floors * PRICE.floor + (assembly ? PRICE.assembly : 0);
  return { hours, movers, assembly, total };
}

function renderCalc() {
  const q = quote();
  $("hours-val").textContent = `${q.hours} ч`;
  $("floors").textContent = floors;
  $("total").textContent = euro(q.total);
  return q;
}

document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
  floors = Math.min(15, Math.max(0, floors + Number(b.dataset.step)));
  renderCalc();
}));
$("calc").addEventListener("input", renderCalc);

// ---------- Что влезет ----------
function itemsHtml() {
  return ITEMS.map((it) => {
    const n = counts[it.id] || 0;
    return `<button type="button" class="item${n ? " has" : ""}" data-id="${it.id}" aria-label="${it.name}: ${n}">
      ${it.name}<small>${m3(it.v)} м³</small>
      ${n ? `<span class="item__count">${n}</span><span class="item__minus" data-minus="${it.id}" role="button" aria-label="Убрать">−</span>` : ""}
    </button>`;
  }).join("");
}

function volume() {
  return ITEMS.reduce((sum, it) => sum + (counts[it.id] || 0) * it.v, 0);
}

function renderFit() {
  $("items").innerHTML = itemsHtml();
  const v = volume();
  const share = v / CAPACITY;
  const fill = $("fill");
  fill.setAttribute("width", String(Math.min(1, share) * 262));
  fill.classList.toggle("is-over", share > 1);
  $("vol").textContent = m3(v);
  const verdict = $("verdict");
  verdict.className = "load__verdict";
  if (!v) verdict.textContent = "Выберите вещи слева";
  else if (share <= 0.85) { verdict.textContent = "Помещается за один рейс"; verdict.classList.add("ok"); }
  else if (share <= 1) { verdict.textContent = "Впритык — лучше разобрать мебель"; verdict.classList.add("ok"); }
  else { verdict.textContent = `Нужно ${Math.ceil(share)} рейса или две машины`; verdict.classList.add("over"); }
}

$("items").addEventListener("click", (e) => {
  const minus = e.target.closest("[data-minus]");
  const btn = e.target.closest(".item");
  if (!btn) return;
  const id = btn.dataset.id;
  counts[id] = Math.max(0, (counts[id] || 0) + (minus ? -1 : 1));
  renderFit();
  document.querySelector(`.item[data-id="${id}"]`)?.focus();
});
$("clear").addEventListener("click", () => { for (const k in counts) delete counts[k]; renderFit(); });

// ---------- Заявка ----------
function listText() {
  const parts = ITEMS.filter((it) => counts[it.id]).map((it) => `${it.name.toLowerCase()} ×${counts[it.id]}`);
  return parts.length ? ` Вещи: ${parts.join(", ")} (≈${m3(volume())} м³).` : "";
}

$("calc").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = renderCalc();
  const movers = q.movers ? `${q.movers} ${q.movers > 1 ? "грузчика" : "грузчик"}` : "без грузчиков";
  const extra = [floors ? `${floors} эт. без лифта` : "", q.assembly ? "сборка мебели" : ""].filter(Boolean).join(", ");
  window.open(waLink(`Здравствуйте! Нужен фургон на ${q.hours} ч, ${movers}${extra ? ", " + extra : ""}. По калькулятору ≈${euro(q.total)}.${listText()} Когда свободны?`), "_blank", "noopener");
});

document.querySelectorAll("[data-wa]").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    window.open(waLink(`Здравствуйте! Хочу заказать фургон.${listText()}`), "_blank", "noopener");
  });
});

renderCalc();
renderFit();
