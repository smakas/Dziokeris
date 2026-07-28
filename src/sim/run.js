// ═══════════════════════════════════════════════════
// sim/run.js — headless N-game runner (Phase 1 determinism proof)
//
// Plays complete games with no browser, driven by a deterministic greedy policy
// (a stand-in until the Phase 2 weight-vector policy lands). Proves the keystone:
// the engine runs headless, and the same seed produces a byte-identical game.
//
// Usage:
//   node src/sim/run.js --games 1000 --seed 42
//   node src/sim/run.js --games 2000            (seed defaults to 1)
// ═══════════════════════════════════════════════════

import { createGame, applyAction, startRound, bestPlay, hpts, cpts } from '../engine/game.js';
import { isValidCombo, worstCard } from '../engine/combos.js';

// ── deterministic greedy policy (sees the real hand; sim-only) ───────────────
// Returns the ordered list of actions the current seat takes this turn.
function greedyTurn(state) {
  const actions = [];
  const seat = state.current;
  const hand = () => state.players[seat].hand;

  // 1) draw — take the discard only if it strictly lowers deadwood, else deck.
  const top = state.discard[state.discard.length - 1];
  const withDiscard = top ? bestPlay([...hand(), top]).rem : Infinity;
  const withoutDiscard = bestPlay(hand()).rem;
  actions.push({ type: 'draw', src: (top && withDiscard < withoutDiscard) ? 'discard' : 'deck' });
  return actions; // remaining actions computed after the draw resolves (needs new hand)
}

// FNV-1a over a string → stable fingerprint for determinism checks.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function playOneGame(seed) {
  let state = createGame(seed);
  let fingerprint = '';
  let guard = 0;

  while (!state.gameOver) {
    if (++guard > 100000) throw new Error('runaway game — no termination');

    // draw
    ({ state } = applyStep(state, greedyTurn(state)[0], (e) => fingerprint += e));

    if (state.roundOver) { state = advance(state, seed); continue; }

    // lay every combo bestPlay finds, one at a time (state changes each lay)
    let laid = true;
    while (laid && !state.roundOver) {
      laid = false;
      const seat = state.current;
      const { combos } = bestPlay(state.players[seat].hand);
      for (const combo of combos) {
        const ids = combo.map(c => c.id);
        if (!ids.every(id => state.players[seat].hand.some(h => h.id === id))) continue;
        ({ state } = applyStep(state, { type: 'lay', cardIds: ids }, (e) => fingerprint += e));
        laid = true;
        break;
      }
    }

    // add spare cards onto existing table groups where legal
    let added = true;
    while (added && !state.roundOver) {
      added = false;
      const seat = state.current;
      const h = state.players[seat].hand;
      outer:
      for (let gi = 0; gi < state.table.length; gi++) {
        for (const c of h) {
          if (isValidCombo([...state.table[gi].cards, c])) {
            ({ state } = applyStep(state, { type: 'add', groupIdx: gi, cardIds: [c.id] }, (e) => fingerprint += e));
            added = true;
            break outer;
          }
        }
      }
    }

    if (state.roundOver) { state = advance(state, seed); continue; }

    // discard the worst deadwood card (or the only card left)
    const seat = state.current;
    const h = state.players[seat].hand;
    if (h.length > 0) {
      const w = h.length === 1 ? h[0] : worstCard(h);
      ({ state } = applyStep(state, { type: 'discard', cardId: w.id }, (e) => fingerprint += e));
    }

    if (state.roundOver) state = advance(state, seed);
  }

  return { winner: state.winnerSeat, rounds: state.round, fingerprint: fnv1a(fingerprint) };
}

// apply an action, fold its events into the fingerprint accumulator
function applyStep(state, action, feed) {
  const { state: next, events } = applyAction(state, action);
  feed(JSON.stringify(events));
  return { state: next };
}

// round finished but game continues → deal the next round with a fresh sub-seed
function advance(state, gameSeed) {
  if (state.gameOver) return state;
  return startRound(state, (gameSeed * 2654435761 + state.round) >>> 0);
}

// ── CLI ──────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const games = parseInt(arg('games', '1000'), 10);
const baseSeed = parseInt(arg('seed', '1'), 10);

const t0 = performance.now();
const wins = {};
let combinedFp = '';
for (let g = 0; g < games; g++) {
  const r = playOneGame((baseSeed + g) >>> 0);
  wins[r.winner] = (wins[r.winner] || 0) + 1;
  combinedFp += r.fingerprint;
}
const ms = performance.now() - t0;

console.log(`Played ${games} games from seed ${baseSeed} in ${ms.toFixed(0)}ms (${(games / (ms / 1000)).toFixed(0)}/s)`);
console.log('Wins by seat:', wins);
console.log('Run fingerprint:', fnv1a(combinedFp), '  <- identical across runs proves determinism');
