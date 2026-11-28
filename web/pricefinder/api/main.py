import json
import os
import subprocess
import sys
import threading
import time
import uuid

import statistics
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg2
from fastapi import FastAPI, HTTPException

sys.path.insert(0, "/app")
from stores import COUNTRY_NAME, NOT_STORE_REASON, is_bundle, not_store, offer_trust, seller  # noqa: E402
from pydantic import BaseModel, Field

app = FastAPI(title="PriceFinder API", version="2.0.0")

DB_CONFIG = {
    "host": os.getenv("PRICEFINDER_DB_HOST", "localhost"),
    "port": int(os.getenv("PRICEFINDER_DB_PORT", "5432")),
    "database": os.getenv("PRICEFINDER_DB_NAME", "pricewatcher"),
    "user": os.getenv("PRICEFINDER_DB_USER", "pricewatcher"),
    "password": os.getenv("PRICEFINDER_DB_PASSWORD", " "),
}

SEARCH_TIMEOUT = 900       # 15 минут на весь поиск
JOB_TTL = 3600             # завершённые задачи храним час
MAX_PARALLEL_SEARCHES = 2  # больше — DuckDuckGo начнёт блокировать

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
search_slots = threading.Semaphore(MAX_PARALLEL_SEARCHES)


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=200)


def db():
    return psycopg2.connect(**DB_CONFIG)


def serialize_offer(row):
    return {
        "id": row[0],
        "product_id": row[1],
        "store": row[2],
        "title": row[3],
        "price": float(row[4]) if row[4] is not None else None,
        "currency": row[5],
        "in_stock": row[6],
        "url": row[7],
        "last_seen": row[8].isoformat() if row[8] else None,
        "price_source": row[9],
        "price_eur": float(row[10]) if row[10] is not None else None,
        # Цена из JSON-LD/микроразметки магазина — надёжная; из текста страницы — нет.
        "confirmed": row[9] in ("json-ld", "meta"),
    }


def enrich(offers, query):
    """Продавец, надёжность, пометки. Сравнивалки и сайты вне ЕС не показываем вовсе."""
    out = []
    for o in offers:
        if not_store(o["store"]):
            continue
        # Американские страницы глобальных магазинов (samsung.com/us/…) — не доставляют в ЕС
        path = urllib.parse.urlparse(o["url"]).path.lower()
        if path.startswith(("/us/", "/en-us/", "/en_us/")):
            continue
        s = seller(o["store"])
        trust, why = offer_trust(s, o["confirmed"], o["in_stock"])
        flags = []
        if o["in_stock"] is False:
            flags.append("out_of_stock")
        if o["price"] is None:
            flags.append("no_price")
        elif not o["confirmed"]:
            flags.append("unconfirmed")
        if is_bundle(query or "", o["title"]):
            flags.append("bundle")
        o.update(seller=s["name"], country=s["country"], country_name=COUNTRY_NAME.get(s["country"]),
                 seller_score=s["score"], seller_known=s["known"], seller_kind=s["kind"],
                 trust=trust, trust_why=why, flags=flags)
        out.append(o)
    # «Другой товар»: подтверждённая цена в 2,5 раза дальше медианы надёжных предложений
    base = [o["price_eur"] for o in out if o["price_eur"] and o["confirmed"] and o["in_stock"] is not False and "bundle" not in o["flags"]]
    if len(base) >= 3:
        med = statistics.median(base)
        for o in out:
            if o["price_eur"] and (o["price_eur"] > med * 2.5 or o["price_eur"] < med / 2.5):
                o["flags"].append("outlier")
    for o in out:
        o["main"] = not o["flags"]          # в основной список — только без пометок
    out.sort(key=lambda o: (not o["main"], o["price_eur"] is None, o["price_eur"] or 0, -o["trust"]))
    return out


def get_offers(product_id=None, query=None):
    sql = """
        SELECT o.id, o.product_id, o.store, o.title, o.price, o.currency, o.in_stock, o.url, o.last_seen,
               o.price_source, o.price_eur
        FROM offers o JOIN products p ON p.id = o.product_id
    """
    conditions, params = [], []
    if product_id is not None:
        conditions.append("o.product_id = %s")
        params.append(product_id)
    if query is not None:
        conditions.append("p.search_query = %s")
        params.append(query)
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += """
        ORDER BY (o.price IS NULL),
                 (o.price_source IS DISTINCT FROM 'json-ld' AND o.price_source IS DISTINCT FROM 'meta'),
                 o.price_eur NULLS LAST, o.price, o.id DESC
    """

    conn = db()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = [serialize_offer(row) for row in cur.fetchall()]
            if query is None and product_id is not None:
                cur.execute("SELECT search_query FROM products WHERE id = %s", (product_id,))
                r = cur.fetchone()
                query = r[0] if r else ""
            return enrich(rows, query)
    finally:
        conn.close()


def update_job(job_id, **fields):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(fields)


def cleanup_jobs():
    now = time.time()
    with jobs_lock:
        for job_id in [j for j, v in jobs.items() if v.get("finished_at") and now - v["finished_at"] > JOB_TTL]:
            del jobs[job_id]


def run_search(job_id, query):
    with search_slots:
        update_job(job_id, status="running", message="Ищем магазины…")
        log_lines: list[str] = []
        started = time.monotonic()
        try:
            process = subprocess.Popen(
                [sys.executable, "-u", "/app/bot.py", query],
                cwd="/app",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            for line in process.stdout:
                line = line.rstrip()
                if line.startswith("@@progress "):
                    try:
                        update_job(job_id, progress=json.loads(line[len("@@progress "):]))
                    except json.JSONDecodeError:
                        pass
                else:
                    log_lines.append(line)
                    del log_lines[:-200]
                if time.monotonic() - started > SEARCH_TIMEOUT:
                    process.kill()
                    raise subprocess.TimeoutExpired(process.args, SEARCH_TIMEOUT)
            return_code = process.wait()

            if return_code != 0:
                update_job(job_id, status="failed", message="Ошибка поискового бота.", log="\n".join(log_lines[-40:]))
                return

            offers = get_offers(query=query)
            update_job(
                job_id,
                status="completed",
                message="Поиск завершён.",
                log="\n".join(log_lines[-60:]),
                offers=offers,
                offers_count=len(offers),
            )
        except subprocess.TimeoutExpired:
            update_job(job_id, status="failed", message="Поиск превысил лимит времени — 15 минут.")
        except Exception as exc:
            update_job(job_id, status="failed", message=f"{type(exc).__name__}: {exc}")
        finally:
            update_job(job_id, finished_at=time.time())


@app.get("/api/health")
def health():
    try:
        conn = db()
        conn.close()
        database = "ok"
    except Exception as exc:
        database = f"error: {type(exc).__name__}"
    with jobs_lock:
        active = sum(1 for j in jobs.values() if j["status"] in ("queued", "running"))
    return {"status": "ok" if database == "ok" else "degraded", "database": database, "active_searches": active}


@app.get("/api/stats")
def stats():
    """Короткая сводка для Server Monitor."""
    conn = db()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    (SELECT count(*) FROM products),
                    (SELECT count(*) FROM offers),
                    (SELECT count(*) FROM offers WHERE price IS NOT NULL),
                    (SELECT max(last_seen) FROM offers),
                    pg_database_size(current_database())
            """)
            products, offers, priced, last_seen, size = cur.fetchone()
    finally:
        conn.close()
    with jobs_lock:
        active = sum(1 for j in jobs.values() if j["status"] in ("queued", "running"))
    return {
        "products": products,
        "offers": offers,
        "priced_offers": priced,
        "last_search": last_seen.isoformat() if last_seen else None,
        "db_size_bytes": size,
        "active_searches": active,
    }


@app.get("/api/history")
def history(limit: int = 12):
    conn = db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.search_query, count(o.id),
                       min(o.price_eur) FILTER (WHERE o.price_source IN ('json-ld', 'meta')),
                       max(o.last_seen), 'EUR'
                FROM products p LEFT JOIN offers o ON o.product_id = p.id
                GROUP BY p.id
                ORDER BY max(o.last_seen) DESC NULLS LAST, p.id DESC
                LIMIT %s
                """,
                (max(1, min(limit, 50)),),
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    best = {}
    for r in rows:
        main = [o for o in get_offers(product_id=r[0]) if o["main"] and o["price_eur"]]
        best[r[0]] = (min(o["price_eur"] for o in main) if main else None, len(main))
    return [
        {
            "product_id": r[0],
            "query": r[1],
            "offers": best[r[0]][1],
            "min_price": best[r[0]][0],
            "last_search": r[4].isoformat() if r[4] else None,
            "currency": r[5],
        }
        for r in rows
    ]


CATALOG = [l.strip() for l in (Path(__file__).parent / "catalog.txt").read_text(encoding="utf-8").splitlines()
           if l.strip() and not l.startswith("#")]
_suggest_cache: dict[str, tuple[float, list[str]]] = {}


def web_suggest(q: str) -> list[str]:
    """Подсказки поисковика (как в адресной строке браузера). DuckDuckGo с этого
    сервера недоступен, поэтому Google. Кэш на час, таймаут 2 секунды."""
    key = q.lower()
    hit = _suggest_cache.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    try:
        url = "https://www.google.com/complete/search?" + urllib.parse.urlencode({"client": "firefox", "hl": "en", "q": q})
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 PriceFinder"})
        with urllib.request.urlopen(req, timeout=2) as r:
            charset = r.headers.get_content_charset() or "utf-8"
            data = json.loads(r.read().decode(charset, "replace"))
        out = [s for s in (data[1] if isinstance(data, list) and len(data) > 1 else []) if isinstance(s, str)]
    except Exception:
        out = []
    _suggest_cache[key] = (time.time(), out)
    if len(_suggest_cache) > 2000:
        _suggest_cache.clear()
    return out


@app.get("/api/suggest")
def suggest(q: str = "", limit: int = 8):
    """Варианты для дописывания: свои прошлые поиски → каталог → подсказки поисковика."""
    q = " ".join(q.split())[:80]
    limit = max(1, min(limit, 12))
    ql = q.lower()
    seen, items = set(), []

    def add(text, source):
        k = text.lower()
        if k in seen or k == ql or not text:
            return
        seen.add(k)
        items.append({"text": text, "source": source})

    conn = db()
    try:
        with conn.cursor() as cur:
            if ql:
                cur.execute("SELECT search_query FROM products WHERE search_query ILIKE %s ORDER BY id DESC LIMIT 5", (f"%{q}%",))
            else:
                cur.execute("SELECT search_query FROM products ORDER BY id DESC LIMIT 6")
            for (text,) in cur.fetchall():
                add(text, "history")
    finally:
        conn.close()
    if ql:
        words = ql.split()
        starts = [c for c in CATALOG if c.lower().startswith(ql)]
        contains = [c for c in CATALOG if all(w in c.lower() for w in words) and c not in starts]
        for c in starts + contains:
            add(c, "catalog")
            if len(items) >= limit:
                break
        if len(items) < limit and len(q) >= 3:
            for s_ in web_suggest(q):
                add(s_, "web")
                if len(items) >= limit:
                    break
    return {"query": q, "items": items[:limit]}


@app.post("/api/search", status_code=202)
def start_search(request: SearchRequest):
    cleanup_jobs()
    query = " ".join(request.query.split())
    if len(query) < 2:
        raise HTTPException(status_code=422, detail="Введите название товара.")

    with jobs_lock:
        # Тот же запрос уже выполняется — возвращаем существующую задачу.
        for job in jobs.values():
            if job["query"].lower() == query.lower() and job["status"] in ("queued", "running"):
                return {"id": job["id"], "status": job["status"]}

        job_id = str(uuid.uuid4())
        jobs[job_id] = {
            "id": job_id,
            "query": query,
            "status": "queued",
            "message": "Поиск поставлен в очередь.",
            "progress": {"stage": "queued", "done": 0, "total": 0},
            "log": "",
            "offers": [],
            "offers_count": 0,
            "created_at": time.time(),
            "finished_at": None,
        }

    threading.Thread(target=run_search, args=(job_id, query), daemon=True).start()
    return {"id": job_id, "status": "queued"}


@app.get("/api/search/{job_id}")
def search_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Задача не найдена.")
        return dict(job)


@app.get("/api/products/{product_id}/offers")
def product_offers(product_id: int):
    try:
        offers = get_offers(product_id=product_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Не удалось прочитать предложения: {type(exc).__name__}") from exc
    return {"product_id": product_id, "count": len(offers), "offers": offers}


@app.delete("/api/products/{product_id}")
def delete_product(product_id: int):
    conn = db()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM products WHERE id = %s", (product_id,))
            deleted = cur.rowcount
    finally:
        conn.close()
    if not deleted:
        raise HTTPException(status_code=404, detail="Запрос не найден.")
    return {"deleted": product_id}
