"use strict";

/* Проверка на лету: под прозрачным textarea лежит слой с тем же текстом,
   в котором подсвечены находки. Печатаем в textarea как обычно, а слой
   повторяет его символ в символ. */

const $ = (id) => document.getElementById(id);
const input = $("input");
const backdrop = $("backdrop");
const pop = $("pop");

const CAT_ORDER = ["hidden", "spell", "grammar", "ai", "style"];
const CHECK_DELAY = 800;  // мс тишины после ввода, прежде чем звать LanguageTool

let text = "";
let issues = [];          // показанные находки (без пересечений)
let ltIssues = [];        // находки LanguageTool, сдвигаются при правках
let nextId = 1;
let current = null;       // открытая в попапе находка или слово
let checkTimer = null;
let inflight = null;      // AbortController текущего запроса

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

function setStatus(state, msg) {
  const el = $("status");
  el.dataset.state = state;
  el.textContent = msg;
}

function updateStats() {
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  $("stats").textContent = `${words} ${plural(words, "слово", "слова", "слов")} · ${text.length} ${plural(text.length, "знак", "знака", "знаков")}`;
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

// ---------- LanguageTool ----------
function ltCategory(match) {
  const type = match.rule?.issueType;
  if (type === "misspelling") return "spell";
  if (["style", "register", "uncategorized"].includes(type)) return "style";
  return "grammar";
}

async function runCheck() {
  clearTimeout(checkTimer);
  inflight?.abort();
  const src = text;
  if (!src.trim()) { ltIssues = []; refresh(); setStatus("idle", ""); return; }

  const ctrl = new AbortController();
  inflight = ctrl;
  setStatus("busy", "Проверяю…");
  const lang = $("lang").value;
  const body = new URLSearchParams({ text: src, language: lang });
  if (lang === "auto") body.set("preferredVariants", "en-US,de-DE");

  try {
    const res = await fetch("/api/lt/check", { method: "POST", body, signal: ctrl.signal });
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    const data = await res.json();
    if (src !== text) return;  // пока шёл запрос, текст поменялся — дождёмся следующей проверки
    ltIssues = data.matches.map((m) => ({
      offset: m.offset,
      length: m.length,
      cat: ltCategory(m),
      title: m.shortMessage || m.rule?.category?.name || "Замечание",
      message: m.message,
      replacements: (m.replacements || []).slice(0, 8).map((r) => r.value),
      word: src.substr(m.offset, m.length),
    })).filter((i) => !(i.cat === "spell" && ignored.has(i.word.toLowerCase())));
    refresh();
    setStatus("ok", "Проверено");
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus("error", "Орфография недоступна");
    toast(`Орфография не проверена: ${err.message}. Признаки ИИ проверяются.`, true);
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

function scheduleCheck() {
  clearTimeout(checkTimer);
  setStatus("wait", text.trim() ? "Ждёт паузы в наборе…" : "");
  checkTimer = setTimeout(runCheck, CHECK_DELAY);
}

// ---------- Сборка находок и отрисовка ----------
function refresh() {
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
  renderBackdrop();
  renderVerdict(text.trim() ? ai : null);
  renderCounts();
  updateStats();
}

function renderBackdrop() {
  let html = "", pos = 0;
  for (const i of issues) {
    html += esc(text.slice(pos, i.offset));
    html += `<mark class="m m--${i.cat}${i.hiddenChar ? " m--char" : ""}" data-id="${i.id}">${esc(text.substr(i.offset, i.length))}</mark>`;
    pos = i.offset + i.length;
  }
  // Лишний перевод строки: чтобы последняя пустая строка тоже имела высоту, как в textarea
  backdrop.innerHTML = html + esc(text.slice(pos)) + "\n ";
}

function renderCounts() {
  const counts = { spell: 0, grammar: 0, style: 0, ai: 0, hidden: 0 };
  for (const i of issues) counts[i.cat]++;
  for (const [cat, n] of Object.entries(counts)) document.querySelector(`[data-count="${cat}"]`).textContent = n;
  $("fix-all-btn").disabled = !issues.some((i) => i.cat === "spell" && i.replacements.length);
  $("clean-btn").disabled = !counts.hidden;
}

function renderVerdict(ai) {
  const v = $("verdict");
  if (!ai) {
    $("ai-meter").style.width = "0";
    delete v.dataset.level;
    $("ai-verdict").textContent = "Начните писать, и оценка появится здесь.";
    $("ai-reasons").innerHTML = "";
    return;
  }
  const s = ai.score;
  $("ai-meter").style.width = `${Math.max(s, 3)}%`;
  v.dataset.level = s >= 55 ? "high" : s >= 25 ? "mid" : "low";
  $("ai-verdict").textContent =
    s >= 55 ? `Много признаков ИИ (${s} из 100)`
    : s >= 25 ? `Есть признаки ИИ (${s} из 100)`
    : `Похоже на живой текст (${s} из 100)`;
  $("ai-reasons").innerHTML = ai.reasons.map((r) => `<li>${esc(r)}</li>`).join("");
}

// ---------- Ввод ----------
/** Сдвигает находки LanguageTool под правку: меняется только кусок между общим началом и концом. */
function shiftIssues(oldText, newText) {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText[start] === newText[start]) start++;
  let endOld = oldText.length, endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) { endOld--; endNew--; }
  const delta = endNew - endOld;
  ltIssues = ltIssues
    .filter((i) => i.offset + i.length <= start || i.offset >= endOld)
    // Правка вплотную к концу слова (дописали букву) — старая находка для него уже неверна
    .filter((i) => !(i.offset + i.length === start && /[\p{L}\p{N}]/u.test(newText[start] || "")))
    .map((i) => (i.offset >= endOld ? { ...i, offset: i.offset + delta } : i));
}

input.addEventListener("input", () => {
  const next = input.value;
  shiftIssues(text, next);
  text = next;
  store.set("tc-draft", text);
  closePop();
  autosize();
  refresh();
  scheduleCheck();
});

$("lang").addEventListener("change", runCheck);

/** Заменить кусок текста так, чтобы работала отмена (Ctrl+Z). */
function replaceRange(offset, length, value) {
  input.focus({ preventScroll: true });
  input.setSelectionRange(offset, offset + length);
  const ok = value === "" ? document.execCommand("delete") : document.execCommand("insertText", false, value);
  if (!ok) {
    input.setRangeText(value, offset, offset + length, "end");
    input.dispatchEvent(new Event("input"));
  }
}

function applyFix(target, value) {
  closePop();
  replaceRange(target.offset, target.length, value);
}

function fixAll(predicate) {
  const list = issues.filter(predicate).sort((a, b) => b.offset - a.offset);
  // Одной правкой, чтобы Ctrl+Z откатил всё разом
  let out = text;
  for (const i of list) out = out.slice(0, i.offset) + i.replacements[0] + out.slice(i.offset + i.length);
  if (list.length) replaceRange(0, text.length, out);
  return list.length;
}

// ---------- Попап ----------
/** Прямоугольник куска текста — по слою подсветки, где текст совпадает символ в символ. */
function rectFor(offset, length) {
  const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0, startSet = false, node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!startSet && offset <= pos + len) { range.setStart(node, offset - pos); startSet = true; }
    if (startSet && offset + length <= pos + len) { range.setEnd(node, offset + length - pos); break; }
    pos += len;
  }
  const rects = range.getClientRects();
  return rects[0] || range.getBoundingClientRect();
}

function openPop(data) {
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
  $("pop-forms").hidden = true;
  const formsWord = pickFormsWord(data);
  if (formsWord) loadForms(formsWord, data);

  backdrop.querySelectorAll(".is-current").forEach((e) => e.classList.remove("is-current"));
  if (data.id) backdrop.querySelector(`[data-id="${data.id}"]`)?.classList.add("is-current");

  pop.hidden = false;
  placePop();
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
    placePop();
  } catch { /* формы — дополнительная подсказка */ }
}

function placePop() {
  if (!current || pop.hidden) return;
  if (window.matchMedia("(max-width: 640px)").matches) { pop.style.left = pop.style.top = ""; return; }
  const r = rectFor(current.offset, current.length);
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 16);
  let top = r.bottom + window.scrollY + 8;
  if (r.bottom + h + 16 > window.innerHeight && r.top > h + 16) top = r.top + window.scrollY - h - 8;
  pop.style.left = `${Math.max(16, left)}px`;
  pop.style.top = `${top}px`;
}

function closePop() {
  if (pop.hidden) return;
  pop.hidden = true;
  current = null;
  backdrop.querySelectorAll(".is-current").forEach((e) => e.classList.remove("is-current"));
}

// Клик по подчёркнутому — исправления
input.addEventListener("click", () => {
  if (input.selectionStart !== input.selectionEnd) return;
  const pos = input.selectionStart;
  const issue = issues.find((i) => i.length && pos >= i.offset && pos <= i.offset + i.length && !document.body.classList.contains(`hide-${i.cat}`));
  if (issue) openPop(issue);
  else closePop();
});

// Двойной клик по слову — его формы
input.addEventListener("dblclick", () => {
  const start = input.selectionStart, end = input.selectionEnd;
  const word = text.slice(start, end).trim();
  if (!/^[\p{Script=Cyrillic}-]{2,}$/u.test(word)) return;
  const offset = start + text.slice(start, end).indexOf(word);
  const issue = issues.find((i) => i.offset === offset && i.length === word.length);
  openPop(issue || { title: word, message: "", replacements: [], offset, length: word.length });
});

$("pop-ignore").addEventListener("click", () => {
  if (!current?.id) return;
  const { offset, length } = current;
  ltIssues = ltIssues.filter((i) => !(i.offset === offset && i.length === length));
  closePop();
  refresh();
});

$("pop-learn").addEventListener("click", () => {
  if (!current) return;
  const w = text.substr(current.offset, current.length).toLowerCase();
  ignored.add(w);
  store.set("tc-ignored", [...ignored]);
  ltIssues = ltIssues.filter((i) => !(i.cat === "spell" && i.word.toLowerCase() === w));
  closePop();
  refresh();
  toast(`«${w}» больше не считается ошибкой`);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !pop.hidden) { closePop(); input.focus(); }
});
document.addEventListener("mousedown", (e) => {
  if (!pop.hidden && !pop.contains(e.target) && e.target !== input) closePop();
});
window.addEventListener("resize", () => { autosize(); placePop(); });

// ---------- Кнопки ----------
$("fix-all-btn").addEventListener("click", () => {
  const n = fixAll((i) => i.cat === "spell" && i.replacements.length);
  toast(`Исправлено опечаток: ${n}`);
});

$("clean-btn").addEventListener("click", () => {
  const n = fixAll((i) => i.cat === "hidden");
  toast(`Убрано скрытых символов и подмен: ${n}`);
});

$("copy-btn").addEventListener("click", async () => {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // На http без HTTPS буфер обмена через API недоступен — копируем через выделение.
    const t = document.createElement("textarea");
    t.value = text;
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

text = input.value = store.get("tc-draft", "");
autosize();
refresh();
if (text.trim()) runCheck();
input.focus();
