#!/usr/bin/env python3
"""AutoDealFinder — машины ниже рынка с ss.com (Латвия) → группа в Telegram.

Источники — только то, что ss.com отдаёт открыто: RSS-лента новых объявлений
(обновляется каждые 5 минут) и страницы списков, разрешённые их robots.txt.
Запросы редкие и подписаны (User-Agent), без обходов защиты.

Как считается «ниже рынка»: для нового объявления берём похожие машины из
базы (та же марка и модель, год ±1, пробег ±50 тыс. км), приводим их цены к
году и пробегу этой машины и берём медиану. Если цена ниже медианы на
`min_discount` и больше — шлём карточку в группу.

Только стандартная библиотека Python. Настройки — config.json, секреты — .env.
"""
import html
import json
import logging
import os
import re
import sqlite3
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

BASE = "https://www.ss.com"
UA = "HomeLab-AutoDealFinder/1.0 (personal use; polite polling)"
HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("ADF_DATA", HERE / "data"))
CFG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("adf")

# ---------------------------------------------------------------------------
# HTTP: один запрос за раз, с паузой между запросами к ss.com
# ---------------------------------------------------------------------------
_last_ss = 0.0
_ss_lock = threading.Lock()


def fetch(url: str, *, ss: bool = True, timeout: int = 20, data: bytes | None = None) -> bytes:
    global _last_ss
    if ss:
        with _ss_lock:
            wait = CFG["request_gap_sec"] - (time.time() - _last_ss)
            if wait > 0:
                time.sleep(wait)
            _last_ss = time.time()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "ru"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def text(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def num(s: str) -> int | None:
    d = re.sub(r"[^\d]", "", s or "")
    return int(d) if d else None


def slugs(url: str) -> tuple[str, str] | None:
    m = re.search(r"/transport/cars/([^/]+)/([^/]+)/[^/]+\.html", url)
    return (m.group(1), m.group(2)) if m else None


def ad_id(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1].replace(".html", "")


# ---------------------------------------------------------------------------
# База
# ---------------------------------------------------------------------------
DATA.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(DATA / "ads.sqlite", check_same_thread=False)
db.execute("""CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY, brand TEXT, model TEXT, year INT, engine TEXT,
  mileage_k INT, price INT, url TEXT, title TEXT,
  first_seen TEXT, last_seen TEXT)""")
db.execute("CREATE INDEX IF NOT EXISTS ads_bm ON ads(brand, model, year)")
db.execute("""CREATE TABLE IF NOT EXISTS sent (id TEXT PRIMARY KEY, at TEXT, discount REAL)""")
db.execute("""CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)""")
db.commit()
dblock = threading.Lock()


def kv_get(k, default=None):
    row = db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    return row[0] if row else default


def kv_set(k, v):
    with dblock:
        db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (k, str(v)))
        db.commit()


def upsert(ad: dict) -> bool:
    """Сохраняет объявление. True, если оно новое."""
    now = datetime.now().isoformat(timespec="seconds")
    with dblock:
        cur = db.execute("SELECT 1 FROM ads WHERE id=?", (ad["id"],)).fetchone()
        if cur:
            db.execute("UPDATE ads SET price=?, mileage_k=COALESCE(?, mileage_k), last_seen=? WHERE id=?",
                       (ad["price"], ad.get("mileage_k"), now, ad["id"]))
        else:
            db.execute("INSERT INTO ads VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                       (ad["id"], ad["brand"], ad["model"], ad.get("year"), ad.get("engine"),
                        ad.get("mileage_k"), ad["price"], ad["url"], ad.get("title", ""), now, now))
        db.commit()
    return not cur


# ---------------------------------------------------------------------------
# ss.com: списки объявлений (для базы цен)
# ---------------------------------------------------------------------------
def parse_list(page: str) -> list[dict]:
    out = []
    for row in re.findall(r'<tr id="tr_\d+".*?</tr>', page, re.S):
        link = re.search(r'href="(/msg/[^"]+\.html)"', row)
        cells = [text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if not link or len(cells) < 8:
            continue
        url = BASE + link.group(1)
        sl = slugs(url)
        price = num(cells[7]) if "€" in cells[7] else None
        if not sl or not price:
            continue
        mil = cells[6]
        out.append({
            "id": ad_id(url), "brand": sl[0], "model": sl[1], "url": url, "title": cells[2][:200],
            "year": num(cells[4]), "engine": cells[5], "price": price,
            "mileage_k": num(mil) if "тыс" in mil else None,
        })
    return out


def brands() -> list[str]:
    page = fetch(f"{BASE}/ru/transport/cars/").decode("utf-8", "ignore")
    found = re.findall(r'href="/ru/transport/cars/([a-z0-9-]+)/"', page)
    skip = {"sell", "buy", "change", "exchange", "rss", "today", "filter", "search", "other"}
    return sorted({b for b in found if b not in skip})


def crawl_market():
    """Проходит все марки и страницы — база цен. Вежливо: пауза между запросами."""
    log.info("market crawl: start")
    total = 0
    for b in brands():
        page_no = 1
        while True:
            url = f"{BASE}/ru/transport/cars/{b}/" + ("" if page_no == 1 else f"page{page_no}.html")
            try:
                page = fetch(url).decode("utf-8", "ignore")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break
                raise
            ads = parse_list(page)
            for a in ads:
                upsert(a)
            total += len(ads)
            last = max([int(n) for n in re.findall(rf"/ru/transport/cars/{re.escape(b)}/page(\d+)\.html", page)] or [1])
            # ss.com на страницах за последней отдаёт первую — останавливаемся по номеру
            if page_no >= last or not ads or page_no >= CFG["max_pages_per_brand"]:
                break
            page_no += 1
    # Старые объявления, которых давно нет в списках, в оценку не берём
    cutoff = (datetime.now() - timedelta(days=CFG["market_days"])).isoformat()
    with dblock:
        db.execute("DELETE FROM ads WHERE last_seen < ?", (cutoff,))
        db.commit()
    kv_set("market_crawled", datetime.now().isoformat(timespec="seconds"))
    log.info("market crawl: done, %d rows seen", total)


# ---------------------------------------------------------------------------
# Оценка рынка
# ---------------------------------------------------------------------------
def market_price(ad: dict) -> tuple[int, int] | None:
    """Медиана цен похожих машин, приведённых к году и пробегу этой. (цена, сколько похожих)."""
    y, m = ad.get("year"), ad.get("mileage_k")
    if not y:
        return None
    for dy, dm in ((1, 50), (2, 80)):
        rows = db.execute(
            "SELECT year, mileage_k, price FROM ads WHERE brand=? AND model=? AND id<>? AND price>=500 "
            "AND year BETWEEN ? AND ?", (ad["brand"], ad["model"], ad["id"], y - dy, y + dy)).fetchall()
        adj = []
        for yc, mc, pc in rows:
            if m is not None and mc is not None and abs(mc - m) > dm:
                continue
            k = (1 + CFG["depreciation_per_year"]) ** (y - yc)               # моложе — дороже
            if m is not None and mc is not None:
                k *= 1 - CFG["depreciation_per_10k_km"] * (m - mc) / 10       # больше пробег — дешевле
            adj.append(pc * k)
        if len(adj) >= CFG["min_comparables"]:
            return int(statistics.median(adj)), len(adj)
    return None


# ---------------------------------------------------------------------------
# Страница объявления — подробности для карточки
# ---------------------------------------------------------------------------
def details(url: str) -> dict:
    page = fetch(url).decode("utf-8", "ignore")
    opts = {}
    for k, v in re.findall(r'class="ads_opt_name"[^>]*>(.*?)</td>\s*<td class="ads_opt"[^>]*>(.*?)</td>', page, re.S):
        opts[text(k).rstrip(":").strip()] = text(v)
    body = re.search(r'<div id="msg_div_msg">(.*?)<table', page, re.S)
    photo = re.findall(r"https://i\.ss\.com/gallery/[^\"']+\.800\.jpg", page)
    return {"opts": opts, "text": text(body.group(1)) if body else "", "photo": photo[0] if photo else None}


# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------
def tg(method: str, **params):
    data = urllib.parse.urlencode({k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}).encode()
    raw = fetch(f"https://api.telegram.org/bot{TOKEN}/{method}", ss=False, data=data, timeout=40)
    return json.loads(raw)


def chat_id() -> str | None:
    return os.environ.get("TELEGRAM_CHAT_ID") or kv_get("chat_id")


def fmt_money(n: int) -> str:
    return f"{n:,}".replace(",", " ") + " €"


def send_deal(ad: dict, market: int, n: int, info: dict):
    o = info["opts"]
    disc = 1 - ad["price"] / market
    name = o.get("Марка") or f"{ad['brand'].title()} {ad['model'].upper()}"
    lines = [
        f"<b>{html.escape(name)}</b> · {html.escape(o.get('Год выпуска', str(ad.get('year') or '')))}",
        f"💶 <b>{fmt_money(ad['price'])}</b>  ·  рынок ≈ {fmt_money(market)}  ·  <b>−{disc:.0%}</b>",
        f"<i>по {n} похожим объявлениям ss.com</i>",
        "",
    ]
    facts = [("Двигатель", "⚙️"), ("Коробка передач", "🔁"), ("Пробег, км", "🛣"), ("Тип кузова", "🚗"), ("Цвет", "🎨"), ("Техосмотр", "🧾")]
    for key, icon in facts:
        if o.get(key):
            val = o[key] + (" км" if key == "Пробег, км" else "")
            lines.append(f"{icon} {html.escape(key.split(',')[0])}: {html.escape(val)}")
    warn = [w for w in CFG["warn_words"] if w in (info["text"] + " " + ad.get("title", "")).lower()]
    if warn:
        lines.append(f"⚠️ В тексте: {html.escape(', '.join(warn))}")
    if disc >= CFG["suspicious_discount"]:
        lines.append("⚠️ Слишком дёшево — проверьте, нет ли подвоха (лизинг, долги, мошенники)")
    if info["text"]:
        lines += ["", html.escape(info["text"][:300]) + ("…" if len(info["text"]) > 300 else "")]
    caption = "\n".join(lines)[:1024]
    kb = {"inline_keyboard": [[{"text": "Открыть на ss.com", "url": ad["url"]}]]}
    cid = chat_id()
    if info["photo"]:
        r = tg("sendPhoto", chat_id=cid, photo=info["photo"], caption=caption, parse_mode="HTML", reply_markup=kb)
    else:
        r = tg("sendMessage", chat_id=cid, text=caption, parse_mode="HTML", reply_markup=kb, disable_web_page_preview=True)
    if not r.get("ok"):
        log.warning("telegram: %s", r)


# ---------------------------------------------------------------------------
# Фильтр и обработка нового объявления
# ---------------------------------------------------------------------------
def interesting(ad: dict) -> bool:
    f = CFG["filters"]
    if ad["price"] < f["price_min"] or ad["price"] > f["price_max"]:
        return False
    if not ad.get("year") or ad["year"] < f["year_min"]:
        return False
    if ad.get("mileage_k") and ad["mileage_k"] > f["mileage_max_k"]:
        return False
    t = ad.get("title", "").lower()
    return not any(w in t for w in CFG["skip_words"])


def handle_new(ad: dict):
    if not interesting(ad):
        return
    est = market_price(ad)
    if not est:
        return
    market, n = est
    disc = 1 - ad["price"] / market
    if disc < CFG["min_discount"]:
        return
    if db.execute("SELECT 1 FROM sent WHERE id=?", (ad["id"],)).fetchone():
        return
    info = details(ad["url"])
    full = (info["text"] + " " + ad.get("title", "")).lower()
    if any(w in full for w in CFG["skip_words"]):
        return
    if not chat_id():
        log.info("deal (no group yet): %s %s %s €, −%.0f%%", ad["brand"], ad["model"], ad["price"], disc * 100)
        return
    send_deal(ad, market, n, info)
    with dblock:
        db.execute("INSERT OR REPLACE INTO sent VALUES (?, ?, ?)", (ad["id"], datetime.now().isoformat(timespec="seconds"), disc))
        db.commit()
    log.info("sent: %s %s %s € (market %s, −%.0f%%)", ad["brand"], ad["model"], ad["price"], market, disc * 100)


def parse_rss(raw: bytes) -> list[dict]:
    out = []
    for it in ET.fromstring(raw).iter("item"):
        url = it.findtext("link") or ""
        sl = slugs(url)
        desc = text(it.findtext("description") or "")
        price = re.search(r"Цена:\s*([\d,\s]+)\s*€", desc)
        if not sl or not price:
            continue
        year = re.search(r"Год:\s*(\d{4})", desc)
        vol = re.search(r"Объём:\s*([\d.]+)", desc)
        mil = re.search(r"Пробег:\s*([\d\s]+)\s*тыс", desc)
        out.append({
            "id": ad_id(url), "brand": sl[0], "model": sl[1], "url": url,
            "title": text(it.findtext("title") or "")[:200], "price": num(price.group(1)),
            "year": int(year.group(1)) if year else None, "engine": vol.group(1) if vol else None,
            "mileage_k": num(mil.group(1)) if mil else None,
        })
    return out


def poll_rss():
    raw = fetch(f"{BASE}/ru/transport/cars/rss/")
    new = 0
    for ad in parse_rss(raw):
        if upsert(ad):
            new += 1
            try:
                handle_new(ad)
            except Exception:
                log.exception("handle %s", ad["url"])
    if new:
        log.info("rss: %d new", new)


# ---------------------------------------------------------------------------
# Команды в группе и поиск группы, куда добавили бота
# ---------------------------------------------------------------------------
def bot_loop():
    offset = int(kv_get("tg_offset", "0"))
    while True:
        try:
            r = tg("getUpdates", offset=offset, timeout=30, allowed_updates=["message", "my_chat_member"])
            for u in r.get("result", []):
                offset = u["update_id"] + 1
                kv_set("tg_offset", offset)
                mcm = u.get("my_chat_member")
                if mcm and mcm["chat"]["type"] in ("group", "supergroup") and mcm["new_chat_member"]["status"] in ("member", "administrator"):
                    if not os.environ.get("TELEGRAM_CHAT_ID"):
                        kv_set("chat_id", mcm["chat"]["id"])
                        log.info("joined group %s (%s)", mcm["chat"].get("title"), mcm["chat"]["id"])
                        tg("sendMessage", chat_id=mcm["chat"]["id"], parse_mode="HTML", text=(
                            "Привет! Буду присылать сюда машины с <b>ss.com</b>, которые дешевле рынка "
                            f"на {CFG['min_discount']:.0%} и больше: от {CFG['filters']['year_min']} года, "
                            f"от {fmt_money(CFG['filters']['price_min'])}, пробег до {CFG['filters']['mileage_max_k']} тыс. км.\n"
                            "Команды: /status — что с базой цен."))
                msg = u.get("message") or {}
                if str(msg.get("chat", {}).get("id")) == str(chat_id()) and (msg.get("text") or "").startswith("/status"):
                    n_ads = db.execute("SELECT COUNT(*) FROM ads").fetchone()[0]
                    n_sent = db.execute("SELECT COUNT(*) FROM sent WHERE at >= ?", ((datetime.now() - timedelta(days=1)).isoformat(),)).fetchone()[0]
                    tg("sendMessage", chat_id=msg["chat"]["id"], text=(
                        f"В базе цен: {n_ads} объявлений\nОбновлена: {kv_get('market_crawled', 'ещё нет')}\n"
                        f"Выгодных за сутки: {n_sent}"))
        except Exception:
            log.exception("bot loop")
            time.sleep(10)


def crawl_safe():
    try:
        crawl_market()
    except Exception:
        log.exception("crawl")


def main():
    threading.Thread(target=bot_loop, daemon=True).start()
    # Обход рынка идёт в своём потоке: лента новых объявлений не ждёт его
    if not kv_get("market_crawled"):
        threading.Thread(target=crawl_safe, daemon=True).start()
    last_crawl_day = kv_get("market_crawled", "")[:10]
    while True:
        try:
            poll_rss()
        except Exception:
            log.exception("rss")
        now = datetime.now()
        if now.hour == CFG["crawl_hour"] and now.strftime("%Y-%m-%d") != last_crawl_day:
            last_crawl_day = now.strftime("%Y-%m-%d")
            threading.Thread(target=crawl_safe, daemon=True).start()
        time.sleep(CFG["rss_every_sec"])


if __name__ == "__main__":
    main()
