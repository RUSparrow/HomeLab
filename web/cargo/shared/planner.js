// 3D-планировщик загрузки: клиент вводит габариты мест, а мы раскладываем их
// в кузове (стенками от кабины к дверям) и показываем, сколько занято по
// длине, ширине, высоте и весу.
import * as THREE from "./three.module.min.js";
import { OrbitControls } from "./OrbitControls.js";
import { buildVehicle } from "./vehicles.js";

const STR = {
  ru: {
    presets: "Добавить одним нажатием", custom: "Свой груз, см", len: "Длина", wid: "Ширина", hei: "Высота",
    qty: "Кол-во", kg: "Вес 1 шт, кг", stack: "Можно ставить сверху", tilt: "Можно класть на бок",
    add: "Добавить", list: "Груз", empty: "Пока пусто. Нажмите на готовый груз или введите свои размеры.",
    clear: "Очистить", remove: "Убрать", pcs: "шт", custom1: "Свой груз",
    v3d: "3D", vside: "Сбоку", vtop: "Сверху", vrear: "Сзади",
    byLen: "Длина", byWid: "Ширина", byHei: "Высота", byVol: "Объём", byKg: "Вес",
    of: "из", ldm: "{n} LDM", allFit: "Всё помещается за один рейс", notFit: "Не поместилось мест: {n}. Нужен второй рейс или машина больше.",
    overweight: "Перегруз: {kg} кг сверх нормы", hint: "Крутите модель мышью или пальцем. Колесо — приблизить.",
    tooBig: "Это место больше кузова по одному из размеров", errDims: "Укажите длину, ширину и высоту",
    m: "м", t: "т", kgU: "кг",
    orient: "Плоские места ставим:", oAuto: "Авто", oAlong: "Вдоль", oAcross: "Поперёк", doorsRear: "Открыть ворота", doorsRearClose: "Закрыть ворота", doorsVan: "Открыть двери", doorsVanClose: "Закрыть двери", tarpOpen: "Открыть тент", tarpOpenClose: "Закрыть тент",
  },
  et: {
    presets: "Lisa ühe klõpsuga", custom: "Oma koorem, cm", len: "Pikkus", wid: "Laius", hei: "Kõrgus",
    qty: "Kogus", kg: "1 tk kaal, kg", stack: "Võib peale laduda", tilt: "Võib külili panna",
    add: "Lisa", list: "Koorem", empty: "Veel tühi. Vali valmis koorem või sisesta oma mõõdud.",
    clear: "Tühjenda", remove: "Eemalda", pcs: "tk", custom1: "Oma koorem",
    v3d: "3D", vside: "Küljelt", vtop: "Ülevalt", vrear: "Tagant",
    byLen: "Pikkus", byWid: "Laius", byHei: "Kõrgus", byVol: "Maht", byKg: "Kaal",
    of: "/", ldm: "{n} LDM", allFit: "Kõik mahub ühe veoga", notFit: "Ei mahtunud: {n} tk. Vaja teist vedu või suuremat autot.",
    overweight: "Ülekaal: {kg} kg üle lubatu", hint: "Pööra mudelit hiire või sõrmega. Ratas — suumi.",
    tooBig: "See koorem on mõnes mõõdus kastist suurem", errDims: "Sisesta pikkus, laius ja kõrgus",
    m: "m", t: "t", kgU: "kg",
    orient: "Alused paigutame:", oAuto: "Auto", oAlong: "Pikuti", oAcross: "Põiki", doorsRear: "Ava uksed", doorsRearClose: "Sulge uksed", doorsVan: "Ava uksed", doorsVanClose: "Sulge uksed", tarpOpen: "Ava kardin", tarpOpenClose: "Sulge kardin",
  },
  en: {
    presets: "Add with one tap", custom: "Your cargo, cm", len: "Length", wid: "Width", hei: "Height",
    qty: "Qty", kg: "Weight each, kg", stack: "Can be stacked on", tilt: "Can lie on its side",
    add: "Add", list: "Cargo", empty: "Nothing yet. Tap a preset or enter your own dimensions.",
    clear: "Clear", remove: "Remove", pcs: "pcs", custom1: "Your item",
    v3d: "3D", vside: "Side", vtop: "Top", vrear: "Rear",
    byLen: "Length", byWid: "Width", byHei: "Height", byVol: "Volume", byKg: "Weight",
    of: "of", ldm: "{n} LDM", allFit: "Everything fits in one trip", notFit: "{n} items didn’t fit. You need a second trip or a bigger vehicle.",
    overweight: "Overweight by {kg} kg", hint: "Drag to rotate the model. Scroll or pinch to zoom.",
    tooBig: "This item is larger than the cargo body in one dimension", errDims: "Enter length, width and height",
    m: "m", t: "t", kgU: "kg",
    orient: "Place pallets:", oAuto: "Auto", oAlong: "Lengthwise", oAcross: "Crosswise", doorsRear: "Open doors", doorsRearClose: "Close doors", doorsVan: "Open doors", doorsVanClose: "Close doors", tarpOpen: "Open curtain", tarpOpenClose: "Close curtain",
  },
  fi: {
    presets: "Lisää yhdellä napautuksella", custom: "Oma kuorma, cm", len: "Pituus", wid: "Leveys", hei: "Korkeus",
    qty: "Määrä", kg: "Paino/kpl, kg", stack: "Päälle saa pinota", tilt: "Saa kääntää kyljelleen",
    add: "Lisää", list: "Kuorma", empty: "Vielä tyhjää. Valitse valmis kuorma tai syötä omat mitat.",
    clear: "Tyhjennä", remove: "Poista", pcs: "kpl", custom1: "Oma kuorma",
    v3d: "3D", vside: "Sivulta", vtop: "Ylhäältä", vrear: "Takaa",
    byLen: "Pituus", byWid: "Leveys", byHei: "Korkeus", byVol: "Tilavuus", byKg: "Paino",
    of: "/", ldm: "{n} LDM", allFit: "Kaikki mahtuu yhdellä kerralla", notFit: "Ei mahtunut: {n} kpl. Tarvitaan toinen kuljetus tai isompi auto.",
    overweight: "Ylipaino: {kg} kg yli sallitun", hint: "Pyöritä mallia hiirellä tai sormella. Rulla — zoomaa.",
    tooBig: "Kuorma on jossain mitassa lavaa suurempi", errDims: "Syötä pituus, leveys ja korkeus",
    m: "m", t: "t", kgU: "kg",
    orient: "Lavat asetetaan:", oAuto: "Auto", oAlong: "Pitkittäin", oAcross: "Poikittain", doorsRear: "Avaa ovet", doorsRearClose: "Sulje ovet", doorsVan: "Avaa ovet", doorsVanClose: "Sulje ovet", tarpOpen: "Avaa pressu", tarpOpenClose: "Sulje pressu",
  },
  de: {
    presets: "Mit einem Tipp hinzufügen", custom: "Eigene Ladung, cm", len: "Länge", wid: "Breite", hei: "Höhe",
    qty: "Anzahl", kg: "Gewicht/Stk., kg", stack: "Stapelbar", tilt: "Darf gekippt werden",
    add: "Hinzufügen", list: "Ladung", empty: "Noch leer. Tippen Sie auf eine Vorlage oder geben Sie eigene Maße ein.",
    clear: "Leeren", remove: "Entfernen", pcs: "Stk.", custom1: "Eigene Ladung",
    v3d: "3D", vside: "Seite", vtop: "Oben", vrear: "Hinten",
    byLen: "Länge", byWid: "Breite", byHei: "Höhe", byVol: "Volumen", byKg: "Gewicht",
    of: "von", ldm: "{n} LDM", allFit: "Alles passt in eine Fahrt", notFit: "{n} Stück passen nicht. Zweite Fahrt oder größeres Fahrzeug nötig.",
    overweight: "Überladen um {kg} kg", hint: "Modell mit Maus oder Finger drehen. Mausrad — Zoom.",
    tooBig: "Dieses Stück ist in einer Richtung größer als der Laderaum", errDims: "Länge, Breite und Höhe angeben",
    m: "m", t: "t", kgU: "kg",
    orient: "Paletten stellen:", oAuto: "Auto", oAlong: "Längs", oAcross: "Quer", doorsRear: "Türen öffnen", doorsRearClose: "Türen schließen", doorsVan: "Türen öffnen", doorsVanClose: "Türen schließen", tarpOpen: "Plane öffnen", tarpOpenClose: "Plane schließen",
  },
};

// ---------------------------------------------------------------------------
// Укладка: «крайние точки» — первая подходящая точка ближе к кабине,
// сначала по полу поперёк, потом вверх, затем к дверям.
// clearance — зазор между местами (см): паллеты никогда не встают вплотную.
// orient — как ставить нештабелируемые «плоские» места: along (длинной
// стороной вдоль кузова), across (поперёк), free, auto (лучший из трёх).
// obstacles — то, что занимает пол (колёсные арки фургона).
// ---------------------------------------------------------------------------
export function pack(container, pieces, opts = {}) {
  if ((opts.orient || "auto") !== "auto") return packOnce(container, pieces, opts);
  const tries = ["along", "across", "free"].map((o) => packOnce(container, pieces, { ...opts, orient: o }));
  tries.sort((a, b) => a.unplaced.length - b.unplaced.length || a.usedLen - b.usedLen);
  return tries[0];
}

function packOnce(container, pieces, { clearance = 0, orient = "free", obstacles = [] } = {}) {
  const { L, W, H } = container;
  const placed = obstacles.map((o) => ({ x: o.x, y: o.z, z: 0, l: o.l, w: o.w, h: o.h, stack: true, obstacle: true }));
  const unplaced = [];
  let points = [{ x: 0, y: 0, z: 0 }];
  for (const o of placed) {
    points.push({ x: o.x + o.l, y: o.y, z: 0 }, { x: o.x, y: o.y + o.w, z: 0 }, { x: o.x, y: o.y, z: o.h });
    // Вдоль препятствия тоже можно ставить: от передней стенки рядом с аркой
    points.push({ x: 0, y: o.y + o.w, z: 0 }, { x: 0, y: Math.max(0, o.y), z: 0 });
  }

  const order = [...pieces].sort((a, b) =>
    b.w * b.d * b.h - a.w * a.d * a.h || Math.max(b.w, b.d) - Math.max(a.w, a.d));

  const overlaps = (x, y, z, l, w, h) => placed.some((p) =>
    x < p.x + p.l && p.x < x + l && y < p.y + p.w && p.y < y + w && z < p.z + p.h && p.z < z + h);

  function supported(x, y, z, l, w) {
    if (z === 0) return true;
    let area = 0;
    for (const p of placed) {
      if (Math.abs(p.z + p.h - z) > 0.01) continue;
      const ox = Math.min(x + l, p.x + p.l) - Math.max(x, p.x);
      const oy = Math.min(y + w, p.y + p.w) - Math.max(y, p.y);
      if (ox > 0 && oy > 0) {
        if (!p.stack) return false;           // на нештабелируемое не ставим
        area += ox * oy;
      }
    }
    return area >= 0.75 * l * w;
  }

  for (const piece of order) {
    const { w, d, h } = piece;
    let orients = [[w, d, h], [d, w, h]];
    if (!piece.tilt && w !== d) {
      if (orient === "along") orients = [[Math.max(w, d), Math.min(w, d), h]];
      if (orient === "across") orients = [[Math.min(w, d), Math.max(w, d), h]];
    }
    if (piece.tilt) orients.push([w, h, d], [h, w, d], [d, h, w], [h, d, w]);
    // Зазор — только по полу; по высоте места стоят друг на друге
    orients = orients.map(([l, ww, hh]) => [l + clearance, ww + clearance, hh]);
    points.sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);

    let best = null;
    for (const pt of points) {
      for (const [l, ww, hh] of orients) {
        if (pt.x + l > L + clearance || pt.y + ww > W + clearance || pt.z + hh > H) continue;
        if (overlaps(pt.x, pt.y, pt.z, l, ww, hh)) continue;
        if (!supported(pt.x, pt.y, pt.z, l, ww)) continue;
        const score = pt.x + l;               // меньше расходуем длину кузова
        if (!best || score < best.score || (score === best.score && hh < best.h)) best = { ...pt, l, w: ww, h: hh, score };
      }
      if (best) break;                        // точки отсортированы — первая годная лучшая
    }

    if (!best) { unplaced.push(piece); continue; }
    const box = { x: best.x, y: best.y, z: best.z, l: best.l, w: best.w, h: best.h, cl: clearance, piece, stack: piece.stack };
    placed.push(box);
    points.push({ x: box.x + box.l, y: box.y, z: box.z }, { x: box.x, y: box.y + box.w, z: box.z }, { x: box.x, y: box.y, z: box.z + box.h });
    points = points.filter((p) => p.x < L && p.y < W && p.z < H &&
      !placed.some((q) => p.x >= q.x && p.x < q.x + q.l && p.y >= q.y && p.y < q.y + q.w && p.z >= q.z && p.z < q.z + q.h));
  }
  const cargo = placed.filter((p) => !p.obstacle);
  const usedLen = Math.max(0, ...cargo.map((b) => b.x + b.l));
  return { placed: cargo, unplaced, usedLen };
}

// ---------------------------------------------------------------------------
// Интерфейс
// ---------------------------------------------------------------------------
export function mountPlanner(root, opts) {
  const { vehicle, presets, colors, start = [], maxPieces = 400 } = opts;
  let lang = opts.lang || "ru";
  let lines = [];                 // { key, name(fn|string), w, d, h, qty, kg, stack, tilt, color }
  let orient = "auto";
  let nextKey = 1;
  const s = (k, vars = {}) => (STR[lang]?.[k] ?? STR.ru[k]).replace(/\{(\w+)\}/g, (_, v) => vars[v]);
  const presetName = (p) => (typeof p.name === "function" ? p.name(lang) : p.name);
  const num = (n, d = 1) => n.toLocaleString(lang, { maximumFractionDigits: d });

  root.classList.add("planner");
  root.innerHTML = `
    <div class="planner__side">
      <p class="planner__label" data-s="presets"></p>
      <div class="planner__presets"></div>
      <details class="planner__custom">
        <summary data-s="custom"></summary>
        <form class="planner__form" novalidate>
          <label><span data-s="len"></span><input name="w" type="number" min="1" inputmode="numeric" required></label>
          <label><span data-s="wid"></span><input name="d" type="number" min="1" inputmode="numeric" required></label>
          <label><span data-s="hei"></span><input name="h" type="number" min="1" inputmode="numeric" required></label>
          <label><span data-s="qty"></span><input name="qty" type="number" min="1" max="300" value="1" inputmode="numeric"></label>
          <label class="planner__wide"><span data-s="kg"></span><input name="kg" type="number" min="0" inputmode="numeric" placeholder="0"></label>
          <label class="planner__chk"><input name="stack" type="checkbox" checked><span data-s="stack"></span></label>
          <label class="planner__chk"><input name="tilt" type="checkbox"><span data-s="tilt"></span></label>
          <p class="planner__err" role="alert"></p>
          <button type="submit" class="planner__add" data-s="add"></button>
        </form>
      </details>
      <div class="planner__listhead"><p class="planner__label" data-s="list"></p><button type="button" class="planner__clear" data-s="clear"></button></div>
      <ul class="planner__list"></ul>
    </div>
    <div class="planner__stage">
      <div class="planner__views" role="group">
        <button type="button" data-view="iso" aria-pressed="true" data-s="v3d"></button>
        <button type="button" data-view="side" data-s="vside"></button>
        <button type="button" data-view="top" data-s="vtop"></button>
        <button type="button" data-view="rear" data-s="vrear"></button>
        <button type="button" class="planner__doors" aria-pressed="false"></button>
      </div>
      <div class="planner__canvas"></div>
      <p class="planner__hint" data-s="hint"></p>
      <div class="planner__status" role="status" aria-live="polite"></div>
      <div class="planner__bars"></div>
      <div class="planner__orient" role="group">
        <span data-s="orient"></span>
        <button type="button" data-orient="auto" aria-pressed="true" data-s="oAuto"></button>
        <button type="button" data-orient="along" aria-pressed="false" data-s="oAlong"></button>
        <button type="button" data-orient="across" aria-pressed="false" data-s="oAcross"></button>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const form = $(".planner__form");

  // ---------- 3D ----------
  const canvasBox = $(".planner__canvas");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  canvasBox.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 2;
  controls.maxDistance = 80;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3ad, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-6, 12, 8);
  scene.add(sun);

  const L = vehicle.L / 100, W = vehicle.W / 100, H = vehicle.H / 100;
  const deckY = vehicle.deck / 100;     // высота пола кузова над землёй
  const center = new THREE.Vector3(L / 2, deckY + H / 2, W / 2);

  const veh = buildVehicle(vehicle, colors);
  scene.add(veh.group);
  // Мягкая тень под машиной
  const front = vehicle.front;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(L + front + 2.5, W + 2.2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set((L - front) / 2, 0.002, W / 2);
  scene.add(shadow);
  const cargoGroup = new THREE.Group();
  cargoGroup.position.y = deckY;
  scene.add(cargoGroup);

  function mat(color, extra = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra }); }

  // Камера: расстояние подбираем так, чтобы машина с кабиной целиком влезла в кадр
  const fullLen = L + front + 0.3;
  const midX = (L - front) / 2;
  controls.target.set(midX, deckY * 0.6 + H / 2, W / 2);
  function dist(span) {
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(0.6, camera.aspect));
    return (span / 2) / Math.tan(Math.min(vfov, hfov) / 2) * 0.86;
  }
  const VIEWS = {
    iso:  () => { const d = dist(Math.hypot(fullLen, W, H + deckY)); const dir = new THREE.Vector3(0.55, 0.5, 0.67).normalize(); return controls.target.clone().addScaledVector(dir, d); },
    side: () => controls.target.clone().add(new THREE.Vector3(0, 0.3, dist(fullLen) + W / 2)),
    top:  () => controls.target.clone().add(new THREE.Vector3(0, dist(fullLen) + H, 0.01)),
    rear: () => controls.target.clone().add(new THREE.Vector3(dist(Math.max(W, H + deckY)) * 1.3 + fullLen / 2, 0.4, 0)),
  };
  let camAnim = null;
  function goView(name, instant = false) {
    const to = VIEWS[name]();
    root.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === name)));
    if (instant) { camera.position.copy(to); controls.update(); return; }
    camAnim = { from: camera.position.clone(), to, t0: performance.now(), dur: 700 };
    kick();
  }

  // Анимация «падения» мест в кузов
  let drops = [];
  function rebuildCargo(result) {
    cargoGroup.clear();
    const now = performance.now() + (reduceMotion || doorT > 0.9 ? 0 : 650);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    drops = [];
    result.placed.forEach((b, i) => {
      const geo = new THREE.BoxGeometry((b.l - b.cl) / 100 - 0.005, b.h / 100 - 0.006, (b.w - b.cl) / 100 - 0.005);
      const mesh = new THREE.Mesh(geo, mat(b.piece.color));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1b1f24, transparent: true, opacity: 0.55 }));
      mesh.add(edges);
      const target = new THREE.Vector3((b.x + b.l / 2) / 100, (b.z + b.h / 2) / 100 + 0.002, (b.y + b.w / 2) / 100);
      mesh.position.copy(target);
      if (!reduce) {
        mesh.position.y += 2.2;
        drops.push({ mesh, target, t0: now + Math.min(i * 28, 1400), dur: 420 });
      }
      cargoGroup.add(mesh);
    });
    if (!reduceMotion && result.placed.length) {
      clearTimeout(closeTimer);
      setDoors(true);
      const endAt = Math.min(result.placed.length * 28, 1400) + 420 + (now - performance.now()) + 700;
      if (!doorsPinned) closeTimer = setTimeout(() => { if (!doorsPinned) setDoors(false); }, endAt);
    }
    // Не поместившееся — красным рядом с машиной
    let ux = 0;
    for (const p of result.unplaced.slice(0, 40)) {
      const geo = new THREE.BoxGeometry(p.w / 100, p.h / 100, p.d / 100);
      const mesh = new THREE.Mesh(geo, mat(0xe5484d, { transparent: true, opacity: 0.55 }));
      mesh.position.set(L + 0.8 + ux + p.w / 200, p.h / 200 - deckY, W + 0.9 + p.d / 200);
      ux += p.w / 100 + 0.1;
      cargoGroup.add(mesh);
    }
    kick();
  }

  let doorT = 0, doorTarget = 0, doorsPinned = false, closeTimer = 0, lastNow = 0;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function setDoors(open, pinned = doorsPinned) {
    doorTarget = open ? 1 : 0;
    doorsPinned = pinned;
    const b = $(".planner__doors");
    if (b) { b.setAttribute("aria-pressed", String(open)); b.textContent = s(open ? veh.openKey + "Close" : veh.openKey); }
    if (reduceMotion) { doorT = doorTarget; veh.setOpen(doorT); }
    kick();
  }

  let running = false;
  function kick() { if (!running) { running = true; lastNow = performance.now(); requestAnimationFrame(tick); } }
  function tick(now) {
    let busy = controls.update();
    const dt = Math.min(64, now - lastNow);
    lastNow = now;
    if (doorT !== doorTarget) {
      doorT = doorTarget > doorT ? Math.min(doorTarget, doorT + dt / 1100) : Math.max(doorTarget, doorT - dt / 1100);
      veh.setOpen(doorT);
      busy = true;
    }
    if (camAnim) {
      const k = Math.min(1, (now - camAnim.t0) / camAnim.dur);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(camAnim.from, camAnim.to, e);
      camera.lookAt(controls.target);
      if (k >= 1) camAnim = null; else busy = true;
    }
    drops = drops.filter((d) => {
      const k = (now - d.t0) / d.dur;
      if (k < 0) { busy = true; return true; }
      const e = k >= 1 ? 1 : 1 - Math.pow(1 - k, 3) + Math.sin(k * Math.PI) * 0.06;
      d.mesh.position.y = d.target.y + (1 - Math.min(1, e)) * 2.2;
      if (k >= 1) { d.mesh.position.y = d.target.y; return false; }
      busy = true;
      return true;
    });
    renderer.render(scene, camera);
    if (busy) requestAnimationFrame(tick); else running = false;
  }
  controls.addEventListener("change", kick);
  controls.addEventListener("start", () => root.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", "false")));

  function resize() {
    const w = canvasBox.clientWidth, h = canvasBox.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    kick();
  }
  let firstFit = true;
  new ResizeObserver(() => { resize(); if (firstFit && canvasBox.clientWidth) { firstFit = false; goView("iso", true); } }).observe(canvasBox);
  goView("iso", true);

  // ---------- Данные ----------
  function addLine(src, qty = 1) {
    const same = lines.find((l) => l.preset && l.preset === src.preset);
    if (same) { same.qty = Math.min(300, same.qty + qty); return; }
    lines.push({ key: nextKey++, color: colors.cargo[(lines.length) % colors.cargo.length], ...src, qty });
  }

  function update() {
    const pieces = [];
    for (const l of lines) for (let i = 0; i < l.qty && pieces.length < maxPieces; i++) pieces.push(l);
    const result = pack(vehicle, pieces, { clearance: vehicle.clearance || 0, orient, obstacles: vehicle.arches || [] });
    rebuildCargo(result);
    renderList();
    renderStats(result, pieces);
  }

  function lineName(l) { return l.preset ? presetName(presets.find((p) => p.id === l.preset)) : s("custom1", { w: l.w, d: l.d, h: l.h }); }

  function renderList() {
    const ul = $(".planner__list");
    $(".planner__clear").hidden = !lines.length;
    if (!lines.length) { ul.innerHTML = `<li class="planner__empty">${s("empty")}</li>`; return; }
    ul.innerHTML = lines.map((l) => `
      <li>
        <i style="background:#${l.color.toString(16).padStart(6, "0")}"></i>
        <span class="planner__name">${lineName(l)}<small>${l.w}×${l.d}×${l.h} · ${l.kg ? l.kg + " " + s("kgU") : "—"}</small></span>
        <span class="planner__qty">
          <button type="button" data-dec="${l.key}" aria-label="−">−</button>
          <b>${l.qty}</b>
          <button type="button" data-inc="${l.key}" aria-label="+">+</button>
        </span>
        <button type="button" class="planner__x" data-del="${l.key}" aria-label="${s("remove")}">×</button>
      </li>`).join("");
  }

  function bar(label, value, max, text) {
    const k = max ? value / max : 0;
    const cls = k > 1.0001 ? " is-over" : "";
    return `<div class="pbar${cls}"><span class="pbar__label">${label}</span><span class="pbar__track"><span style="width:${Math.min(100, k * 100)}%"></span></span><span class="pbar__val">${text}</span></div>`;
  }

  function renderStats(result, pieces) {
    const P = result.placed;
    const maxX = Math.max(0, ...P.map((b) => b.x + b.l));
    const maxY = Math.max(0, ...P.map((b) => b.y + b.w));
    const maxZ = Math.max(0, ...P.map((b) => b.z + b.h));
    const vol = P.reduce((a, b) => a + b.l * b.w * b.h, 0) / 1e6;
    const cap = (vehicle.L * vehicle.W * vehicle.H) / 1e6;
    const kg = pieces.reduce((a, p) => a + (p.kg || 0), 0);
    const m = s("m");
    const tons = vehicle.payload >= 5000;
    const kgText = (v) => (tons ? `${num(v / 1000)} ${s("t")}` : `${num(v, 0)} ${s("kgU")}`);
    let lenText = `${num(maxX / 100)} ${s("of")} ${num(vehicle.L / 100)} ${m}`;
    // Загрузочный метр — метр длины полуприцепа шириной 2,4 м; шире 2,4 м не считаем
    if (vehicle.ldm) lenText += ` · ${s("ldm", { n: num((maxX / 100) * Math.min(1, maxY / 240)) })}`;
    $(".planner__bars").innerHTML =
      bar(s("byLen"), maxX, vehicle.L, lenText) +
      bar(s("byWid"), maxY, vehicle.W, `${num(maxY / 100, 2)} ${s("of")} ${num(vehicle.W / 100, 2)} ${m}`) +
      bar(s("byHei"), maxZ, vehicle.H, `${num(maxZ / 100, 2)} ${s("of")} ${num(vehicle.H / 100, 2)} ${m}`) +
      bar(s("byVol"), vol, cap, `${num(vol)} ${s("of")} ${num(cap, 0)} м³`.replace("м³", "m³")) +
      bar(s("byKg"), kg, vehicle.payload, `${kgText(kg)} ${s("of")} ${kgText(vehicle.payload)}`);

    const st = $(".planner__status");
    st.className = "planner__status";
    const msgs = [];
    if (!pieces.length) { st.textContent = ""; return; }
    if (result.unplaced.length) { msgs.push(s("notFit", { n: result.unplaced.length })); st.classList.add("is-bad"); }
    if (kg > vehicle.payload) { msgs.push(s("overweight", { kg: num(kg - vehicle.payload, 0) })); st.classList.add("is-bad"); }
    if (!msgs.length) { msgs.push(s("allFit")); st.classList.add("is-ok"); }
    st.textContent = msgs.join(" ");
    root.dispatchEvent(new CustomEvent("planner:change", { detail: { lines, result, kg, vol } }));
  }

  function renderTexts() {
    root.querySelectorAll("[data-s]").forEach((el) => { el.textContent = s(el.dataset.s); });
    $(".planner__doors").textContent = s(doorTarget > 0.5 ? veh.openKey + "Close" : veh.openKey);
    $(".planner__presets").innerHTML = presets.map((p) =>
      `<button type="button" class="planner__preset" data-preset="${p.id}">${presetName(p)}<small>${p.w}×${p.d}×${p.h}</small></button>`).join("");
  }

  // ---------- События ----------
  $(".planner__presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    const p = presets.find((x) => x.id === b.dataset.preset);
    addLine({ preset: p.id, w: p.w, d: p.d, h: p.h, kg: p.kg, stack: p.stack, tilt: p.tilt });
    update();
  });

  $(".planner__list").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const key = Number(t.dataset.inc || t.dataset.dec || t.dataset.del);
    const l = lines.find((x) => x.key === key);
    if (!l) return;
    if (t.dataset.inc) l.qty = Math.min(300, l.qty + 1);
    if (t.dataset.dec) l.qty -= 1;
    if (t.dataset.del || l.qty <= 0) lines = lines.filter((x) => x !== l);
    update();
  });

  $(".planner__clear").addEventListener("click", () => { lines = []; update(); });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const w = Number(f.get("w")), d = Number(f.get("d")), h = Number(f.get("h"));
    const err = $(".planner__err");
    if (!(w > 0 && d > 0 && h > 0)) { err.textContent = s("errDims"); return; }
    const dims = [w, d, h].sort((a, b) => a - b);
    const body = [vehicle.L, vehicle.W, vehicle.H].sort((a, b) => a - b);
    if (dims.some((v, i) => v > body[i])) { err.textContent = s("tooBig"); return; }
    err.textContent = "";
    addLine({ w, d, h, kg: Number(f.get("kg")) || 0, stack: f.get("stack") === "on", tilt: f.get("tilt") === "on" }, Math.max(1, Math.min(300, Number(f.get("qty")) || 1)));
    update();
  });

  root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => goView(b.dataset.view)));
  root.querySelectorAll("[data-orient]").forEach((b) => b.addEventListener("click", () => {
    orient = b.dataset.orient;
    root.querySelectorAll("[data-orient]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    update();
  }));
  $(".planner__doors").addEventListener("click", () => {
    clearTimeout(closeTimer);
    const open = doorTarget < 0.5;
    setDoors(open, open);
  });

  // Стартовый пример
  for (const [id, qty] of start) {
    const p = presets.find((x) => x.id === id);
    if (p) addLine({ preset: p.id, w: p.w, d: p.d, h: p.h, kg: p.kg, stack: p.stack, tilt: p.tilt }, qty);
  }
  renderTexts();
  update();

  return {
    setLang(code) { lang = code; renderTexts(); update(); },
    summary() {
      return lines.map((l) => `${lineName(l)} ${l.w}×${l.d}×${l.h} ×${l.qty}`).join("; ");
    },
  };
}
