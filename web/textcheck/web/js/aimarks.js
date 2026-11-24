/* Признаки ИИ-текста: скрытые символы, подмена букв, шаблонные обороты, ритм.
   Всё работает в браузере. Возвращает те же «находки», что и LanguageTool:
   { offset, length, cat, title, message, replacements[] }. */
"use strict";

const AIMarks = (() => {
  // ---- Скрытые и «не те» символы ----
  const HIDDEN = {
    "​": ["Пробел нулевой ширины", ""],
    "‌": ["Разделитель нулевой ширины", ""],
    "‍": ["Соединитель нулевой ширины", ""],
    "⁠": ["Невидимый соединитель слов", ""],
    "﻿": ["Невидимый символ BOM", ""],
    "­": ["Мягкий перенос", ""],
    " ": ["Неразрывный пробел", " "],
    " ": ["Узкий неразрывный пробел", " "],
    " ": ["Тонкий пробел", " "],
    " ": ["Сверхтонкий пробел", " "],
    " ": ["Цифровой пробел", " "],
    " ": ["Пунктуационный пробел", " "],
    "　": ["Широкий пробел", " "],
    "᠎": ["Монгольский разделитель", ""],
  };
  const BIDI = /[‪-‮⁦-⁩‎‏]/;
  const VARIATION = /[︀-️]/;

  // Латинские буквы, которые выглядят как кириллические
  const LAT2CYR = {
    a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", b: "в",
    A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", X: "Х", Y: "У",
  };

  // ---- Шаблонные обороты. w — вес для оценки ----
  const RU = [
    ["(?:важно|стоит|следует|необходимо|хочется) (?:отметить|подчеркнуть|упомянуть)", 2, "Вводный штамп. Обычно можно просто удалить."],
    ["важно (?:понимать|помнить)", 1.5, "Вводный штамп."],
    ["в заключени[еи]|подводя итог\\p{L}*|в итоге можно сказать", 1.5, "Шаблонная концовка."],
    ["в современном мире|в мире,? где|в (?:нашу|цифровую|современную) эпоху|в наше время|в сегодняшн\\p{L}+ (?:мире|реалиях)", 2, "Шаблонное вступление."],
    ["давайте (?:разбер[её]мся|рассмотрим|погрузимся|вместе)|погрузимся|окун[её]мся", 2, "Обращение в стиле ИИ-ассистента."],
    ["игра\\p{L}+ (?:ключев|важн|решающ|значим)\\p{L}+ роль", 2, "Штамп «играет ключевую роль»."],
    ["ключев(?:ой|ые|ых|ым) (?:аспект|фактор|момент)\\p{L}*", 1.5, "Штамп."],
    ["не просто [\\p{L}-]+(?: [\\p{L}-]+)?,? (?:а|это)", 2, "Конструкция «не просто X, а Y» — частый приём ИИ."],
    ["широк\\p{L}+ (?:спектр|диапазон)\\p{L}*", 1.5, "Канцелярский штамп."],
    ["(?:комплексн|целостн|всесторонн)\\p{L}+ подход\\p{L}*", 1.5, "Канцелярский штамп."],
    ["неотъемлем\\p{L}+ част\\p{L}+", 1.5, "Штамп «неотъемлемая часть»."],
    ["(?:уникальн|незаменим|революционн|инновационн|бесшовн|беспрецедентн)\\p{L}*", 1, "Рекламное превосходство без фактов."],
    ["откройте для себя|раскр\\p{L}+ (?:свой |весь )?потенциал|на новый уровень", 2, "Рекламный штамп."],
    ["надеюсь,? (?:это|эта информация) (?:поможет|была полезн\\p{L}+)|отличный вопрос", 3, "Фраза из ответа чат-бота."],
    ["как (?:языковая модель|ИИ|искусственный интеллект),? я|я не могу (?:предоставить|выполнить)", 4, "Прямой след чат-бота."],
    ["безусловно|несомненно|конечно же", 1, "Усилитель, который ничего не добавляет."],
    ["более того|кроме того|помимо этого|вместе с тем", 0.5, "Связка, которую ИИ ставит слишком часто."],
    ["(?:значительно|существенно) (?:улучш|повыш|увелич|упрощ)\\p{L}+", 1, "Обещание без цифр."],
    ["позволяет (?:эффективно|легко|быстро|значительно)", 1, "Штамп «позволяет эффективно»."],
    ["вот (?:несколько|основные|ключевые) [\\p{L}]+", 1.5, "Типичное начало списка у ИИ."],
  ];
  const EN = [
    ["delv(?:e|es|ing)", 3, "“Delve” is a well-known LLM tell."],
    ["it'?s (?:important|worth|crucial) (?:to note|noting|to remember)", 2, "Filler opener."],
    ["in today'?s (?:world|fast-paced|digital|ever-changing)\\p{L}*", 2, "Template opener."],
    ["tapestry|testament to|realm of|landscape of", 2, "Overused LLM metaphor."],
    ["seamless(?:ly)?|leverag(?:e|ing)|unlock(?:ing)? the|elevate|embark|foster(?:ing)?|showcas(?:e|ing)", 1, "Buzzword."],
    ["navigat(?:e|ing) the (?:complexities|world|landscape)", 2, "Template phrase."],
    ["i hope this helps|great question|as an ai(?: language model)?", 3, "Chatbot phrase."],
    ["in conclusion|in summary|to sum up", 1.5, "Template conclusion."],
    ["moreover|furthermore|additionally", 0.7, "Connector LLMs overuse."],
    ["robust|crucial|pivotal|vibrant|meticulous(?:ly)?|intricate|cutting[- ]edge|game[- ]changer", 1, "Inflated adjective."],
    ["not (?:just|only|merely) [\\p{L}-]+(?: [\\p{L}-]+)?,? but", 1.5, "“Not just X, but Y” construction."],
  ];
  const compile = (list) => list.map(([src, w, hint]) =>
    [new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, "giu"), w, hint]);
  const RU_RX = compile(RU);
  const EN_RX = compile(EN);
  const MARKDOWN = /\*\*[^*\n]+\*\*|^#{1,6} +|^\s*[-*] \*\*/gmu;

  function sentences(text) {
    return text.split(/(?<=[.!?…])\s+|\n{2,}/u).map((s) => s.trim()).filter((s) => /\p{L}/u.test(s));
  }

  function wordsOf(text) {
    return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  }

  function scan(text) {
    const found = [];
    const reasons = [];
    let score = 0;

    // 1. Скрытые символы
    let hiddenCount = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let info = HIDDEN[ch];
      if (!info && BIDI.test(ch)) info = ["Управляющий символ направления текста", ""];
      if (!info && VARIATION.test(ch) && !/\p{Extended_Pictographic}/u.test(text.slice(Math.max(0, i - 2), i))) info = ["Селектор варианта", ""];
      if (!info) {
        const cp = text.codePointAt(i);
        if (cp >= 0xE0000 && cp <= 0xE007F) {
          info = ["Невидимый тег-символ (так прячут водяные знаки)", ""];
          found.push({ offset: i, length: 2, cat: "hidden", title: info[0], message: "Символ не виден, но остаётся в тексте при копировании.", replacements: [info[1]], hiddenChar: true });
          hiddenCount++; i++; continue;
        }
      }
      if (info) {
        found.push({ offset: i, length: 1, cat: "hidden", title: info[0],
          message: info[1] === " " ? "Выглядит как обычный пробел, но это другой символ." : "Символ не виден, но остаётся в тексте при копировании.",
          replacements: [info[1]], hiddenChar: true });
        if (ch !== " ") hiddenCount++;
      }
    }
    if (hiddenCount) {
      score += Math.min(35, 12 + hiddenCount * 3);
      reasons.push(`Скрытых символов: ${hiddenCount}. Так иногда помечают сгенерированный текст.`);
    }

    // 2. Слова со смесью кириллицы и латиницы
    let mixed = 0;
    for (const m of text.matchAll(/[\p{L}]+/gu)) {
      const w = m[0];
      if (/\p{Script=Cyrillic}/u.test(w) && /\p{Script=Latin}/u.test(w)) {
        const fixed = [...w].map((c) => LAT2CYR[c] || c).join("");
        if (!/\p{Script=Latin}/u.test(fixed)) {
          mixed++;
          found.push({ offset: m.index, length: w.length, cat: "hidden", title: "Латинские буквы в русском слове",
            message: "Слово выглядит нормально, но часть букв латинская. Поиск и проверка его не найдут.", replacements: [fixed] });
        }
      }
    }
    if (mixed) reasons.push(`Слов с подменёнными буквами: ${mixed}.`);

    // 3. Шаблонные обороты
    const cyr = (text.match(/\p{Script=Cyrillic}/gu) || []).length;
    const lat = (text.match(/\p{Script=Latin}/gu) || []).length;
    const sets = cyr >= lat ? [RU_RX, EN_RX] : [EN_RX, RU_RX];
    let phraseWeight = 0, phraseCount = 0;
    for (const set of sets) {
      for (const [rx, w, hint] of set) {
        rx.lastIndex = 0;
        for (const m of text.matchAll(rx)) {
          if (found.some((f) => f.cat === "ai" && m.index < f.offset + f.length && f.offset < m.index + m[0].length)) continue;
          found.push({ offset: m.index, length: m[0].length, cat: "ai", title: "Похоже на ИИ", message: hint, replacements: [], weight: w });
          phraseWeight += w; phraseCount++;
        }
      }
    }

    // 4. Остатки Markdown
    let md = 0;
    for (const m of text.matchAll(MARKDOWN)) {
      md++;
      const clean = m[0].replace(/\*\*/g, "").replace(/^#{1,6} +/, "");
      found.push({ offset: m.index, length: m[0].length, cat: "ai", title: "Разметка Markdown",
        message: "Звёздочки и решётки остаются, когда текст скопирован из чат-бота.", replacements: [clean], weight: 2 });
    }
    if (md) { score += Math.min(15, md * 4); reasons.push(`Остатки разметки Markdown: ${md}.`); }

    // 5. Ритм и типографика
    const words = wordsOf(text);
    const per100 = words.length ? 100 / Math.max(words.length, 60) : 0;
    if (phraseCount) {
      score += Math.min(45, phraseWeight * per100 * 9);
      reasons.push(`Шаблонных оборотов: ${phraseCount}.`);
    }

    const sents = sentences(text);
    if (sents.length >= 5) {
      const lens = sents.map((s) => wordsOf(s).length);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
      const cv = sd / (mean || 1);
      if (cv < 0.3 && mean > 9) {
        score += 15;
        reasons.push("Предложения почти одинаковой длины. У людей ритм обычно рванее.");
      } else if (cv < 0.42 && mean > 9) {
        score += 7;
        reasons.push("Ритм предложений довольно ровный.");
      }
    }

    const dashes = (text.match(/ — /g) || []).length;
    if (sents.length && dashes / sents.length > (cyr >= lat ? 0.6 : 0.25) && dashes >= 4) {
      score += 8;
      reasons.push(`Много длинных тире: ${dashes} на ${sents.length} предложений.`);
    }

    const triads = (text.match(/[\p{L}-]+, [\p{L}-]+ и [\p{L}-]+/gu) || []).length;
    if (sents.length >= 4 && triads / sents.length > 0.35) {
      score += 6;
      reasons.push(`Частые перечисления из трёх: ${triads}.`);
    }

    const bullets = (text.match(/^\s*(?:[-•*]|\d+[.)]) /gmu) || []).length;
    const lines = text.split("\n").filter((l) => l.trim()).length;
    if (lines >= 6 && bullets / lines > 0.5) {
      score += 6;
      reasons.push("Текст в основном из списков.");
    }

    if (words.length < 40 && score > 0) reasons.push("Текст короткий, оценка неточная.");
    score = Math.round(Math.min(100, score));
    return { found, score, reasons };
  }

  return { scan };
})();
