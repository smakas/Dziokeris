// ═══════════════════════════════════════════════════
// functions/api/stats.js — leaderboard + per-player progress
// GET /api/stats → { leaderboard[], recentTrends[] }
// ═══════════════════════════════════════════════════

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: 'no database bound' }, 503);

  // Leaderboard: games played, wins, win %, best (lowest) final score per player.
  const leaderboard = (await env.DB.prepare(
    `SELECT p.id, p.name, p.is_ai,
            COUNT(gp.game_id)                    AS games,
            SUM(gp.won)                          AS wins,
            ROUND(100.0 * SUM(gp.won) / COUNT(gp.game_id), 1) AS win_pct,
            MIN(gp.final_score)                  AS best_score,
            ROUND(AVG(gp.final_score), 1)        AS avg_score
     FROM game_players gp JOIN players p ON p.id = gp.player_id
     GROUP BY p.id
     ORDER BY wins DESC, win_pct DESC, games DESC
     LIMIT 50`
  ).all()).results;

  // Recent running-score trend per player (last 100 round rows).
  const trends = (await env.DB.prepare(
    `SELECT rs.player_id, p.name, rs.round_no, rs.running, rs.game_id
     FROM round_scores rs JOIN players p ON p.id = rs.player_id
     ORDER BY rs.rowid DESC LIMIT 100`
  ).all()).results;

  return json({ leaderboard, trends });
}
