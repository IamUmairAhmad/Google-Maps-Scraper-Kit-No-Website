@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 launch.py & goto :end)
where python >nul 2>nul && (python launch.py & goto :end)
echo Python 3 was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
pause
:end
