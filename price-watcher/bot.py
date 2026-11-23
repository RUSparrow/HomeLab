
import re
import psycopg2
import sys
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from ddgs import DDGS


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 "
        "(KHTML, like Gecko) "
        "Chrome/140.0 Safari/537.36"
    )
}

DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "database": "pricewatcher",
    "user": "pricewatcher",
    "password": " ",
}

# Сайты, которые не являются магазинами
EXCLUDED_DOMAINS = {
    "wikipedia.org",
    "grokipedia.com",
    "amd.com",
    "reddit.com",
    "hardforum.com",
    "idc.com",
    "userbenchmark.com",
}


# ---------------------------------------------------------
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ---------------------------------------------------------

def save_results(product_name, results):

    conn = psycopg2.connect(**DB_CONFIG)

    try:
        with conn:
            with conn.cursor() as cur:

                # Получаем или создаём товар
                cur.execute(
                    """
                    SELECT id
                    FROM products
                    WHERE search_query = %s
                    """,
                    (product_name,)
                )

                product = cur.fetchone()

                if product:

                    product_id = product[0]

                else:

                    cur.execute(
                        """
                        INSERT INTO products
                            (name, search_query)
                        VALUES
                            (%s, %s)
                        RETURNING id
                        """,
                        (
                            product_name,
                            product_name,
                        )
                    )

                    product_id = cur.fetchone()[0]

                saved = 0

                for offer in results:

                    url = offer["url"]
                    store = offer["domain"]
                    title = offer.get("title", "")

                    price_data = offer.get("price")

                    if price_data:

                        price = price_data["price"]
                        currency = price_data["currency"]

                    else:

                        price = None
                        currency = None

                    status = offer.get(
                        "status",
                        "unknown",
                    )

                    # Пока статус страницы:
                    # ok / blocked / error
                    if status == "ok":
                        in_stock = None
                    else:
                        in_stock = False

                    cur.execute(
                        """
                        INSERT INTO offers
                        (
                            product_id,
                            store,
                            title,
                            price,
                            currency,
                            in_stock,
                            url,
                            last_seen
                        )
                        VALUES
                        (
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            NOW()
                        )

                        ON CONFLICT
                            (product_id, store, url)

                        DO UPDATE SET
                            title = EXCLUDED.title,
                            price = EXCLUDED.price,
                            currency = EXCLUDED.currency,
                            in_stock = EXCLUDED.in_stock,
                            last_seen = NOW()
                        """,
                        (
                            product_id,
                            store,
                            title,
                            price,
                            currency,
                            in_stock,
                            url,
                        )
                    )

                    saved += 1

                print()
                print(
                    f"Сохранено/обновлено предложений: {saved}"
                )

    finally:

        conn.close()

def get_domain(url):
    domain = urlparse(url).netloc.lower()

    if domain.startswith("www."):
        domain = domain[4:]

    return domain


def is_excluded(url):
    domain = get_domain(url)

    return any(
        domain == excluded or domain.endswith("." + excluded)
        for excluded in EXCLUDED_DOMAINS
    )


# ---------------------------------------------------------
# ПОИСК
# ---------------------------------------------------------

def search(query, max_results=8):
    """
    Многоязычный и региональный поиск товара.

    Ищем:
    - международно
    - на языках стран Балтии
    - на языках Скандинавии
    - на немецком и польском
    - по конкретным местным магазинам

    Результаты объединяются и дубли удаляются.
    """

    search_profiles = [

        # =================================================
        # INTERNATIONAL
        # =================================================

        {
            "query": query,
            "region": "us-en",
            "label": "International / English",
        },

        {
            "query": f"{query} price",
            "region": "us-en",
            "label": "International price",
        },

        {
            "query": f"{query} buy",
            "region": "us-en",
            "label": "International buy",
        },


        # =================================================
        # ESTONIA 🇪🇪
        # =================================================

        {
            "query": f"{query} hind",
            "region": "ee-et",
            "label": "Estonia / Estonian",
        },

        {
            "query": f"{query} osta",
            "region": "ee-et",
            "label": "Estonia / Buy",
        },

        {
            "query": f"{query} hind osta",
            "region": "ee-et",
            "label": "Estonia / Price",
        },

        {
            "query": f"site:arvutitark.ee {query}",
            "region": "ee-et",
            "label": "Arvutitark",
        },

        {
            "query": f"site:1a.ee {query}",
            "region": "ee-et",
            "label": "1a.ee",
        },

        {
            "query": f"site:kaup24.ee {query}",
            "region": "ee-et",
            "label": "Kaup24",
        },

        {
            "query": f"site:galador.ee {query}",
            "region": "ee-et",
            "label": "Galador",
        },

        {
            "query": f"site:photopoint.ee {query}",
            "region": "ee-et",
            "label": "Photopoint",
        },


        # =================================================
        # LATVIA 🇱🇻
        # =================================================

        {
            "query": f"{query} cena",
            "region": "lv-lv",
            "label": "Latvia / Latvian",
        },

        {
            "query": f"{query} pirkt",
            "region": "lv-lv",
            "label": "Latvia / Buy",
        },

        {
            "query": f"site:1a.lv {query}",
            "region": "lv-lv",
            "label": "1a.lv",
        },

        {
            "query": f"site:dateks.lv {query}",
            "region": "lv-lv",
            "label": "Dateks",
        },

        {
            "query": f"site:rdveikals.lv {query}",
            "region": "lv-lv",
            "label": "RD Electronics",
        },

        {
            "query": f"site:m79.lv {query}",
            "region": "lv-lv",
            "label": "M79",
        },


        # =================================================
        # LITHUANIA 🇱🇹
        # =================================================

        {
            "query": f"{query} kaina",
            "region": "lt-lt",
            "label": "Lithuania / Lithuanian",
        },

        {
            "query": f"{query} pirkti",
            "region": "lt-lt",
            "label": "Lithuania / Buy",
        },

        {
            "query": f"site:varle.lt {query}",
            "region": "lt-lt",
            "label": "Varle",
        },

        {
            "query": f"site:skytech.lt {query}",
            "region": "lt-lt",
            "label": "Skytech",
        },

        {
            "query": f"site:kilobaitas.lt {query}",
            "region": "lt-lt",
            "label": "Kilobaitas",
        },

        {
            "query": f"site:1a.lt {query}",
            "region": "lt-lt",
            "label": "1a.lt",
        },


        # =================================================
        # FINLAND 🇫🇮
        # =================================================

        {
            "query": f"{query} hinta",
            "region": "fi-fi",
            "label": "Finland / Finnish",
        },

        {
            "query": f"{query} osta",
            "region": "fi-fi",
            "label": "Finland / Buy",
        },

        {
            "query": f"site:verkkokauppa.com {query}",
            "region": "fi-fi",
            "label": "Verkkokauppa",
        },

        {
            "query": f"site:jimms.fi {query}",
            "region": "fi-fi",
            "label": "Jimm's",
        },

        {
            "query": f"site:gigantti.fi {query}",
            "region": "fi-fi",
            "label": "Gigantti Finland",
        },

        {
            "query": f"site:proshop.fi {query}",
            "region": "fi-fi",
            "label": "Proshop Finland",
        },


        # =================================================
        # SWEDEN 🇸🇪
        # =================================================

        {
            "query": f"{query} pris",
            "region": "se-sv",
            "label": "Sweden / Swedish",
        },

        {
            "query": f"{query} köpa",
            "region": "se-sv",
            "label": "Sweden / Buy",
        },

        {
            "query": f"site:inet.se {query}",
            "region": "se-sv",
            "label": "Inet",
        },

        {
            "query": f"site:webhallen.com {query}",
            "region": "se-sv",
            "label": "Webhallen",
        },

        {
            "query": f"site:elgiganten.se {query}",
            "region": "se-sv",
            "label": "Elgiganten Sweden",
        },

        {
            "query": f"site:komplett.se {query}",
            "region": "se-sv",
            "label": "Komplett Sweden",
        },


        # =================================================
        # NORWAY 🇳🇴
        # =================================================

        {
            "query": f"{query} pris",
            "region": "no-no",
            "label": "Norway / Norwegian",
        },

        {
            "query": f"{query} kjøpe",
            "region": "no-no",
            "label": "Norway / Buy",
        },

        {
            "query": f"site:komplett.no {query}",
            "region": "no-no",
            "label": "Komplett Norway",
        },

        {
            "query": f"site:elkjop.no {query}",
            "region": "no-no",
            "label": "Elkjøp",
        },

        {
            "query": f"site:proshop.no {query}",
            "region": "no-no",
            "label": "Proshop Norway",
        },


        # =================================================
        # DENMARK 🇩🇰
        # =================================================

        {
            "query": f"{query} pris",
            "region": "dk-da",
            "label": "Denmark / Danish",
        },

        {
            "query": f"{query} køb",
            "region": "dk-da",
            "label": "Denmark / Buy",
        },

        {
            "query": f"site:proshop.dk {query}",
            "region": "dk-da",
            "label": "Proshop Denmark",
        },

        {
            "query": f"site:elgiganten.dk {query}",
            "region": "dk-da",
            "label": "Elgiganten Denmark",
        },


        # =================================================
        # GERMANY 🇩🇪
        # =================================================

        {
            "query": f"{query} Preis",
            "region": "de-de",
            "label": "Germany / German",
        },

        {
            "query": f"{query} kaufen",
            "region": "de-de",
            "label": "Germany / Buy",
        },

        {
            "query": f"site:mindfactory.de {query}",
            "region": "de-de",
            "label": "Mindfactory",
        },

        {
            "query": f"site:alternate.de {query}",
            "region": "de-de",
            "label": "Alternate Germany",
        },

        {
            "query": f"site:caseking.de {query}",
            "region": "de-de",
            "label": "Caseking",
        },

        {
            "query": f"site:computeruniverse.net {query}",
            "region": "de-de",
            "label": "Computeruniverse",
        },


        # =================================================
        # POLAND 🇵🇱
        # =================================================

        {
            "query": f"{query} cena",
            "region": "pl-pl",
            "label": "Poland / Polish",
        },

        {
            "query": f"{query} kupić",
            "region": "pl-pl",
            "label": "Poland / Buy",
        },

        {
            "query": f"site:x-kom.pl {query}",
            "region": "pl-pl",
            "label": "x-kom",
        },

        {
            "query": f"site:morele.net {query}",
            "region": "pl-pl",
            "label": "Morele",
        },

        {
            "query": f"site:komputronik.pl {query}",
            "region": "pl-pl",
            "label": "Komputronik",
        },


        # =================================================
        # RUSSIA / RUSSIAN 🇷🇺
        # =================================================

        {
            "query": f"{query} цена",
            "region": "ru-ru",
            "label": "Russian / Price",
        },

        {
            "query": f"{query} купить",
            "region": "ru-ru",
            "label": "Russian / Buy",
        },
    ]

    results = []
    seen_urls = set()

    print()
    print(
        f"Запускаем "
        f"{len(search_profiles)} "
        f"поисковых запросов..."
    )

    for profile in search_profiles:

        search_query = profile["query"]
        region = profile["region"]
        label = profile["label"]

        print()
        print(
            f"[{label}] "
            f"{search_query}"
        )

        try:

            with DDGS() as ddgs:

                search_results = ddgs.text(
                    search_query,
                    region=region,
                    safesearch="off",
                    max_results=max_results,
                )

                for result in search_results:

                    url = result.get(
                        "href",
                        "",
                    ).strip()

                    if not url:
                        continue

                    # Удаляем query-параметры
                    # для определения дублей
                    clean_url = (
                        url
                        .split("?")[0]
                        .rstrip("/")
                    )

                    if clean_url in seen_urls:
                        continue

                    seen_urls.add(clean_url)

                    results.append({
                        "title": result.get(
                            "title",
                            "",
                        ),
                        "url": url,
                        "snippet": result.get(
                            "body",
                            "",
                        ),
                        "search_query": search_query,
                        "region": region,
                        "search_label": label,
                    })

        except Exception as e:

            print(
                f"Ошибка: {e}"
            )

    print()
    print(
        f"Уникальных результатов: "
        f"{len(results)}"
    )

    return results

# ---------------------------------------------------------
# ИЗВЛЕЧЕНИЕ ЦЕН
# ---------------------------------------------------------

def extract_prices(text):
    """
    Общий поиск цен на странице.
    Используется как fallback, если нет
    специального парсера магазина.
    """

    text = text[:5000]

    patterns = [
        # $469.00
        r"(?P<currency>[$€£])\s*"
        r"(?P<price>\d{1,5}(?:[.,]\d{1,2})?)",

        # 469.00 USD
        r"(?P<price>\d{1,5}(?:[.,]\d{1,2})?)\s*"
        r"(?P<currency>EUR|USD|GBP)",
    ]

    prices = []

    for pattern in patterns:

        for match in re.finditer(
            pattern,
            text,
            re.IGNORECASE,
        ):

            if match.groupdict().get("currency"):
                currency = match.group("currency").upper()

            else:
                currency = ""

            price = match.group("price")

            price = price.replace(",", ".")

            try:
                price = float(price)
            except ValueError:
                continue

            # Отбрасываем явно подозрительные значения
            if price < 50:
                continue

            if price > 2000:
                continue

            prices.append({
                "price": price,
                "currency": currency,
            })

    # Удаляем дубликаты
    unique = []
    seen = set()

    for item in prices:

        key = (
            item["price"],
            item["currency"],
        )

        if key not in seen:
            seen.add(key)
            unique.append(item)

    return unique


# ---------------------------------------------------------
# NEWEGG
# ---------------------------------------------------------

def extract_newegg_price(text):
    """
    Newegg обычно отдаёт основную цену рядом с Item#.
    Например:

    Item#: N82E16819113877 $ 469 .00 $507.99
    """

    patterns = [

        # Item#: XXXXX $ 469 .00
        r"Item#:\s*[A-Z0-9]+\s+"
        r"\$\s*(\d{1,5})\s*"
        r"(?:[.]\s*(\d{1,2}))?",

        # Item#: XXXXX $469.00
        r"Item#:\s*[A-Z0-9]+\s+"
        r"\$\s*(\d{1,5}(?:[.,]\d{1,2})?)",
    ]

    for pattern in patterns:

        match = re.search(
            pattern,
            text,
            re.IGNORECASE,
        )

        if not match:
            continue

        whole = match.group(1)

        decimal = match.group(2)

        if decimal is not None:
            price = float(
                f"{whole}.{decimal}"
            )
        else:
            price = float(
                whole.replace(",", ".")
            )

        return {
            "price": price,
            "currency": "$",
        }

    return None


# ---------------------------------------------------------
# ОБЩИЙ ПАРСЕР ЦЕНЫ
# ---------------------------------------------------------

def extract_product_price(text, domain):

    # Специальный парсер Newegg
    if "newegg.com" in domain:

        price = extract_newegg_price(text)

        if price:
            return price

    # Общий fallback
    prices = extract_prices(text)

    if prices:
        return prices[0]

    return None


# ---------------------------------------------------------
# ПРОВЕРКА СТРАНИЦЫ
# ---------------------------------------------------------

def inspect_page(url, query):

    print()
    print("=" * 80)
    print(f"URL: {url}")

    domain = get_domain(url)

    try:

        response = requests.get(
            url,
            headers=HEADERS,
            timeout=15,
            allow_redirects=True,
        )

        print(f"HTTP: {response.status_code}")

        # Защита магазина
        if response.status_code in (
            401,
            403,
            429,
        ):

            print("STATUS: BLOCKED")
            print(
                "Причина: сайт не разрешил автоматический доступ"
            )

            return {
                "url": url,
                "domain": domain,
                "status": "blocked",
                "price": None,
            }

        # Остальные ошибки
        if response.status_code >= 400:

            print("STATUS: ERROR")

            return {
                "url": url,
                "domain": domain,
                "status": "error",
                "price": None,
            }

        # HTML
        soup = BeautifulSoup(
            response.text,
            "html.parser",
        )

        # Заголовок
        if soup.title:

            title = soup.title.get_text(
                " ",
                strip=True,
            )

        else:

            title = ""

        print(f"TITLE: {title}")

        # Весь текст страницы
        text = soup.get_text(
            " ",
            strip=True,
        )

        # Цена
        price = extract_product_price(
            text,
            domain,
        )

        if price:

            print(
                f"PRICE: "
                f"{price['price']:.2f} "
                f"{price['currency']}"
            )

        else:

            print("PRICE: unavailable")

        # Небольшой фрагмент страницы
        print()
        print(
            f"TEXT: {text[:500]}"
        )

        return {
            "url": url,
            "domain": domain,
            "status": "ok",
            "title": title,
            "price": price,
        }

    except requests.RequestException as e:

        print(
            f"REQUEST ERROR: {e}"
        )

        return {
            "url": url,
            "domain": domain,
            "status": "error",
            "price": None,
        }


# ---------------------------------------------------------
# ОСНОВНАЯ ПРОГРАММА
# ---------------------------------------------------------

def main():

    if len(sys.argv) < 2:

        print(
            'Использование: '
            'python bot.py "Ryzen 7 9800X3D"'
        )

        sys.exit(1)

    query = " ".join(
        sys.argv[1:]
    )

    print(
        f"Поиск: {query}"
    )

    # -----------------------------------------------------
    # ПОИСК
    # -----------------------------------------------------

    results = search(
        query,
        max_results=10,
    )

    print()
    print(
        f"Найдено результатов: "
        f"{len(results)}"
    )

    # -----------------------------------------------------
    # ФИЛЬТРАЦИЯ
    # -----------------------------------------------------

    filtered = []

    non_store_domains = {
        "youtube.com",
        "youtu.be",
        "tomshardware.com",
        "videocardz.com",
        "wccftech.com",
        "pcpartpicker.com",
        "gputracker.eu",
    }

    for result in results:

        title = result["title"]
        url = result["url"]
        snippet = result["snippet"]

        combined = (
            title
            + " "
            + snippet
            + " "
            + url
        ).lower()

        domain = get_domain(url)

        # -------------------------------------------------
        # Товар обязательно должен присутствовать
        # -------------------------------------------------

        query_lower = query.lower()

        if query_lower not in combined:

            # Для Ryzen 7 9800X3D разрешаем искать
            # по точному идентификатору модели.
            if "9800x3d" not in combined:
                continue

        # -------------------------------------------------
        # Известные НЕ-магазины
        # -------------------------------------------------

        if is_excluded(url):

            print(
                f"SKIP: {domain}"
            )

            continue

        # -------------------------------------------------
        # Дополнительные информационные сайты
        # -------------------------------------------------

        if any(
            domain == d
            or domain.endswith("." + d)
            for d in non_store_domains
        ):

            print(
                f"SKIP INFO: {domain}"
            )

            continue

        # -------------------------------------------------
        # Исключаем страницы поиска магазина
        # -------------------------------------------------

        lower_url = url.lower()

        search_page_markers = [
            "/search",
            "searchpage",
            "?q=",
            "?query=",
            "?keyword=",
            "/pl?",
        ]

        if any(
            marker in lower_url
            for marker in search_page_markers
        ):

            print(
                f"SKIP SEARCH PAGE: {url}"
            )

            continue

        # -------------------------------------------------
        # Добавляем нормальный результат
        # -------------------------------------------------

        filtered.append(result)

    # -----------------------------------------------------
    # РЕЗУЛЬТАТ ФИЛЬТРАЦИИ
    # -----------------------------------------------------

    print()
    print(
        f"После фильтрации: "
        f"{len(filtered)}"
    )

    # -----------------------------------------------------
    # ПОКАЗЫВАЕМ НАЙДЕННЫЕ МАГАЗИНЫ
    # -----------------------------------------------------

    for index, result in enumerate(
        filtered,
        1,
    ):

        print()
        print(
            f"{index}. "
            f"{result['title']}"
        )

        print(
            f"   {result['url']}"
        )

    # -----------------------------------------------------
    # ЗАХОДИМ НА СТРАНИЦЫ
    # -----------------------------------------------------

    offers = []

    for result in filtered:

        offer = inspect_page(
            result["url"],
            query,
        )

        offers.append(offer)

    # -----------------------------------------------------
    # СОХРАНЕНИЕ В БД
    # -----------------------------------------------------

    save_results(
        query,
        offers,
    )
    
    # -----------------------------------------------------
    # ИТОГ
    # -----------------------------------------------------

    print()
    print()
    print("=" * 80)
    print("ИТОГ")
    print("=" * 80)

    for offer in offers:

        domain = offer["domain"]

        status = offer["status"]

        price = offer.get(
            "price"
        )

        if price:

            price_text = (
                f"{price['price']:.2f} "
                f"{price['currency']}"
            )

        else:

            price_text = "N/A"

        print(
            f"{domain:25} "
            f"{price_text:12} "
            f"{status}"
        )


if __name__ == "__main__":
    main()

