"use strict";

const $ = (id) => document.getElementById(id);
const input = $("input");
const doc = $("doc");
const pop = $("pop");

const CAT_ORDER = ["hidden", "spell", "grammar", "ai", "style"];
const HIDDEN_SYMBOL = { " ": "⍽", " ": "⍽", " ": "⍽" };

let text = "";
let issues = [];          // сейчас показанные находки
let ltIssues = [];        // находки LanguageTool (сдвигаются при правках)
let nextId = 1;
let current = null;       // открытая в попапе находка или слово

// ---------- Мелочи ----------
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ } },
};
const ignored = new Set(store.get("tc-ignored", []));

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("is-error", isError);
  t.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-visible"), 3200);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function updateStats() {
  const src = doc.hidden ? input.value : text;
  const words = (src.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  $("stats").textContent = `${words} ${plural(words, "слово", "слова", "слов")} · ${src.length} ${plural(src.length, "знак", "знака", "знаков")}`;
}

// ---------- Проверка ----------
function ltCategory(match) {
  const type = match.rule?.issueType;
  if (type === "misspelling") return "spell";
  if (["style", "register", "uncategorized"].includes(type)) return "style";
  return "grammar";
}

async function fetchLanguageTool(src) {
  const lang = $("lang").value;
  const body = new URLSearchParams({ text: src, language: lang });
  if (lang === "auto") body.set("preferredVariants", "en-US,de-DE");
  const res = await fetch("/api/lt/check", { method: "POST", body });
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  const data = await res.json();
  return data.matches.map((m) => {
    const word = src.substr(m.offset, m.length);
    return {
      offset: m.offset,
      length: m.length,
      cat: ltCategory(m),
      title: m.shortMessage || m.rule?.category?.name || "Замечание",
      message: m.message,
      replacements: (m.replacements || []).slice(0, 8).map((r) => r.value),
      word,
    };
  }).filter((i) => !(i.cat === "spell" && ignored.has(i.word.toLowerCase())));
}

async function check() {
  text = input.value;
  if (!text.trim()) { toast("Вставьте текст для проверки"); input.focus(); return; }
  closePop();
  $("busy").hidden = false;
  $("check-btn").disabled = true;
  try {
    ltIssues = await fetchLanguageTool(text);
  } catch (err) {
    ltIssues = [];
    toast(`Орфография не проверена: ${err.message}. Признаки ИИ проверены.`, true);
  } finally {
    $("busy").hidden = true;
    $("check-btn").disabled = false;
  }
  rescan();
  showReview();
}

/** Пересчитать признаки ИИ и собрать список без пересечений. */
function rescan() {
  const ai = AIMarks.scan(text);
  const all = [...ltIssues, ...ai.found];
  all.sort((a, b) => a.offset - b.offset || CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat));
  const kept = [];
  for (const issue of all) {
    const clash = kept.findIndex((k) => issue.offset < k.offset + k.length && k.offset < issue.offset + issue.length);
    if (clash === -1) { kept.push(issue); continue; }
    if (CAT_ORDER.indexOf(issue.cat) < CAT_ORDER.indexOf(kept[clash].cat)) kept[clash] = issue;
  }
  issues = kept.sort((a, b) => a.offset - b.offset).map((i) => ({ ...i, id: nextId++ }));
  renderVerdict(ai);
  renderCounts();
}

// ---------- Отрисовка ----------
function wordSpans(chunk) {
  return esc(chunk).replace(/[\p{Script=Cyrillic}][\p{Script=Cyrillic}-]*/gu, (w) => `<span class="w">${w}</span>`);
}

function renderDoc() {
  let html = "", pos = 0;
  for (const i of issues) {
    html += wordSpans(text.slice(pos, i.offset));
    const raw = text.substr(i.offset, i.length);
    let inner = esc(raw);
    if (i.hiddenChar) inner = `<span class="sym">${HIDDEN_SYMBOL[raw] || "◆"}</span>${raw === " " || raw === " " ? " " : ""}`;
    html += `<mark class="m m--${i.cat}" data-id="${i.id}" tabindex="0">${inner}</mark>`;
    pos = i.offset + i.length;
  }
  html += wordSpans(text.slice(pos));
  doc.innerHTML = html + "\n";
}

function renderCounts() {
  const counts = { spell: 0, grammar: 0, style: 0, ai: 0, hidden: 0 };
  for (const i of issues) counts[i.cat]++;
  for (const [cat, n] of Object.entries(counts)) document.querySelector(`[data-count="${cat}"]`).textContent = n;
  $("fix-all-btn").disabled = !issues.some((i) => i.cat === "spell" && i.replacements.length);
  $("clean-btn").disabled = !counts.hidden;
}

function renderVerdict(ai) {
  const s = ai.score;
  $("ai-meter").style.width = `${Math.max(s, 3)}%`;
  const v = $("verdict");
  v.dataset.level = s >= 55 ? "high" : s >= 25 ? "mid" : "low";
  $("ai-verdict").textContent =
    s >= 55 ? `Много признаков ИИ (${s} из 100)`
    : s >= 25 ? `Есть признаки ИИ (${s} из 100)`
    : `Похоже на живой текст (${s} из 100)`;
  $("ai-reasons").innerHTML = ai.reasons.map((r) => `<li>${esc(r)}</li>`).join("");
}

function showReview() {
  renderDoc();
  input.hidden = true;
  doc.hidden = false;
  $("edit-btn").hidden = false;
  $("hint").hidden = false;
  updateStats();
}

function showEditor() {
  closePop();
  input.value = text;
  doc.hidden = true;
  input.hidden = false;
  $("edit-btn").hidden = true;
  input.focus();
}

// ---------- Правки ----------
function replaceRange(offset, length, value, skipId) {
  const delta = value.length - length;
  text = text.slice(0, offset) + value + text.slice(offset + length);
  ltIssues = ltIssues
    .filter((i) => !(i.offset < offset + length && offset < i.offset + i.length) && !(length === 0 && i.offset === offset))
    .map((i) => (i.offset >= offset + length ? { ...i, offset: i.offset + delta } : i));
  input.value = text;
  store.set("tc-draft", text);
}

function commit() {
  rescan();
  renderDoc();
  updateStats();
}

function applyFix(issue, value) {
  replaceRange(issue.offset, issue.length, value);
  closePop();
  commit();
}

function fixAll(predicate) {
  const list = issues.filter(predicate).sort((a, b) => b.offset - a.offset);
  for (const i of list) replaceRange(i.offset, i.length, i.replacements[0]);
  commit();
  return list.length;
}

// ---------- Попап ----------
function openPop(anchor, data) {
  current = data;
  $("pop-title").textContent = data.title;
  $("pop-msg").textContent = data.message || "";
  $("pop-msg").hidden = !data.message;

  const opts = $("pop-options");
  opts.innerHTML = "";
  for (const r of data.replacements || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt opt--main";
    b.textContent = r === "" ? "Удалить символ" : r === " " ? "Обычный пробел" : r;
    b.addEventListener("click", () => applyFix(data, r));
    opts.appendChild(b);
  }
  opts.hidden = !opts.children.length;

  $("pop-ignore").hidden = !data.id;
  $("pop-learn").hidden = data.cat !== "spell";

  const formsWord = pickFormsWord(data);
  $("pop-forms").hidden = true;
  if (formsWord) loadForms(formsWord, data);

  pop.hidden = false;
  placePop(anchor);
  (opts.querySelector("button") || $("pop-ignore")).focus({ preventScroll: true });
}

function pickFormsWord(data) {
  const single = (w) => w && /^[\p{Script=Cyrillic}-]+$/u.test(w) && w.length > 1;
  if (data.cat === "spell" && single(data.replacements?.[0])) return data.replacements[0];
  const raw = text.substr(data.offset, data.length);
  return single(raw) ? raw : null;
}

async function loadForms(word, data) {
  try {
    const res = await fetch(`/api/forms?word=${encodeURIComponent(word)}`);
    if (!res.ok || current !== data) return;
    const { forms } = await res.json();
    const original = text.substr(data.offset, data.length);
    const list = forms.filter((f) => f.word !== original);
    if (!list.length || current !== data) return;
    $("pop-forms-title").textContent = word === original ? "Другие формы" : `Формы слова «${word}»`;
    const box = $("pop-forms-list");
    box.innerHTML = "";
    for (const f of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.innerHTML = `${esc(f.word)}<small>${esc(f.label)}</small>`;
      b.addEventListener("click", () => applyFix(data, f.word));
      box.appendChild(b);
    }
    $("pop-forms").hidden = false;
    placePop(current.anchor);
  } catch { /* формы — дополнительная подсказка, без них можно */ }
}

function placePop(anchor) {
  if (!anchor || window.matchMedia("(max-width: 640px)").matches) { pop.style.left = pop.style.top = ""; return; }
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 16);
  let top = r.bottom + window.scrollY + 8;
  if (r.bottom + h + 16 > window.innerHeight && r.top > h + 16) top = r.top + window.scrollY - h - 8;
  pop.style.left = `${Math.max(16, left)}px`;
  pop.style.top = `${top}px`;
}

function closePop() {
  pop.hidden = true;
  current = null;
  doc.querySelectorAll(".is-current").forEach((e) => e.classList.remove("is-current"));
}

doc.addEventListener("click", (e) => {
  const mark = e.target.closest(".m");
  const word = e.target.closest(".w");
  doc.querySelectorAll(".is-current").forEach((el) => el.classList.remove("is-current"));
  if (mark) {
    const issue = issues.find((i) => i.id === Number(mark.dataset.id));
    if (!issue) return;
    mark.classList.add("is-current");
    openPop(mark, Object.assign(issue, { anchor: mark }));
  } else if (word) {
    // Смещение слова: считаем по тексту до него в DOM
    const range = document.createRange();
    range.setStart(doc, 0);
    range.setEndBefore(word);
    const offset = domTextLength(range.cloneContents());
    word.classList.add("is-current");
    openPop(word, { title: word.textContent, message: "", replacements: [], offset, length: word.textContent.length, anchor: word });
  } else {
    closePop();
  }
});

doc.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("m")) { e.preventDefault(); e.target.click(); }
});

/** Длина исходного текста во фрагменте: значки скрытых символов считаются по их реальной длине. */
function domTextLength(fragment) {
  let n = 0;
  const walk = (node) => {
    if (node.nodeType === 3) { n += node.nodeValue.length; return; }
    if (node.classList?.contains("m")) {
      const issue = issues.find((i) => i.id === Number(node.dataset.id));
      n += issue ? issue.length : node.textContent.length;
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(fragment);
  return n;
}

$("pop-ignore").addEventListener("click", () => {
  if (!current?.id) return;
  ltIssues = ltIssues.filter((i) => !(i.offset === current.offset && i.length === current.length));
  issues = issues.filter((i) => i.id !== current.id);
  closePop();
  renderDoc();
  renderCounts();
});

$("pop-learn").addEventListener("click", () => {
  if (!current) return;
  const w = text.substr(current.offset, current.length).toLowerCase();
  ignored.add(w);
  store.set("tc-ignored", [...ignored]);
  ltIssues = ltIssues.filter((i) => !(i.cat === "spell" && i.word.toLowerCase() === w));
  closePop();
  commit();
  toast(`«${w}» больше не считается ошибкой`);
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) closePop(); });
document.addEventListener("click", (e) => {
  if (!pop.hidden && !pop.contains(e.target) && !doc.contains(e.target)) closePop();
});
window.addEventListener("resize", () => { if (current) placePop(current.anchor); });

// ---------- Кнопки ----------
$("check-btn").addEventListener("click", check);
$("edit-btn").addEventListener("click", showEditor);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
});
input.addEventListener("input", () => { store.set("tc-draft", input.value); updateStats(); });

$("fix-all-btn").addEventListener("click", () => {
  const n = fixAll((i) => i.cat === "spell" && i.replacements.length);
  toast(`Исправлено опечаток: ${n}`);
});

$("clean-btn").addEventListener("click", () => {
  const n = fixAll((i) => i.cat === "hidden");
  toast(`Убрано скрытых символов и подмен: ${n}`);
});

$("copy-btn").addEventListener("click", async () => {
  const src = doc.hidden ? input.value : text;
  if (!src) return;
  try {
    await navigator.clipboard.writeText(src);
  } catch {
    // На http без HTTPS буфер обмена недоступен через API — копируем через выделение.
    const t = document.createElement("textarea");
    t.value = src;
    t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  toast("Текст скопирован");
});

$("filters").addEventListener("change", (e) => {
  const cat = e.target.dataset.cat;
  if (cat) document.body.classList.toggle(`hide-${cat}`, !e.target.checked);
});

// ---------- Старт ----------
const host = `${location.protocol}//${location.hostname}`;
$("monitor-link").href = `${host}:8080`;
$("pf-link").href = `${host}:8082`;
input.value = store.get("tc-draft", "");
updateStats();
