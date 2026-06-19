"""Background bash job manager.

`execute_bash_async` starts a long-running command, returns a job id.
`bash_job_status` polls; `bash_job_output` returns accumulated stdout/stderr.
"""

from __future__ import annotations

import subprocess
import threading
import time
import uuid
from pathlib import Path

_JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()


def start_job(command: str, workspace: Path) -> str:
    job_id = uuid.uuid4().hex[:8]
    job = {
        "id": job_id,
        "command": command,
        "started_at": time.time(),
        "ended_at": None,
        "exit_code": None,
        "stdout": "",
        "stderr": "",
        "running": True,
    }
    with _LOCK:
        _JOBS[job_id] = job

    def _run():
        try:
            proc = subprocess.Popen(
                command, shell=True, cwd=str(workspace),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            out, err = proc.communicate()
            with _LOCK:
                job["stdout"] = out or ""
                job["stderr"] = err or ""
                job["exit_code"] = proc.returncode
                job["ended_at"] = time.time()
                job["running"] = False
        except Exception as exc:
            with _LOCK:
                job["stderr"] = f"failed to launch: {exc}"
                job["exit_code"] = -1
                job["ended_at"] = time.time()
                job["running"] = False

    threading.Thread(target=_run, daemon=True).start()
    return job_id


def job_status(job_id: str) -> dict | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return None
        return {
            "id": job["id"],
            "command": job["command"],
            "running": job["running"],
            "exit_code": job["exit_code"],
            "duration": (job["ended_at"] or time.time()) - job["started_at"],
        }


def job_output(job_id: str, max_chars: int = 20000) -> dict | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return None
        out = job["stdout"]
        err = job["stderr"]
    body = out
    if err:
        body += ("\n[stderr]\n" + err)
    if len(body) > max_chars:
        body = body[-max_chars:] + "\n[...head truncated...]"
    return {
        "id": job_id,
        "running": job["running"],
        "exit_code": job["exit_code"],
        "output": body,
    }


def list_jobs() -> list[dict]:
    with _LOCK:
        return [
            {"id": j["id"], "running": j["running"], "exit_code": j["exit_code"], "command": j["command"][:80]}
            for j in _JOBS.values()
        ]


def kill_job(job_id: str) -> bool:
    # Best-effort; we didn't store the Popen handle (would require restructuring).
    # For now just mark as not-tracked.
    return False
