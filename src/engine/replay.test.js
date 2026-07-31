// ═══════════════════════════════════════════════════
// replay.test.js — the saved action log is a faithful, replayable record.
// Run: node --test src/engine/replay.test.js
//
// The persistence layer stores { seed, config } + an ordered action list (and the
// derived table combinations). These tests prove the guarantee that makes that log
// worth storing: replaying seed + actions reconstructs the exact same game, across
// round boundaries — so any later analysis of the stored data is sound.
// ═══════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, startRound } from './game.js';
import { bestPlay, worstCard } from './combos.js';

// The round-seed derivation the UI uses (src/ui/app.js startNextRound). Replay must
// use the identical formula to reproduce deals past round 1.
const roundSeed = (seed, round) => (seed * 2654435761 + round) >>> 0;

// A small deterministic policy, enough to exercise draw / lay / discard and to end
// rounds naturally. Plays exactly one seat's turn, recording each action.
function playTurn(s, actions) {
  const seat = s.current;
  const step = (a) => { actions.push(a); ({ state: s } = applyAction(s, a)); };

  step({ type: 'draw', src: 'deck' });
  if (s.roundOver) return s;

  for (const combo of bestPlay(s.players[seat].hand).combos) {
    const ids = combo.map(c => c.id);
    if (!ids.every(id => s.players[seat].hand.some(c => c.id === id))) continue;
    step({ type: 'lay', cardIds: ids });
    if (s.roundOver) return s;
  }
  if (s.roundOver) return s;

  step({ type: 'discard', cardId: worstCard(s.players[seat].hand).id });
  return s;
}

// Play a whole game (bounded) with the policy, returning the final state + action log.
function playGame(seed, maxRounds = 6) {
  let s = createGame(seed);
  const actions = [];
  let guard = 0;
  while (!s.gameOver && s.round <= maxRounds && guard++ < 5000) {
    s = playTurn(s, actions);
    if (s.roundOver) {
      if (s.gameOver || s.round >= maxRounds) break;
      s = startRound(s, roundSeed(seed, s.round));
    }
  }
  return { finalState: s, actions };
}

// Replay purely from seed + the recorded actions — exactly what an analysis tool
// (or the resume path) would do. startRound is re-applied at each round boundary,
// detected structurally (no round tags needed).
function replay(seed, actions) {
  let s = createGame(seed);
  for (let i = 0; i < actions.length; i++) {
    ({ state: s } = applyAction(s, actions[i]));
    // Start the next round only when more actions follow — mirrors the live game,
    // which stops on the round-ending action without dealing a fresh round.
    const isLast = i === actions.length - 1;
    if (!isLast && s.roundOver && !s.gameOver) s = startRound(s, roundSeed(seed, s.round));
  }
  return s;
}

test('seed + action log replays to a byte-identical game', () => {
  const seed = 20260730;
  const { finalState, actions } = playGame(seed);
  assert.ok(actions.length > 5, 'expected a non-trivial action log');
  const replayed = replay(seed, actions);
  assert.deepEqual(replayed, finalState);
});

test('same seed produces the same action log (determinism)', () => {
  const a = playGame(777);
  const b = playGame(777);
  assert.deepEqual(a.actions, b.actions);
  assert.deepEqual(a.finalState, b.finalState);
});

test('replay reconstructs the table combinations at every step', () => {
  const seed = 4242;
  const { actions } = playGame(seed);
  // Live table snapshots after each action.
  const live = [];
  let s = createGame(seed);
  for (const a of actions) {
    ({ state: s } = applyAction(s, a));
    if (s.roundOver && !s.gameOver) s = startRound(s, roundSeed(seed, s.round));
    live.push(s.table.map(g => ({ owner: g.owner, ids: g.cards.map(c => c.id) })));
  }
  // Independent replay must yield the identical sequence of table states — the
  // combinations we persist are therefore reproducible from the log alone.
  const seen = [];
  let r = createGame(seed);
  for (const a of actions) {
    ({ state: r } = applyAction(r, a));
    if (r.roundOver && !r.gameOver) r = startRound(r, roundSeed(seed, r.round));
    seen.push(r.table.map(g => ({ owner: g.owner, ids: g.cards.map(c => c.id) })));
  }
  assert.deepEqual(seen, live);
});
