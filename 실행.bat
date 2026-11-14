@echo off
chcp 65001 >nul
title 클로드 관제실 (서버 - 닫으면 앱이 꺼져요)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 가 없어서 켤 수 없어요.
  echo   https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  echo   Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
node server.js %*
if errorlevel 1 pause
