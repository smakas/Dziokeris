// ═══════════════════════════════════════════════════
// ai/policy.js — turn planner for AI seats
//
// planTurn(state) returns the ordered list of actions the CURRENT seat should
// take this turn: [draw, lay*, add*, discard]. It simulates internally (never
// mutating the caller's state) so each action is legal in sequence — the caller
// (browser controller or headless sim) just replays them, adding delays and
// animation as it likes.
//
// This is the greedy baseline, faithful to the original doAI() (dziokeris.html
// lines 694–784). The Phase-2 weight-vector policy will replace the internals of
// the choose* helpers without changing this planTurn contract.
// ═══════════════════════════════════════════════════

import { applyAction, bestPlay } from '../engine/game.js';
import { isValidCombo, worstCard } from '../engine/combos.js';

export function planTurn(state) {
  const actions = [];
  let s = state;
  const seat = s.current;
  const hand = () => s.players[seat].hand;

  // 1) draw — take the discard only if it strictly lowers deadwood, else deck.
  const top = s.discard[s.discard.length - 1];
  const withDiscard = top ? bestPlay([...hand(), top]).rem : Infinity;
  const withoutDiscard = bestPlay(hand()).rem;
  const drawAction = { type: 'draw', src: (top && withDiscard < withoutDiscard) ? 'discard' : 'deck' };
  actions.push(drawAction);
  ({ state: s } = applyAction(s, drawAction));
  if (s.roundOver) return actions; // deck ran out on draw

  // 2) lay every combo bestPlay finds, one at a time
  let laid = true;
  while (laid && !s.roundOver) {
    laid = false;
    const { combos } = bestPlay(s.players[seat].hand);
    for (const combo of combos) {
      const ids = combo.map(c => c.id);
      if (!ids.every(id => s.players[seat].hand.some(h => h.id === id))) continue;
      const a = { type: 'lay', cardIds: ids };
      actions.push(a);
      ({ state: s } = applyAction(s, a));
      laid = true;
      break;
    }
  }

  // 3) add spare cards onto existing table groups where legal
  let added = true;
  while (added && !s.roundOver) {
    added = false;
    const h = s.players[seat].hand;
    outer:
    for (let gi = 0; gi < s.table.length; gi++) {
      for (const c of h) {
        if (isValidCombo([...s.table[gi].cards, c])) {
          const a = { type: 'add', groupIdx: gi, cardIds: [c.id] };
          actions.push(a);
          ({ state: s } = applyAction(s, a));
          added = true;
          break outer;
        }
      }
    }
  }

  if (s.roundOver) return actions; // laid down the whole hand

  // 4) discard the worst deadwood card (or the only card left)
  const h = s.players[seat].hand;
  if (h.length > 0) {
    const w = h.length === 1 ? h[0] : worstCard(h);
    actions.push({ type: 'discard', cardId: w.id });
  }
  return actions;
}

/** Whether taking the current discard-top would help this seat (coach + AI hint). */
export function shouldTakeDiscard(hand, top) {
  return bestPlay([...hand, top]).rem < bestPlay(hand).rem;
}
