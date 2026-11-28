"""Справочник продавцов PriceFinder: кому можно верить, а кто вообще не магазин.

score — надёжность продавца 0–100:
  95–98  крупные проверенные магазины электроники (свой склад, гарантия, история);
  85–92  крупные маркетплейсы и магазины поменьше, но с хорошей репутацией;
  80     маркетплейсы, где продают сторонние продавцы (надёжность зависит от продавца);
  45–55  неизвестный магазин в ЕС;
  35     неизвестный сайт без страны.
Предложение не может быть надёжнее своего продавца — см. offer_trust().
"""
import re

# домен: (название, страна, надёжность, тип)
STORES = {
    # --- Эстония ---
    "arvutitark.ee": ("Arvutitark", "EE", 97, "shop"),
    "datagate.ee": ("Datagate", "EE", 96, "shop"),
    "1a.ee": ("1a.ee", "EE", 95, "shop"),
    "kaup24.ee": ("Kaup24", "EE", 90, "marketplace"),
    "rde.ee": ("RDE", "EE", 96, "shop"),
    "smarttech.ee": ("Smarttech", "EE", 93, "shop"),
    "euronics.ee": ("Euronics", "EE", 96, "shop"),
    "klick.ee": ("Klick", "EE", 95, "shop"),
    "photopoint.ee": ("Photopoint", "EE", 94, "shop"),
    "onoff.ee": ("On/Off", "EE", 93, "shop"),
    "galador.ee": ("Galador", "EE", 90, "shop"),
    "mobix.ee": ("Mobix", "EE", 85, "shop"),
    "expert.ee": ("Expert", "EE", 92, "shop"),
    # --- Латвия ---
    "1a.lv": ("1a.lv", "LV", 95, "shop"),
    "rdveikals.lv": ("RD Electronics", "LV", 96, "shop"),
    "dateks.lv": ("Dateks", "LV", 95, "shop"),
    "euronics.lv": ("Euronics", "LV", 95, "shop"),
    "220.lv": ("220.lv", "LV", 85, "marketplace"),
    "capital.lv": ("Capital", "LV", 88, "shop"),
    "elkor.lv": ("Elkor", "LV", 88, "shop"),
    # --- Литва ---
    "varle.lt": ("Varle", "LT", 90, "marketplace"),
    "pigu.lt": ("Pigu", "LT", 90, "marketplace"),
    "1a.lt": ("1a.lt", "LT", 95, "shop"),
    "topocentras.lt": ("Topo centras", "LT", 95, "shop"),
    "skytech.lt": ("Skytech", "LT", 92, "shop"),
    "kilobaitas.lt": ("Kilobaitas", "LT", 92, "shop"),
    "elesen.lt": ("Elesen", "LT", 90, "shop"),
    "technorama.lt": ("Technorama", "LT", 90, "shop"),
    # --- Финляндия ---
    "verkkokauppa.com": ("Verkkokauppa.com", "FI", 98, "shop"),
    "jimms.fi": ("Jimm's", "FI", 96, "shop"),
    "gigantti.fi": ("Gigantti", "FI", 96, "shop"),
    "proshop.fi": ("Proshop", "FI", 95, "shop"),
    "power.fi": ("Power", "FI", 95, "shop"),
    "multitronic.fi": ("Multitronic", "FI", 92, "shop"),
    "datatronic.fi": ("Datatronic", "FI", 90, "shop"),
    "karkkainen.com": ("Kärkkäinen", "FI", 92, "shop"),
    # --- Швеция ---
    "inet.se": ("Inet", "SE", 97, "shop"),
    "webhallen.com": ("Webhallen", "SE", 96, "shop"),
    "komplett.se": ("Komplett", "SE", 96, "shop"),
    "proshop.se": ("Proshop", "SE", 95, "shop"),
    "elgiganten.se": ("Elgiganten", "SE", 96, "shop"),
    "netonnet.se": ("NetOnNet", "SE", 95, "shop"),
    "dustinhome.se": ("Dustin Home", "SE", 94, "shop"),
    "kjell.com": ("Kjell & Company", "SE", 93, "shop"),
    "cdon.se": ("CDON", "SE", 80, "marketplace"),
    # --- Норвегия ---
    "komplett.no": ("Komplett", "NO", 96, "shop"),
    "proshop.no": ("Proshop", "NO", 95, "shop"),
    "elkjop.no": ("Elkjøp", "NO", 96, "shop"),
    "power.no": ("Power", "NO", 95, "shop"),
    "multicom.no": ("Multicom", "NO", 92, "shop"),
    "netonnet.no": ("NetOnNet", "NO", 94, "shop"),
    # --- Дания ---
    "proshop.dk": ("Proshop", "DK", 96, "shop"),
    "komplett.dk": ("Komplett", "DK", 95, "shop"),
    "elgiganten.dk": ("Elgiganten", "DK", 96, "shop"),
    "power.dk": ("Power", "DK", 95, "shop"),
    "computersalg.dk": ("Computersalg", "DK", 90, "shop"),
    # --- Германия и Австрия ---
    "mindfactory.de": ("Mindfactory", "DE", 95, "shop"),
    "alternate.de": ("Alternate", "DE", 96, "shop"),
    "caseking.de": ("Caseking", "DE", 95, "shop"),
    "cyberport.de": ("Cyberport", "DE", 95, "shop"),
    "notebooksbilliger.de": ("notebooksbilliger", "DE", 95, "shop"),
    "computeruniverse.net": ("Computeruniverse", "DE", 93, "shop"),
    "galaxus.de": ("Galaxus", "DE", 95, "shop"),
    "mediamarkt.de": ("MediaMarkt", "DE", 95, "shop"),
    "saturn.de": ("Saturn", "DE", 95, "shop"),
    "proshop.de": ("Proshop", "DE", 94, "shop"),
    "reichelt.de": ("Reichelt", "DE", 94, "shop"),
    "conrad.de": ("Conrad", "DE", 93, "shop"),
    "amazon.de": ("Amazon.de", "DE", 88, "marketplace"),
    "galaxus.at": ("Galaxus", "AT", 95, "shop"),
    "amazon.fr": ("Amazon.fr", "FR", 86, "marketplace"),
    "amazon.it": ("Amazon.it", "IT", 86, "marketplace"),
    "amazon.es": ("Amazon.es", "ES", 86, "marketplace"),
    "amazon.nl": ("Amazon.nl", "NL", 86, "marketplace"),
    "amazon.se": ("Amazon.se", "SE", 86, "marketplace"),
    "amazon.pl": ("Amazon.pl", "PL", 86, "marketplace"),
    "alternate.nl": ("Alternate", "NL", 94, "shop"),
    "alternate.be": ("Alternate", "BE", 94, "shop"),
    "alternate.at": ("Alternate", "AT", 94, "shop"),
    # --- Польша ---
    "x-kom.pl": ("x-kom", "PL", 96, "shop"),
    "morele.net": ("Morele", "PL", 95, "shop"),
    "komputronik.pl": ("Komputronik", "PL", 94, "shop"),
    "proline.pl": ("Proline", "PL", 92, "shop"),
    "mediaexpert.pl": ("Media Expert", "PL", 95, "shop"),
    "euro.com.pl": ("RTV Euro AGD", "PL", 95, "shop"),
    "allegro.pl": ("Allegro", "PL", 80, "marketplace"),
}

# Не магазины: где купить нельзя. Такие результаты отбрасываются ещё до загрузки страниц.
NOT_STORES = {
    "comparison": {  # сравнивалки цен
        "hind.ee", "hinnavaatlus.ee", "kaina24.lt", "kainos.lt", "salidzini.lv", "kurpirkt.lv",
        "hintaseuranta.fi", "hintaopas.fi", "hinta.fi", "prisjakt.nu", "prisjakt.no", "pricespy.co.uk",
        "pricerunner.dk", "pricerunner.se", "pricerunner.com", "geizhals.de", "geizhals.at", "geizhals.eu",
        "idealo.de", "idealo.at", "billiger.de", "guenstiger.de", "ceneo.pl", "skapiec.pl",
        "kelkoo.com", "pangoly.com", "gpuprix.com", "pctechvault.com", "originalpricing.com",
        "versus.com", "camelcamelcamel.com", "keepa.com", "pcpartpicker.com", "hinnavaatlus.com",
        "hardwareschotte.de", "eponuda.com", "heureka.cz", "pricespy.de", "preisvergleich.de",
    },
    "media": {  # обзоры, новости, сделки
        "pcguide.com", "pcgameshardware.de", "computerbase.de", "hardwaredealz.com", "mydealz.de",
        "geex.x-kom.pl", "tech.morele.net", "techradar.com", "pcgamer.com", "rtings.com",
        "hardwareluxx.de", "io-tech.fi", "sweclockers.com", "guru3d.com", "kitguru.net",
    },
    "classifieds": {  # объявления б/у
        "kleinanzeigen.de", "skelbiu.lt", "m.skelbiu.lt", "ss.lv", "ss.com", "okidoki.ee", "osta.ee",
        "tori.fi", "blocket.se", "finn.no", "dba.dk", "olx.pl", "ebay-kleinanzeigen.de",
    },
    "offregion": {  # не доставляют в ЕС / санкции / вне ЕС с пошлинами
        "market.yandex.ru", "yandex.ru", "ozon.ru", "wildberries.ru", "aliexpress.ru", "28bit.ru",
        "dns-shop.ru", "citilink.ru", "amazon.com", "walmart.com", "bestbuy.com", "newegg.com",
        "bhphotovideo.com", "microcenter.com", "ebay.com",
    },
}
NOT_STORE_REASON = {"comparison": "сравнивалка цен", "media": "статья или обзор",
                    "classifieds": "объявления б/у", "offregion": "не доставляют в ЕС"}

TLD_COUNTRY = {
    "ee": "EE", "lv": "LV", "lt": "LT", "fi": "FI", "se": "SE", "no": "NO", "dk": "DK",
    "de": "DE", "at": "AT", "pl": "PL", "nl": "NL", "be": "BE", "fr": "FR", "it": "IT",
    "es": "ES", "cz": "CZ", "sk": "SK", "ie": "IE", "pt": "PT",
}
COUNTRY_NAME = {
    "EE": "Эстония", "LV": "Латвия", "LT": "Литва", "FI": "Финляндия", "SE": "Швеция", "NO": "Норвегия",
    "DK": "Дания", "DE": "Германия", "AT": "Австрия", "PL": "Польша", "NL": "Нидерланды", "BE": "Бельгия",
    "FR": "Франция", "IT": "Италия", "ES": "Испания", "CZ": "Чехия", "SK": "Словакия", "IE": "Ирландия",
    "PT": "Португалия",
}


def _match(domain: str, names) -> str | None:
    for d in names:
        if domain == d or domain.endswith("." + d):
            return d
    return None


def not_store(domain: str) -> str | None:
    """Причина, по которой это не магазин, или None."""
    for kind, names in NOT_STORES.items():
        if _match(domain, names):
            return kind
    return None


def seller(domain: str) -> dict:
    """Кто продаёт: название, страна, надёжность, известен ли продавец."""
    key = _match(domain, STORES)
    if key:
        name, country, score, kind = STORES[key]
        return {"name": name, "country": country, "score": score, "kind": kind, "known": True}
    tld = domain.rsplit(".", 1)[-1]
    country = TLD_COUNTRY.get(tld)
    return {"name": domain, "country": country, "score": 50 if country else 35, "kind": "unknown", "known": False}


def offer_trust(seller_info: dict, confirmed: bool, in_stock) -> tuple[int, list[str]]:
    """Надёжность конкретного предложения (0–100) и почему такая."""
    score = seller_info["score"]
    why = []
    if seller_info["known"]:
        why.append("проверенный продавец" if seller_info["kind"] == "shop" else "маркетплейс: проверьте продавца")
    else:
        why.append("неизвестный магазин")
    if confirmed:
        why.append("цена из карточки товара")
    else:
        score *= 0.6
        why.append("цена найдена в тексте страницы")
    if in_stock is True:
        why.append("в наличии")
    elif in_stock is False:
        score *= 0.5
        why.append("нет в наличии")
    else:
        score *= 0.9
        why.append("наличие не указано")
    return round(score), why


# Готовые компьютеры и комплекты: не то, что ищут, когда ищут деталь
BUNDLE_WORDS = (
    "gaming pc", "gaming-pc", "gaming computer", "lauaarvuti", "arvutikomplekt", "sülearvuti", "desktop",
    "tower", "pöytäkone", "kannettava", "datorkomplekts", "stacionārais dators", "portatīvais",
    "kompiuteris", "nešiojamas", "stationär", "komplett-pc", "notebook", "laptop", "zestaw komputerowy",
    "komputer stacjonarny", "laptop", "ноутбук", "компьютер", "системный блок",
)


def is_bundle(query: str, title: str) -> bool:
    q, t = query.lower(), (title or "").lower()
    if any(w in q for w in BUNDLE_WORDS):
        return False
    if any(w in t for w in BUNDLE_WORDS):
        return True
    # «… 32GB DDR5 1TB SSD … RTX 5080» — несколько ключевых узлов ПК в одном названии
    parts = sum(bool(re.search(p, t)) for p in (r"\b\d+\s?gb\b.*(ddr|ram)", r"\b\d+\s?(tb|gb)\b.*ssd", r"\brtx\s?\d{4}", r"\bryzen\b|\bcore i\d|\bcore ultra"))
    return parts >= 3
