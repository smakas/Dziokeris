// ═══════════════════════════════════════════════════
// functions/api/resume.js — save / load an in-progress game + its move log.
// Cloudflare Pages Function. D1 bound as env.DB.
//   GET  /api/resume?playerId=…   → { snapshot, gameId } | { none: true }
//   PUT  /api/resume  { playerId, game:{id,seed,config,mode,round}, snapshot,
//                       actions[], combinations[], finished }
//        → { ok: true } | { error }
//
// The snapshot is a full JSON dump of the engine state (+ minimal UI/meta); it
// restores a game exactly. `actions` and `combinations` are append-only history
// for later analysis — combinations especially, the table melds being the richest
// learning signal. Every write is idempotent so buffered offline moves re-send safely.
// ═══════════════════════════════════════════════════

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// GET /api/resume?playerId=  → the player's active (unfinished) saved game, if any.
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no database bound' }, 503);
  const url = new URL(request.url);
  const playerId = (url.searchParams.get('playerId') || '').trim();
  if (!playerId) return json({ none: true });

  const row = await env.DB.prepare(
    `SELECT game_id, snapshot_json FROM saved_games
     WHERE player_id = ? AND finished = 0 LIMIT 1`
  ).bind(playerId).first();

  if (!row) return json({ none: true });
  let snapshot;
  try { snapshot = JSON.parse(row.snapshot_json); } catch { return json({ none: true }); }
  return json({ snapshot, gameId: row.game_id });
}

// PUT /api/resume  → upsert the snapshot, append new actions + combinations.
export async function onRequestPut({ request, env }) {
  if (!env.DB) return json({ error: 'no database bound' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

  const playerId = (body.playerId || '').trim();
  const g = body.game || {};
  const snapshot = body.snapshot;
  if (!playerId || !g.id || !snapshot) return json({ error: 'missing playerId/game/snapshot' }, 400);

  const actions = Array.isArray(body.actions) ? body.actions : [];
  const combos = Array.isArray(body.combinations) ? body.combinations : [];
  const log = Array.isArray(body.log) ? body.log : [];
  const finished = body.finished ? 1 : 0;
  const stmts = [];

  // Parent games row must exist before actions/combinations reference it. Created
  // early here (partial); the end-of-game POST /api/games finalises rounds/winner.
  stmts.push(env.DB.prepare(
    `INSERT OR IGNORE INTO games (id, seed, variant, config_json, mode, started_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).bind(g.id, g.seed | 0, g.variant || 2, JSON.stringify(g.config || {}), g.mode || 'solo'));

  stmts.push(env.DB.prepare(
    `INSERT INTO saved_games (player_id, game_id, snapshot_json, round_no, finished, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(player_id) DO UPDATE SET
       game_id = excluded.game_id, snapshot_json = excluded.snapshot_json,
       round_no = excluded.round_no, finished = excluded.finished, updated_at = datetime('now')`
  ).bind(playerId, g.id, JSON.stringify(snapshot), g.round | 0, finished));

  for (const a of actions) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO actions (game_id, seq, round_no, seat, type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(g.id, a.seq | 0, a.round | 0, a.seat | 0, String(a.type || ''), JSON.stringify(a.payload || {})));
  }

  for (const c of combos) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO combinations
         (game_id, seq, round_no, grp_idx, owner_seat, kind, combo_key, cards_json, card_count, points)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(g.id, c.seq | 0, c.round | 0, c.grpIdx | 0, c.ownerSeat | 0,
      String(c.kind || ''), String(c.comboKey || ''), JSON.stringify(c.cards || []),
      c.cardCount | 0, c.points | 0));
  }

  for (const e of log) {
    stmts.push(env.DB.prepare(
      `INSERT INTO game_log (game_id, entry_id, round_no, seat, player, action, detail, comment, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, entry_id) DO UPDATE SET
         comment = excluded.comment, detail = excluded.detail`
    ).bind(g.id, e.id | 0, e.round | 0, e.seat == null ? null : e.seat | 0,
      String(e.player || ''), String(e.action || ''), String(e.detail || ''),
      e.comment ? String(e.comment) : null, e.ts ? String(e.ts) : null));
  }

  try {
    await env.DB.batch(stmts);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
