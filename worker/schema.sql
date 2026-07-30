-- ═══════════════════════════════════════════════════
-- Džiokeris — Cloudflare D1 (SQLite) schema
-- Apply:  npx wrangler d1 execute dziokeris --file worker/schema.sql
-- (add --local to target the local dev database)
-- ═══════════════════════════════════════════════════

-- Players — one row per human or AI participant, identified by a stable client id.
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,        -- client-generated uuid (localStorage) or 'ai:<name>'
  name        TEXT NOT NULL,
  is_ai       INTEGER NOT NULL DEFAULT 0,
  profile_json TEXT,                   -- learned tendencies (Phase 5)
  name_key    TEXT,                    -- lower(name) for human accounts; unique login key
  pin_hash    TEXT,                    -- SHA-256(salt + pin) hex; NULL for AI/legacy
  pin_salt    TEXT,                    -- per-player random hex salt
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One human account per name (case-insensitive). AI rows leave name_key NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_namekey ON players(name_key);

-- Games — one finished game (a match to the 100-point bust rule).
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,        -- uuid
  seed        INTEGER NOT NULL,        -- reproduces the whole game
  variant     INTEGER NOT NULL DEFAULT 2,
  config_json TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'solo',   -- 'solo' | 'online'
  started_at  TEXT,
  ended_at    TEXT NOT NULL DEFAULT (datetime('now')),
  rounds      INTEGER NOT NULL DEFAULT 0,
  winner_player_id TEXT REFERENCES players(id),
  candy_pot   INTEGER NOT NULL DEFAULT 0
);

-- Per-seat outcome of a game.
CREATE TABLE IF NOT EXISTS game_players (
  game_id     TEXT NOT NULL REFERENCES games(id),
  player_id   TEXT NOT NULL REFERENCES players(id),
  seat        INTEGER NOT NULL,
  final_score INTEGER NOT NULL,
  won         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, seat)
);

-- Per-round scoring (for trend charts over time).
CREATE TABLE IF NOT EXISTS round_scores (
  game_id     TEXT NOT NULL REFERENCES games(id),
  round_no    INTEGER NOT NULL,
  seat        INTEGER NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  deadwood    INTEGER NOT NULL,        -- points counted this round
  running     INTEGER NOT NULL,        -- cumulative score after the round
  PRIMARY KEY (game_id, round_no, seat)
);

-- Full action log (optional now; the asset that makes any later analysis possible).
CREATE TABLE IF NOT EXISTS actions (
  game_id     TEXT NOT NULL REFERENCES games(id),
  seq         INTEGER NOT NULL,
  round_no    INTEGER NOT NULL,
  seat        INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload_json TEXT,
  PRIMARY KEY (game_id, seq)
);

-- Mined insights + tuned policies (Phase 5). Defined now so the schema is stable.
CREATE TABLE IF NOT EXISTS insights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  stats_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS policy_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  weights_json TEXT NOT NULL,
  winrate     REAL,
  games_evaluated INTEGER,
  parent_id   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gp_player ON game_players(player_id);
CREATE INDEX IF NOT EXISTS idx_rs_player ON round_scores(player_id);
CREATE INDEX IF NOT EXISTS idx_games_ended ON games(ended_at);
