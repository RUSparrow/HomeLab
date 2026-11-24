import os
import time
import threading
import docker
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app import exporter, history, insights
from app.metrics import collect_all, get_docker_containers

FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", Path(__file__).resolve().parent.parent.parent / "frontend"))
DEPLOY_AGENT_URL = os.getenv("DEPLOY_AGENT_URL", "http://deploy-agent:9000")

app = FastAPI(title="Server Monitor", version="1.2.0")

# Панель и API живут на одном адресе, поэтому CORS не нужен.
# Управляющие POST-запросы должны нести собственный заголовок: браузер
# не даст чужому сайту отправить его без CORS-разрешения, а значит
# страница из интернета не сможет «нажать кнопку» за пользователя.
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "server-monitor"


@app.middleware("http")
async def require_csrf_header(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
            return JSONResponse({"detail": "Запрос отклонён"}, status_code=403)
    return await call_next(request)

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def _start_history():
    history.start()


@app.on_event("shutdown")
def _stop_history():
    history.stop()


@app.get("/api/metrics")
def metrics():
    data = collect_all()
    data["network"] = {k: history.latest().get(k) for k in ("rx", "tx")}
    data["insights"] = insights.collect(data["docker"], data["plex"], data["amnezia"])
    return data


@app.get("/metrics", response_class=PlainTextResponse)
def prometheus_metrics():
    """Экспорт для Prometheus — по нему Grafana строит графики сервисов."""
    return PlainTextResponse(exporter.render(metrics()), media_type="text/plain; version=0.0.4")


@app.get("/api/history")
def metrics_history(range: str = "1h"):
    if range not in history.RANGES:
        raise HTTPException(status_code=400, detail="range: 1h, 6h или 24h")
    return history.series(range)


_docker_ops = set()
_docker_ops_lock = threading.Lock()


def _watch_docker_operation(client, members, turn_on, key):
    try:
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            for container in members:
                container.reload()

            states = [container.status for container in members]
            health = [
                (((container.attrs or {}).get("State") or {}).get("Health") or {})
                .get("Status", "")
                for container in members
            ]

            if turn_on:
                ready = all(
                    state == "running" and health_state != "starting"
                    for state, health_state in zip(states, health)
                )
                failed = (
                    any(state in ("exited", "dead") for state in states)
                    or "unhealthy" in health
                )
                if ready or failed:
                    break
            elif all(state in ("exited", "dead") for state in states):
                break

            get_docker_containers.cache_clear()
            time.sleep(2)
    except Exception:
        pass
    finally:
        get_docker_containers.cache_clear()
        try:
            client.close()
        except Exception:
            pass
        with _docker_ops_lock:
            _docker_ops.discard(key)


@app.post("/api/docker/toggle")
def toggle_docker(payload: dict, request: Request):
    action = str(payload.get("action") or "toggle")
    if action not in ("toggle", "restart"):
        raise HTTPException(status_code=400, detail="Неизвестная операция Docker")
    kind = str(payload.get("kind") or "")
    name = str(payload.get("name") or "").strip()
    project = str(payload.get("project") or "").strip()

    if kind not in ("compose", "standalone") or not name:
        raise HTTPException(status_code=400, detail="Некорректная группа Docker")
    if kind == "compose" and not project:
        raise HTTPException(status_code=400, detail="Не указано имя Compose-проекта")

    key = f"{kind}:{project if kind == 'compose' else name}"
    with _docker_ops_lock:
        if key in _docker_ops:
            raise HTTPException(status_code=409, detail="Операция уже выполняется")
        _docker_ops.add(key)

    watcher_started = False
    client = None
    try:
        client = docker.from_env()
        if kind == "compose":
            members = []
            for c in client.containers.list(all=True):
                labels = (c.attrs.get("Config") or {}).get("Labels") or {}
                if labels.get("com.docker.compose.project") == project:
                    members.append(c)
        else:
            try:
                c = client.containers.get(name)
            except docker.errors.NotFound as exc:
                raise HTTPException(status_code=404, detail="Контейнер не найден") from exc
            labels = (c.attrs.get("Config") or {}).get("Labels") or {}
            if labels.get("com.docker.compose.project"):
                raise HTTPException(status_code=400, detail="Этот контейнер управляется Compose")
            members = [c]

        if not members:
            raise HTTPException(status_code=404, detail="Группа Docker не найдена")

        for c in members:
            c.reload()

        if any(c.status in ("restarting", "removing") for c in members):
            raise HTTPException(status_code=409, detail="Контейнер уже меняет состояние")

        restarting = action == "restart"
        turn_on = restarting or not all(c.status == "running" for c in members)

        # Не выключаем саму панель, обслуживающую этот запрос.
        own_id = os.getenv("HOSTNAME", "")
        controls_monitor = restarting or not turn_on
        if controls_monitor and any(
            c.id == own_id or c.short_id == own_id[:12]
            for c in members
        ):
            raise HTTPException(
                status_code=409,
                detail="Нельзя изменять состояние самой панели мониторинга отсюда"
            )

        # Не выключаем веб-порт, через который открыт текущий интерфейс.
        host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
        port = request.headers.get("x-forwarded-port", "")
        if not port and ":" in host:
            port = host.rsplit(":", 1)[-1]
        if not port:
            referer = request.headers.get("referer", "")
            authority = referer.split("://", 1)[-1].split("/", 1)[0]
            if ":" in authority:
                port = authority.rsplit(":", 1)[-1]
        if not turn_on and port.isdigit():
            for c in members:
                bindings = (c.attrs.get("NetworkSettings") or {}).get("Ports") or {}
                if any(
                    str(binding.get("HostPort")) == port
                    for rows in bindings.values() for binding in (rows or [])
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Нельзя выключить веб-вход, через который открыта панель"
                    )

        ordered = sorted(
            members,
            key=lambda c: ((c.attrs or {}).get("Created", ""), c.name),
            reverse=not turn_on and not restarting,
        )
        for c in ordered:
            c.reload()
            if restarting:
                if c.status == "running":
                    c.restart(timeout=10)
                elif c.status == "paused":
                    c.unpause()
                    c.restart(timeout=10)
                else:
                    c.start()
            elif turn_on:
                if c.status == "paused":
                    c.unpause()
                elif c.status != "running":
                    c.start()
            elif c.status == "running":
                c.stop(timeout=10)

        watcher = threading.Thread(
            target=_watch_docker_operation,
            args=(client, members, turn_on, key),
            daemon=True,
        )
        watcher.start()
        watcher_started = True
        get_docker_containers.cache_clear()

        return {
            "ok": True,
            "action": "restart" if restarting else "start" if turn_on else "stop",
            "target_status": "running" if turn_on else "stopped",
            "message": f"{name}: {'перезапуск выполняется' if restarting else 'запуск выполняется' if turn_on else 'остановка выполняется'}",
        }
    except HTTPException:
        raise
    except docker.errors.APIError as exc:
        raise HTTPException(status_code=502, detail=f"Ошибка Docker: {exc}") from exc
    finally:
        if not watcher_started:
            if client is not None:
                client.close()
            get_docker_containers.cache_clear()
            with _docker_ops_lock:
                _docker_ops.discard(key)


@app.post("/api/actions/update")
def update_project():
    try:
        response = requests.post(f"{DEPLOY_AGENT_URL}/update", timeout=5)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=503, detail="Сервис обновления недоступен") from exc

    return response.json()


@app.get("/api/actions/status")
def update_status():
    try:
        response = requests.get(f"{DEPLOY_AGENT_URL}/status", timeout=5)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=503, detail="Сервис обновления недоступен") from exc

    return response.json()


@app.get("/update-status")
def update_status_page():
    status_file = FRONTEND_DIR / "update-status.html"
    if status_file.exists():
        return FileResponse(status_file, headers={"Cache-Control": "no-store"})
    return {"message": "Update status page is unavailable"}


@app.get("/")
def index():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers={"Cache-Control": "no-store"})
    return {"message": "Server Monitor API", "docs": "/docs"}
