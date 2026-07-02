@echo off
rem Launcher for environments whose PATH predates the Node.js install.
set "PATH=C:\Program Files\nodejs;%PATH%"
rem Each top-level folder under SPLAT_WORKSPACE is a project. Defaults to the repo's
rem ./workspace; set SPLAT_WORKSPACE in your environment to point elsewhere.
if not defined SPLAT_WORKSPACE set "SPLAT_WORKSPACE=%~dp0workspace"
cd /d "%~dp0"
call npm run dev
