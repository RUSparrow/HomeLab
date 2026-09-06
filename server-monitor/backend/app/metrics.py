import os
import shutil
import socket
import subprocess
import time
from unittest import result
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import docker
import psutil

client = docker.from_env()

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

WIREGUARD_CONFIG = Path(
    os.getenv(
        "WIREGUARD_CONFIG",
        "/wireguard/wg_confs/wg0.conf"
    )
)


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


def get_cpu() -> dict:
    return {
        "percent": round(psutil.cpu_percent(interval=0.1), 1),
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
    model_file = device_dir / "device" / "model"
    size_file = device_dir / "size"

    try:
        model = model_file.read_text().strip()
    except OSError:
        model = device.upper()

    try:
        nominal_total = int(size_file.read_text().strip()) * 512
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
    seconds = time.time() - psutil.boot_time()
    return {
        "seconds": int(seconds),
        "formatted": _format_uptime(seconds),
    }


def get_temperature() -> dict | None:
    thermal_dir = SYSFS_PATH / "class" / "thermal"
    if not thermal_dir.exists():
        return None

    readings = []
    for zone in sorted(thermal_dir.glob("thermal_zone*")):
        temp_file = zone / "temp"
        if not temp_file.exists():
            continue
        try:
            celsius = int(temp_file.read_text().strip()) / 1000.0
        except (OSError, ValueError):
            continue

        type_file = zone / "type"
        label = type_file.read_text().strip() if type_file.exists() else zone.name
        readings.append({"label": label, "celsius": round(celsius, 1)})

    if not readings:
        return None

    hottest = max(readings, key=lambda r: r["celsius"])
    return {
        "celsius": hottest["celsius"],
        "label": hottest["label"],
        "zones": readings,
    }


def get_docker_containers() -> dict:
    try:
        client = docker.from_env()
        client.ping()
    except Exception as exc:
        return {"available": False, "error": str(exc), "containers": []}

    containers = []
    for container in client.containers.list(all=True):
        containers.append({
            "id": container.short_id,
            "name": container.name,
            "status": container.status,
            "image": (
                container.image.tags[0]
                if container.image.tags
                else container.image.short_id
            ),
            "created": container.attrs.get("Created", ""),
        })

    containers.sort(key=lambda c: c["name"])
    return {"available": True, "containers": containers, "total": len(containers)}


def _parse_iso_timestamp(value: str) -> float | None:
    if not value or value in ("n/a", "0"):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def _parse_systemctl_show(output: str) -> dict[str, str]:
    props: dict[str, str] = {}
    for line in output.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            props[key] = value
    return props


def _map_service_status(active_state: str, sub_state: str) -> str:
    if active_state == "active" and sub_state == "running":
        return "running"
    return "stopped"


def _check_plex_web() -> dict:
    host = PLEX_WEB_HOST
    port = PLEX_WEB_PORT
    url = f"http://{host}:{port}/identity"

    try:
        request = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(request, timeout=3) as response:
            return {
                "available": True,
                "host": host,
                "port": port,
                "url": url,
                "status_code": response.status,
            }
    except urllib.error.HTTPError as exc:
        return {
            "available": exc.code < 500,
            "host": host,
            "port": port,
            "url": url,
            "status_code": exc.code,
            "error": str(exc),
        }
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        # Fallback: TCP connect if HTTP fails (e.g. redirect/SSL quirks)
        try:
            with socket.create_connection((host, port), timeout=3):
                return {
                    "available": True,
                    "host": host,
                    "port": port,
                    "url": url,
                    "status_code": None,
                    "note": "tcp_ok",
                }
        except OSError:
            pass

        return {
            "available": False,
            "host": host,
            "port": port,
            "url": url,
            "error": str(exc),
        }


def _get_plex_from_systemd() -> dict | None:
    if not shutil.which("systemctl"):
        return None

    try:
        result = subprocess.run(
            [
                "systemctl",
                "show",
                PLEX_SERVICE_NAME,
                "--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp,UnitFileState",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    if result.returncode != 0 or not result.stdout.strip():
        return None

    props = _parse_systemctl_show(result.stdout)
    active_state = props.get("ActiveState", "unknown")
    sub_state = props.get("SubState", "")
    unit_state = props.get("UnitFileState", "")

    if active_state == "not-found" and unit_state in ("", "disabled", "masked"):
        return None

    main_pid = int(props.get("MainPID", "0") or "0")
    started_at = _parse_iso_timestamp(props.get("ActiveEnterTimestamp", ""))
    status = _map_service_status(active_state, sub_state)
    is_running = status == "running"
    uptime_seconds = int(time.time() - started_at) if started_at and is_running else 0

    return {
        "found": True,
        "service": f"{PLEX_SERVICE_NAME}.service",
        "status": status,
        "systemd": {
            "active_state": active_state,
            "sub_state": sub_state,
            "main_pid": main_pid,
        },
        "uptime": {
            "seconds": uptime_seconds,
            "formatted": _format_uptime(uptime_seconds) if uptime_seconds else "—",
        },
    }


def get_plex_status() -> dict:
    service_info = _get_plex_from_systemd()
    web_info = _check_plex_web()

    if not service_info:
        return {
            "found": False,
            "service": f"{PLEX_SERVICE_NAME}.service",
            "status": "not_found",
            "uptime": {"seconds": 0, "formatted": "—"},
            "web": web_info,
        }

    return {
        **service_info,
        "web": web_info,
    }


def get_wireguard_status() -> dict:
    try:
        client = docker.from_env()

        container = client.containers.get("wireguard")

        result = container.exec_run(
            ["wg", "show", "wg0", "dump"]
        )

        if result.exit_code != 0:
            return {
                "available": False,
                "error": result.output.decode(errors="ignore")
            }

        output = result.output.decode(errors="ignore").strip()

        if not output:
            return {
                "available": False,
                "error": "Empty WireGuard response"
            }

        lines = output.splitlines()

        peers = []

        for index, line in enumerate(lines[1:], start=1):
            fields = line.split("\t")

            if len(fields) < 8:
                continue

            handshake = int(fields[4])
            received = int(fields[5])
            sent = int(fields[6])

            # не показываем никогда не использованных клиентов
            if handshake == 0 and received == 0 and sent == 0:
                continue

            peers.append({
                "name": f"peer{index}",
                "public_key": fields[0],
                "endpoint": (
                    None
                    if fields[2] == "(none)"
                    else fields[2]
                ),
                "ip": fields[3],
                "handshake": handshake,
                "received_bytes": received,
                "sent_bytes": sent,
                "online": handshake != 0
            })

        return {
            "available": True,
            "status": "running",
            "count": len(peers),
            "peers": peers
        }

    except docker.errors.NotFound:
        return {
            "available": False,
            "error": "WireGuard container not found"
        }

    except Exception as e:
        return {
            "available": False,
            "error": str(e)
        }
        

def _format_bytes(value):
    units = ["B", "KB", "MB", "GB", "TB"]

    size = float(value)

    for unit in units:
        if size < 1024:
            return f"{size:.2f} {unit}"

        size /= 1024

    return f"{size:.2f} PB"


def collect_all() -> dict:
    return {
        "cpu": get_cpu(),
        "memory": get_memory(),
        "disk": get_disk(),
        "storage_disks": get_storage_disks(),
        "uptime": get_uptime(),
        "temperature": get_temperature(),
        "docker": get_docker_containers(),
        "wireguard": get_wireguard_status(),
        "plex": get_plex_status(),
        "hostname": os.uname().nodename,
        "timestamp": time.time(),
    }
