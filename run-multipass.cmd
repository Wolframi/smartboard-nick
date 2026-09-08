@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-multipass.ps1" %*
exit /b %ERRORLEVEL%
