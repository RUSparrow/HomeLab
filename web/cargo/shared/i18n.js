// Языки для сайтов грузоперевозок.
// Русский текст берётся прямо из HTML (data-i18n), переводы — из словаря сайта.
//   <h1 data-i18n="hero.title">Фура до 24 тонн…</h1>
//   <input data-i18n-attr="placeholder:form.km">
//   <div data-lang-switch></div>  — сюда встанет переключатель

export const LANGS = [
  { code: "ru", short: "RU", name: "Русский" },
  { code: "et", short: "ET", name: "Eesti" },
  { code: "en", short: "EN", name: "English" },
  { code: "fi", short: "FI", name: "Suomi" },
  { code: "de", short: "DE", name: "Deutsch" },
];
const CODES = LANGS.map((l) => l.code);
const STORE_KEY = "cargo-lang";

export function createI18n(dict, { onChange } = {}) {
  dict.ru = dict.ru || {};
  const listeners = onChange ? [onChange] : [];

  // Русские исходники из разметки
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (!(key in dict.ru)) dict.ru[key] = el.innerHTML.trim();
  });
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(",")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (!(key in dict.ru)) dict.ru[key] = el.getAttribute(attr) || "";
    }
  });
  if (!("meta.title" in dict.ru)) dict.ru["meta.title"] = document.title;
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc && !("meta.desc" in dict.ru)) dict.ru["meta.desc"] = metaDesc.content;

  let lang = pickInitial();

  function pickInitial() {
    const fromUrl = new URLSearchParams(location.search).get("lang");
    if (CODES.includes(fromUrl)) return fromUrl;
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (CODES.includes(saved)) return saved;
    } catch { /* без localStorage — по браузеру */ }
    for (const l of navigator.languages || [navigator.language || "ru"]) {
      const code = l.slice(0, 2).toLowerCase();
      if (CODES.includes(code)) return code;
    }
    return "ru";
  }

  /** Перевод: t("calc.days", { n: 3 }). Значение-объект — формы множественного числа. */
  function t(key, vars = {}) {
    let s = dict[lang]?.[key] ?? dict.ru[key] ?? key;
    if (typeof s === "object") {
      const form = new Intl.PluralRules(lang).select(vars.n ?? 0);
      s = s[form] ?? s.other ?? s.many ?? Object.values(s)[0];
    }
    return String(s).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
  }

  function applyDom() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      for (const pair of el.dataset.i18nAttr.split(",")) {
        const [attr, key] = pair.split(":").map((s) => s.trim());
        el.setAttribute(attr, t(key));
      }
    });
    document.title = t("meta.title");
    if (metaDesc) metaDesc.content = t("meta.desc");
    document.querySelectorAll("[data-lang-switch]").forEach(renderSwitch);
    listeners.forEach((fn) => fn(lang));
  }

  function set(code) {
    if (!CODES.includes(code) || code === lang) return;
    lang = code;
    try { localStorage.setItem(STORE_KEY, code); } catch { /* ничего */ }
    const url = new URL(location.href);
    url.searchParams.set("lang", code);
    history.replaceState(null, "", url);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (document.startViewTransition && !reduce) document.startViewTransition(applyDom);
    else applyDom();
  }

  function renderSwitch(box) {
    const cur = LANGS.find((l) => l.code === lang);
    box.classList.add("lang");
    box.innerHTML = `
      <button type="button" class="lang__btn" aria-haspopup="true" aria-expanded="false" aria-label="${t("lang.choose")}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>
        <span>${cur.short}</span>
      </button>
      <ul class="lang__menu" role="menu" hidden>
        ${LANGS.map((l) => `<li role="none"><button type="button" role="menuitemradio" aria-checked="${l.code === lang}" data-lang="${l.code}" lang="${l.code}"><b>${l.short}</b>${l.name}</button></li>`).join("")}
      </ul>`;
    const btn = box.querySelector(".lang__btn");
    const menu = box.querySelector(".lang__menu");
    const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      document.querySelectorAll(".lang__menu").forEach((m) => { m.hidden = true; });
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector('[aria-checked="true"]')?.focus();
    });
    menu.addEventListener("click", (e) => {
      const item = e.target.closest("[data-lang]");
      if (item) { close(); set(item.dataset.lang); }
    });
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      if (e.key === "Escape") { close(); btn.focus(); }
    });
  }

  document.addEventListener("click", () => document.querySelectorAll(".lang__menu").forEach((m) => { m.hidden = true; }));

  return {
    t,
    set,
    get lang() { return lang; },
    onChange(fn) { listeners.push(fn); },
    start() { applyDom(); },
  };
}
