"""Полезные сведения о сервисах для карточек Docker.

Каждая функция возвращает словарь:
    level    — ok | warn | bad | idle (idle — «выключен, и это нормально»)
    summary  — одна строка для строки таблицы
    facts    — [[подпись, значение], …] для раскрывающейся карточки
    items    — необязательный список строк (найденные вирусы, сайты и т.п.)
Все функции быстрые, кэшируются и выполняются параллельно.
"""

import json
import os
import re
import socket
import ssl
import struct
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from app.metrics import get_smart, ttl_cache
from app.settings import DUCKDNS_DOMAIN

HOST = os.getenv("HOST_GATEWAY", "host.docker.internal")
TZ = ZoneInfo(os.getenv("TZ", "Europe/Tallinn"))
CLAMAV_REPORTS = Path(os.getenv("CLAMAV_REPORTS", "/data/clamav-reports"))
CLAMAV_SCAN_HOUR = int(os.getenv("CLAMAV_SCAN_HOUR", "4"))
DUCKDNS_LOG = Path(os.getenv("DUCKDNS_LOG", "/data/duckdns/duck.log"))
SYNCTHING_CONFIG = Path(os.getenv("SYNCTHING_CONFIG", "/data/syncthing/config.xml"))

_insecure = ssl._create_unverified_context()


def _get(url: str, timeout: float = 3, headers: dict | None = None) -> tuple[int, str]:
    request = urllib.request.Request(url, headers=headers or {})
    context = _insecure if url.startswith("https") else None
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            return response.status, response.read().decode(errors="ignore")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(errors="ignore") if exc.fp else ""


def _json(url: str, **kwargs):
    status, body = _get(url, **kwargs)
    if status >= 400:
        raise RuntimeError(f"HTTP {status}")
    return json.loads(body)


def _fmt_int(n) -> str:
    return f"{int(n):,}".replace(",", " ")


def _fmt_ago(ts: float) -> str:
    diff = max(int(time.time() - ts), 0)
    if diff < 60:
        return "только что"
    if diff < 3600:
        return f"{diff // 60} мин назад"
    if diff < 86400:
        return f"{diff // 3600} ч {diff % 3600 // 60} мин назад"
    return f"{diff // 86400} д назад"


def _fmt_dt(dt: datetime) -> str:
    months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
    return f"{dt.day} {months[dt.month - 1]} {dt:%H:%M}"


def _fmt_bytes(value: float) -> str:
    units = ["Б", "КБ", "МБ", "ГБ", "ТБ"]
    i = 0
    while value >= 1024 and i < len(units) - 1:
        value /= 1024
        i += 1
    return f"{value:.1f} {units[i]}".replace(".", ",")


def _error(exc: Exception, what: str) -> dict:
    return {"level": "bad", "summary": f"{what} не отвечает", "facts": [["Ошибка", str(exc)[:200]]]}


# ---------------------------------------------------------------- ClamAV

@ttl_cache(60)
def clamav() -> dict:
    reports = sorted(CLAMAV_REPORTS.glob("scan-*.log"))
    now = datetime.now(TZ)
    next_scan = now.replace(hour=CLAMAV_SCAN_HOUR, minute=0, second=0, microsecond=0)
    if next_scan <= now:
        next_scan += timedelta(days=1)

    base = {"expected_stopped": True}
    if not reports:
        return {**base, "level": "warn", "summary": "Отчётов о проверке ещё нет",
                "facts": [["Следующая проверка", _fmt_dt(next_scan)]]}

    text = reports[-1].read_text(errors="ignore")
    started = re.search(r"^Started: (\S+)", text, re.M)
    infected = re.search(r"^Infected files: (\d+)", text, re.M)
    duration = re.search(r"^Time: [\d.]+ sec \(([^)]+)\)", text, re.M)
    exit_code = re.search(r"^ClamAV exit code: (\d+)", text, re.M)
    found = re.findall(r"^(.+?): (.+) FOUND$", text, re.M)
    scanned = re.search(r"^Scanned files: (\d+)", text, re.M)

    started_dt = datetime.fromisoformat(started.group(1)).astimezone(TZ) if started else None
    age_hours = (now - started_dt).total_seconds() / 3600 if started_dt else 999
    n_infected = int(infected.group(1)) if infected else None

    if n_infected:
        level, summary = "bad", f"Найдено заражённых файлов: {n_infected}!"
    elif "ERROR" in text or (exit_code and exit_code.group(1) not in ("0", "1")):
        level, summary = "bad", "Последняя проверка завершилась с ошибкой"
    elif n_infected is None:
        level, summary = "warn", "Проверка не завершилась (нет итогов)"
    elif age_hours > 36:
        level, summary = "warn", f"Последняя проверка была {int(age_hours // 24)} д назад"
    else:
        level, summary = "ok", f"Вирусов нет · проверено {_fmt_dt(started_dt)}"

    # История: сколько из последних отчётов «чистые»
    recent = reports[-14:]
    clean = sum(1 for r in recent if re.search(r"^Infected files: 0$", r.read_text(errors="ignore"), re.M))

    facts = [
        ["Последняя проверка", _fmt_dt(started_dt) if started_dt else "—"],
        ["Результат", "чисто" if n_infected == 0 else (f"заражено: {n_infected}" if n_infected else "нет итогов")],
        ["Длительность", re.sub(r"(\d+) s\b", r"\1 с", re.sub(r"(\d+) m\b", r"\1 мин", re.sub(r"(\d+) h\b", r"\1 ч", duration.group(1)))) if duration else "—"],
        ["Следующая проверка", f"{_fmt_dt(next_scan)} (автоматически)"],
        ["Что проверяется", "HomeLab, Downloads, медиатека"],
        ["Чистых проверок", f"{clean} из последних {len(recent)}"],
    ]
    if scanned:
        facts.insert(3, ["Проверено файлов", _fmt_int(scanned.group(1))])
    return {**base, "level": level, "summary": summary, "facts": facts,
            "items": [f"{path} — {virus}" for path, virus in found[:20]]}


# -------------------------------------------------------------- Fail2ban

@ttl_cache(30)
def fail2ban() -> dict:
    try:
        _, text = _get(f"http://{HOST}:9191/metrics")
    except Exception as exc:
        return _error(exc, "Экспортер fail2ban")

    def metric(name):
        return {m.group(1): float(m.group(2))
                for m in re.finditer(rf'^{name}\{{jail="([^"]+)"\}} (\S+)$', text, re.M)}

    up = re.search(r"^f2b_up (\S+)$", text, re.M)
    if not up or float(up.group(1)) != 1:
        return {"level": "bad", "summary": "fail2ban не отвечает экспортеру", "facts": []}

    banned_now, banned_total = metric("f2b_jail_banned_current"), metric("f2b_jail_banned_total")
    failed_now, failed_total = metric("f2b_jail_failed_current"), metric("f2b_jail_failed_total")
    ban_time = metric("f2b_config_jail_ban_time")
    max_retry = metric("f2b_config_jail_max_retries")

    facts = []
    for jail in sorted(banned_now):
        name = "SSH" if jail == "sshd" else jail
        facts += [
            [f"{name}: забанено сейчас", _fmt_int(banned_now[jail])],
            [f"{name}: банов всего", _fmt_int(banned_total.get(jail, 0))],
            [f"{name}: неудачных входов", f"{_fmt_int(failed_total.get(jail, 0))} (сейчас {_fmt_int(failed_now.get(jail, 0))})"],
            [f"{name}: правило", f"{int(max_retry.get(jail, 0))} попыток → бан на {int(ban_time.get(jail, 0)) // 60} мин"],
        ]
    total_now = sum(banned_now.values())
    summary = (f"Защищает SSH · сейчас забанено {_fmt_int(total_now)} · всего {_fmt_int(sum(banned_total.values()))}"
               if "sshd" in banned_now else f"Тюрем: {len(banned_now)} · забанено {_fmt_int(total_now)}")
    return {"level": "ok", "summary": summary, "facts": facts}


# ---------------------------------------------------------------- DuckDNS

@ttl_cache(60)
def duckdns() -> dict:
    facts = [["Домен", DUCKDNS_DOMAIN]]
    try:
        ip = socket.gethostbyname(DUCKDNS_DOMAIN)
        facts.append(["Указывает на IP", ip])
    except OSError:
        ip = None
        facts.append(["Указывает на IP", "не резолвится"])

    try:
        lines = DUCKDNS_LOG.read_text(errors="ignore").splitlines()
    except OSError:
        lines = []
    last = next((l for l in reversed(lines) if l.startswith("DuckDNS request at")), None)
    if not last:
        return {"level": "warn", "summary": "Нет данных об обновлениях", "facts": facts}

    m = re.match(r"DuckDNS request at (.+?) (successful|failed)", last)
    ok = bool(m and m.group(2) == "successful")
    when = None
    if m:
        try:
            when = datetime.strptime(re.sub(r" [A-Z]{3,4} ", " ", m.group(1)), "%a %b %d %H:%M:%S %Y").replace(tzinfo=TZ)
        except ValueError:
            pass
    facts.append(["Последнее обновление", f"{_fmt_ago(when.timestamp())} — {'успешно' if ok else 'ошибка'}" if when else last[:80]])
    changed = "IP(s) unchanged" not in last
    facts.append(["IP менялся", "да, при последнем обновлении" if changed and ok else "нет"])

    stale = when and time.time() - when.timestamp() > 3600
    level = "ok" if ok and not stale else "bad" if not ok else "warn"
    summary = f"{DUCKDNS_DOMAIN} → {ip or '?'} · обновлён {_fmt_ago(when.timestamp()) if when else '?'}"
    return {"level": level, "summary": summary, "facts": facts}


# -------------------------------------------------------------- Syncthing

@ttl_cache(30)
def syncthing() -> dict:
    try:
        root = ET.parse(SYNCTHING_CONFIG).getroot()
        api_key = root.findtext("gui/apikey")
    except (OSError, ET.ParseError) as exc:
        return _error(exc, "Конфигурация Syncthing")
    headers = {"X-API-Key": api_key or ""}
    base = f"http://{HOST}:8384/rest"
    try:
        status = _json(f"{base}/system/status", headers=headers)
        folders = _json(f"{base}/config/folders", headers=headers)
        devices = _json(f"{base}/config/devices", headers=headers)
        connections = _json(f"{base}/system/connections", headers=headers).get("connections", {})
        stats = _json(f"{base}/stats/device", headers=headers)
    except Exception as exc:
        return _error(exc, "API Syncthing")

    my_id = status.get("myID")
    remote = [d for d in devices if d["deviceID"] != my_id]
    online = [d for d in remote if connections.get(d["deviceID"], {}).get("connected")]

    facts, problems = [], 0
    for folder in folders:
        if folder.get("paused"):
            facts.append([f"Папка «{folder['label'] or folder['id']}»", "на паузе"])
            continue
        try:
            st = _json(f"{base}/db/status?folder={urllib.request.quote(folder['id'])}", headers=headers)
        except Exception:
            continue
        need = st.get("needFiles", 0) + st.get("needDeletes", 0)
        state = st.get("state", "?")
        errors = st.get("errors", 0) or st.get("pullErrors", 0)
        if errors:
            problems += 1
        text = {"idle": "синхронизирована", "scanning": "сканируется", "syncing": "синхронизируется",
                "sync-preparing": "готовится", "error": "ошибка"}.get(state, state)
        if need:
            text += f", осталось файлов: {_fmt_int(need)}"
        if errors:
            text += f", ошибок: {errors}"
        facts.append([f"Папка «{folder['label'] or folder['id']}»",
                      f"{text} · {_fmt_bytes(st.get('localBytes', 0))}"])

    for d in remote:
        conn = connections.get(d["deviceID"], {})
        if conn.get("connected"):
            seen = "онлайн"
        else:
            last = (stats.get(d["deviceID"]) or {}).get("lastSeen", "")
            try:
                seen = "был " + _fmt_ago(datetime.fromisoformat(last.replace("Z", "+00:00")).timestamp())
            except ValueError:
                seen = "не подключался"
            if last.startswith("1970"):
                seen = "не подключался"
        facts.append([f"Устройство «{d.get('name') or d['deviceID'][:7]}»", seen])

    level = "bad" if problems else "ok" if online or not remote else "warn"
    summary = f"Папок: {len(folders)} · устройств онлайн {len(online)} из {len(remote)}"
    if problems:
        summary += f" · с ошибками: {problems}"
    return {"level": level, "summary": summary, "facts": facts}


# -------------------------------------------------- Prometheus и компания

@ttl_cache(30)
def prometheus_targets() -> dict:
    try:
        data = _json(f"http://{HOST}:9090/api/v1/targets?state=active")["data"]["activeTargets"]
    except Exception as exc:
        return {"error": str(exc), "targets": {}}
    targets = {}
    for t in data:
        job = t["labels"].get("job", "?")
        targets.setdefault(job, []).append({
            "health": t.get("health"),
            "error": t.get("lastError", ""),
            "duration": t.get("lastScrapeDuration", 0),
        })
    return {"targets": targets}


def prometheus() -> dict:
    info = prometheus_targets()
    if "error" in info:
        return _error(RuntimeError(info["error"]), "Prometheus")
    facts, down = [], 0
    names = {"node": "Метрики системы (node-exporter)", "smartctl": "SMART дисков",
             "fail2ban": "Fail2ban", "fail2ban-detail": "Fail2ban (детально)", "prometheus": "Сам Prometheus"}
    for job, items in sorted(info["targets"].items()):
        bad = [t for t in items if t["health"] != "up"]
        down += len(bad)
        facts.append([names.get(job, job), "собирается" if not bad else f"ошибка: {bad[0]['error'][:80]}"])
    total = sum(len(v) for v in info["targets"].values())
    try:
        tsdb = _json(f"http://{HOST}:9090/api/v1/status/tsdb")["data"]["headStats"]
        facts.append(["Временных рядов", _fmt_int(tsdb.get("numSeries", 0))])
    except Exception:
        pass
    return {"level": "bad" if down else "ok",
            "summary": f"Собирает метрики: {total - down} из {total} источников",
            "facts": facts}


def _target(job: str, title: str) -> dict:
    info = prometheus_targets()
    items = info.get("targets", {}).get(job)
    if not items:
        return {"level": "warn", "summary": f"{title}: Prometheus его не опрашивает", "facts": []}
    bad = [t for t in items if t["health"] != "up"]
    return {"level": "bad" if bad else "ok",
            "summary": f"{title}: отдаёт метрики в Prometheus" if not bad else f"{title}: ошибка сбора",
            "facts": [["Опрос Prometheus", "успешно" if not bad else bad[0]["error"][:120]],
                      ["Время ответа", f"{items[0]['duration'] * 1000:.0f} мс"]]}


@ttl_cache(30)
def node_exporter() -> dict:
    return _target("node", "Системные метрики")


@ttl_cache(60)
def smartctl() -> dict:
    smart = get_smart()
    base = _target("smartctl", "SMART")
    if not smart:
        return base
    facts = []
    bad = 0
    for device, info in sorted(smart.items()):
        healthy = info.get("healthy")
        bad += healthy is False
        hours = info.get("power_on_hours")
        facts.append([f"Диск {device}",
                      f"{'исправен' if healthy else 'SMART: ОШИБКА' if healthy is False else '?'}"
                      f" · {info.get('temperature', '?'):.0f} °C"
                      + (f" · наработка {hours // 24} д" if hours else "")])
    temps = [i["temperature"] for i in smart.values() if "temperature" in i]
    summary = f"Дисков: {len(smart)} · SMART {'в норме' if not bad else 'ОШИБКА'}"
    if temps:
        summary += f" · {min(temps):.0f}–{max(temps):.0f} °C"
    return {"level": "bad" if bad else base["level"], "summary": summary, "facts": facts + base["facts"]}


@ttl_cache(30)
def grafana() -> dict:
    try:
        data = _json(f"http://{HOST}:3000/api/health")
    except Exception as exc:
        return _error(exc, "Grafana")
    ok = data.get("database") == "ok"
    return {"level": "ok" if ok else "bad",
            "summary": f"Работает · версия {data.get('version', '?')}" if ok else "Проблема с базой Grafana",
            "facts": [["База данных", data.get("database", "?")], ["Версия", data.get("version", "?")]]}


@ttl_cache(30)
def loki() -> dict:
    try:
        status, body = _get(f"http://{HOST}:3100/ready")
    except Exception as exc:
        return _error(exc, "Loki")
    ok = status == 200
    return {"level": "ok" if ok else "warn",
            "summary": "Готов принимать логи" if ok else "Запускается…",
            "facts": [["Состояние", body.strip()[:100] or str(status)]]}


@ttl_cache(30)
def alloy() -> dict:
    try:
        status, _ = _get(f"http://{HOST}:12345/-/ready")
    except Exception as exc:
        return _error(exc, "Alloy")
    return {"level": "ok" if status == 200 else "warn",
            "summary": "Собирает логи контейнеров и отчёты ClamAV → Loki" if status == 200 else "Не готов",
            "facts": [["Источники", "логи Docker-контейнеров, отчёты ClamAV"], ["Куда отправляет", "Loki"]]}


# ------------------------------------------------------------- Остальное

@ttl_cache(60)
def portainer() -> dict:
    try:
        data = _json(f"https://{HOST}:9443/api/system/status")
    except Exception as exc:
        return _error(exc, "Portainer")
    return {"level": "ok", "summary": f"Работает · версия {data.get('Version', '?')}",
            "facts": [["Версия", data.get("Version", "?")]]}


@ttl_cache(30)
def pricefinder() -> dict:
    try:
        data = _json(f"http://{HOST}:8082/api/stats")
    except Exception as exc:
        return _error(exc, "API PriceFinder")
    last = data.get("last_search")
    facts = [
        ["Сохранённых запросов", _fmt_int(data["products"])],
        ["Предложений", f"{_fmt_int(data['offers'])} (с ценой {_fmt_int(data['priced_offers'])})"],
        ["Размер базы", _fmt_bytes(data["db_size_bytes"])],
        ["Поисков сейчас", _fmt_int(data["active_searches"])],
    ]
    if last:
        facts.insert(0, ["Последний поиск", _fmt_ago(datetime.fromisoformat(last).replace(tzinfo=TZ).timestamp())])
    summary = (f"Идёт поиск…" if data["active_searches"]
               else f"Запросов: {data['products']} · предложений: {_fmt_int(data['offers'])}")
    return {"level": "ok", "summary": summary, "facts": facts}


SITES = [
    (8080, "Server Monitor"),
    (8081, "Сайт-визитка"),
    (8082, "PriceFinder"),
    (8083, "Граф проекта (graphify)"),
]


@ttl_cache(30)
def websites() -> dict:
    facts, items, down = [], [], 0
    for port, name in SITES:
        try:
            start = time.monotonic()
            status, body = _get(f"http://{HOST}:{port}/", timeout=3)
            ms = (time.monotonic() - start) * 1000
            ok = status < 400
            title = re.search(r"<title>([^<]*)</title>", body)
            facts.append([f"{name} (:{port})", f"{'отвечает' if ok else f'HTTP {status}'} · {ms:.0f} мс"])
        except Exception as exc:
            ok = False
            facts.append([f"{name} (:{port})", f"не отвечает: {type(exc).__name__}"])
        down += not ok
    return {"level": "bad" if down else "ok",
            "summary": f"Сайтов работает: {len(SITES) - down} из {len(SITES)}",
            "facts": facts}


def _mc_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def _mc_pack_varint(value: int) -> bytes:
    out = b""
    while True:
        byte = value & 0x7F
        value >>= 7
        out += bytes([byte | (0x80 if value else 0)])
        if not value:
            return out


@ttl_cache(30)
def minecraft_status(running: bool) -> dict:
    if not running:
        return {"level": "idle", "expected_stopped": True, "summary": "Сервер выключен",
                "facts": [["Адрес для игры", "rusparrow.duckdns.org:55555"]]}
    try:
        host = HOST
        with socket.create_connection((host, 55555), timeout=3) as sock:
            handshake = b"\x00" + _mc_pack_varint(763) + _mc_pack_varint(len(host)) + host.encode() + struct.pack(">H", 55555) + b"\x01"
            sock.sendall(_mc_pack_varint(len(handshake)) + handshake + b"\x01\x00")
            data = b""
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
                try:
                    length, pos = _mc_varint(data, 0)
                    if len(data) >= pos + length:
                        break
                except IndexError:
                    continue
        _, pos = _mc_varint(data, 0)
        _, pos = _mc_varint(data, pos)        # id пакета
        str_len, pos = _mc_varint(data, pos)
        info = json.loads(data[pos:pos + str_len])
    except Exception as exc:
        return {"level": "warn", "summary": "Запускается или не отвечает",
                "facts": [["Ошибка", str(exc)[:120]]]}
    players = info.get("players", {})
    names = [p.get("name") for p in players.get("sample", []) or []]
    return {"level": "ok",
            "summary": f"Игроков онлайн: {players.get('online', 0)} из {players.get('max', '?')}",
            "facts": [["Версия", (info.get("version") or {}).get("name", "?")],
                      ["Игроки", ", ".join(names) or "никого"],
                      ["Адрес для игры", "rusparrow.duckdns.org:55555"]]}


def amnezia_insight(vpn: dict) -> dict:
    if not vpn or not vpn.get("available"):
        return {"level": "bad", "summary": f"VPN недоступен: {(vpn or {}).get('error', 'нет данных')}", "facts": []}
    peers = vpn.get("peers", [])
    online = [p["name"] for p in peers if p.get("online")]
    total_rx = sum(p.get("received_bytes", 0) for p in peers)
    total_tx = sum(p.get("sent_bytes", 0) for p in peers)
    summary = f"Клиентов активно: {len(online)} из {len(peers)}"
    if online:
        summary += f" ({', '.join(online[:3])}{'…' if len(online) > 3 else ''})"
    return {"level": "ok", "summary": summary,
            "facts": [["Трафик с запуска", f"↓ {_fmt_bytes(total_rx)} · ↑ {_fmt_bytes(total_tx)}"]]}


def plex_insight(plex: dict) -> dict:
    if not plex or not plex.get("found"):
        return {"level": "bad", "summary": "Plex не найден", "facts": []}
    web = (plex.get("web") or {}).get("available")
    return {"level": "ok" if web else "warn",
            "summary": "Медиасервер доступен" if web else "Процесс есть, но веб-интерфейс не отвечает",
            "facts": []}


# --------------------------------------------------------------- Сборка

def collect(docker: dict, plex: dict, amnezia: dict) -> dict:
    containers = {c["name"]: c for c in docker.get("containers", [])}
    mc_running = (containers.get("minecraft") or {}).get("status") == "running"

    jobs = {
        "clamav": clamav,
        "fail2ban-exporter": fail2ban,
        "duckdns": duckdns,
        "syncthing": syncthing,
        "prometheus": prometheus,
        "node-exporter": node_exporter,
        "smartctl-exporter": smartctl,
        "grafana": grafana,
        "loki": loki,
        "alloy": alloy,
        "portainer": portainer,
        "pricefinder-api": pricefinder,
        "websites": websites,
        "minecraft": lambda: minecraft_status(mc_running),
    }
    results: dict = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {name: pool.submit(fn) for name, fn in jobs.items() if name in containers}
        for name, future in futures.items():
            try:
                results[name] = future.result(timeout=8)
            except Exception as exc:
                results[name] = _error(exc, name)

    if "amnezia-awg2" in containers:
        results["amnezia-awg2"] = amnezia_insight(amnezia)
    results["plex"] = plex_insight(plex)
    return results
