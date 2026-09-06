import json
import os
import subprocess
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
#testv4

DEPLOY_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "deploy.sh"
STATUS_FILE = Path(os.getenv("DEPLOY_STATUS_FILE", "/home/sparrow/site/server-monitor/.deploy-status.json"))
status_lock = threading.Lock()

app = FastAPI(title="Deploy Agent")


def read_status():
    try:
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"status": "idle"}


def write_status(status, message=None):
    payload = {"status": status}
    if message:
        payload["message"] = message

    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = STATUS_FILE.with_suffix(".tmp")
    temporary_file.write_text(json.dumps(payload), encoding="utf-8")
    temporary_file.replace(STATUS_FILE)


def wait_for_update(process):
    return_code = process.wait()
    with status_lock:
        if return_code == 0:
            write_status("completed")
        else:
            write_status("error", f"Скрипт обновления завершился с кодом {return_code}")


@app.on_event("startup")
def mark_interrupted_update():
    with status_lock:
        if read_status().get("status") == "running":
            write_status("error", "Обновление было прервано перезапуском deploy-agent")


@app.post("/update")
def update():
    with status_lock:
        if read_status().get("status") == "running":
            return {"status": "started", "message": "Обновление уже запущено"}

        try:
            write_status("running")
            process = subprocess.Popen([str(DEPLOY_SCRIPT)], start_new_session=True)
        except OSError as exc:
            write_status("error", "Не удалось запустить скрипт обновления")
            raise HTTPException(status_code=500, detail="Не удалось запустить скрипт обновления") from exc

    threading.Thread(target=wait_for_update, args=(process,), daemon=True).start()
    return {"status": "started", "message": "Обновление запущено"}


@app.get("/status")
def status():
    with status_lock:
        return read_status()
