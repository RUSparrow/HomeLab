"""Замер скорости интернета через speed.cloudflare.com.

Cloudflare отвечает с ближайшей точки (из Эстонии — Таллин, TLL), поэтому
результат — это скорость канала провайдера, а не далёкого сервера.
Замер идёт в фоне раз в SPEEDTEST_INTERVAL секунд и по кнопке на панели.
Один замер — около 8 с скачивания и 8 с отдачи в несколько потоков:
при 300 Мбит/с это примерно 300 МБ вниз и столько же вверх.
"""

import json
import os
import re
import statistics
import threading
import time
from pathlib import Path

import requests

BASE = "https://speed.cloudflare.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (HomeLab server-monitor)", "Referer": f"{BASE}/"}
INTERVAL = int(os.getenv("SPEEDTEST_INTERVAL", str(4 * 3600)))
STATE_FILE = Path(os.getenv("SPEEDTEST_FILE", "/state/speedtest.json"))
STREAMS = 4
PHASE_SECONDS = 8
CHUNK_DOWN = 25_000_000   # больше Cloudflare не отдаёт за один запрос
CHUNK_UP = 4_000_000     # мелкие куски: меньше теряется на незавершённом запросе
KEEP = 200                # результатов в истории

_lock = threading.Lock()
_results: list[dict] = []
_running = threading.Event()
_started = False


def _load():
    try:
        data = json.loads(STATE_FILE.read_text())
        _results.extend(data.get("results", [])[-KEEP:])
    except (OSError, json.JSONDecodeError):
        pass


def _save():
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        with _lock:
            tmp.write_text(json.dumps({"results": _results[-KEEP:]}))
        tmp.replace(STATE_FILE)
    except OSError as exc:
        print(f"Speedtest save failed: {exc}")


def _ping(session) -> tuple[float, float, str]:
    """Задержка до узла Cloudflare. Время ответа включает ~30 мс работы их сервера,
    поэтому берём RTT TCP-соединения, который Cloudflare сам пишет в Server-Timing
    (cfL4 rtt, микросекунды). Если заголовка нет — время ответа минус время сервера."""
    session.get(f"{BASE}/__down?bytes=0", headers=HEADERS, timeout=10)  # открыть соединение
    times = []
    for _ in range(10):
        t = time.perf_counter()
        r = session.get(f"{BASE}/__down?bytes=0", headers=HEADERS, timeout=10)
        elapsed = (time.perf_counter() - t) * 1000
        timing = r.headers.get("server-timing", "")
        rtt = re.search(r"[?&]rtt=(\d+)", timing)
        if rtt:
            times.append(int(rtt.group(1)) / 1000)
        else:
            server = sum(float(x) for x in re.findall(r"dur=([\d.]+)", timing))
            times.append(max(elapsed - server, 0.1))
    trace = session.get(f"{BASE}/cdn-cgi/trace", headers=HEADERS, timeout=10).text
    colo = next((line[5:] for line in trace.splitlines() if line.startswith("colo=")), "")
    jitter = statistics.mean(abs(a - b) for a, b in zip(times, times[1:]))
    return statistics.median(times), jitter, colo


def _phase(worker) -> float:
    """Запускает STREAMS потоков на PHASE_SECONDS, возвращает бит/с.
    Считается только то, что успело пройти до конца отрезка: зависший запрос
    (у Cloudflare бывает 504 через полминуты) не растягивает время замера."""
    total = [0]
    lock = threading.Lock()
    deadline = time.monotonic() + PHASE_SECONDS

    def loop():
        session = requests.Session()
        while time.monotonic() < deadline:
            try:
                n = worker(session, deadline)
            except requests.RequestException:
                break
            if n and time.monotonic() <= deadline + 0.5:
                with lock:
                    total[0] += n

    start = time.monotonic()
    threads = [threading.Thread(target=loop, daemon=True) for _ in range(STREAMS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(max(deadline + 1 - time.monotonic(), 0))  # опоздавшие потоки доработают в фоне
    return total[0] * 8 / max(min(time.monotonic(), deadline) - start, 0.001)


def _download(session, deadline) -> int:
    got = 0
    with session.get(f"{BASE}/__down?bytes={CHUNK_DOWN}", headers=HEADERS, stream=True, timeout=(5, 5)) as r:
        if not r.ok:
            return 0
        for chunk in r.iter_content(256 * 1024):
            got += len(chunk)
            if time.monotonic() >= deadline:
                break
    return got


_PAYLOAD = b"0" * CHUNK_UP


def _upload(session, deadline) -> int:
    left = max(deadline - time.monotonic(), 0.5)
    r = session.post(f"{BASE}/__up", data=_PAYLOAD, headers=HEADERS, timeout=(5, left + 2))
    return len(_PAYLOAD) if r.ok else 0


def run_now() -> dict:
    """Один замер. Параллельные вызовы не запускают второй замер."""
    if _running.is_set():
        return {"busy": True}
    _running.set()
    result = {"ts": round(time.time())}
    try:
        session = requests.Session()
        ping, jitter, colo = _ping(session)
        result.update(ping_ms=round(ping, 1), jitter_ms=round(jitter, 1), colo=colo,
                      down_bps=round(_phase(_download)), up_bps=round(_phase(_upload)))
    except Exception as exc:  # сеть могла пропасть — это тоже результат
        result["error"] = str(exc)[:200]
    finally:
        _running.clear()
    with _lock:
        _results.append(result)
        del _results[:-KEEP]
    _save()
    return result


def _loop():
    time.sleep(120)  # не мешать старту панели
    while True:
        last = _results[-1]["ts"] if _results else 0
        wait = last + INTERVAL - time.time()
        if wait <= 0:
            run_now()
            wait = INTERVAL
        time.sleep(min(max(wait, 60), INTERVAL))


def start():
    global _started
    if _started or INTERVAL <= 0:
        return
    _started = True
    _load()
    threading.Thread(target=_loop, name="speedtest", daemon=True).start()


def status() -> dict:
    with _lock:
        results = list(_results)
    ok = [r for r in results if "error" not in r]
    return {
        "running": _running.is_set(),
        "interval": INTERVAL,
        "last": results[-1] if results else None,
        "last_ok": ok[-1] if ok else None,
        "history": [[r["ts"], r["down_bps"], r["up_bps"], r["ping_ms"]] for r in ok[-48:]],
    }
