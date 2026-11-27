import { createI18n } from "/shared/i18n.js";
import { mountPlanner } from "/shared/planner.js?v=4";
import { DICT } from "./lang.js";

const WHATSAPP = "37250000202";
const PRICE = { van: 35, mover: 22, floor: 10, assembly: 25 };

const $ = (id) => document.getElementById(id);
const i18n = createI18n(DICT);
const t = i18n.t;
let floors = 0;

const euro = (n) => `${Math.round(n)} €`;
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
  $("hours-val").textContent = t("calc.h", { n: q.hours });
  $("floors").textContent = floors;
  $("total").textContent = euro(q.total);
  return q;
}

document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
  floors = Math.min(15, Math.max(0, floors + Number(b.dataset.step)));
  renderCalc();
}));
$("calc").addEventListener("input", renderCalc);

// ---------- 3D: что влезет в Boxer ----------
const P = (id, w, d, h, kg, stack, tilt) => ({ id, w, d, h, kg, stack, tilt, name: () => t(`pr.${id}`) });
const planner = mountPlanner($("planner"), {
  lang: i18n.lang,
  vehicle: {
    // Boxer L3H2: 3,7 × 1,87 × 1,93 м; между колёсными арками 1,42 м
    kind: "van", L: 370, W: 187, H: 193, payload: 1400, deck: 55, front: 2.3, viewSide: -1,
    arches: [{ x: 200, z: 0, l: 90, w: 22, h: 30 }, { x: 200, z: 165, l: 90, w: 22, h: 30 }],
  },
  colors: {
    body: 0xffffff, edge: 0x1b1e2b, floor: 0xb8bcc8, cab: 0xffffff,
    cargo: [0xc99a62, 0x2a52f4, 0x8fb3ff, 0xe08a5a, 0x5b6072, 0xb9c96a, 0xd16ba5],
  },
  presets: [
    P("box", 60, 40, 40, 15, true, true), P("sofa", 210, 95, 85, 60, false, true),
    P("ward", 100, 60, 200, 80, false, true), P("fridge", 60, 65, 185, 70, false, false),
    P("washer", 60, 60, 85, 65, false, false), P("mattr", 200, 160, 25, 20, true, true),
    P("table", 120, 80, 75, 30, true, true), P("chair", 90, 85, 90, 30, false, false),
    P("bike", 175, 60, 100, 15, false, true), P("bag", 60, 40, 30, 8, true, true),
  ],
  start: [["sofa", 1], ["ward", 1], ["fridge", 1], ["washer", 1], ["box", 10]],
});

// ---------- Заявка ----------
$("calc").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = renderCalc();
  const movers = q.movers ? t("wa.movers", { n: q.movers }) : t("wa.noMovers");
  const extra = [floors ? t("wa.floors", { n: floors }) : "", q.assembly ? t("wa.assembly") : ""].filter(Boolean).join(", ");
  const items = planner.summary();
  window.open(waLink(t("wa.book", { h: q.hours, movers: movers + (extra ? ", " + extra : ""), total: euro(q.total) }) + (items ? " " + t("wa.items", { list: items }) : "")), "_blank", "noopener");
});

function setupWa() {
  document.querySelectorAll("[data-wa]").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const items = planner.summary();
      window.open(waLink(t("wa.hello") + (items ? " " + t("wa.items", { list: items }) : "")), "_blank", "noopener");
    };
  });
}

i18n.onChange((lang) => { renderCalc(); planner.setLang(lang); setupWa(); });
i18n.start();
