@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" server.js >> worker.log 2>&1