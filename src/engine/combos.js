// ═══════════════════════════════════════════════════
// combos.js — combination validation, sorting, enumeration
// Pure module. Extracted behaviour-preserving from dziokeris.html lines 319–415.
//
// Two deliberate changes from the original, both called out in the plan:
//   1. bestPlay() no longer caps at two combos (original i,j pair loop, line 398)
//      — it does a general greedy cover, correct for any deal size / player count.
//   2. bestPlay() memoises on a canonical hand key (search is cheap — ~219 subsets
//      for 8 cards — but memoisation removes repeat work across a turn).
// The validation rules (isValidCombo/isSet/isRun/runFits/sortCombo) are unchanged.
// ═══════════════════════════════════════════════════

import { SUITS, RV, cpts, hpts } from './cards.js';

export function isValidCombo(cards) {
  if (!cards || cards.length < 3) return false;
  const real = cards.filter(c => !c.isJoker), jn = cards.length - real.length;
  if (!real.length) return true; // all jokers (rare) — treated valid, as original
  return isSet(real, jn, cards.length) || isRun(real, jn, cards.length);
}

export function isSet(real, jn, tot) {
  if (tot < 3 || tot > 4) return false;
  const r = real[0].rank;
  if (!real.every(c => c.rank === r)) return false;
  const suits = real.map(c => c.suit);
  return new Set(suits).size === suits.length; // no duplicate suits
}

export function isRun(real, jn, tot) {
  if (tot < 3) return false;
  const s = real[0].suit;
  if (!real.every(c => c.suit === s)) return false;
  const sorted = [...real].sort((a, b) => RV[a.rank] - RV[b.rank]);
  return runFits(sorted, jn, false) || runFits(sorted, jn, true);
}

// aceLow: treat A as 1 instead of 14. A run may use ace low (A-2-3) or ace high
// (Q-K-A) but not wrap (K-A-2) — the two includes() guards enforce that.
export function runFits(sorted, jn, aceLow) {
  const vals = sorted.map(c => (c.rank === 'A' && aceLow) ? 1 : RV[c.rank]).sort((a, b) => a - b);
  if (!aceLow && vals.includes(14) && vals.includes(2)) return false;
  if (aceLow && vals.includes(1) && vals.includes(13)) return false;
  let gaps = 0;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] === vals[i - 1]) return false; // duplicate rank in a run
    gaps += vals[i] - vals[i - 1] - 1;
  }
  return gaps <= jn; // jokers fill the gaps
}

/** Order a valid combo for display: sets by suit, runs ascending with jokers in gaps. */
export function sortCombo(cards) {
  const jokers = cards.filter(c => c.isJoker);
  const real = cards.filter(c => !c.isJoker);
  if (!real.length) return cards;
  const r = real[0].rank;
  if (real.every(c => c.rank === r)) {
    return [...real].sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit)).concat(jokers);
  }
  const srt = [...real].sort((a, b) => RV[a.rank] - RV[b.rank]);
  const out = [];
  let jLeft = [...jokers];
  for (let i = 0; i < srt.length; i++) {
    if (i > 0) {
      const gap = RV[srt[i].rank] - RV[srt[i - 1].rank] - 1;
      for (let g = 0; g < gap && jLeft.length; g++) out.push(jLeft.shift());
    }
    out.push(srt[i]);
  }
  return out.concat(jLeft);
}

// ── enumeration (for coach + AI) ─────────────────────
function subs(arr, sz) {
  const res = [];
  (function go(i, cur) {
    if (cur.length === sz) { res.push([...cur]); return; }
    if (i >= arr.length) return;
    cur.push(arr[i]); go(i + 1, cur); cur.pop(); go(i + 1, cur);
  })(0, []);
  return res;
}

/** Every valid combo (size ≥ 3) formable from a hand. */
export function allCombos(hand) {
  const res = [];
  for (let sz = 3; sz <= hand.length; sz++) for (const s of subs(hand, sz)) if (isValidCombo(s)) res.push(s);
  return res;
}

// Canonical key for memoising bestPlay across identical hands within a turn.
function handKey(hand) {
  return hand.map(c => c.isJoker ? 'J' : c.rank + c.suit).sort().join(',');
}
const _bestCache = new Map();

/**
 * Best set of disjoint combos to minimise leftover (deadwood) points.
 * Greedy general cover — repeatedly takes the combo that best reduces remaining
 * points, then recurses on what's left. Replaces the original's hardcoded
 * "at most two combos" pair loop, which broke silently past 8-card hands.
 * Returns { combos: Card[][], rem: number }.
 */
export function bestPlay(hand) {
  const key = handKey(hand);
  const cached = _bestCache.get(key);
  if (cached) return cached;

  const result = _bestPlay(hand);
  if (_bestCache.size > 5000) _bestCache.clear(); // bound memory
  _bestCache.set(key, result);
  return result;
}

function _bestPlay(hand) {
  const all = allCombos(hand);
  if (!all.length) return { combos: [], rem: hpts(hand) };

  let best = { combos: [], rem: hpts(hand) };
  for (const c of all) {
    const ids = new Set(c.map(x => x.id));
    const rem = hand.filter(x => !ids.has(x.id));
    // recurse to cover the remainder too (this is the multi-combo generalisation)
    const sub = _bestPlay(rem);
    const combos = [c, ...sub.combos];
    if (sub.rem < best.rem) best = { combos, rem: sub.rem };
  }
  return best;
}

/** Highest-point card not used by bestPlay's combos — the safe discard candidate. */
export function worstCard(hand) {
  const { combos } = bestPlay(hand);
  const inC = new Set(combos.flatMap(c => c.map(x => x.id)));
  const nc = hand.filter(c => !inC.has(c.id));
  const pool = nc.length ? nc : hand;
  return pool.reduce((a, b) => cpts(a) >= cpts(b) ? a : b);
}

/** Test hook: clear the bestPlay memo (used so benchmarks measure cold cost). */
export function _clearCache() { _bestCache.clear(); }
