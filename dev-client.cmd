@echo off
rem Vite-only launcher: lets the preview harness run a second UI instance on a
rem free port (PORT env) that proxies /api + /files to the already-running
rem API server on 127.0.0.1:5174. Used for headless screenshots/QA.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
call npx vite
