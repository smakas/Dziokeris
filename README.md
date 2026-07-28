# 🃏 Džiokeris

A browser trainer for the Lithuanian card game **Džiokeris** (a Rummy variant):
play against AI opponents with a built-in coach, and — once hosted — track every
player's scores and results in the cloud.

## Architecture

The rules live in a **pure engine** (`src/engine/`) with no DOM, network, or
randomness beyond a seeded RNG. The same engine runs in three places:

- **the browser** — solo play vs AI (`src/ui/app.js` + `index.html`)
- **Node** — headless simulation & (later) AI tuning (`src/sim/`)
- **Cloudflare** — (later) authoritative online multiplayer

A game is fully described by a **seed + an ordered list of actions**, so any game
can be replayed exactly. See `docs`-style notes in each module header.

```
src/engine/   cards.js, combos.js, game.js   ← pure rules (the keystone)
src/ai/       policy.js                        ← AI turn planner
src/ui/       app.js                            ← browser controller
src/sim/      run.js                            ← headless self-play
functions/    api/games.js, api/stats.js        ← Cloudflare Pages API (D1)
worker/       schema.sql                         ← D1 database schema
index.html    thin shell (loads src/ui/app.js as an ES module)
```

## Run it locally

The game uses ES modules, so it must be served over HTTP (not opened as a file):

```bash
python -m http.server 8099
```

Then open <http://127.0.0.1:8099/index.html>. Scores are tracked only when the
Cloudflare API is present; locally the game plays fine without it (offline-first).

To run the full stack (app + API + local database) exactly as in the cloud:

```bash
npx wrangler d1 execute dziokeris --local --file worker/schema.sql --persist-to .wrangler/state
npx wrangler pages dev . --persist-to .wrangler/state
```

## Tests

```bash
node --test src/engine/combos.test.js src/engine/game.test.js
node src/sim/run.js --games 1000 --seed 42
```

## Deploy

See **DEPLOY.md** for the step-by-step (GitHub + Cloudflare, all free).
