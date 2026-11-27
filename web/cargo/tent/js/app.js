import { createI18n } from "/shared/i18n.js";
import { mountPlanner } from "/shared/planner.js?v=3";
import { mountShowcase } from "/shared/showcase.js?v=4";
import { DICT } from "./lang.js";

const WHATSAPP = "37250000303";
const PRICE = { hour: 42, km: 0.85, minTrip: 120, mover: 22 };

const $ = (id) => document.getElementById(id);
const i18n = createI18n(DICT);
const t = i18n.t;
const waLink = (text) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;

// ---------- 3D: кузов 4,2 × 2,1 × 2,2 м ----------
const P = (id, w, d, h, kg, stack, tilt) => ({ id, w, d, h, kg, stack, tilt, name: () => t(`pr.${id}`) });
const VEHICLE = { kind: "tent", L: 420, W: 210, H: 220, payload: 1200, deck: 90, front: 2.45, clearance: 1 };
const COLORS = {
  body: 0xd9dde1, edge: 0x2a3036, floor: 0x9a8f80, cab: 0xf7f8f9,
  cargo: [0xd9b682, 0xf08a24, 0x7d8a96, 0xc79b63, 0x4f6d7a, 0xa3b18a],
};

// Первый экран: модель машины, тент один раз открывается и показывает 8 паллет
mountShowcase($("showcase"), {
  vehicle: VEHICLE, colors: COLORS,
  cargo: [{ w: 120, d: 80, h: 120, qty: 8, stack: true, color: 0xd9b682 }],
  view: [-0.62, 0.34, 0.72],              // три четверти спереди: видно кабину и открытый борт
});

const planner = mountPlanner($("planner"), {
  lang: i18n.lang,
  vehicle: VEHICLE,
  colors: COLORS,
  presets: [
    P("euro", 120, 80, 120, 140, true, false), P("fin", 120, 100, 120, 160, true, false),
    P("bag", 90, 90, 100, 1000, false, false), P("board", 420, 60, 40, 300, true, false),
    P("roll", 120, 120, 100, 150, false, false), P("box", 60, 40, 40, 15, true, true),
  ],
  start: [["euro", 8]],
});

// ---------- Калькулятор ----------
function quote() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const hours = Number($("hours").value);
  const km = Math.max(10, Number($("km").value) || 0);
  const mover = $("mover").checked;
  const sum = mode === "city"
    ? hours * PRICE.hour + (mover ? hours * PRICE.mover : 0)
    : Math.max(PRICE.minTrip, km * 2 * PRICE.km) + (mover ? 2 * PRICE.mover : 0);
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
  const what = q.mode === "city" ? t("wa.city", { h: q.hours }) : t("wa.trip", { km: q.km });
  const cargo = planner.summary();
  window.open(waLink(t("wa.order", { what: what + (q.mover ? t("wa.mover") : ""), sum: Math.round(q.sum) }) + (cargo ? " " + t("wa.cargo", { list: cargo }) : "")), "_blank", "noopener");
});

function setupWa() {
  document.querySelectorAll("[data-wa]").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const cargo = planner.summary();
      window.open(waLink(t("wa.hello") + (cargo ? " " + t("wa.cargo", { list: cargo }) : "")), "_blank", "noopener");
    };
  });
}

i18n.onChange((lang) => { render(); planner.setLang(lang); setupWa(); });
i18n.start();
