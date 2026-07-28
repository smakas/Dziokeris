// ═══════════════════════════════════════════════════
// game.js — the deterministic reducer core (Phase 1 keystone)
//
// A game = a seed + config + an ordered list of actions. Given those, the whole
// game replays identically in the browser, a Cloudflare Worker, or Node. No DOM,
// no network, no storage, no Math.random — randomness enters ONLY at createGame()
// via a seeded RNG, and the shuffled deck is baked into state, so every action
// after that is pure.
//
// applyAction(state, action) -> { state, events }
//   - returns a NEW state (never mutates the input)
//   - events describe what happened, for the UI's animation queue; headless
//     callers ignore them
// ═══════════════════════════════════════════════════

import { buildDeck, shuffle, mulberry32, hpts, cpts } from './cards.js';
import { isValidCombo, sortCombo, bestPlay } from './combos.js';

export const DEFAULT_CONFIG = {
  players: 3,      // 3–5 supported (was hardcoded NP=3)
  deal: 7,         // cards per player
  candyStart: 3,   // starting pot
  target: 100,     // bust threshold
  names: null,     // optional string[]; defaults to Seat 0..N
};

function defaultNames(n) {
  const base = ['Jūs', 'Rytas', 'Vakaras', 'Pietūs', 'Šiaurė'];
  return Array.from({ length: n }, (_, i) => base[i] || `Žaidėjas ${i + 1}`);
}

/** Deep clone of the mutable game state (structuredClone is available in all targets). */
function clone(state) { return structuredClone(state); }

/**
 * Create a fresh game. Deterministic in (seed, config): same inputs → same deck.
 * dealer defaults to seat 0; the first turn is the dealer's.
 */
export function createGame(seed, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const names = cfg.names || defaultNames(cfg.players);
  const rng = mulberry32(seed);

  const deck = shuffle(buildDeck(), rng);
  const players = Array.from({ length: cfg.players }, (_, i) => ({
    name: names[i], hand: [], score: 0, isHuman: i === 0,
  }));
  for (let r = 0; r < cfg.deal; r++) for (const p of players) p.hand.push(deck.pop());

  const discard = [deck.pop()]; // one card face-up to start the pile

  return {
    seed, config: cfg,
    deck, discard, table: [],
    players,
    current: 0, dealer: 0, round: 1,
    candyPot: cfg.candyStart,
    phase: 'draw',        // 'draw' → must draw; 'play' → may lay/add then must discard
    drawnId: null,
    roundOver: false, gameOver: false,
    winnerSeat: -1,
    seq: 0,               // action counter — the authoritative move index
  };
}

/** Filtered view for one seat: never exposes other players' hands. */
export function playerView(state, seat) {
  return {
    seat,
    phase: state.phase,
    current: state.current,
    hand: state.players[seat].hand.map(c => ({ ...c })),
    table: state.table.map(g => ({ owner: g.owner, cards: g.cards.map(c => ({ ...c })) })),
    discard: state.discard.map(c => ({ ...c })),          // full history, face-up
    deckCount: state.deck.length,
    opponents: state.players.map((p, i) => ({
      seat: i, name: p.name, handCount: p.hand.length, score: p.score,
    })),
    scores: state.players.map(p => p.score),
    candyPot: state.candyPot,
    round: state.round,
    roundOver: state.roundOver,
    gameOver: state.gameOver,
    config: state.config,
  };
}

// ── action application ───────────────────────────────

/**
 * Apply one action. Throws on an illegal action (the caller — UI or server —
 * decides how to surface that; the server rejects, the UI never generates one).
 * @returns {{state: object, events: object[]}}
 */
export function applyAction(prev, action) {
  const state = clone(prev);
  const events = [];
  const seat = state.current;
  const p = state.players[seat];

  switch (action.type) {
    case 'draw': {
      requirePhase(state, 'draw');
      if (action.src === 'discard') {
        if (!state.discard.length) throw new Error('discard pile empty');
        const card = state.discard.pop();
        p.hand.push(card);
        state.drawnId = card.id;
        events.push({ type: 'draw', seat, from: 'discard', card });
      } else {
        if (!state.deck.length) { endRound(state, events, -1); break; } // malka baigėsi
        const card = state.deck.pop();
        p.hand.push(card);
        state.drawnId = card.id;
        events.push({ type: 'draw', seat, from: 'deck', card });
      }
      state.phase = 'play';
      break;
    }

    case 'lay': {
      requirePhase(state, 'play');
      const cards = takeFromHand(p, action.cardIds);
      if (!isValidCombo(cards)) throw new Error('not a valid combination');
      state.table.push({ owner: seat, cards: sortCombo(cards) });
      events.push({ type: 'lay', seat, cards });
      checkLayDownWin(state, events, seat);
      break;
    }

    case 'add': {
      requirePhase(state, 'play');
      const g = state.table[action.groupIdx];
      if (!g) throw new Error('no such table group');
      const cards = takeFromHand(p, action.cardIds);
      const merged = [...g.cards, ...cards];
      if (!isValidCombo(merged)) { p.hand.push(...cards); throw new Error('addition would be invalid'); }
      g.cards = sortCombo(merged);
      events.push({ type: 'add', seat, groupIdx: action.groupIdx, cards });
      checkLayDownWin(state, events, seat);
      break;
    }

    case 'rearrange': {
      // Commit a whole proposed table layout at once. This is how the UI's
      // free-form drafting (drag cards between groups, form/merge/split combos,
      // pull cards from hand onto the table) reaches the engine: one validated
      // action carrying the final table. Cheat-proof because every resulting
      // group must be a valid combo and no table card may return to a hand.
      requirePhase(state, 'play');
      const groups = action.groups || [];
      const handIds = new Set(p.hand.map(c => c.id));
      const tableIds = new Set(state.table.flatMap(g => g.cards.map(c => c.id)));
      const byId = new Map();
      for (const g of state.table) for (const c of g.cards) byId.set(c.id, c);
      for (const c of p.hand) byId.set(c.id, c);

      const usedFromHand = [];
      const seen = new Set();
      const newTable = [];
      for (const grp of groups) {
        const cards = [];
        for (const id of grp.ids) {
          if (seen.has(id)) throw new Error('card used twice in rearrange');
          seen.add(id);
          const card = byId.get(id);
          if (!card) throw new Error('rearrange references unknown card ' + id);
          if (handIds.has(id)) usedFromHand.push(id);
          cards.push(card);
        }
        if (!isValidCombo(cards)) throw new Error('rearrange produced an invalid group');
        newTable.push({ owner: grp.owner ?? seat, cards: sortCombo(cards) });
      }
      // No card currently on the table may vanish (can't take table cards to hand).
      for (const id of tableIds) if (!seen.has(id)) throw new Error('rearrange dropped a table card');

      const usedSet = new Set(usedFromHand);
      p.hand = p.hand.filter(c => !usedSet.has(c.id));
      state.table = newTable;
      events.push({ type: 'rearrange', seat, groups: newTable.map(g => g.cards.map(c => c.id)) });
      checkLayDownWin(state, events, seat);
      break;
    }

    case 'discard': {
      requirePhase(state, 'play');
      if (state.table.some(g => !isValidCombo(g.cards))) throw new Error('invalid group on table');
      const idx = p.hand.findIndex(c => c.id === action.cardId);
      if (idx < 0) throw new Error('card not in hand');
      const card = p.hand.splice(idx, 1)[0];
      state.discard.push(card);
      state.drawnId = null;
      events.push({ type: 'discard', seat, card });
      if (p.hand.length === 0) { endRound(state, events, seat); break; }
      nextTurn(state, events);
      break;
    }

    default:
      throw new Error('unknown action type: ' + action.type);
  }

  state.seq = prev.seq + 1;
  return { state, events };
}

function requirePhase(state, phase) {
  if (state.roundOver) throw new Error('round is over');
  if (state.phase !== phase) throw new Error(`expected phase ${phase}, in ${state.phase}`);
}

function takeFromHand(p, cardIds) {
  const ids = new Set(cardIds);
  const cards = p.hand.filter(c => ids.has(c.id));
  if (cards.length !== cardIds.length) throw new Error('card(s) not in hand');
  p.hand = p.hand.filter(c => !ids.has(c.id));
  return cards;
}

// Variant 2 turn flow is draw → lay/add → discard, so the round normally closes
// on the final discard. The one exception in the rules: a player who lays ALL
// their cards has "nothing to discard" and closes the round immediately. That is
// exactly the empty-hand case, handled here so the rule lives in one place.
function checkLayDownWin(state, events, seat) {
  if (state.players[seat].hand.length === 0) endRound(state, events, seat);
}

function nextTurn(state, events) {
  state.current = (state.current + 1) % state.players.length;
  state.phase = 'draw';
  state.drawnId = null;
  events.push({ type: 'turn', seat: state.current });
}

/**
 * End the round, score every player, apply the 100+ bust/reset rule, and decide
 * whether the game is over. Extracted from dziokeris.html endRound (lines 789–847).
 */
function endRound(state, events, winnerSeat) {
  state.roundOver = true;
  state.winnerSeat = winnerSeat;

  const results = state.players.map((pl, i) => ({ i, pts: hpts(pl.hand) }));
  for (const r of results) state.players[r.i].score += r.pts;

  // 100+ : pay a candy, score resets to the next-highest player's score.
  for (const r of results) {
    const pl = state.players[r.i];
    if (pl.score >= state.config.target) {
      const others = results.filter(x => x.i !== r.i).map(x => state.players[x.i].score);
      pl.score = others.length ? Math.max(...others) : pl.score;
      state.candyPot++;
    }
  }

  events.push({ type: 'roundEnd', winnerSeat, scores: state.players.map(p => p.score) });

  const under = state.players.map((p, i) => ({ i, s: p.score })).filter(x => x.s < state.config.target);
  if (under.length <= 1) {
    state.gameOver = true;
    const champ = under.length === 1
      ? under[0].i
      : state.players.reduce((a, b, i) => (b.score < state.players[a].score ? i : a), 0);
    state.winnerSeat = champ;
    events.push({ type: 'gameEnd', winnerSeat: champ, candyPot: state.candyPot });
  }
}

/** Advance to the next round: reshuffle from seed-derived stream, rotate dealer. */
export function startRound(state, roundSeed) {
  const next = clone(state);
  const rng = mulberry32(roundSeed);
  next.deck = shuffle(buildDeck(), rng);
  next.discard = [];
  next.table = [];
  for (const p of next.players) p.hand = [];
  for (let r = 0; r < next.config.deal; r++) for (const p of next.players) p.hand.push(next.deck.pop());
  next.discard.push(next.deck.pop());
  next.round += 1;
  next.dealer = (next.dealer + 1) % next.players.length;
  next.current = next.dealer;
  next.phase = 'draw';
  next.drawnId = null;
  next.roundOver = false;
  next.winnerSeat = -1;
  return next;
}

export { hpts, cpts, bestPlay };
