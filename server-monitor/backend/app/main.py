import os
from pathlib import Path

import requests
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.metrics import collect_all

FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", Path(__file__).resolve().parent.parent.parent / "frontend"))
DEPLOY_AGENT_URL = os.getenv("DEPLOY_AGENT_URL", "http://deploy-agent:9000")

app = FastAPI(title="Server Monitor", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/metrics")
def metrics():
    return collect_all()


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
