@echo off
rem Launcher for environments whose PATH predates the Node.js install.
set "PATH=C:\Program Files\nodejs;%PATH%"
rem Each top-level folder here is a project (HOTP, Acropolis, Independence Hall, …).
set "SPLAT_WORKSPACE=C:\Users\user\Documents\ClaudeWorkbench\splats"
cd /d "%~dp0"
call npm run dev
