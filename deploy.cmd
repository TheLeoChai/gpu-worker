@echo off
rem Task Scheduler wrapper for deploy.ps1 (task "gpu-worker-deploy").
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
