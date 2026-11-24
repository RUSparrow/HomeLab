"""Тесты textclean: python3 -m unittest discover -s tools/textclean"""
import unittest

import textclean as tc

R = tc.load_rules()


def run(text, lang=None):
    lang = lang or tc.detect_lang(text)
    out, fixes = tc.clean(text, R, lang)
    return out, fixes, tc.find_warnings(out, R, lang)


class TestClean(unittest.TestCase):
    def test_invisible_chars_removed(self):
        out, fixes, _ = run("Tere​! Olen⁠ valmis﻿­.")
        self.assertEqual(out, "Tere! Olen valmis.")
        self.assertTrue(fixes)

    def test_tag_watermark_removed(self):
        mark = "".join(chr(0xE0000 + ord(c)) for c in "AI")
        out, _, _ = run(f"Hello{mark} world")
        self.assertEqual(out, "Hello world")

    def test_dashes_and_quotes(self):
        out, _, _ = run("Москва — столица «России», 2–3 дня… “ok”", "ru")
        self.assertEqual(out, 'Москва - столица "России", 2-3 дня... "ok"')

    def test_estonian_quotes(self):
        out, _, _ = run("Väljend „on alust arvata“ – oletus.", "et")
        self.assertEqual(out, 'Väljend "on alust arvata" - oletus.')

    def test_homoglyphs(self):
        # латинская e внутри русских слов и кириллическая о в английском
        out, fixes, _ = run("Привeт, мeня зовут Маша", "ru")
        self.assertEqual(out, "Привет, меня зовут Маша")
        out, _, _ = run("Hellо world", "en")
        self.assertEqual(out, "Hello world")
        self.assertNotIn("Ж", out)

    def test_markdown(self):
        out, _, _ = run("### Pealkiri\n**Tähtis** asi\n* punkt", "et")
        self.assertEqual(out, "Pealkiri\nTähtis asi\n- punkt")

    def test_clean_text_untouched(self):
        txt = "Tere!\n\nSooviksin kandideerida. Valdan 3 keelt.\n\nLugupidamisega,\nEdvard"
        out, fixes, warn = run(txt, "et")
        self.assertEqual(out, txt)
        self.assertFalse(fixes)
        self.assertFalse(warn["phrases"])

    def test_phrases_flagged(self):
        _, _, w = run("Olen kirglik IT vastu ja soovin anda oma panus ettevõtte arengusse.", "et")
        found = {p["phrase"] for p in w["phrases"]}
        self.assertIn("olen kirglik", found)
        self.assertIn("anda oma panus", found)

    def test_long_words_and_sentences(self):
        _, _, w = run("Tarbijavaidluskomisjonile " + "sõna " * 30 + ".", "et")
        self.assertIn("Tarbijavaidluskomisjonile", w["long_words"])
        self.assertTrue(w["long_sentences"])

    def test_lang_detect(self):
        self.assertEqual(tc.detect_lang("Привет, как дела"), "ru")
        self.assertEqual(tc.detect_lang("Tere, kuidas läheb"), "et")
        self.assertEqual(tc.detect_lang("Hello there"), "en")


if __name__ == "__main__":
    unittest.main()
