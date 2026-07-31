@echo off
REM ---------------------------------------------------------
REM  Dziokeris — one-click migrate + deploy.
REM  Double-click this file (or run: deploy-all) from the project folder.
REM  It does everything, in order, and stops if any step fails:
REM    1. sync the code branch
REM    2. create the new tables in the LIVE D1 database
REM    3. show the tables so you can see they exist
REM    4. build + deploy to Cloudflare Pages (via deploy.cmd)
REM  No copy-pasting: run it and watch the window.
REM ---------------------------------------------------------
cd /d "%~dp0"
setlocal
set BRANCH=claude/player-data-storage-i0zpmt

echo.
echo ==================================================
echo   Dziokeris  -  migrate ^& deploy
echo ==================================================

echo.
echo [1/4] Syncing branch %BRANCH% ...
git fetch origin || goto :err
git checkout %BRANCH% || goto :err
git pull origin %BRANCH% || goto :err

echo.
echo [2/4] Creating tables in the LIVE database (saved_games, combinations) ...
call npx -y wrangler d1 execute dziokeris --remote --file worker/schema.sql --yes || goto :err

echo.
echo [3/4] Verifying tables in the LIVE database ...
call npx -y wrangler d1 execute dziokeris --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

echo.
echo [4/4] Building and deploying to Cloudflare Pages ...
call deploy.cmd
goto :end

:err
echo.
echo *** A step above FAILED. Nothing further was run. Read the message above. ***
echo *** (Common cause: not logged in to Cloudflare -- run: npx wrangler login) ***
pause

:end
endlocal
