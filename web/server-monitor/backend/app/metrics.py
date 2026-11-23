import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

import docker
import psutil

from app.settings import (
    AMNEZIA_CLIENT_NAMES,
    DOCKER_DESCRIPTIONS,
    HOST_NETWORK_PORTS,
    LINK_OVERRIDES,
    SERVER_IP,
)

SYSFS_PATH = Path(os.getenv("SYSFS_PATH", "/sys"))
PLEX_SERVICE_NAME = "plexmediaserver"
PLEX_WEB_HOST = os.getenv("PLEX_WEB_HOST", "127.0.0.1")
PLEX_WEB_PORT = int(os.getenv("PLEX_WEB_PORT", "32400"))
ROOT_BLOCK_DEVICE = os.getenv("ROOT_BLOCK_DEVICE", "sdc")

STORAGE_DISKS = tuple(
    entry.split(":", 1)
    for entry in os.getenv("STORAGE_DISKS", "sda:/mnt/disk1,sdb:/mnt/disk2").split(",")
    if ":" in entry
)

# Датчики, которые показывают температуру именно процессора.
CPU_THERMAL_ZONES = ("x86_pkg_temp", "coretemp", "k10temp", "cpu-thermal", "cpu_thermal")

WEB_PORTS = {80, 443, 3000, 3001, 5000, 5001, 8000, 8080, 8081, 8082, 8384, 8443, 9000, 9090, 9443, 12345, 32400}
PREFERRED_WEB_PORTS = {80, 443, 3000, 8080, 8443, 9000, 9090, 9443, 32400}

# Первый вызов cpu_percent(None) всегда 0.0 — «заряжаем» счётчик заранее,
# чтобы дальше получать среднюю загрузку между опросами без блокировки.
psutil.cpu_percent(interval=None)


def ttl_cache(seconds: float):
    """Кэширует результат функции на заданное число секунд."""
    def decorator(func):
        lock = threading.Lock()
        cached_value = None
        cached_at = 0.0

        @wraps(func)
        def wrapper(*args, **kwargs):
            nonlocal cached_value, cached_at
            with lock:
                now = time.monotonic()
                if cached_value is not None and now - cached_at < seconds:
                    return cached_value
                cached_value = func(*args, **kwargs)
                cached_at = time.monotonic()
                return cached_value

        def cache_clear():
            nonlocal cached_value, cached_at
            with lock:
                cached_value = None
                cached_at = 0.0

        wrapper.cache_clear = cache_clear
        return wrapper
    return decorator


def _format_uptime(seconds: float) -> str:
    total = int(seconds)
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    parts.append(f"{secs}s")
    return " ".join(parts)


def _uptime(seconds: int) -> dict:
    return {"seconds": seconds, "formatted": _format_uptime(seconds) if seconds else "—"}


def _parse_docker_time(value) -> float | None:
    """Разбирает время Docker (ISO-8601 с наносекундами) в Unix timestamp."""
    if not value or not isinstance(value, str) or value.startswith("0001-"):
        return None
    s = value.strip().replace("Z", "+00:00")
    # Python понимает максимум микросекунды — обрезаем лишние цифры дроби.
    if "." in s:
        head, tail = s.split(".", 1)
        digits = ""
        rest = ""
        for i, ch in enumerate(tail):
            if not ch.isdigit():
                rest = tail[i:]
                break
            digits += ch
        s = f"{head}.{digits[:6]}{rest}"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _container_uptime(container) -> int:
    """Сколько секунд контейнер работает с последнего запуска (0, если остановлен)."""
    state = (container.attrs or {}).get("State") or {}
    if not state.get("Running"):
        return 0
    started = _parse_docker_time(state.get("StartedAt"))
    return int(max(time.time() - started, 0)) if started else 0


def get_cpu() -> dict:
    # Загрузку считает фоновый сэмплер истории: общий счётчик psutil
    # нельзя дёргать из двух мест, иначе интервалы перемешаются.
    from app import history
    latest = history.latest()
    if latest.get("ts") and time.time() - latest["ts"] < 30:
        percent = latest["cpu"]
    else:
        percent = psutil.cpu_percent(interval=0.2)
    return {
        "percent": round(percent, 1),
        "cores": psutil.cpu_count(logical=True) or 0,
        "physical_cores": psutil.cpu_count(logical=False) or 0,
        "model": _get_cpu_model(),
        "load_avg": [round(x, 2) for x in os.getloadavg()],
    }


def _get_cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.startswith(("model name", "Hardware", "Processor")) and ":" in line:
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return "CPU"


def get_memory() -> dict:
    mem = psutil.virtual_memory()
    return {
        "total": mem.total,
        "used": mem.used,
        "available": mem.available,
        "percent": round(mem.percent, 1),
    }


def _get_block_device_info(device: str) -> dict:
    device_dir = SYSFS_PATH / "class" / "block" / device
    try:
        model = (device_dir / "device" / "model").read_text().strip()
    except OSError:
        model = device.upper()
    try:
        nominal_total = int((device_dir / "size").read_text().strip()) * 512
    except (OSError, ValueError):
        nominal_total = None
    return {"device": device, "model": model, "nominal_total": nominal_total}


def _get_disk(mount: Path, device: str) -> dict | None:
    if not mount.is_dir():
        return None
    try:
        usage = psutil.disk_usage(mount)
    except OSError:
        return None
    return {
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "percent": round(usage.percent, 1),
        "mount": str(mount),
        **_get_block_device_info(device),
    }


SMARTCTL_URL = os.getenv("SMARTCTL_EXPORTER_URL", "http://host.docker.internal:9633/metrics")


@ttl_cache(60)
def get_smart() -> dict:
    """SMART из smartctl-exporter: {device: {healthy, temperature, power_on_hours}}."""
    result: dict = {}
    try:
        with urllib.request.urlopen(SMARTCTL_URL, timeout=3) as response:
            text = response.read().decode(errors="ignore")
    except (urllib.error.URLError, OSError):
        return result
    pattern = re.compile(r'^(smartctl_device_(?:smart_status|temperature|power_on_seconds))\{device="([^"]+)"([^}]*)\}\s+(\S+)$')
    for line in text.splitlines():
        m = pattern.match(line)
        if not m:
            continue
        metric, device, labels, value = m.groups()
        info = result.setdefault(device, {})
        try:
            number = float(value)
        except ValueError:
            continue
        if metric.endswith("smart_status"):
            info["healthy"] = number == 1
        elif metric.endswith("temperature") and 'temperature_type="current"' in labels:
            info["temperature"] = number
        elif metric.endswith("power_on_seconds"):
            info["power_on_hours"] = int(number // 3600)
    return result


def _with_smart(disk: dict) -> dict:
    if disk:
        disk["smart"] = get_smart().get(disk.get("device"), {})
    return disk


def get_disk() -> dict:
    return _with_smart(_get_disk(Path("/"), ROOT_BLOCK_DEVICE) or {})


def get_storage_disks() -> list[dict]:
    disks = []
    for device, mount in STORAGE_DISKS:
        disk = _get_disk(Path(mount), device)
        if disk:
            disks.append(_with_smart(disk))
    return disks


def get_uptime() -> dict:
    return _uptime(int(time.time() - psutil.boot_time()))


def get_cpu_temperature() -> dict | None:
    """Температура процессора из hwmon (coretemp — Intel, k10temp — AMD)."""
    hwmon = SYSFS_PATH / "class" / "hwmon"
    for sensor in sorted(hwmon.glob("hwmon*")):
        try:
            name = (sensor / "name").read_text().strip()
        except OSError:
            continue
        if name not in ("coretemp", "k10temp", "zenpower"):
            continue
        package = None
        cores = []
        crit = None
        for temp_input in sorted(sensor.glob("temp*_input"), key=lambda f: int(re.sub(r"\D", "", f.name) or 0)):
            base = temp_input.name[: -len("_input")]
            try:
                value = int(temp_input.read_text()) / 1000
            except (OSError, ValueError):
                continue
            try:
                label = (sensor / f"{base}_label").read_text().strip()
            except OSError:
                label = base
            if crit is None:
                try:
                    crit = int((sensor / f"{base}_crit").read_text()) / 1000
                except (OSError, ValueError):
                    pass
            if label.startswith(("Package", "Tctl", "Tdie")) and package is None:
                package = value
            elif label.startswith("Core"):
                cores.append(round(value, 1))
        if package is None and cores:
            package = max(cores)
        if package is not None:
            return {"package": round(package, 1), "cores": cores, "crit": crit, "sensor": name}
    return None


def get_temperature() -> dict | None:
    cpu = get_cpu_temperature()
    zones = []
    for zone in sorted((SYSFS_PATH / "class" / "thermal").glob("thermal_zone*")):
        try:
            zones.append({
                "label": (zone / "type").read_text().strip(),
                "celsius": round(int((zone / "temp").read_text().strip()) / 1000, 1),
            })
        except (OSError, ValueError):
            continue
    board = [z["celsius"] for z in zones if z["label"] == "acpitz"]

    if cpu:
        return {
            "celsius": cpu["package"],
            "cores": cpu["cores"],
            "crit": cpu["crit"],
            "board": max(board) if board else None,
            "is_cpu": True,
            "label": _get_cpu_model(),
            "zones": zones,
        }
    if zones:
        hottest = max(zones, key=lambda z: z["celsius"])
        return {"celsius": hottest["celsius"], "cores": [], "crit": None, "board": None,
                "is_cpu": False, "label": hottest["label"], "zones": zones}
    return None


def _container_ports(container, network_mode: str) -> tuple[list[dict], list[str]]:
    port_data = ((container.attrs or {}).get("NetworkSettings") or {}).get("Ports") or {}
    published = []
    labels = []
    for container_port, mappings in port_data.items():
        internal_port, _, protocol = container_port.partition("/")
        for mapping in mappings or []:
            host_port = str(mapping.get("HostPort") or "")
            if not host_port.isdigit():
                continue
            published.append({
                "host_port": int(host_port),
                "internal_port": internal_port,
                "protocol": protocol or "tcp",
            })
            label = f"{host_port}/{protocol or 'tcp'}"
            if label not in labels:
                labels.append(label)

    # Для контейнеров с host network Docker не показывает порты.
    if network_mode == "host":
        for label in HOST_NETWORK_PORTS.get(container.name, []):
            if label not in labels:
                labels.append(label)

    labels.sort(key=lambda item: (int(item.split("/")[0]), item.split("/")[1]))
    return published, labels


def _container_link(name: str, published: list[dict]) -> tuple[str, str]:
    """Возвращает (url, подпись) веб-интерфейса контейнера."""
    if name in LINK_OVERRIDES:
        url_template, label = LINK_OVERRIDES[name]
        url = url_template.format(ip=SERVER_IP)
        return url, label or url

    candidates = sorted(
        (p for p in published if p["host_port"] in WEB_PORTS),
        key=lambda p: (0 if p["host_port"] in PREFERRED_WEB_PORTS else 1, p["host_port"]),
    )
    if not candidates:
        return "", ""
    port = candidates[0]["host_port"]
    scheme = "https" if port in (443, 8443, 9443) else "http"
    suffix = "" if port in (80, 443) else f":{port}"
    url = f"{scheme}://{SERVER_IP}{suffix}"
    return url, url


@ttl_cache(15)
def get_docker_containers() -> dict:
    try:
        client = docker.from_env()
        client.ping()
    except Exception as exc:
        return {"available": False, "error": str(exc), "containers": [], "stacks": [], "total": 0}

    try:
        raw_containers = client.containers.list(all=True)
        containers = []
        for container in raw_containers:
            attrs = container.attrs or {}
            labels = (attrs.get("Config") or {}).get("Labels") or {}
            project = str(labels.get("com.docker.compose.project") or "").strip()
            service = str(labels.get("com.docker.compose.service") or "").strip()
            health = ((attrs.get("State") or {}).get("Health") or {}).get("Status") or ""
            network_mode = (attrs.get("HostConfig") or {}).get("NetworkMode", "")
            published, port_labels = _container_ports(container, network_mode)
            link_url, link_label = _container_link(container.name, published)

            try:
                image = container.image.tags[0] if container.image.tags else container.image.short_id
            except docker.errors.ImageNotFound:
                image = (attrs.get("Config") or {}).get("Image", "—")

            containers.append({
                "id": container.short_id,
                "name": container.name,
                "status": container.status,
                "health": health,
                "image": image,
                "created": attrs.get("Created", ""),
                "uptime_seconds": _container_uptime(container),
                "restart_count": int(attrs.get("RestartCount") or 0),
                "exit_code": (attrs.get("State") or {}).get("ExitCode"),
                "finished_at": (attrs.get("State") or {}).get("FinishedAt", ""),
                "compose_project": project,
                "compose_service": service,
                "kind": "compose" if project else "standalone",
                "link_url": link_url,
                "link_label": link_label,
                "ports": ", ".join(port_labels),
                "description": DOCKER_DESCRIPTIONS.get(container.name, "Docker-контейнер"),
            })
    finally:
        client.close()

    containers.sort(key=lambda c: c["name"].casefold())

    # Compose-контейнеры группируются по метке проекта,
    # контейнер без метки остаётся отдельной записью.
    groups: dict[tuple[str, str], list[dict]] = {}
    for c in containers:
        key = ("compose", c["compose_project"]) if c["compose_project"] else ("standalone", c["name"])
        groups.setdefault(key, []).append(c)

    stacks = []
    for (kind, group_name), members in groups.items():
        container_count = len(members)
        running_count = sum(1 for c in members if c["status"] == "running")
        statuses = {c["status"] for c in members}
        health_states = {c["health"] for c in members}

        if statuses & {"restarting", "removing"} or "starting" in health_states:
            stack_status = "partial"
        elif running_count == 0:
            stack_status = "stopped"
        elif "unhealthy" in health_states:
            stack_status = "unhealthy"
        elif running_count == container_count:
            stack_status = "running"
        else:
            stack_status = "mixed"

        if container_count == 1:
            services = [members[0]["name"]]
        else:
            services = sorted({c["compose_service"] or c["name"] for c in members}, key=str.casefold)

        ports = sorted(
            {p.strip() for c in members for p in c["ports"].split(",") if p.strip()},
            key=lambda item: (int(item.split("/")[0]), item.split("/")[1]),
        )

        # Предпочитаем ссылку контейнера, совпадающего по имени с проектом.
        link_member = next(
            (c for c in members if c["name"] == group_name and (c["link_url"] or c["link_label"])),
            None,
        ) or next((c for c in members if c["link_url"] or c["link_label"]), {})

        description = DOCKER_DESCRIPTIONS.get(group_name) or next(
            (c["description"] for c in members if c["description"]), ""
        )

        display_name = group_name
        if kind == "compose" and container_count == 1:
            display_name = members[0]["name"] or group_name

        stacks.append({
            "name": display_name,
            "project": group_name if kind == "compose" else "",
            "kind": kind,
            "status": stack_status,
            "container_count": container_count,
            "running_count": running_count,
            "services": services,
            "container_names": [c["name"] for c in members],
            "container_ids": [c["id"] for c in members],
            "ports": ", ".join(ports),
            "link_url": link_member.get("link_url", ""),
            "link_label": link_member.get("link_label", ""),
            "description": description,
        })

    stacks.sort(key=lambda s: (s["name"].casefold(), s["kind"]))

    return {
        "available": True,
        "containers": containers,
        "stacks": stacks,
        "total": len(stacks),
    }


def _check_plex_web() -> dict:
    host = PLEX_WEB_HOST
    port = PLEX_WEB_PORT
    url = f"http://{host}:{port}/identity"
    result = {"host": host, "port": port, "url": url}

    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=3) as response:
            return {**result, "available": True, "status_code": response.status}
    except urllib.error.HTTPError as exc:
        return {**result, "available": exc.code < 500, "status_code": exc.code, "error": str(exc)}
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        # HTTP не ответил — проверяем хотя бы TCP-порт.
        try:
            with socket.create_connection((host, port), timeout=3):
                return {**result, "available": True, "status_code": None, "note": "tcp_ok"}
        except OSError:
            return {**result, "available": False, "error": str(exc)}


@ttl_cache(15)
def get_plex_status() -> dict:
    """Plex работает нативно (systemd). Контейнер видит процессы хоста,
    поэтому находим процесс «Plex Media Server» и проверяем веб-порт."""
    for proc in psutil.process_iter(["pid", "name", "create_time"]):
        if (proc.info["name"] or "").startswith("Plex Media Serv"):
            uptime = int(max(time.time() - (proc.info["create_time"] or time.time()), 0))
            return {
                "found": True,
                "source": "systemd",
                "service": f"{PLEX_SERVICE_NAME}.service",
                "status": "running",
                "pid": proc.info["pid"],
                "uptime": _uptime(uptime),
                "web": _check_plex_web(),
            }
    web = _check_plex_web()
    return {
        "found": web.get("available", False),
        "source": "systemd",
        "service": f"{PLEX_SERVICE_NAME}.service",
        "status": "running" if web.get("available") else "stopped",
        "pid": None,
        "uptime": _uptime(0),
        "web": web,
    }


def _ip_sort_key(peer: dict) -> tuple:
    try:
        return tuple(int(part) for part in peer["ip"].split("/")[0].split("."))
    except ValueError:
        return (999,)


@ttl_cache(10)
def get_amnezia_status() -> dict:
    """Возвращает настроенных клиентов AmneziaWG и статистику их трафика."""
    try:
        client = docker.from_env()
        try:
            container = client.containers.get("amnezia-awg2")
            if container.status != "running":
                return {"available": False, "error": f"Контейнер не запущен ({container.status})"}

            result = container.exec_run(["awg", "show", "awg0", "dump"])
            output = result.output.decode(errors="ignore").strip()
            uptime = _container_uptime(container)
        finally:
            client.close()

        if result.exit_code != 0:
            return {"available": False, "error": output or "Не удалось выполнить awg show awg0 dump"}
        if not output:
            return {"available": False, "error": "Пустой ответ AmneziaWG"}

        peers = []
        now = int(time.time())
        # Первая строка описывает интерфейс, остальные — клиентов.
        for index, line in enumerate(output.splitlines()[1:], start=1):
            fields = line.split("\t")
            if len(fields) < 8:
                continue
            try:
                handshake = int(fields[4])
                received = int(fields[5])
                sent = int(fields[6])
            except ValueError:
                continue

            allowed_ips = fields[3]
            client_ip = allowed_ips.split(",")[0].split("/")[0] if allowed_ips else ""
            peers.append({
                "name": AMNEZIA_CLIENT_NAMES.get(
                    client_ip, f"Клиент {client_ip}" if client_ip else f"Клиент {index}"
                ),
                "public_key": fields[0],
                "endpoint": None if fields[2] == "(none)" else fields[2],
                "ip": allowed_ips,
                "handshake": handshake,
                "received_bytes": received,
                "sent_bytes": sent,
                # Недавний handshake означает активность, но не гарантирует,
                # что устройство подключено прямо сейчас.
                "online": handshake > 0 and (now - handshake) <= 180,
            })

        peers.sort(key=_ip_sort_key)

        return {
            "available": True,
            "status": "running",
            "name": "amnezia-awg2",
            "interface": "awg0",
            "port": 45180,
            "count": len(peers),
            "online_count": sum(1 for p in peers if p["online"]),
            "peers": peers,
            "uptime": _uptime(uptime),
        }
    except docker.errors.NotFound:
        return {"available": False, "error": "Контейнер amnezia-awg2 не найден"}
    except Exception as exc:
        print(f"Error checking Amnezia peers: {exc}")
        return {"available": False, "error": str(exc)}


def _host_name() -> str:
    """Имя хоста: из смонтированного /etc/hostname, иначе имя контейнера."""
    try:
        name = Path(os.getenv("HOST_HOSTNAME_FILE", "/host/etc/hostname")).read_text().strip()
        if name:
            return name
    except OSError:
        pass
    return os.uname().nodename


def _host_service_stacks(plex: dict) -> list[dict]:
    """Службы хоста (не Docker), которые показываем в общем списке."""
    if not plex.get("found"):
        return []
    return [{
        "name": "plex",
        "project": "",
        "kind": "host",
        "status": "running" if plex.get("status") == "running" else "stopped",
        "container_count": 1,
        "running_count": 1 if plex.get("status") == "running" else 0,
        "services": ["plexmediaserver.service"],
        "container_names": [],
        "container_ids": [],
        "ports": "32400/tcp",
        "link_url": LINK_OVERRIDES["plex"][0].format(ip=SERVER_IP),
        "link_label": LINK_OVERRIDES["plex"][0].format(ip=SERVER_IP),
        "description": "Медиасервер Plex · служба systemd",
    }]


def collect_all() -> dict:
    plex = get_plex_status()
    docker_info = dict(get_docker_containers())
    if docker_info.get("available"):
        stacks = docker_info["stacks"] + _host_service_stacks(plex)
        docker_info["stacks"] = sorted(stacks, key=lambda s: s["name"].casefold())
        docker_info["total"] = len(docker_info["stacks"])
    return {
        "cpu": get_cpu(),
        "memory": get_memory(),
        "disk": get_disk(),
        "storage_disks": get_storage_disks(),
        "uptime": get_uptime(),
        "temperature": get_temperature(),
        "docker": docker_info,
        "plex": plex,
        "amnezia": get_amnezia_status(),
        "hostname": _host_name(),
        "server_ip": SERVER_IP,
        "timestamp": time.time(),
    }
