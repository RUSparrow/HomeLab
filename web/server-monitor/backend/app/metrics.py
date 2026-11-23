import os
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
    return {
        "percent": round(psutil.cpu_percent(interval=None), 1),
        "cores": psutil.cpu_count(logical=True) or 0,
        "model": _get_cpu_model(),
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


def get_disk() -> dict:
    return _get_disk(Path("/"), ROOT_BLOCK_DEVICE) or {}


def get_storage_disks() -> list[dict]:
    disks = []
    for device, mount in STORAGE_DISKS:
        disk = _get_disk(Path(mount), device)
        if disk:
            disks.append(disk)
    return disks


def get_uptime() -> dict:
    return _uptime(int(time.time() - psutil.boot_time()))


def get_temperature() -> dict | None:
    thermal_dir = SYSFS_PATH / "class" / "thermal"
    if not thermal_dir.exists():
        return None

    readings = []
    for zone in sorted(thermal_dir.glob("thermal_zone*")):
        try:
            celsius = int((zone / "temp").read_text().strip()) / 1000.0
        except (OSError, ValueError):
            continue
        try:
            label = (zone / "type").read_text().strip()
        except OSError:
            label = zone.name
        readings.append({"label": label, "celsius": round(celsius, 1)})

    if not readings:
        return None

    cpu = [r for r in readings if r["label"] in CPU_THERMAL_ZONES]
    primary = max(cpu or readings, key=lambda r: r["celsius"])
    return {
        "celsius": primary["celsius"],
        "label": primary["label"],
        "is_cpu": bool(cpu),
        "zones": readings,
    }


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


def _get_plex_from_systemd() -> dict | None:
    if not shutil.which("systemctl"):
        return None
    try:
        result = subprocess.run(
            [
                "systemctl", "show", PLEX_SERVICE_NAME,
                "--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp,UnitFileState",
            ],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None

    props = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    active_state = props.get("ActiveState", "unknown")
    sub_state = props.get("SubState", "")
    if active_state == "not-found" and props.get("UnitFileState", "") in ("", "disabled", "masked"):
        return None

    is_running = active_state == "active" and sub_state == "running"
    uptime = 0
    if is_running:
        try:
            # Формат systemd: "Mon 2026-11-23 10:00:00 UTC"
            started = datetime.strptime(
                " ".join(props.get("ActiveEnterTimestamp", "").split()[1:3]), "%Y-%m-%d %H:%M:%S"
            ).timestamp()
            uptime = int(max(time.time() - started, 0))
        except ValueError:
            pass

    return {
        "found": True,
        "source": "systemd",
        "service": f"{PLEX_SERVICE_NAME}.service",
        "status": "running" if is_running else "stopped",
        "pid": int(props.get("MainPID", "0") or "0"),
        "uptime": _uptime(uptime),
    }


@ttl_cache(15)
def get_plex_status() -> dict:
    # Сначала ищем контейнер Plex.
    try:
        client = docker.from_env()
        try:
            for container in client.containers.list(all=True):
                tags = container.image.tags if container.image else []
                if "plex" not in container.name.lower() and not (tags and "plex" in tags[0].lower()):
                    continue
                running = container.status == "running"
                return {
                    "found": True,
                    "source": "docker",
                    "service": container.name,
                    "status": "running" if running else "stopped",
                    "pid": None,
                    "uptime": _uptime(_container_uptime(container)),
                    "web": _check_plex_web() if running else {"available": False, "port": PLEX_WEB_PORT},
                }
        finally:
            client.close()
    except Exception as exc:
        print(f"Error checking Plex container: {exc}")

    # Контейнера нет — проверяем системную службу.
    service_info = _get_plex_from_systemd()
    if not service_info:
        return {
            "found": False,
            "service": f"{PLEX_SERVICE_NAME}.service",
            "status": "not_found",
            "uptime": _uptime(0),
            "web": {"available": False, "port": PLEX_WEB_PORT},
        }
    return {**service_info, "web": _check_plex_web()}


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


def collect_all() -> dict:
    return {
        "cpu": get_cpu(),
        "memory": get_memory(),
        "disk": get_disk(),
        "storage_disks": get_storage_disks(),
        "uptime": get_uptime(),
        "temperature": get_temperature(),
        "docker": get_docker_containers(),
        "plex": get_plex_status(),
        "amnezia": get_amnezia_status(),
        "hostname": _host_name(),
        "server_ip": SERVER_IP,
        "timestamp": time.time(),
    }
