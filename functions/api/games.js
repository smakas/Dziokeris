// ═══════════════════════════════════════════════════
// functions/api/games.js — record a finished game, list recent games
// Cloudflare Pages Function. D1 bound as env.DB.
//   POST /api/games   body: { game, players[], roundScores[] }
//   GET  /api/games   → recent finished games
// ═══════════════════════════════════════════════════

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no database bound' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

  const g = body.game, players = body.players || [], rs = body.roundScores || [];
  if (!g || !g.id || !Array.isArray(players) || !players.length) return json({ error: 'missing game/players' }, 400);

  const stmts = [];

  // upsert players (name may change; keep latest)
  for (const p of players) {
    stmts.push(env.DB.prepare(
      `INSERT INTO players (id, name, is_ai) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    ).bind(p.id, p.name, p.isAi ? 1 : 0));
  }

  stmts.push(env.DB.prepare(
    `INSERT OR IGNORE INTO games (id, seed, variant, config_json, mode, rounds, winner_player_id, candy_pot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(g.id, g.seed | 0, g.variant || 2, JSON.stringify(g.config || {}), g.mode || 'solo',
    g.rounds | 0, g.winnerPlayerId || null, g.candyPot | 0));

  for (const p of players) {
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO game_players (game_id, player_id, seat, final_score, won)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(g.id, p.id, p.seat | 0, p.finalScore | 0, p.won ? 1 : 0));
  }

  for (const r of rs) {
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO round_scores (game_id, round_no, seat, player_id, deadwood, running)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(g.id, r.roundNo | 0, r.seat | 0, r.playerId, r.deadwood | 0, r.running | 0));
  }

  try {
    await env.DB.batch(stmts);
    return json({ ok: true, gameId: g.id });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: 'no database bound' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.mode, g.rounds, g.ended_at, p.name AS winner
     FROM games g LEFT JOIN players p ON p.id = g.winner_player_id
     ORDER BY g.ended_at DESC LIMIT 25`
  ).all();
  return json({ games: results });
}
