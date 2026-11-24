"use strict";

// Личные данные лежат в profile.json (в .gitignore — репозиторий публичный).
// Если его нет, страница показывает шаблон из profile.example.json.
const LANGS = ["et", "ru", "en"];
let P = null;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function pickLang() {
  const saved = localStorage.getItem("lang");
  if (LANGS.includes(saved)) return saved;
  const nav = (navigator.language || "et").slice(0, 2);
  return LANGS.includes(nav) ? nav : "et";
}

function renderLab(t) {
  const lanes = $("lab-lanes");
  lanes.replaceChildren();
  const rows = [
    ["lane_access", P.lab.access],
    ["lane_services", P.lab.services],
    ["lane_watch", P.lab.watch],
  ];
  rows.forEach(([key, items]) => {
    const lane = el("div", "lane");
    lane.append(el("p", "lane__title", t[key]));
    const ul = el("ul", "lane__items");
    items.forEach((i) => ul.append(el("li", null, i)));
    lane.append(ul);
    lanes.append(lane);
  });
}

function render(lang) {
  const t = P.i18n[lang];
  document.documentElement.lang = lang;
  document.title = P.name;

  document.querySelectorAll("[data-t]").forEach((n) => {
    n.textContent = t[n.dataset.t] ?? "";
  });
  document.querySelectorAll("[data-lang]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  });

  $("top-name").textContent = P.name;
  $("name").textContent = P.name;
  $("role").textContent = t.role;
  $("intro").textContent = t.intro;
  $("cta-mail").href = `mailto:${P.email}`;
  $("cta-github").href = P.github;
  $("foot").textContent = t.foot;

  renderLab(t);

  const tl = $("timeline");
  tl.replaceChildren();
  t.timeline.forEach((e) => {
    const li = el("li", "timeline__item");
    li.append(el("span", "timeline__when", e.when));
    const body = el("div", "timeline__body");
    body.append(el("p", "timeline__what", e.what), el("p", "timeline__where", e.where));
    li.append(body);
    tl.append(li);
  });

  const sg = $("skill-groups");
  sg.replaceChildren();
  t.skill_groups.forEach((g) => {
    const box = el("div", "skills__group");
    box.append(el("h3", null, g.title));
    const ul = el("ul");
    g.items.forEach((i) => ul.append(el("li", null, i)));
    box.append(ul);
    sg.append(box);
  });

  const cl = $("contact-list");
  cl.replaceChildren();
  const mail = el("a", null, P.email);
  mail.href = `mailto:${P.email}`;
  const gh = el("a", null, P.github.replace(/^https?:\/\//, ""));
  gh.href = P.github;
  gh.target = "_blank";
  gh.rel = "noopener noreferrer";
  [
    [t.contact_email, mail],
    ["GitHub", gh],
    [t.contact_city, document.createTextNode(P.city)],
    [t.contact_langs, document.createTextNode(t.langs)],
  ].forEach(([k, v]) => {
    const row = el("div", "contact__row");
    const dd = el("dd");
    dd.append(v);
    row.append(el("dt", null, k), dd);
    cl.append(row);
  });
}

async function load() {
  for (const file of ["profile.json", "profile.example.json"]) {
    try {
      const r = await fetch(file, { cache: "no-store" });
      if (r.ok) return r.json();
    } catch { /* try next */ }
  }
  throw new Error("profile.json not found");
}

load()
  .then((data) => {
    P = data;
    const lang = pickLang();
    render(lang);
    document.querySelectorAll("[data-lang]").forEach((b) =>
      b.addEventListener("click", () => {
        localStorage.setItem("lang", b.dataset.lang);
        render(b.dataset.lang);
      })
    );
  })
  .catch(() => {
    $("name").textContent = "profile.json puudub / не найден";
  });
