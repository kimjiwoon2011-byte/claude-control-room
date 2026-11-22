@echo off
chcp 65001 >nul
title Claude Control Room (server - closing this window stops the app)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, so the app cannot start.
  echo   Install the LTS version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
node server.js %*
if errorlevel 1 pause
