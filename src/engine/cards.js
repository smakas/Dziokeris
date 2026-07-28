// ═══════════════════════════════════════════════════
// cards.js — deck, card primitives, seeded RNG
// Pure module: no DOM, no globals. Runs in browser, Worker, and Node.
// Extracted verbatim (behaviour-preserving) from dziokeris.html lines 273–314.
// ═══════════════════════════════════════════════════

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Rank ordering value (for run adjacency). Ace high = 14; ace-low handled in combos.js.
export const RV = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };

// Penalty points for uncombined cards at scoring.
export const PTS = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 10, Q: 10, K: 10, A: 11, JOKER: 25 };

/** Make a card. `id` must be unique within a game; caller supplies it. */
export function mk(id, rank, suit) {
  return { id, rank, suit, isJoker: rank === 'JOKER' };
}

export function cpts(c) { return PTS[c.rank] || 0; }
export function hpts(h) { return h.reduce((s, c) => s + cpts(c), 0); }
export function isRed(c) { return c.suit === '♥' || c.suit === '♦'; }
export function clbl(c) { return c.isJoker ? 'Džk' : c.rank + c.suit; }

/**
 * CSS class for a card's colour. Kept here (not in ui/) because it is a pure
 * function of the card and is reused by any renderer.
 */
export function suitCls(c) {
  if (c.isJoker) return 'jkr';
  if (c.suit === '♥' || c.suit === '♦') return 'red';
  if (c.suit === '♣') return 'club';
  return 'blk';
}

/** Build a full 54-card deck (52 + 2 jokers) with stable ids 0..53. */
export function buildDeck() {
  const d = [];
  let id = 0;
  for (const s of SUITS) for (const r of RANKS) d.push(mk(id++, r, s));
  d.push(mk(id++, 'JOKER', ''));
  d.push(mk(id++, 'JOKER', ''));
  return d;
}

/**
 * mulberry32 — tiny deterministic PRNG. Same seed → same sequence, in every
 * runtime. This is what makes games replayable (plan: seed + action log).
 * Returns a function producing floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded Fisher–Yates shuffle. Same algorithm as the original (line 312)
 * but takes an injected rng so results are reproducible.
 */
export function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
