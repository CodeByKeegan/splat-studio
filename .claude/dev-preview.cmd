@echo off
if not defined PORT set PORT=5273
set API_PORT=5274
set SPLAT_WORKSPACE=%~dp0..\workspace
cd /d %~dp0..
npm run dev
