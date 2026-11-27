// Витрина для первого экрана: машина из планировщика, медленно покачивается,
// при появлении один раз открывает двери или тент и показывает груз.
// Без управления мышью — это картинка, а не инструмент.
import * as THREE from "./three.module.min.js";
import { buildVehicle } from "./vehicles.js?v=3";
import { pack } from "./planner.js?v=3";

export function mountShowcase(el, { vehicle, colors, cargo = [], view = [0.62, 0.32, 0.72], openDelay = 900 }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;                       // без WebGL остаётся запасная картинка
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);
  el.classList.add("is-3d");

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8f979f, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-5, 9, 7);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.9);   // подсветка со стороны камеры — кабина белая, а не серая
  fill.position.set(-6, 3, 6);
  scene.add(fill);

  const L = vehicle.L / 100, W = vehicle.W / 100, H = vehicle.H / 100, D = vehicle.deck / 100;
  const veh = buildVehicle(vehicle, colors);
  const rig = new THREE.Group();
  rig.add(veh.group);

  // Груз внутри — та же укладка, что в планировщике
  const pieces = [];
  cargo.forEach((c) => { for (let i = 0; i < c.qty; i++) pieces.push(c); });
  const { placed } = pack(vehicle, pieces, { clearance: vehicle.clearance || 0, orient: "auto", obstacles: vehicle.arches || [] });
  for (const b of placed) {
    const geo = new THREE.BoxGeometry((b.l - b.cl) / 100 - 0.005, b.h / 100 - 0.006, (b.w - b.cl) / 100 - 0.005);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: b.piece.color, roughness: 0.75 }));
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1b1f24, transparent: true, opacity: 0.5 })));
    m.position.set((b.x + b.l / 2) / 100, D + (b.z + b.h / 2) / 100 + 0.002, (b.y + b.w / 2) / 100);
    rig.add(m);
  }
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set((L + vehicle.front) * 0.62, (W + 1) * 0.7, 1);
  shadow.position.set((L - vehicle.front) / 2, 0.003, W / 2);
  rig.add(shadow);

  // Вращаем вокруг центра машины
  const cx = (L - vehicle.front) / 2, cz = W / 2;
  rig.position.set(-cx, 0, -cz);
  const turn = new THREE.Group();
  turn.add(rig);
  scene.add(turn);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const target = new THREE.Vector3(0, (D + H) * 0.5, 0);
  const dir = new THREE.Vector3(...view).normalize();

  function fit() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const span = Math.hypot(L + vehicle.front, W, D + H);
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const dist = (span / 2) / Math.tan(Math.min(vfov, hfov) / 2) * 0.8;
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
  }
  new ResizeObserver(fit).observe(el);
  fit();

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t0 = performance.now();
  let visible = true, raf = 0, opened = reduce ? 1 : 0;
  veh.setOpen(opened);

  function frame(now) {
    const t = (now - t0) / 1000;
    turn.rotation.y = Math.sin(t * 0.25) * 0.28;                    // спокойное покачивание
    if (opened < 1 && now - t0 > openDelay) { opened = Math.min(1, opened + 0.012); veh.setOpen(opened); }
    renderer.render(scene, camera);
    raf = visible ? requestAnimationFrame(frame) : 0;
  }
  if (reduce) { veh.setOpen(1); renderer.render(scene, camera); }
  else {
    // Не тратим батарею, когда первый экран прокручен
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(frame);
    }).observe(el);
    raf = requestAnimationFrame(frame);
  }
  return { renderer };
}
