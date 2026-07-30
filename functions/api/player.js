// ═══════════════════════════════════════════════════
// functions/api/player.js — lightweight name + 4-digit-PIN accounts.
// Cloudflare Pages Function. D1 bound as env.DB.
//   GET  /api/player?name=Simas   → { exists: bool }
//   POST /api/player  { name, pin } → create (if new) or verify (if returning)
//        → { ok:true, player:{id,name}, created?:bool }  |  { ok:false, reason }
//
// The PIN is a casual family gate, not real security: 4 digits = 10k combos.
// It is salted + SHA-256 hashed and never stored or returned in plaintext.
// ═══════════════════════════════════════════════════

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const norm = (s) => (typeof s === 'string' ? s.trim() : '');
const keyOf = (name) => norm(name).toLowerCase();

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// GET /api/player?name=  → does a human account with this name already exist?
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no database bound' }, 503);
  const url = new URL(request.url);
  const key = keyOf(url.searchParams.get('name') || '');
  if (!key) return json({ exists: false });
  const row = await env.DB.prepare(
    `SELECT 1 FROM players WHERE name_key = ? AND is_ai = 0 LIMIT 1`
  ).bind(key).first();
  return json({ exists: !!row });
}

// POST /api/player  { name, pin }  → create new or verify returning
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no database bound' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

  const name = norm(body.name);
  const pin = norm(body.pin);
  if (name.length < 1 || name.length > 24) return json({ ok: false, reason: 'bad_name' }, 400);
  if (!/^\d{4}$/.test(pin)) return json({ ok: false, reason: 'bad_pin' }, 400);
  const key = keyOf(name);

  const existing = await env.DB.prepare(
    `SELECT id, name, pin_hash, pin_salt FROM players WHERE name_key = ? AND is_ai = 0 LIMIT 1`
  ).bind(key).first();

  if (existing) {
    // Legacy row without a PIN yet → let this login set one (claim the account).
    if (!existing.pin_hash || !existing.pin_salt) {
      const salt = randomHex();
      const hash = await sha256hex(salt + pin);
      await env.DB.prepare(
        `UPDATE players SET pin_hash = ?, pin_salt = ?, name = ? WHERE id = ?`
      ).bind(hash, salt, name, existing.id).run();
      return json({ ok: true, player: { id: existing.id, name } });
    }
    const hash = await sha256hex(existing.pin_salt + pin);
    if (hash !== existing.pin_hash) return json({ ok: false, reason: 'wrong_pin' });
    return json({ ok: true, player: { id: existing.id, name: existing.name || name } });
  }

  // New account
  const id = (crypto.randomUUID && crypto.randomUUID()) || ('p' + randomHex(8));
  const salt = randomHex();
  const hash = await sha256hex(salt + pin);
  try {
    await env.DB.prepare(
      `INSERT INTO players (id, name, is_ai, name_key, pin_hash, pin_salt) VALUES (?, ?, 0, ?, ?, ?)`
    ).bind(id, name, key, hash, salt).run();
  } catch (e) {
    // Lost an insert race on the unique name_key → fall back to verifying.
    const row = await env.DB.prepare(
      `SELECT id, name, pin_hash, pin_salt FROM players WHERE name_key = ? AND is_ai = 0 LIMIT 1`
    ).bind(key).first();
    if (row && row.pin_hash) {
      const h = await sha256hex(row.pin_salt + pin);
      if (h === row.pin_hash) return json({ ok: true, player: { id: row.id, name: row.name || name } });
      return json({ ok: false, reason: 'wrong_pin' });
    }
    return json({ ok: false, reason: 'error' }, 500);
  }
  return json({ ok: true, created: true, player: { id, name } });
}
