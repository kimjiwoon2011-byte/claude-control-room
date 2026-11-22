@echo off
chcp 65001 >nul
if /i "%LOGIN_KIND%"=="codex" goto codex
title Claude login
echo.
echo   Claude Code login
echo   Log in with your Claude account in the browser that opens.
echo.
if not defined LOGIN_CLAUDE claude auth login
if defined LOGIN_CLAUDE "%LOGIN_CLAUDE%" %LOGIN_CLAUDE_ARG% auth login
goto done

:codex
title GPT login
echo.
echo   GPT (Codex) login
echo   Log in with your own ChatGPT account in the browser that opens.
echo.
if not defined LOGIN_CODEX codex login
if defined LOGIN_CODEX "%LOGIN_CODEX%" %LOGIN_CODEX_ARG% login

:done
echo.
echo   Done. The control room checks the login by itself.
echo   Press any key to close this window.
pause >nul
exit
