"""Local page for Google Chrome: niche + location in, Maps listings out (filter and download by group)."""

from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app.leads import FILTER_KEYS, filter_rows, result_filename, rows_to_csv, rows_to_xlsx, write_results
from app.scrape import scrape_places, summary_message

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8765

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_running = False


def _public_job(job: dict) -> dict:
    return {
        "id": job["id"],
        "status": job["status"],
        "phase": job.get("phase", ""),
        "message": job.get("message", ""),
        "niche": job.get("niche", ""),
        "location": job.get("location", ""),
        "checked": job.get("checked", 0),
        "total": job.get("total", 0),
        "found": job.get("found", 0),
        "skipped_website": job.get("skipped_website", 0),
        "skipped_closed": job.get("skipped_closed", 0),
        "failed": job.get("failed", 0),
        "error": job.get("error", ""),
        "rows": job.get("rows", []),
    }


def _start_job(niche: str, location: str, limit: int) -> dict:
    global _running
    with _lock:
        if _running:
            raise RuntimeError("A search is already running. Wait for it to finish.")
        _running = True
        job_id = uuid.uuid4().hex[:8]
        job = {
            "id": job_id,
            "status": "running",
            "phase": "starting",
            "message": "Starting Chrome.",
            "niche": niche,
            "location": location,
            "limit": limit,
            "checked": 0,
            "total": 0,
            "found": 0,
            "skipped_website": 0,
            "skipped_closed": 0,
            "failed": 0,
            "error": "",
            "rows": [],
        }
        _jobs[job_id] = job

    def run() -> None:
        global _running

        def on_progress(event: dict) -> None:
            with _lock:
                current = _jobs[job_id]
                for key, value in event.items():
                    if key == "message":
                        current["message"] = value
                    elif key == "phase":
                        current["phase"] = value
                    elif key in current:
                        current[key] = value

        try:
            summary = scrape_places(niche, location, limit=limit, on_progress=on_progress)
            write_results(summary["rows"], niche, location)
            with _lock:
                current = _jobs[job_id]
                current.update(
                    status="done",
                    phase="done",
                    rows=summary["rows"],
                    checked=summary["checked"],
                    found=summary["found"],
                    skipped_website=summary["skipped_website"],
                    skipped_closed=summary["skipped_closed"],
                    failed=summary["failed"],
                    message=summary_message(summary, summary["failed"]),
                )
        except Exception as exc:
            with _lock:
                current = _jobs[job_id]
                current["status"] = "error"
                current["phase"] = "error"
                current["error"] = str(exc)
                current["message"] = str(exc)
        finally:
            with _lock:
                _running = False

    threading.Thread(target=run, name=f"scrape-{job_id}", daemon=True).start()
    return _public_job(job)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[finder] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, status: int, body: bytes, content_type: str, filename: str = "") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            page = (STATIC / "index.html").read_bytes()
            self._send(200, page, "text/html; charset=utf-8")
            return
        for extension, content_type in (
            ("csv", "text/csv; charset=utf-8"),
            ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ):
            if path.startswith("/api/jobs/") and path.endswith("." + extension):
                job_id = path.removeprefix("/api/jobs/").removesuffix("." + extension)
                key = (parse_qs(parsed.query).get("filter", ["checked"])[0] or "checked").strip()
                if key not in FILTER_KEYS:
                    self._json(400, {"error": "Pick one of: " + ", ".join(FILTER_KEYS) + "."})
                    return
                with _lock:
                    job = _jobs.get(job_id)
                    rows = list(job.get("rows", [])) if job else []
                    status = job.get("status") if job else ""
                    niche = job.get("niche", "") if job else ""
                    location = job.get("location", "") if job else ""
                if not job:
                    self._json(404, {"error": "Search not found."})
                    return
                if status != "done":
                    self._json(409, {"error": "The download is ready when the search finishes."})
                    return
                subset = filter_rows(rows, key)
                if extension == "csv":
                    body = rows_to_csv(subset).encode("utf-8")
                else:
                    body = rows_to_xlsx(subset)
                self._send(200, body, content_type, result_filename(key, niche, location, extension))
                return
        if path.startswith("/api/jobs/"):
            job_id = path.removeprefix("/api/jobs/")
            with _lock:
                job = _jobs.get(job_id)
                payload = _public_job(job) if job else None
            if not payload:
                self._json(404, {"error": "Search not found."})
                return
            self._json(200, payload)
            return
        self._json(404, {"error": "Not found."})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/jobs":
            self._json(404, {"error": "Not found."})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "Send niche and location as JSON."})
            return
        niche = str(body.get("niche", "")).strip()
        location = str(body.get("location", "")).strip()
        try:
            limit = int(body.get("limit", 40))
        except (TypeError, ValueError):
            self._json(400, {"error": "Listings to check must be a number from 1 to 120."})
            return
        if not niche or not location:
            self._json(400, {"error": "Enter both a niche and a location."})
            return
        if len(niche) > 80 or len(location) > 80:
            self._json(400, {"error": "Keep the niche and location under 80 characters."})
            return
        if limit < 1 or limit > 120:
            self._json(400, {"error": "Listings to check must be from 1 to 120."})
            return
        try:
            job = _start_job(niche, location, limit)
        except RuntimeError as exc:
            self._json(409, {"error": str(exc)})
            return
        self._json(202, job)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Open http://{HOST}:{PORT} in Google Chrome", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
