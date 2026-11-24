"""Формы слова для «Проверки текста»: все падежи, числа и времена через pymorphy3.

GET /api/forms?word=машина  ->  {"word": "машина", "forms": [{"word": "машины", "label": "род. ед."}, ...]}
GET /api/health             ->  {"ok": true}
"""
import json
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pymorphy3

morph = pymorphy3.MorphAnalyzer(lang="ru")

LABELS = {
    "nomn": "им.", "gent": "род.", "datv": "дат.", "accs": "вин.", "ablt": "твор.", "loct": "предл.",
    "voct": "зват.", "gen2": "род. 2", "acc2": "вин. 2", "loc2": "предл. 2",
    "sing": "ед.", "plur": "мн.",
    "masc": "м. р.", "femn": "ж. р.", "neut": "ср. р.",
    "past": "прош.", "pres": "наст.", "futr": "буд.",
    "1per": "1 л.", "2per": "2 л.", "3per": "3 л.",
    "impr": "повел.", "INFN": "инфинитив",
    "PRTF": "причастие", "PRTS": "кр. причастие", "GRND": "деепричастие",
    "ADJS": "кр. форма", "COMP": "сравн.", "Supr": "превосх.",
}
ORDER = ["INFN", "PRTF", "PRTS", "GRND", "ADJS", "COMP", "Supr", "impr",
         "past", "pres", "futr", "1per", "2per", "3per",
         "masc", "femn", "neut", "sing", "plur",
         "nomn", "gent", "datv", "accs", "ablt", "loct", "voct", "gen2", "acc2", "loc2"]


def match_case(form: str, original: str) -> str:
    if original.isupper() and len(original) > 1:
        return form.upper()
    if original[:1].isupper():
        return form[:1].upper() + form[1:]
    return form


@lru_cache(maxsize=4096)
def forms_for(word: str) -> dict:
    parses = [p for p in morph.parse(word.lower()) if p.is_known]
    if not parses:
        return {"word": word, "lemma": None, "forms": []}
    best = parses[0]
    seen, forms = set(), []
    for f in best.lexeme:
        text = match_case(f.word, word)
        if text in seen:
            continue
        seen.add(text)
        grams = [g for g in ORDER if g in f.tag.grammemes or g == str(f.tag.POS)]
        forms.append({"word": text, "label": " ".join(LABELS[g] for g in grams)})
    return {"word": word, "lemma": match_case(best.normal_form, word), "forms": forms[:60]}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path == "/api/health":
            return self._send(200, {"ok": True})
        if url.path == "/api/forms":
            word = (parse_qs(url.query).get("word") or [""])[0].strip()
            if not word or len(word) > 40 or not any(c.isalpha() for c in word):
                return self._send(400, {"error": "Нужно одно слово"})
            return self._send(200, forms_for(word))
        self._send(404, {"error": "not found"})

    def log_message(self, *_):  # без шума в логах на каждый запрос
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
