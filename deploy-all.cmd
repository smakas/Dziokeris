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
echo [2/4] Creating tables in the LIVE database (combinations, saved_games) ...
REM Run each new statement via --command (the query endpoint). Avoids the D1
REM --file "import" endpoint, which rejects OAuth tokens (auth error 10000).
REM Every statement is IF NOT EXISTS, so re-running this is safe.
call npx -y wrangler d1 execute dziokeris --remote --command "CREATE TABLE IF NOT EXISTS combinations (game_id TEXT NOT NULL REFERENCES games(id), seq INTEGER NOT NULL, round_no INTEGER NOT NULL, grp_idx INTEGER NOT NULL, owner_seat INTEGER NOT NULL, kind TEXT NOT NULL, combo_key TEXT NOT NULL, cards_json TEXT NOT NULL, card_count INTEGER NOT NULL, points INTEGER NOT NULL, PRIMARY KEY (game_id, seq, grp_idx))" || goto :err
call npx -y wrangler d1 execute dziokeris --remote --command "CREATE INDEX IF NOT EXISTS idx_combos_key ON combinations(combo_key)" || goto :err
call npx -y wrangler d1 execute dziokeris --remote --command "CREATE INDEX IF NOT EXISTS idx_combos_game ON combinations(game_id, round_no)" || goto :err
call npx -y wrangler d1 execute dziokeris --remote --command "CREATE TABLE IF NOT EXISTS saved_games (player_id TEXT PRIMARY KEY REFERENCES players(id), game_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, round_no INTEGER NOT NULL DEFAULT 1, finished INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))" || goto :err
call npx -y wrangler d1 execute dziokeris --remote --command "CREATE TABLE IF NOT EXISTS game_log (game_id TEXT NOT NULL REFERENCES games(id), entry_id INTEGER NOT NULL, round_no INTEGER NOT NULL, seat INTEGER, player TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, comment TEXT, ts TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (game_id, entry_id))" || goto :err

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
