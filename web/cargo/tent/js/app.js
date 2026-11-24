"use strict";

const WHATSAPP = "37250000303";
const PRICE = { hour: 42, km: 0.85, minTrip: 120, mover: 22 };
const M = 100; // пикселей на метр на схеме кузова

const $ = (id) => document.getElementById(id);
const waLink = (text) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;

// ---------- Раскладки груза (метры от левого переднего угла кузова) ----------
function grid(cols, rows, w, h, x0 = 0, y0 = 0, gap = 0.04) {
  const out = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) out.push([x0 + c * (w + gap), y0 + r * (h + gap), w - gap, h - gap]);
  return out;
}

const CARGO = {
  euro: {
    title: "8 европаллет",
    text: "5 поперёк и 3 вдоль. Погрузчик подъезжает сбоку — тент сдвигается за пару минут.",
    sides: ["left", "right", "rear"],
    kind: "pallet",
    units: [...grid(5, 1, 0.8, 1.2, 0.02, 0.02), ...grid(3, 1, 1.2, 0.8, 0.02, 1.26)],
  },
  fin: {
    title: "6 финпаллет",
    text: "Паллеты 1,2 × 1,0 м — по две в ряд, три ряда. Остаётся место под коробки сзади.",
    sides: ["left", "right", "rear"],
    kind: "pallet",
    units: grid(3, 2, 1.2, 1.0, 0.02, 0.04),
  },
  long: {
    title: "До 4,2 м в кузове",
    text: "Доски, трубы, профиль. С открытым задним бортом — до 4,8 м. Удобнее грузить сверху краном или сзади.",
    sides: ["rear", "top"],
    kind: "board",
    units: Array.from({ length: 9 }, (_, i) => [0.05, 0.08 + i * 0.22, 4.1, 0.16]),
  },
  bags: {
    title: "8 биг-бэгов",
    text: "Мешки 0,9 × 0,9 м с песком, щебнем или пеллетами — по две в ряд. Грузим краном-манипулятором сверху.",
    sides: ["top", "left", "right"],
    kind: "bag",
    units: grid(4, 2, 0.95, 0.95, 0.15, 0.1),
  },
  move: {
    title: "Двушка за один рейс",
    text: "Шкафы и диван — вдоль бортов, коробки — в середину. Высота 2,2 м: шкаф едет стоя.",
    sides: ["rear", "left"],
    kind: "furn",
    units: [
      [0.04, 0.04, 2.1, 0.9, "диван"], [2.2, 0.04, 1.0, 0.6, "шкаф"], [3.25, 0.04, 0.9, 0.6, "шкаф"],
      [0.04, 1.3, 1.6, 0.75, "кровать"], [1.7, 1.3, 0.75, 0.75, "холод."], [2.5, 1.3, 0.6, 0.75, "стир."],
      [3.15, 1.3, 1.0, 0.75, "стол"],
      [0.04, 0.98, 4.1, 0.28, "коробки"],
    ],
  },
};

const SIDE_NAMES = { left: "сбоку слева", right: "сбоку справа", rear: "сзади", top: "сверху краном" };

function draw(key) {
  const c = CARGO[key];
  $("load").innerHTML = c.units.map(([x, y, w, h, label]) => {
    const rect = `<rect class="unit unit--${c.kind}" x="${x * M}" y="${y * M}" width="${w * M}" height="${h * M}" rx="${c.kind === "bag" ? 10 : 3}"/>`;
    return label ? rect + `<text class="unit-label" x="${(x + w / 2) * M}" y="${(y + h / 2) * M}">${label}</text>` : rect;
  }).join("");
  document.querySelectorAll(".side").forEach((g) => g.classList.toggle("is-on", c.sides.includes(g.dataset.side)));
  $("plan-big").textContent = c.title;
  $("plan-caption").textContent = c.text;
  $("plan-sides").innerHTML = c.sides.map((s) => `<li>Погрузка ${SIDE_NAMES[s]}</li>`).join("");
  document.querySelectorAll("#tabs [data-cargo]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.cargo === key)));
}

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cargo]");
  if (b) draw(b.dataset.cargo);
});

// ---------- Калькулятор ----------
function quote() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const hours = Number($("hours").value);
  const km = Math.max(10, Number($("km").value) || 0);
  const mover = $("mover").checked;
  let sum;
  if (mode === "city") sum = hours * PRICE.hour + (mover ? hours * PRICE.mover : 0);
  else sum = Math.max(PRICE.minTrip, km * 2 * PRICE.km) + (mover ? 2 * PRICE.mover : 0);
  return { mode, hours, km, mover, sum };
}

function render() {
  const q = quote();
  $("f-hours").hidden = q.mode !== "city";
  $("f-km").hidden = q.mode !== "trip";
  $("hours-val").textContent = q.hours;
  $("sum").textContent = `${Math.round(q.sum)} €`;
  return q;
}

$("calc").addEventListener("input", render);
$("calc").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = render();
  const cargo = document.querySelector('#tabs [aria-selected="true"]').textContent.toLowerCase();
  const what = q.mode === "city" ? `по городу на ${q.hours} ч` : `междугородний рейс, ${q.km} км в одну сторону`;
  window.open(waLink(`Здравствуйте! Нужен тентованный Crafter ${what}${q.mover ? ", с грузчиком" : ""}. Груз: ${cargo}. По калькулятору ≈${Math.round(q.sum)} €. Когда свободны?`), "_blank", "noopener");
});

document.querySelectorAll("[data-wa]").forEach((a) => {
  a.href = waLink("Здравствуйте! Хочу заказать тентованный Crafter.");
  a.target = "_blank";
  a.rel = "noopener";
});

draw("euro");
render();
