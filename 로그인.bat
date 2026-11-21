@echo off
chcp 65001 >nul
if /i "%LOGIN_KIND%"=="codex" goto codex
title Claude 로그인
echo.
echo   Claude Code 로그인 창이에요.
echo   브라우저가 열리면 Claude 계정으로 직접 로그인해 주세요.
echo   (Claude Code login - log in with your Claude account in the browser that opens.)
echo.
if not defined LOGIN_CLAUDE claude auth login
if defined LOGIN_CLAUDE "%LOGIN_CLAUDE%" %LOGIN_CLAUDE_ARG% auth login
goto done

:codex
title GPT 로그인
echo.
echo   GPT(Codex) 로그인 창이에요.
echo   브라우저가 열리면 내 ChatGPT 계정으로 직접 로그인해 주세요.
echo   (GPT login - log in with your ChatGPT account in the browser that opens.)
echo.
if not defined LOGIN_CODEX codex login
if defined LOGIN_CODEX "%LOGIN_CODEX%" %LOGIN_CODEX_ARG% login

:done
echo.
echo   끝났어요. 관제실 화면이 저절로 로그인을 확인해요.
echo   아무 키나 누르면 이 창이 닫혀요.
echo   (Done. The control room checks the login by itself. Press any key to close.)
pause >nul
exit
