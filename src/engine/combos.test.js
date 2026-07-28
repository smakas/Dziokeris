// ═══════════════════════════════════════════════════
// combos.test.js — Phase 0 golden master / rules truth table
// Run: node --test src/engine/combos.test.js
//
// Guards the rules so later refactors cannot silently change them. Cases are
// authored from Projects\Džiokeris\CLAUDE.md (Variant 2 rules), not from the
// old code, so they validate correctness AND extraction fidelity at once.
// ═══════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCombo, bestPlay, worstCard, sortCombo } from './combos.js';
import { hpts } from './cards.js';

let _id = 0;
// Build cards from compact labels: "K♠", "10♥", "J" or "Džk" = joker.
function C(...labels) {
  return labels.map(l => {
    if (l === 'J*' || l === 'Džk' || l === 'JOKER') return { id: _id++, rank: 'JOKER', suit: '', isJoker: true };
    const m = l.match(/^(10|[2-9JQKA])([♠♥♦♣])$/);
    if (!m) throw new Error('bad label: ' + l);
    return { id: _id++, rank: m[1], suit: m[2], isJoker: false };
  });
}

// ── VALID sets ───────────────────────────────────────
const VALID = [
  ['three Kings', C('K♠', 'K♥', 'K♦')],
  ['four Aces', C('A♠', 'A♥', 'A♦', 'A♣')],
  ['set of 7s', C('7♠', '7♥', '7♣')],
  ['set with one joker', C('Q♠', 'Q♥', 'J*')],
  ['run ♣2-3-4', C('2♣', '3♣', '4♣')],
  ['run ascending 5-6-7-8 ♦', C('5♦', '6♦', '7♦', '8♦')],
  ['run with internal joker gap 4♠_6♠', C('4♠', 'J*', '6♠')],
  ['run with leading joker _3-4 ♥', C('J*', '3♥', '4♥')],
  ['ace-low A-2-3 ♠', C('A♠', '2♠', '3♠')],
  ['ace-high Q-K-A ♥', C('Q♥', 'K♥', 'A♥')],
  ['7-card run ♣2..8', C('2♣', '3♣', '4♣', '5♣', '6♣', '7♣', '8♣')],
  ['run with two jokers bridging', C('5♦', 'J*', 'J*', '8♦')],
];

// ── INVALID ──────────────────────────────────────────
const INVALID = [
  ['too short (2 cards)', C('K♠', 'K♥')],
  ['single card', C('5♦')],
  ['set with duplicate suit', C('K♠', 'K♠', 'K♥')],
  ['set of 5 (exceeds 4)', C('9♠', '9♥', '9♦', '9♣', 'J*')],
  ['mixed suits, not a set', C('5♠', '6♥', '7♦')],
  ['run wrap K-A-2 ♠ (ace cannot bridge)', C('K♠', 'A♠', '2♠')],
  ['non-consecutive same suit', C('2♣', '4♣', '7♣')],
  ['run gap too big for jokers', C('2♠', 'J*', '9♠')],
  ['duplicate rank in run', C('4♥', '4♥', '5♥')],
];

test('valid combinations are accepted', () => {
  for (const [name, cards] of VALID) {
    assert.equal(isValidCombo(cards), true, `should be VALID: ${name}`);
  }
});

test('invalid combinations are rejected', () => {
  for (const [name, cards] of INVALID) {
    assert.equal(isValidCombo(cards), false, `should be INVALID: ${name}`);
  }
});

test('joker substitutes any card (set and run)', () => {
  assert.equal(isValidCombo(C('K♠', 'K♥', 'J*')), true);      // joker as third King
  assert.equal(isValidCombo(C('9♦', '10♦', 'J*', 'Q♦')), true); // joker as J♦ in run
});

test('ace is low OR high but never both ends', () => {
  assert.equal(isValidCombo(C('A♠', '2♠', '3♠')), true);   // low
  assert.equal(isValidCombo(C('Q♥', 'K♥', 'A♥')), true);   // high
  assert.equal(isValidCombo(C('K♠', 'A♠', '2♠')), false);  // wrap — forbidden
});

test('sortCombo orders a run ascending and preserves membership', () => {
  const combo = C('6♠', '4♠', '5♠');
  const sorted = sortCombo(combo);
  assert.deepEqual(sorted.map(c => c.rank), ['4', '5', '6']);
  assert.equal(sorted.length, 3);
});

test('bestPlay finds a single combo and correct remainder', () => {
  const hand = C('K♠', 'K♥', 'K♦', '2♣', '9♠'); // one set + two deadwood
  const bp = bestPlay(hand);
  assert.equal(bp.combos.length, 1);
  assert.equal(bp.combos[0].length, 3);
  assert.equal(bp.rem, hpts(C('2♣', '9♠'))); // 2 + 9 = 11
});

test('bestPlay covers MORE than two combos (generalisation fix)', () => {
  // Three disjoint sets — the original two-combo cap would leave one uncovered.
  const hand = C('K♠', 'K♥', 'K♦', 'Q♠', 'Q♥', 'Q♦', '7♠', '7♥', '7♦');
  const bp = bestPlay(hand);
  assert.equal(bp.rem, 0, 'all nine cards should be covered by three sets');
  assert.equal(bp.combos.length, 3);
});

test('worstCard returns highest-point deadwood, not a combo card', () => {
  const hand = C('K♠', 'K♥', 'K♦', 'A♣', '3♠'); // set of Kings + A(11) + 3
  const w = worstCard(hand);
  assert.equal(w.rank, 'A'); // Ace = 11 pts, the worst deadwood
});
