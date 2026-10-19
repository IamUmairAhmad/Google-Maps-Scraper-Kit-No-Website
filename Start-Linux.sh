#!/bin/bash
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then python3 launch.py
else echo "Python 3 not found. Install it with your package manager (e.g. sudo apt install python3 python3-venv)."; read -r -p "Press Enter to close..."; fi
