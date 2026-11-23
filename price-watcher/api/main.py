import subprocess
import sys
import threading
import uuid
from datetime import datetime
from decimal import Decimal

import psycopg2
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="PriceFinder API")

jobs = {}
jobs_lock = threading.Lock()

DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "database": "pricewatcher",
    "user": "pricewatcher",
    "password": " ",
}


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=200)


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
        "created_at": row[9].isoformat() if row[9] else None,
    }


def get_offers(product_id=None, query=None):
    sql = """
        SELECT
            o.id,
            o.product_id,
            o.store,
            o.title,
            o.price,
            o.currency,
            o.in_stock,
            o.url,
            o.last_seen,
            o.created_at
        FROM offers o
        JOIN products p ON p.id = o.product_id
    """
    conditions = []
    params = []

    if product_id is not None:
        conditions.append("o.product_id = %s")
        params.append(product_id)

    if query is not None:
        conditions.append("p.search_query = %s")
        params.append(query)

    if conditions:
        sql += " WHERE " + " AND ".join(conditions)

    sql += """
        ORDER BY
            (o.price IS NULL) ASC,
            o.price ASC NULLS LAST,
            o.last_seen DESC NULLS LAST,
            o.id DESC
    """

    conn = psycopg2.connect(**DB_CONFIG)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return [serialize_offer(row) for row in rows]
    finally:
        conn.close()


def run_search(job_id, query):
    with jobs_lock:
        jobs[job_id]["status"] = "running"
        jobs[job_id]["message"] = "Бот выполняет поиск магазинов и цен."

    try:
        result = subprocess.run(
            [sys.executable, "/app/bot.py", query],
            cwd="/app",
            capture_output=True,
            text=True,
            timeout=900,
        )

        if result.returncode == 0:
            try:
                offers = get_offers(query=query)
                with jobs_lock:
                    jobs[job_id].update(
                        status="completed",
                        message="Поиск завершён.",
                        log=(result.stdout or "")[-5000:],
                        offers=offers,
                        offers_count=len(offers),
                    )
            except Exception as exc:
                with jobs_lock:
                    jobs[job_id].update(
                        status="completed",
                        message="Поиск завершён, но не удалось загрузить предложения из базы.",
                        log=(result.stdout or "")[-4000:]
                        + "\nОшибка чтения базы: "
                        + f"{type(exc).__name__}: {exc}",
                        offers=[],
                        offers_count=0,
                    )
        else:
            with jobs_lock:
                jobs[job_id].update(
                    status="failed",
                    message="Ошибка поискового бота.",
                    log=(result.stderr or result.stdout or "")[-3000:],
                )

    except subprocess.TimeoutExpired:
        with jobs_lock:
            jobs[job_id].update(
                status="failed",
                message="Поиск превысил лимит времени — 15 минут.",
            )
    except Exception as exc:
        with jobs_lock:
            jobs[job_id].update(
                status="failed",
                message=f"{type(exc).__name__}: {exc}",
            )


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/search", status_code=202)
def start_search(request: SearchRequest):
    query = request.query.strip()
    if len(query) < 2:
        raise HTTPException(status_code=422, detail="Введите название товара.")

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "query": query,
            "status": "queued",
            "message": "Поиск поставлен в очередь.",
            "log": "",
            "offers": [],
            "offers_count": 0,
        }

    threading.Thread(
        target=run_search,
        args=(job_id, query),
        daemon=True,
    ).start()

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
        raise HTTPException(
            status_code=500,
            detail=f"Не удалось прочитать предложения: {type(exc).__name__}",
        ) from exc

    return {
        "product_id": product_id,
        "count": len(offers),
        "offers": offers,
    }
