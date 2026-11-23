"""Собственная история метрик — «маленький Prometheus» для панели.

Фоновый поток каждые SAMPLE_INTERVAL секунд записывает загрузку CPU, RAM,
температуру процессора и скорость сети хоста. Хранятся последние 24 часа,
на диск сбрасываются раз в несколько минут, поэтому история переживает
перезапуск контейнера.
"""

import json
import os
import threading
import time
from collections import deque
from pathlib import Path

import psutil

SAMPLE_INTERVAL = 10
RETENTION = 24 * 3600
STATE_FILE = Path(os.getenv("HISTORY_FILE", "/state/history.json"))
SAVE_EVERY = 300

FIELDS = ("cpu", "ram", "temp", "rx", "tx")
RANGES = {"1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600}

_samples: deque = deque(maxlen=RETENTION // SAMPLE_INTERVAL + 10)
_lock = threading.Lock()
_latest: dict = {}
_started = False


def _host_net_bytes() -> tuple[int, int] | None:
    """Трафик хоста. Контейнер видит процессы хоста (pid: host),
    поэтому /proc/1/net/dev — это сетевые интерфейсы самого сервера."""
    try:
        default_iface = None
        for line in Path("/proc/1/net/route").read_text().splitlines()[1:]:
            parts = line.split()
            if len(parts) > 2 and parts[1] == "00000000":
                default_iface = parts[0]
                break
        for line in Path("/proc/1/net/dev").read_text().splitlines()[2:]:
            name, data = line.split(":", 1)
            if name.strip() == default_iface:
                values = data.split()
                return int(values[0]), int(values[8])
    except (OSError, ValueError, IndexError):
        pass
    return None


def _cpu_temperature() -> float | None:
    from app.metrics import get_cpu_temperature  # локальный импорт, чтобы избежать цикла
    info = get_cpu_temperature()
    return info["package"] if info else None


def _load():
    try:
        data = json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return
    cutoff = time.time() - RETENTION
    with _lock:
        for row in data.get("samples", []):
            if row and row[0] >= cutoff:
                _samples.append(tuple(row))


def _save():
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            rows = list(_samples)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"fields": FIELDS, "samples": rows}))
        tmp.replace(STATE_FILE)
    except OSError as exc:
        print(f"History save failed: {exc}")


def _loop():
    psutil.cpu_percent(interval=None)
    prev_net = _host_net_bytes()
    prev_time = time.monotonic()
    last_save = time.monotonic()
    while True:
        time.sleep(SAMPLE_INTERVAL)
        try:
            now_mono = time.monotonic()
            elapsed = max(now_mono - prev_time, 0.001)
            cpu = psutil.cpu_percent(interval=None)
            ram = psutil.virtual_memory().percent
            temp = _cpu_temperature()
            net = _host_net_bytes()
            rx = tx = None
            if net and prev_net:
                rx = max(net[0] - prev_net[0], 0) / elapsed
                tx = max(net[1] - prev_net[1], 0) / elapsed
            prev_net, prev_time = net, now_mono

            row = (round(time.time(), 1), round(cpu, 1), round(ram, 1),
                   None if temp is None else round(temp, 1),
                   None if rx is None else round(rx), None if tx is None else round(tx))
            with _lock:
                _samples.append(row)
                _latest.update(zip(("ts",) + FIELDS, row))

            if now_mono - last_save > SAVE_EVERY:
                _save()
                last_save = now_mono
        except Exception as exc:  # поток не должен умирать
            print(f"History sampler error: {exc}")


def start():
    global _started
    if _started:
        return
    _started = True
    _load()
    threading.Thread(target=_loop, name="history-sampler", daemon=True).start()


def stop():
    _save()


def latest() -> dict:
    with _lock:
        return dict(_latest)


def _stats(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"avg": round(sum(values) / len(values), 1), "min": min(values), "max": max(values)}


def series(range_key: str = "1h", points: int = 120) -> dict:
    seconds = RANGES.get(range_key, 3600)
    now = time.time()
    start_ts = now - seconds
    with _lock:
        rows = [r for r in _samples if r[0] >= start_ts]

    bucket = seconds / points
    buckets: list[list] = [[] for _ in range(points)]
    for row in rows:
        idx = min(int((row[0] - start_ts) / bucket), points - 1)
        buckets[idx].append(row)

    result = {"range": range_key, "seconds": seconds, "points": points, "samples": len(rows),
              "covered_seconds": round(now - rows[0][0]) if rows else 0, "series": {}, "stats": {}}
    for i, field in enumerate(FIELDS, start=1):
        line = []
        for b in buckets:
            vals = [r[i] for r in b if r[i] is not None]
            line.append(round(sum(vals) / len(vals), 1) if vals else None)
        result["series"][field] = line
        result["stats"][field] = _stats([r[i] for r in rows])
    return result
