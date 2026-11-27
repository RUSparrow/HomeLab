// Модели машин для 3D-планировщика. Не точные копии, а узнаваемые силуэты:
// кабина с лобовым стеклом, фарами, решёткой и зеркалами, рама, колёса с
// дисками, кузов с прозрачными стенками, чтобы был виден груз, и двери,
// которые открываются.
//
// Система координат совпадает с планировщиком (всё в метрах):
//   x — вдоль кузова, от передней стенки (0) к дверям (L); кабина при x < 0;
//   z — поперёк, внутренняя ширина от 0 до W; y — вверх от земли.
import * as THREE from "./three.module.min.js";
import { RoundedBoxGeometry } from "./RoundedBoxGeometry.js";

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08, ...o });
const GLASS = () => mat(0x1d2730, { roughness: 0.12, metalness: 0.55 });
const RUBBER = () => mat(0x1b1d20, { roughness: 0.9 });
const STEEL = () => mat(0xb9bec4, { roughness: 0.35, metalness: 0.6 });
const DARK = () => mat(0x2b2f34, { roughness: 0.7 });
const LAMP = () => mat(0xf4f6f8, { emissive: 0x9aa4ad, emissiveIntensity: 0.25, roughness: 0.2 });
const RED = () => mat(0xc4242b, { emissive: 0x5a0d10, emissiveIntensity: 0.3 });

function box(w, h, d, m, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function rbox(w, h, d, r, m, x, y, z) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, r), m);
  mesh.position.set(x, y, z);
  return mesh;
}

// Колесо: шина, диск и ступица; ось колеса — вдоль z
function wheel(r, width, rimColor = 0xc9cdd2) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, width, 32), RUBBER());
  tire.rotation.x = Math.PI / 2;
  g.add(tire);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, width + 0.01, 24), mat(rimColor, { metalness: 0.6, roughness: 0.3 }));
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.2, width + 0.03, 12), DARK());
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  return g;
}
function axle(group, x, r, width, zs, rim) {
  for (const z of zs) {
    const w = wheel(r, width, rim);
    w.position.set(x, r, z);
    group.add(w);
  }
}

// Плоский многоугольник в плоскости xy (на высоте z)
function flat(points, m, z) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), m);
  mesh.position.z = z;
  return mesh;
}

// Тент: светлая ткань со стяжными ремнями и люверсами (рисуем на canvas)
function tarpTexture(len, hei, base = "#e4e7ea", strap = "#c7ccd1") {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = base; g.fillRect(0, 0, c.width, c.height);
  const n = Math.max(4, Math.round(len / 0.6));
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * c.width;
    g.fillStyle = strap; g.fillRect(x - 5, 0, 10, c.height);
    g.fillStyle = "#8a9096"; g.fillRect(x - 7, c.height - 22, 14, 16);
  }
  g.fillStyle = "#b5bbc1"; g.fillRect(0, c.height - 30, c.width, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Прозрачная стенка кузова: видно груз, но понятно, где борт
const wallMat = (color, opacity = 0.16, map = null) => new THREE.MeshStandardMaterial({
  color, map, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.8,
});

// Пол кузова чуть ниже уровня груза и с polygonOffset — без мерцания
function deck(L, W, y, color, thick = 0.08, pad = 0.04) {
  const m = mat(color, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  return box(L + pad, thick, W + pad, m, L / 2, y - thick / 2 - 0.004, W / 2);
}

function outline(w, h, d, color, x, y, z) {
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
  e.position.set(x, y, z);
  return e;
}

// Дверь на шарнире: поворачивается вокруг вертикальной оси
function hingedDoor(w, h, m, hingeX, y, hingeZ, side) {
  const pivot = new THREE.Group();
  pivot.position.set(hingeX, y, hingeZ);
  const panel = box(0.04, h, w, m, 0, h / 2, side * w / 2);
  pivot.add(panel);
  const handle = box(0.03, 0.5, 0.04, STEEL(), 0.03, h / 2, side * (w - 0.12));
  pivot.add(handle);
  pivot.add(outline(0.04, h, w, 0x333a40, 0, h / 2, side * w / 2));
  return pivot;
}

// Лобовое стекло: тонкая плита, уложенная по наклону от низа (xb, yb) к верху (xt, yt)
function windshield(g, xb, yb, xt, yt, width, cz) {
  const dx = xt - xb, dy = yt - yb, len = Math.hypot(dx, dy);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.03, len - 0.06, width), GLASS());
  glass.rotation.z = -(Math.PI / 2 - Math.atan2(dy, dx));   // верх уходит назад, к салону
  const nx = -dy / len, ny = dx / len;                       // наружная нормаль: вперёд и вверх
  glass.position.set((xb + xt) / 2 + nx * 0.045, (yb + yt) / 2 + ny * 0.045, cz);
  g.add(glass);
}

// Зеркало на кронштейне
function mirror(g, x, y, z, side) {
  g.add(box(0.05, 0.05, 0.22, DARK(), x, y + 0.05, z - side * 0.11));
  g.add(box(0.1, 0.34, 0.09, DARK(), x, y - 0.08, z));
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// =====================================================================
// Фура: тягач Actros-подобный + тентованный полуприцеп 13,6 м
// =====================================================================
function semi(v, c) {
  const L = v.L / 100, W = v.W / 100, H = v.H / 100, D = v.deck / 100;
  const g = new THREE.Group();
  const white = c.cab;

  // --- Полуприцеп ---
  g.add(deck(L, W, D, 0x8b6f4e));
  g.add(box(L + 0.1, 0.26, 0.16, DARK(), L / 2, D - 0.22, 0.35));
  g.add(box(L + 0.1, 0.26, 0.16, DARK(), L / 2, D - 0.22, W - 0.35));
  // Боковые защитные трубы между опорами и колёсами
  for (const z of [-0.02, W + 0.02]) {
    for (const dy of [0.25, 0.45]) g.add(box(L - 7.2, 0.05, 0.05, STEEL(), 3 + (L - 7.2) / 2, D - dy - 0.15, z));
  }
  // Передняя стенка — сплошная
  g.add(box(0.06, H, W + 0.06, mat(white), -0.03, D + H / 2, W / 2));
  // Тент по бокам и крыша — полупрозрачные
  const tex = tarpTexture(L, H);
  for (const z of [-0.03, W + 0.03]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(L, H), wallMat(0xffffff, 0.34, tex));
    side.position.set(L / 2, D + H / 2, z);
    g.add(side);
  }
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(L, W + 0.06), wallMat(0xe9ecef, 0.25));
  roof.rotation.x = -Math.PI / 2;
  roof.position.set(L / 2, D + H + 0.02, W / 2);
  g.add(roof);
  g.add(outline(L, H, W + 0.06, 0x2b3036, L / 2, D + H / 2, W / 2));
  // Колёса: три оси сзади
  for (const x of [L - 3.9, L - 2.6, L - 1.3]) {
    axle(g, x, 0.52, 0.42, [0.24, W - 0.24]);
    g.add(box(1.0, 0.04, 0.5, DARK(), x, 1.08, -0.02));
    g.add(box(1.0, 0.04, 0.5, DARK(), x, 1.08, W + 0.02));
  }
  // Опорные ноги
  for (const z of [0.45, W - 0.45]) g.add(box(0.12, D - 0.35, 0.12, STEEL(), 2.6, (D - 0.35) / 2 + 0.05, z));
  // Фонари
  for (const z of [0.15, W - 0.15]) g.add(box(0.03, 0.12, 0.28, RED(), L + 0.03, D - 0.18, z));

  // --- Тягач ---
  const cabL = 2.35, cabH = 2.95, cabY = 0.95, cabX = -0.95 - cabL / 2;
  g.add(box(4.6, 0.28, 0.9, DARK(), -1.1, 0.95, W / 2));                          // рама
  g.add(rbox(cabL, cabH, W + 0.02, 0.18, mat(white), cabX, cabY + cabH / 2, W / 2));  // кабина
  const front = cabX - cabL / 2;
  g.add(box(0.04, 1.05, W - 0.25, GLASS(), front - 0.005, cabY + 2.0, W / 2));     // лобовое
  g.add(box(0.12, 0.16, W - 0.1, DARK(), front - 0.02, cabY + 2.62, W / 2));       // козырёк
  g.add(box(0.05, 0.9, W - 0.55, DARK(), front - 0.01, cabY + 0.95, W / 2));       // решётка
  for (let i = 0; i < 4; i++) g.add(box(0.06, 0.04, W - 0.6, STEEL(), front - 0.02, cabY + 0.62 + i * 0.22, W / 2));
  g.add(rbox(0.22, 0.38, W + 0.04, 0.06, DARK(), front + 0.02, 0.72, W / 2));        // бампер
  for (const z of [0.28, W - 0.28]) g.add(box(0.04, 0.16, 0.42, LAMP(), front - 0.01, 0.86, z));
  for (const z of [-0.01, W + 0.01]) {
    g.add(box(0.85, 0.85, 0.02, GLASS(), front + 0.6, cabY + 2.05, z));           // боковые окна
    const arm = box(0.05, 0.05, 0.35, DARK(), front + 0.35, cabY + 2.2, z < 1 ? -0.17 : W + 0.17);
    g.add(arm);
    g.add(box(0.08, 0.5, 0.14, DARK(), front + 0.32, cabY + 1.95, z < 1 ? -0.36 : W + 0.36));
    g.add(box(0.9, 0.5, 0.06, STEEL(), front + 1.55, 0.95, z < 1 ? -0.05 : W + 0.05)); // ступени/бак
  }
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.1, 20), STEEL());
  tank.rotation.z = Math.PI / 2;
  tank.position.set(-0.4, 0.75, -0.1);
  g.add(tank);
  axle(g, front + 0.8, 0.5, 0.36, [0.1, W - 0.1]);
  axle(g, 1.0, 0.5, 0.42, [0.22, W - 0.22]);
  axle(g, 1.0, 0.5, 0.42, [0.6, W - 0.6]);

  // --- Задние ворота: две створки на 270° ---
  const dm = wallMat(0xf1f3f5, 0.5);
  const half = (W + 0.06) / 2;
  const left = hingedDoor(half, H, dm, L + 0.03, D, -0.03, 1);
  const right = hingedDoor(half, H, dm, L + 0.03, D, W + 0.03, -1);
  g.add(left, right);
  const setOpen = (t) => {
    const a = ease(t) * Math.PI * 1.45;
    left.rotation.y = a;      // створки распахиваются наружу и ложатся на борта
    right.rotation.y = -a;
  };
  return { group: g, setOpen, openKey: "doorsRear" };
}

// =====================================================================
// Фургон: Peugeot Boxer-подобный цельнометаллический L3H2
// =====================================================================
function van(v, c) {
  const L = v.L / 100, W = v.W / 100, H = v.H / 100, D = v.deck / 100;
  const g = new THREE.Group();
  const t = 0.09;                       // толщина борта
  const top = D + H + 0.08, xr = L + 0.06, bot = 0.4;
  const zL = -t, zR = W + t;
  const white = mat(c.cab);

  // --- Кабина: экструзия бокового силуэта ---
  const fx = -0.25, xFront = -2.2, xF = -1.5, rw = 0.36;
  const cab = new THREE.Shape();
  cab.moveTo(fx, bot);
  cab.lineTo(fx, top);
  cab.lineTo(-0.55, top);
  cab.quadraticCurveTo(-0.75, top, -0.85, top - 0.12);
  cab.lineTo(-1.45, 1.42);
  cab.quadraticCurveTo(-1.55, 1.3, -1.75, 1.25);
  cab.lineTo(xFront + 0.08, 1.12);
  cab.quadraticCurveTo(xFront, 1.1, xFront, 0.95);
  cab.lineTo(xFront, bot + 0.05);
  cab.lineTo(xF - rw - 0.06, bot);
  cab.absarc(xF, rw, rw + 0.06, Math.PI, 0, true);
  cab.lineTo(fx, bot);
  const cabGeo = new THREE.ExtrudeGeometry(cab, { depth: zR - zL - 0.08, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 3, curveSegments: 16 });
  const cabMesh = new THREE.Mesh(cabGeo, white);
  cabMesh.position.z = zL + 0.04;
  g.add(cabMesh);
  // Стёкла: лобовое по наклону и боковые окна
  windshield(g, -1.45, 1.42, -0.85, top - 0.12, W + 2 * t - 0.22, W / 2);
  for (const z of [zL - 0.002, zR + 0.002]) {
    const win = flat([[-0.3, top - 0.18], [-0.82, top - 0.18], [-1.35, 1.5], [-0.3, 1.5]], GLASS(), z);
    if (z > W) win.rotation.y = 0; else win.material.side = THREE.DoubleSide;
    g.add(win);
  }
  // Морда: решётка, фары, бампер, зеркала
  // Кабина скруглена на 4 см — решётку, фары и бампер ставим поверх скругления
  g.add(box(0.05, 0.26, 1.05, DARK(), xFront - 0.055, 0.8, W / 2));
  for (let i = 0; i < 3; i++) g.add(box(0.06, 0.03, 1.0, STEEL(), xFront - 0.07, 0.72 + i * 0.08, W / 2));
  g.add(rbox(0.18, 0.3, W + 2 * t + 0.06, 0.05, DARK(), xFront - 0.02, 0.52, W / 2));
  for (const z of [zL + 0.24, zR - 0.24]) g.add(box(0.05, 0.13, 0.36, LAMP(), xFront - 0.055, 1.0, z));
  mirror(g, -1.38, 1.72, zL - 0.2, -1);
  mirror(g, -1.38, 1.72, zR + 0.2, 1);

  // --- Грузовой отсек: прозрачные борта, крыша, проём сдвижной двери ---
  g.add(deck(L, W, D, 0x6f747a, 0.06, 0.02));
  g.add(box(xr + 2.1, 0.12, W * 0.9, DARK(), (xr - 2.1) / 2, 0.38, W / 2));        // днище между колёсами
  const xB = 2.45;
  const sideShape = (withDoor) => {
    const s = new THREE.Shape();
    s.moveTo(fx, bot); s.lineTo(fx, top); s.lineTo(xr, top); s.lineTo(xr, bot);
    s.lineTo(xB + rw + 0.06, bot); s.absarc(xB, rw, rw + 0.06, 0, Math.PI, false); s.lineTo(fx, bot);
    if (withDoor) {
      const h = new THREE.Path();
      h.moveTo(0.12, D + 0.02); h.lineTo(1.4, D + 0.02); h.lineTo(1.4, top - 0.12); h.lineTo(0.12, top - 0.12); h.lineTo(0.12, D + 0.02);
      s.holes.push(h);
    }
    return s;
  };
  const wall = wallMat(0xffffff, 0.2);
  const wl = new THREE.Mesh(new THREE.ShapeGeometry(sideShape(false), 16), wall);
  wl.position.z = zL;
  const wr = new THREE.Mesh(new THREE.ShapeGeometry(sideShape(true), 16), wall);
  wr.position.z = zR;
  g.add(wl, wr);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(xr - fx, zR - zL), wallMat(0xffffff, 0.22));
  roof.rotation.x = -Math.PI / 2;
  roof.position.set((xr + fx) / 2, top, W / 2);
  g.add(roof);
  g.add(outline(xr - fx, top - bot, zR - zL, 0x3a4148, (xr + fx) / 2, (top + bot) / 2, W / 2));
  // Колёсные арки внутри кузова (по ним считаем раскладку)
  for (const a of v.arches || []) g.add(box(a.l / 100, a.h / 100, a.w / 100, mat(0x9aa0a6), (a.x + a.l / 2) / 100, D + a.h / 200, (a.z + a.w / 2) / 100));
  axle(g, xF, rw, 0.24, [zL + 0.1, zR - 0.1]);
  axle(g, xB, rw, 0.24, [zL + 0.1, zR - 0.1]);
  for (const z of [0.25, W - 0.25]) g.add(box(0.03, 0.22, 0.12, RED(), xr + 0.02, top - 1.0, z));

  // --- Сдвижная боковая дверь и задние распашные ---
  const dm = wallMat(0xf4f5f7, 0.55);
  const slide = new THREE.Group();
  slide.add(box(1.28, top - 0.12 - D - 0.02, 0.04, dm, 0.76, (top - 0.12 + D + 0.02) / 2, 0));
  slide.add(outline(1.28, top - 0.12 - D - 0.02, 0.04, 0x3a4148, 0.76, (top - 0.12 + D + 0.02) / 2, 0));
  slide.add(box(0.05, 0.22, 0.05, STEEL(), 0.25, D + 0.9, 0.04));
  slide.position.z = zR + 0.005;
  g.add(slide);
  const half = (zR - zL) / 2, dh = top - bot - 0.06;
  const left = hingedDoor(half, dh, dm, xr + 0.02, bot + 0.03, zL, 1);
  const right = hingedDoor(half, dh, dm, xr + 0.02, bot + 0.03, zR, -1);
  g.add(left, right);

  const setOpen = (t) => {
    // Сдвижная: сначала отходит от борта, потом едет назад
    const a = ease(Math.min(1, t * 1.6));
    const out = Math.min(1, a * 4) * 0.09;
    slide.position.set(Math.max(0, a - 0.2) / 0.8 * 1.3, 0, zR + 0.005 + out);
    const b = ease(Math.max(0, (t - 0.25) / 0.75)) * Math.PI * 1.45;
    left.rotation.y = b;
    right.rotation.y = -b;
  };
  return { group: g, setOpen, openKey: "doorsVan" };
}

// =====================================================================
// Crafter-подобный с бортовой платформой и тентом
// =====================================================================
function tent(v, c) {
  const L = v.L / 100, W = v.W / 100, H = v.H / 100, D = v.deck / 100;
  const g = new THREE.Group();
  const white = mat(c.cab);
  const cw = 2.05, cz = W / 2;               // ширина кабины
  const cabTop = 2.45, bot = 0.42, xFront = -2.35, fx = -0.18, xF = -1.65, rw = 0.37;

  // --- Кабина (профиль как у современного фургона) ---
  const s = new THREE.Shape();
  s.moveTo(fx, bot); s.lineTo(fx, cabTop); s.lineTo(-0.7, cabTop);
  s.quadraticCurveTo(-0.9, cabTop, -1.0, cabTop - 0.12);
  s.lineTo(-1.55, 1.45);
  s.quadraticCurveTo(-1.7, 1.3, -1.95, 1.27);
  s.lineTo(xFront + 0.08, 1.15);
  s.quadraticCurveTo(xFront, 1.12, xFront, 0.98);
  s.lineTo(xFront, bot + 0.05); s.lineTo(xF - rw - 0.06, bot);
  s.absarc(xF, rw, rw + 0.06, Math.PI, 0, true); s.lineTo(fx, bot);
  const cab = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: cw - 0.08, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 3, curveSegments: 16 }), white);
  cab.position.z = cz - cw / 2 + 0.04;
  g.add(cab);
  windshield(g, -1.55, 1.45, -1.0, cabTop - 0.12, cw - 0.2, cz);
  for (const z of [cz - cw / 2 - 0.002, cz + cw / 2 + 0.002]) {
    const win = flat([[-0.25, cabTop - 0.18], [-0.95, cabTop - 0.18], [-1.45, 1.52], [-0.25, 1.52]], GLASS(), z);
    win.material.side = THREE.DoubleSide;
    g.add(win);
  }
  // Морда современного фургона: широкая решётка с ламелями, узкие фары, тёмный бампер
  g.add(box(0.05, 0.3, 1.35, DARK(), xFront - 0.055, 0.84, cz));
  for (let i = 0; i < 3; i++) g.add(box(0.06, 0.03, 1.3, STEEL(), xFront - 0.07, 0.75 + i * 0.09, cz));
  g.add(rbox(0.2, 0.34, cw + 0.06, 0.05, DARK(), xFront - 0.02, 0.55, cz));
  for (const z of [cz - cw / 2 + 0.26, cz + cw / 2 - 0.26]) g.add(box(0.05, 0.1, 0.4, LAMP(), xFront - 0.055, 1.04, z));
  mirror(g, -1.48, 1.8, cz - cw / 2 - 0.2, -1);
  mirror(g, -1.48, 1.8, cz + cw / 2 + 0.2, 1);
  // Обтекатель на крыше кабины — до высоты тента
  const sp = new THREE.Shape([new THREE.Vector2(fx, cabTop), new THREE.Vector2(-0.95, cabTop), new THREE.Vector2(fx, D + H - 0.05)]);
  const spoiler = new THREE.Mesh(new THREE.ExtrudeGeometry(sp, { depth: cw - 0.2, bevelEnabled: false }), mat(c.cab, { side: THREE.DoubleSide }));
  spoiler.position.z = cz - (cw - 0.2) / 2;
  g.add(spoiler);

  // --- Рама, платформа, алюминиевые борта ---
  g.add(box(L + 2.4, 0.18, 0.9, DARK(), (L - 2.4) / 2, D - 0.2, W / 2));
  g.add(deck(L, W, D, 0x9a8f80, 0.08, 0.06));
  const board = 0.4, alu = STEEL();
  g.add(box(L + 0.06, board, 0.04, alu, L / 2, D + board / 2, -0.03));
  g.add(box(0.04, board, W + 0.06, alu, -0.03, D + board / 2, W / 2));
  g.add(box(0.04, board, W + 0.06, alu, L + 0.03, D + board / 2, W / 2));
  g.add(box(L + 0.06, board, 0.04, alu, L / 2, D + board / 2, W + 0.03));
  // Стойки и дуги каркаса
  for (const x of [0.02, L / 3, (2 * L) / 3, L - 0.02]) {
    for (const z of [-0.03, W + 0.03]) g.add(box(0.05, H, 0.05, alu, x, D + H / 2, z));
    g.add(box(0.05, 0.05, W + 0.06, alu, x, D + H, W / 2));
  }

  // --- Тент: серо-белый, полупрозрачный ---
  const tex = tarpTexture(L, H - board);
  const tarpH = H - board;
  const leftTarp = new THREE.Mesh(new THREE.PlaneGeometry(L, tarpH), wallMat(0xffffff, 0.5, tex));
  leftTarp.position.set(L / 2, D + board + tarpH / 2, -0.05);
  g.add(leftTarp);
  // Правый тент сдвигается назад — собран в «гармошку» у задней стойки
  const pivot = new THREE.Group();
  pivot.position.set(L, D + board, W + 0.05);
  const rightTarp = new THREE.Mesh(new THREE.PlaneGeometry(L, tarpH), wallMat(0xffffff, 0.5, tarpTexture(L, tarpH)));
  rightTarp.position.set(-L / 2, tarpH / 2, 0);
  pivot.add(rightTarp);
  g.add(pivot);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(L, W + 0.1), wallMat(0xdfe3e6, 0.45));
  roof.rotation.x = -Math.PI / 2;
  roof.position.set(L / 2, D + H + 0.03, W / 2);
  g.add(roof);
  g.add(box(0.03, H - board, W + 0.06, wallMat(0xe4e7ea, 0.6), -0.05, D + board + (H - board) / 2, W / 2));

  axle(g, xF, rw, 0.24, [cz - cw / 2 + 0.12, cz + cw / 2 - 0.12]);
  axle(g, 2.75, rw, 0.22, [0.05, 0.3, W - 0.3, W - 0.05]);
  for (const z of [0.2, W - 0.2]) g.add(box(0.03, 0.12, 0.25, RED(), L + 0.06, D - 0.12, z));

  const setOpen = (t) => {
    const a = ease(t);
    pivot.scale.x = 1 - a * 0.9;            // тент собирается к задней стойке
  };
  return { group: g, setOpen, openKey: "tarpOpen" };
}

export function buildVehicle(v, colors) {
  const fn = { semi, van, tent }[v.kind];
  return fn(v, colors);
}
