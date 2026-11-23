"""PriceFinder — поиск товара по магазинам и извлечение цен.

Запуск: python bot.py "Ryzen 7 9800X3D"

Скрипт печатает в stdout служебные строки вида
    @@progress {"stage": "search", "done": 3, "total": 52}
по которым API показывает реальный прогресс поиска.
"""

import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import psycopg2
import requests
from bs4 import BeautifulSoup
from ddgs import DDGS

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    ),
    "Accept-Language": "en;q=0.9,et;q=0.8,ru;q=0.7",
}

DB_CONFIG = {
    "host": os.getenv("PRICEFINDER_DB_HOST", "localhost"),
    "port": int(os.getenv("PRICEFINDER_DB_PORT", "5432")),
    "database": os.getenv("PRICEFINDER_DB_NAME", "pricewatcher"),
    "user": os.getenv("PRICEFINDER_DB_USER", "pricewatcher"),
    "password": os.getenv("PRICEFINDER_DB_PASSWORD", " "),
}

SEARCH_WORKERS = 4      # DuckDuckGo не любит много параллельных запросов
PAGE_WORKERS = 10
RESULTS_PER_QUERY = 10
PAGE_TIMEOUT = 12

# Сайты, которые не являются магазинами.
NON_STORE_DOMAINS = {
    "wikipedia.org", "grokipedia.com", "reddit.com", "hardforum.com", "idc.com",
    "userbenchmark.com", "youtube.com", "youtu.be", "tomshardware.com",
    "videocardz.com", "wccftech.com", "pcpartpicker.com", "gputracker.eu",
    "techpowerup.com", "anandtech.com", "notebookcheck.net", "amd.com",
    "intel.com", "nvidia.com", "facebook.com", "x.com", "twitter.com",
    "instagram.com", "tiktok.com", "quora.com", "medium.com",
}

SEARCH_PAGE_MARKERS = ("/search", "searchpage", "?q=", "&q=", "?query=", "?keyword=", "/pl?", "?s=")

# (суффикс запроса или site:домен, регион DuckDuckGo)
SEARCH_PROFILES = [
    ("{q}", "us-en"), ("{q} price", "us-en"), ("{q} buy", "us-en"),
    # Эстония
    ("{q} hind", "ee-et"), ("{q} osta", "ee-et"),
    ("site:arvutitark.ee {q}", "ee-et"), ("site:1a.ee {q}", "ee-et"),
    ("site:kaup24.ee {q}", "ee-et"), ("site:galador.ee {q}", "ee-et"),
    ("site:photopoint.ee {q}", "ee-et"), ("site:hinnavaatlus.ee {q}", "ee-et"),
    # Латвия
    ("{q} cena", "lv-lv"), ("site:1a.lv {q}", "lv-lv"), ("site:dateks.lv {q}", "lv-lv"),
    ("site:rdveikals.lv {q}", "lv-lv"),
    # Литва
    ("{q} kaina", "lt-lt"), ("site:varle.lt {q}", "lt-lt"), ("site:skytech.lt {q}", "lt-lt"),
    ("site:kilobaitas.lt {q}", "lt-lt"),
    # Финляндия
    ("{q} hinta", "fi-fi"), ("site:verkkokauppa.com {q}", "fi-fi"), ("site:jimms.fi {q}", "fi-fi"),
    ("site:gigantti.fi {q}", "fi-fi"), ("site:proshop.fi {q}", "fi-fi"),
    # Швеция / Норвегия / Дания
    ("{q} pris", "se-sv"), ("site:inet.se {q}", "se-sv"), ("site:webhallen.com {q}", "se-sv"),
    ("site:komplett.se {q}", "se-sv"), ("site:komplett.no {q}", "no-no"),
    ("site:proshop.dk {q}", "dk-da"),
    # Германия
    ("{q} Preis", "de-de"), ("{q} kaufen", "de-de"), ("site:mindfactory.de {q}", "de-de"),
    ("site:alternate.de {q}", "de-de"), ("site:caseking.de {q}", "de-de"),
    ("site:computeruniverse.net {q}", "de-de"), ("site:geizhals.eu {q}", "de-de"),
    # Польша
    ("{q} cena", "pl-pl"), ("site:x-kom.pl {q}", "pl-pl"), ("site:morele.net {q}", "pl-pl"),
    # Русскоязычные
    ("{q} цена", "ru-ru"), ("{q} купить", "ru-ru"),
]

CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "zł": "PLN", "₽": "RUB", "kr": "SEK"}
CURRENCY_CODES = {"EUR", "USD", "GBP", "PLN", "SEK", "NOK", "DKK", "RUB", "CHF", "CZK"}

IN_STOCK_MARKERS = ("instock", "in_stock", "limitedavailability", "onlineonly", "presale", "preorder")
OUT_OF_STOCK_MARKERS = ("outofstock", "out_of_stock", "soldout", "discontinued")


def progress(stage, done=0, total=0, **extra):
    print("@@progress " + json.dumps({"stage": stage, "done": done, "total": total, **extra}), flush=True)


def log(*args):
    print(*args, flush=True)


# ---------------------------------------------------------
# Вспомогательное
# ---------------------------------------------------------

def get_domain(url):
    domain = urlparse(url).netloc.lower()
    return domain[4:] if domain.startswith("www.") else domain


def domain_matches(domain, candidates):
    return any(domain == d or domain.endswith("." + d) for d in candidates)


def normalize(text):
    """Нижний регистр, без пробелов и дефисов: «RTX 5070-Ti» → «rtx5070ti»."""
    return re.sub(r"[\s\-_/]+", "", (text or "").lower())


def query_tokens(query):
    return [t for t in re.split(r"[\s\-_/]+", query.lower()) if len(t) >= 2]


def is_relevant(query, *texts):
    """Все значимые слова запроса должны встречаться в заголовке/сниппете/URL."""
    haystack = " ".join(texts).lower()
    compact = normalize(haystack)
    if normalize(query) in compact:
        return True
    return all(token in haystack or token in compact for token in query_tokens(query))


def is_relevant_strict(query, title, url):
    """Каждое слово запроса — отдельным словом в заголовке страницы или URL.
    «990 PRO 2TB» не совпадёт с «990 EVO 2TB» или «990 PRO 1TB»."""
    text = f"{title} {url}".lower()
    if normalize(query) in normalize(text):
        return True
    for token in query_tokens(query):
        # «2tb» должно находиться и как «2 tb»
        spaced = re.sub(r"(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)", r"[\\s\\-]?", re.escape(token))
        if not re.search(rf"(?<![a-z0-9]){spaced}(?![a-z0-9])", text):
            return False
    return True


def parse_number(raw):
    """«1 299,90» / «1.299,90» / «1,299.90» / «469» → float."""
    s = re.sub(r"[^\d.,]", "", str(raw))
    if not s:
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        head, _, tail = s.rpartition(",")
        s = f"{head.replace(',', '')}.{tail}" if len(tail) in (1, 2) else s.replace(",", "")
    elif s.count(".") > 1 or (s.count(".") == 1 and len(s.rpartition(".")[2]) == 3):
        s = s.replace(".", "")
    try:
        value = float(s)
    except ValueError:
        return None
    return value if 0 < value < 1_000_000 else None


TLD_CURRENCY = {
    "ee": "EUR", "lv": "EUR", "lt": "EUR", "fi": "EUR", "de": "EUR", "eu": "EUR", "nl": "EUR",
    "fr": "EUR", "it": "EUR", "es": "EUR", "at": "EUR", "be": "EUR", "ie": "EUR",
    "se": "SEK", "no": "NOK", "dk": "DKK", "pl": "PLN", "uk": "GBP", "ru": "RUB",
}


def normalize_currency(raw):
    raw = (raw or "").strip()
    if raw.upper() in CURRENCY_CODES:
        return raw.upper()
    return CURRENCY_SYMBOLS.get(raw) or CURRENCY_SYMBOLS.get(raw.lower())


ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
FALLBACK_RATES = {"EUR": 1.0, "USD": 1.09, "GBP": 0.84, "SEK": 11.2, "NOK": 11.6, "DKK": 7.46, "PLN": 4.25, "CHF": 0.94, "CZK": 24.5}
_rates = None


def eur_rates():
    """Курсы ЕЦБ (сколько единиц валюты за 1 евро); при ошибке — примерные."""
    global _rates
    if _rates is None:
        _rates = dict(FALLBACK_RATES)
        try:
            xml = requests.get(ECB_URL, timeout=8).text
            for code, rate in re.findall(r"currency='([A-Z]{3})' rate='([0-9.]+)'", xml):
                _rates[code] = float(rate)
        except requests.RequestException:
            log("Курсы ЕЦБ недоступны — используем примерные")
    return _rates


def to_eur(price, currency):
    rate = eur_rates().get((currency or "").upper())
    return round(price / rate, 2) if price and rate else None


def currency_for_domain(domain):
    return TLD_CURRENCY.get(domain.rsplit(".", 1)[-1])


def availability(raw):
    value = str(raw or "").lower().replace(" ", "")
    if any(m in value for m in OUT_OF_STOCK_MARKERS):
        return False
    if any(m in value for m in IN_STOCK_MARKERS):
        return True
    return None


# ---------------------------------------------------------
# Поиск
# ---------------------------------------------------------

def run_search_query(template, region, query):
    search_query = template.format(q=query)
    try:
        with DDGS() as ddgs:
            return list(ddgs.text(search_query, region=region, safesearch="off", max_results=RESULTS_PER_QUERY))
    except Exception as exc:
        log(f"Ошибка поиска [{search_query}]: {exc}")
        return []


def search(query):
    results = []
    seen = set()
    total = len(SEARCH_PROFILES)
    progress("search", 0, total)

    with ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as pool:
        futures = [pool.submit(run_search_query, t, r, query) for t, r in SEARCH_PROFILES]
        for done, future in enumerate(as_completed(futures), start=1):
            for item in future.result():
                url = (item.get("href") or "").strip()
                if not url:
                    continue
                key = url.split("?")[0].split("#")[0].rstrip("/")
                if key in seen:
                    continue
                seen.add(key)
                results.append({
                    "title": item.get("title", ""),
                    "url": url,
                    "snippet": item.get("body", ""),
                })
            progress("search", done, total, found=len(results))

    log(f"Уникальных результатов: {len(results)}")
    return results


def filter_results(query, results):
    filtered = []
    for r in results:
        domain = get_domain(r["url"])
        if domain_matches(domain, NON_STORE_DOMAINS):
            continue
        if any(m in r["url"].lower() for m in SEARCH_PAGE_MARKERS):
            continue
        if not is_relevant(query, r["title"], r["snippet"], r["url"]):
            continue
        filtered.append(r)
    log(f"После фильтрации: {len(filtered)}")
    return filtered


# ---------------------------------------------------------
# Извлечение цены
# ---------------------------------------------------------

def _iter_jsonld(soup):
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or tag.get_text() or "")
        except (json.JSONDecodeError, TypeError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                yield node
                for key in ("@graph", "offers", "mainEntity", "itemListElement"):
                    if key in node:
                        stack.append(node[key])


def price_from_jsonld(soup):
    """schema.org Product → Offer / AggregateOffer."""
    for node in _iter_jsonld(soup):
        types = node.get("@type")
        types = types if isinstance(types, list) else [types]
        if not any(t in ("Offer", "AggregateOffer") for t in types):
            continue
        raw = node.get("price") or node.get("lowPrice")
        spec = node.get("priceSpecification")
        if raw is None and isinstance(spec, dict):
            raw = spec.get("price")
        price = parse_number(raw) if raw is not None else None
        if price:
            currency = node.get("priceCurrency")
            if not currency and isinstance(spec, dict):
                currency = spec.get("priceCurrency")
            return {
                "price": price,
                "currency": normalize_currency(currency),
                "in_stock": availability(node.get("availability")),
                "source": "json-ld",
            }
    return None


def price_from_meta(soup):
    """Open Graph / microdata: product:price:amount, itemprop=price."""
    amount = (
        soup.find("meta", property="product:price:amount")
        or soup.find("meta", property="og:price:amount")
        or soup.find(attrs={"itemprop": "price"})
    )
    if not amount:
        return None
    raw = amount.get("content") or amount.get_text(" ", strip=True)
    price = parse_number(raw)
    if not price:
        return None
    currency_tag = (
        soup.find("meta", property="product:price:currency")
        or soup.find("meta", property="og:price:currency")
        or soup.find(attrs={"itemprop": "priceCurrency"})
    )
    currency = currency_tag.get("content") if currency_tag else None
    stock_tag = soup.find(attrs={"itemprop": "availability"}) or soup.find("meta", property="product:availability")
    stock = (stock_tag.get("href") or stock_tag.get("content")) if stock_tag else None
    return {"price": price, "currency": normalize_currency(currency), "in_stock": availability(stock), "source": "meta"}


PRICE_PATTERNS = [
    re.compile(r"(?P<cur>[€$£₽])\s?(?P<num>\d{1,3}(?:[ ., ]\d{3})*(?:[.,]\d{1,2})?)"),
    re.compile(r"(?P<num>\d{1,3}(?:[ ., ]\d{3})*(?:[.,]\d{1,2})?)\s?(?P<cur>€|EUR|USD|GBP|zł|PLN|SEK|NOK|DKK|kr|₽)", re.I),
]


def price_from_text(text):
    """Запасной вариант: первая цена с валютой в начале страницы."""
    for pattern in PRICE_PATTERNS:
        for match in pattern.finditer(text[:8000]):
            price = parse_number(match.group("num"))
            if price and price >= 1:
                return {"price": price, "currency": normalize_currency(match.group("cur")), "in_stock": None, "source": "text"}
    return None


def inspect_page(result, query):
    url = result["url"]
    domain = get_domain(url)
    offer = {"url": url, "domain": domain, "title": result.get("title", ""), "status": "error", "price": None, "query": query}
    try:
        response = requests.get(url, headers=HEADERS, timeout=PAGE_TIMEOUT, allow_redirects=True)
    except requests.RequestException as exc:
        log(f"[{domain}] ошибка запроса: {type(exc).__name__}")
        return offer

    if response.status_code in (401, 403, 429, 503):
        offer["status"] = "blocked"
        log(f"[{domain}] сайт закрыт для ботов (HTTP {response.status_code})")
        return offer
    if response.status_code >= 400:
        log(f"[{domain}] HTTP {response.status_code}")
        return offer

    soup = BeautifulSoup(response.text, "html.parser")
    if soup.title and soup.title.get_text(strip=True):
        offer["title"] = soup.title.get_text(" ", strip=True)[:300]

    if not is_relevant_strict(offer["query"], offer["title"], url):
        offer["status"] = "irrelevant"
        log(f"[{domain}] не тот товар: {offer['title'][:80]}")
        return offer

    price = price_from_jsonld(soup) or price_from_meta(soup) or price_from_text(soup.get_text(" ", strip=True))
    offer["status"] = "ok"
    offer["price"] = price
    log(f"[{domain}] {price['price']:.2f} {price['currency'] or ''} ({price['source']})" if price else f"[{domain}] цена не найдена")
    return offer


def inspect_pages(results, query):
    offers = []
    total = len(results)
    progress("pages", 0, total)
    with ThreadPoolExecutor(max_workers=PAGE_WORKERS) as pool:
        futures = [pool.submit(inspect_page, r, query) for r in results]
        for done, future in enumerate(as_completed(futures), start=1):
            offers.append(future.result())
            progress("pages", done, total, priced=sum(1 for o in offers if o["price"]))
    return offers


def clean_offers(offers):
    """Убирает мусор текстового парсера и дубли."""
    for o in offers:
        price = o.get("price")
        if not price:
            continue
        local = currency_for_domain(o["domain"])
        # Валюта по доменной зоне, если магазин её не указал
        # или текстовый парсер нашёл «чужой» символ (например $ на .ee).
        if not price.get("currency") or (price["source"] == "text" and local and price["currency"] != local):
            price["currency"] = local or price.get("currency")

    # Выбросы: текстовая цена в 3+ раза дальше от медианы надёжных цен.
    trusted = sorted(o["price"]["price"] for o in offers if o.get("price") and o["price"]["source"] != "text")
    if len(trusted) >= 3:
        median = trusted[len(trusted) // 2]
        for o in offers:
            price = o.get("price")
            if price and price["source"] == "text" and not (median / 3 <= price["price"] <= median * 3):
                log(f"[{o['domain']}] цена {price['price']} отброшена как выброс (медиана {median})")
                o["price"] = None

    # Дубли: один магазин, одно название, одна цена.
    unique, seen = [], set()
    for o in offers:
        key = (o["domain"], (o.get("title") or "").strip().lower(), (o.get("price") or {}).get("price"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(o)
    return unique


# ---------------------------------------------------------
# Сохранение
# ---------------------------------------------------------

def save_results(query, offers):
    """Сохраняет свежие результаты; старые предложения по этому запросу удаляются."""
    progress("save")
    usable = [o for o in offers if o["status"] == "ok"]
    conn = psycopg2.connect(**DB_CONFIG)
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM products WHERE search_query = %s", (query,))
            row = cur.fetchone()
            if row:
                product_id = row[0]
                cur.execute("DELETE FROM offers WHERE product_id = %s", (product_id,))
            else:
                cur.execute(
                    "INSERT INTO products (name, search_query) VALUES (%s, %s) RETURNING id",
                    (query, query),
                )
                product_id = cur.fetchone()[0]

            for o in usable:
                price = o["price"] or {}
                cur.execute(
                    """
                    INSERT INTO offers (product_id, store, title, price, currency, in_stock, url,
                                        price_source, price_eur, last_seen)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (product_id, store, url) DO UPDATE SET
                        title = EXCLUDED.title, price = EXCLUDED.price, currency = EXCLUDED.currency,
                        in_stock = EXCLUDED.in_stock, price_source = EXCLUDED.price_source,
                        price_eur = EXCLUDED.price_eur, last_seen = NOW()
                    """,
                    (
                        product_id, o["domain"], o["title"][:500],
                        price.get("price"), (price.get("currency") or "")[:3] or None,
                        price.get("in_stock"), o["url"],
                        price.get("source"), to_eur(price.get("price"), price.get("currency")),
                    ),
                )
    finally:
        conn.close()
    log(f"Сохранено предложений: {len(usable)}")
    return len(usable)


def main():
    if len(sys.argv) < 2:
        print('Использование: python bot.py "Ryzen 7 9800X3D"')
        sys.exit(1)

    query = " ".join(sys.argv[1:]).strip()
    log(f"Поиск: {query}")

    results = filter_results(query, search(query))
    offers = clean_offers(inspect_pages(results, query))
    saved = save_results(query, offers)

    blocked = sum(1 for o in offers if o["status"] == "blocked")
    priced = sum(1 for o in offers if o["price"])
    progress("done", saved, len(offers), priced=priced, blocked=blocked)
    log(f"Итог: страниц {len(offers)}, с ценой {priced}, закрыты для ботов {blocked}, сохранено {saved}")


if __name__ == "__main__":
    main()
