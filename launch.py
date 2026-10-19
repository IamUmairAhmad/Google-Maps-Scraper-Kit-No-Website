"""One-click launcher: sets up a private environment once, starts the search, opens Chrome."""
import os
import hashlib
import socket
import subprocess
import sys
import threading
import time
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
PORT = 8765
URL = f"http://127.0.0.1:{PORT}"


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup() -> None:
    if not venv_python().exists():
        print("First run: creating a private Python environment...")
        venv.create(VENV, with_pip=True)
    marker = VENV / ".installed"
    reqs = ROOT / "requirements.txt"
    digest = hashlib.sha256(reqs.read_bytes()).hexdigest()
    if not marker.exists() or marker.read_text() != digest:
        print("Installing requirements (first run or after an update)...")
        subprocess.check_call([str(venv_python()), "-m", "pip", "install", "-q", "-r", str(reqs)])
        marker.write_text(digest)


def open_chrome_when_ready() -> None:
    for _ in range(60):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.5).close()
            break
        except OSError:
            time.sleep(0.5)
    else:
        return
    try:
        webbrowser.get("chrome").open(URL)
        return
    except webbrowser.Error:
        pass
    if sys.platform == "darwin":
        if subprocess.call(["open", "-a", "Google Chrome", URL]) == 0:
            return
    elif os.name == "nt":
        if subprocess.call(["cmd", "/c", "start", "chrome", URL]) == 0:
            return
    else:
        for name in ("google-chrome", "google-chrome-stable", "chrome"):
            try:
                subprocess.Popen([name, URL])
                return
            except OSError:
                continue
    webbrowser.open(URL)


def main() -> int:
    os.chdir(ROOT)
    try:
        setup()
    except Exception as exc:  # noqa: BLE001
        print(f"Setup failed: {exc}")
        return 1
    threading.Thread(target=open_chrome_when_ready, daemon=True).start()
    print(f"Starting at {URL}  (close this window to stop)")
    try:
        return subprocess.call([str(venv_python()), "-m", "app"])
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    code = main()
    if code:
        input("Press Enter to close...")
    sys.exit(code)
