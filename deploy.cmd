@echo off
REM ─────────────────────────────────────────────────────────
REM  Deploy Džiokeris to Cloudflare Pages.
REM  Double-click this file (or run: deploy) after changes.
REM  Steps: auto-commit your changes locally -> stamp the build
REM  version (date/time + commit hash) -> upload to Cloudflare.
REM  (Local commit only; run `git push` yourself to sync GitHub.)
REM ─────────────────────────────────────────────────────────
setlocal
for /f "delims=" %%d in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy.MM.dd HHmm'"') do set STAMP=%%d

echo Committing changes (local)...
git add -A
git commit -m "Deploy %STAMP%" 1>nul 2>nul
if errorlevel 1 (echo   nothing new to commit) else (echo   committed: Deploy %STAMP%)

set COMMIT=nogit
for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set COMMIT=%%i

echo Building static folder (.pages-dist)...
if exist .pages-dist rmdir /s /q .pages-dist
mkdir .pages-dist
copy /y index.html .pages-dist\ >nul
xcopy /e /i /y /q src .pages-dist\src >nul

echo Stamping version v%STAMP% (%COMMIT%)...
powershell -NoProfile -Command "$p='.pages-dist\index.html'; $c=[IO.File]::ReadAllText($p); $c=$c.Replace('__BUILD__','v%STAMP%').Replace('__BUILDHASH__','Build %STAMP% - commit %COMMIT%'); [IO.File]::WriteAllText($p,$c,(New-Object Text.UTF8Encoding($false)))"

echo Deploying to Cloudflare Pages...
call npx wrangler pages deploy --project-name dziokeris --branch main --commit-dirty=true
echo.
echo Done. Live at https://dziokeris.pages.dev  (version v%STAMP%)
endlocal
pause
