// ═══════════════════════════════════════════════════
// game.test.js — reducer core tests (Phase 1)
// Run: node --test src/engine/game.test.js
// ═══════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, playerView } from './game.js';

test('createGame deals correctly and is deterministic', () => {
  const a = createGame(123, { players: 3, deal: 7 });
  const b = createGame(123, { players: 3, deal: 7 });
  assert.equal(a.players.length, 3);
  assert.equal(a.players[0].hand.length, 7);
  assert.equal(a.discard.length, 1);
  assert.equal(a.deck.length, 54 - 3 * 7 - 1); // 54 - 21 - 1 = 32
  // same seed → identical deal
  assert.deepEqual(a.players[0].hand.map(c => c.id), b.players[0].hand.map(c => c.id));
  // different seed → (almost surely) different deal
  const c = createGame(124, { players: 3, deal: 7 });
  assert.notDeepEqual(a.players[0].hand.map(c => c.id), c.players[0].hand.map(c => c.id));
});

test('draw then discard advances the turn', () => {
  let s = createGame(1);
  const before = s.players[0].hand.length;
  ({ state: s } = applyAction(s, { type: 'draw', src: 'deck' }));
  assert.equal(s.players[0].hand.length, before + 1);
  assert.equal(s.phase, 'play');
  const cardId = s.players[0].hand[0].id;
  ({ state: s } = applyAction(s, { type: 'discard', cardId }));
  assert.equal(s.current, 1);          // next seat
  assert.equal(s.phase, 'draw');
  assert.equal(s.discard[s.discard.length - 1].id, cardId);
});

test('playerView hides opponent hands but shows counts', () => {
  const s = createGame(7);
  const v = playerView(s, 0);
  assert.equal(v.hand.length, 7);              // own hand visible
  assert.equal(v.opponents.length, 3);
  assert.equal(v.opponents[1].handCount, 7);   // count only
  assert.equal(v.opponents[1].hand, undefined); // no hand leaked
});

test('illegal action is rejected (draw twice)', () => {
  let s = createGame(1);
  ({ state: s } = applyAction(s, { type: 'draw', src: 'deck' }));
  assert.throws(() => applyAction(s, { type: 'draw', src: 'deck' }), /expected phase draw/);
});

test('rearrange commits a valid table and consumes hand cards', () => {
  // Hand-craft a state: give seat 0 three Kings after drawing.
  let s = createGame(1);
  s.phase = 'play';
  const kings = [
    { id: 900, rank: 'K', suit: '♠', isJoker: false },
    { id: 901, rank: 'K', suit: '♥', isJoker: false },
    { id: 902, rank: 'K', suit: '♦', isJoker: false },
  ];
  s.players[0].hand = [...kings, { id: 903, rank: '4', suit: '♣', isJoker: false }];
  const { state: s2 } = applyAction(s, { type: 'rearrange', groups: [{ owner: 0, ids: [900, 901, 902] }] });
  assert.equal(s2.table.length, 1);
  assert.equal(s2.table[0].cards.length, 3);
  assert.equal(s2.players[0].hand.length, 1);      // only the 4♣ remains
  assert.equal(s2.players[0].hand[0].id, 903);
});

test('rearrange rejects an invalid group', () => {
  let s = createGame(1);
  s.phase = 'play';
  s.players[0].hand = [
    { id: 800, rank: 'K', suit: '♠', isJoker: false },
    { id: 801, rank: '2', suit: '♥', isJoker: false },
    { id: 802, rank: '9', suit: '♦', isJoker: false },
  ];
  assert.throws(() => applyAction(s, { type: 'rearrange', groups: [{ ids: [800, 801, 802] }] }), /invalid group/);
});
