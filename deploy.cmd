@echo off
REM ─────────────────────────────────────────────────────────
REM  Deploy Džiokeris to Cloudflare Pages.
REM  Just double-click this file (or run: deploy) after changes.
REM ─────────────────────────────────────────────────────────
setlocal
echo Building static folder (.pages-dist)...
if exist .pages-dist rmdir /s /q .pages-dist
mkdir .pages-dist
copy /y index.html .pages-dist\ >nul
xcopy /e /i /y /q src .pages-dist\src >nul
echo Deploying to Cloudflare Pages...
call npx wrangler pages deploy --project-name dziokeris --branch main --commit-dirty=true
echo.
echo Done. Live at https://dziokeris.pages.dev
endlocal
pause
