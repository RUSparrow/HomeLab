#!/usr/bin/env python3
"""textclean — убирает из текста скрытые следы ИИ и показывает шаблонные фразы.

Что делает:
  * удаляет невидимые символы (zero-width, метки направления, tag-символы,
    мягкие переносы), заменяет неразрывные и типографские пробелы обычными;
  * длинные/короткие тире, «ёлочки», „лапки“, “кавычки”, … и маркеры •
    заменяет на то, что набирается с обычной клавиатуры;
  * чинит слова со смешанными буквами (латинская «e» в русском слове и наоборот);
  * снимает markdown-разметку (**жирный**, ### заголовки);
  * находит фразы-штампы (et/ru/en), длинные предложения и очень длинные слова —
    их не меняет, а показывает, чтобы переписать своими словами.

Правила общие с веб-страницей: web/server-monitor/frontend/textclean/rules.json

Примеры:
  textclean.py letter.txt                 # только отчёт
  textclean.py --fix letter.txt > out.txt # чистый текст в stdout, отчёт в stderr
  pbpaste | textclean.py --fix --lang et -
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

RULES_PATH = (Path(__file__).resolve().parents[2]
              / "web/server-monitor/frontend/textclean/rules.json")

CYR = re.compile(r"[Ѐ-ӿ]")
LAT = re.compile(r"[A-Za-zÀ-ɏ]")
WORD = re.compile(r"[^\W\d_]+")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")


def load_rules(path=RULES_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def detect_lang(text):
    cyr = len(CYR.findall(text))
    lat = len(LAT.findall(text))
    if cyr > lat:
        return "ru"
    if re.search(r"[õäöüÕÄÖÜšž]", text):
        return "et"
    return "en"


def _js_repl(repl):
    """'$1-$2' (синтаксис JS) -> r'\\1-\\2' для re.sub."""
    return re.sub(r"\$(\d)", r"\\\1", repl)


def _char_table(rules):
    table = []
    for start, end, repl, label in rules["chars"]:
        table.append((int(start, 16), int(end, 16), repl, label))
    return table


def fix_chars(text, rules, fixes):
    table = _char_table(rules)
    out = []
    for ch in text:
        cp = ord(ch)
        for start, end, repl, label in table:
            if start <= cp <= end:
                if repl != ch:
                    fixes[label] += 1
                    out.append(repl)
                break
        else:
            out.append(ch)
    return "".join(out)


def fix_homoglyphs(text, rules, lang, fixes):
    c2l = rules["homoglyphs"]["cyr_to_lat"]
    l2c = rules["homoglyphs"]["lat_to_cyr"]

    def repair(m):
        w = m.group(0)
        n_cyr = len(CYR.findall(w))
        n_lat = len(LAT.findall(w))
        if not n_cyr or not n_lat:
            return w
        to_cyr = n_cyr > n_lat or (n_cyr == n_lat and lang == "ru")
        table = l2c if to_cyr else c2l
        new = "".join(table.get(ch, ch) for ch in w)
        if new != w:
            fixes["подменённые буквы (латиница/кириллица в одном слове)"] += 1
        return new

    return WORD.sub(repair, text)


def fix_replace(text, rules, fixes):
    for pattern, repl, label in rules["replace"]:
        rx = re.compile(pattern, re.M)
        text, n = rx.subn(_js_repl(repl), text)
        if n:
            fixes[label] += n
    return text


def clean(text, rules, lang):
    fixes = Counter()
    text = fix_chars(text, rules, fixes)
    text = fix_homoglyphs(text, rules, lang, fixes)
    text = fix_replace(text, rules, fixes)
    return text, fixes


def find_warnings(text, rules, lang):
    low = text.lower()
    phrases = []
    for phrase, hint in rules["phrases"].get(lang, []):
        n = low.count(phrase)
        if n:
            phrases.append({"phrase": phrase, "count": n, "hint": hint})
    lim = rules["limits"]
    long_sent = []
    for s in SENT_SPLIT.split(text):
        words = WORD.findall(s)
        if len(words) > lim["long_sentence_words"]:
            long_sent.append({"words": len(words), "start": " ".join(s.split()[:8]) + " ..."})
    long_words = sorted({w for w in WORD.findall(text) if len(w) >= lim["long_word_chars"]})
    return {"phrases": phrases, "long_sentences": long_sent, "long_words": long_words}


def report(fixes, warn, lang, fixed):
    lines = [f"Язык: {lang}"]
    if fixes:
        lines.append("Исправлено:" if fixed else "Будет исправлено с --fix:")
        lines += [f"  {n:>3} × {label}" for label, n in fixes.most_common()]
    else:
        lines.append("Скрытых символов и типографики нет.")
    if warn["phrases"]:
        lines.append("Шаблонные фразы (переписать своими словами):")
        lines += [f"  «{p['phrase']}» ×{p['count']} — {p['hint']}" for p in warn["phrases"]]
    if warn["long_sentences"]:
        lines.append("Длинные предложения (лучше разбить):")
        lines += [f"  {s['words']} слов: {s['start']}" for s in warn["long_sentences"]]
    if warn["long_words"]:
        lines.append("Очень длинные слова (поискать проще):")
        lines.append("  " + ", ".join(warn["long_words"]))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("file", nargs="?", default="-", help="файл или - для stdin")
    ap.add_argument("--fix", action="store_true", help="вывести исправленный текст в stdout")
    ap.add_argument("--lang", choices=["auto", "et", "ru", "en"], default="auto")
    ap.add_argument("--json", action="store_true", help="отчёт в JSON")
    ap.add_argument("--rules", default=str(RULES_PATH))
    a = ap.parse_args(argv)

    text = sys.stdin.read() if a.file == "-" else Path(a.file).read_text(encoding="utf-8")
    rules = load_rules(a.rules)
    lang = detect_lang(text) if a.lang == "auto" else a.lang
    cleaned, fixes = clean(text, rules, lang)
    warn = find_warnings(cleaned, rules, lang)

    if a.json:
        out = {"lang": lang, "fixes": dict(fixes), **warn}
        if a.fix:
            out["text"] = cleaned
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    if a.fix:
        sys.stdout.write(cleaned)
    print(report(fixes, warn, lang, a.fix), file=sys.stderr if a.fix else sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
