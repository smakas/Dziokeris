// ═══════════════════════════════════════════════════
// ui/app.js — browser controller (Phase 1)
//
// Wires the pure engine to the DOM. The engine (state) is authoritative between
// committed moves. During the human's play phase we keep a local `work` draft of
// hand+table so the player can drag freely (invalid groups glow red) exactly as
// before; at discard the draft is committed to the engine as one `rearrange`
// action + a `discard`, so the move is validated and replayable.
//
// AI seats are driven by planTurn() from ai/policy.js, replayed with animation.
// ═══════════════════════════════════════════════════

import { createGame, applyAction, startRound, hpts, cpts } from '../engine/game.js';
import { isValidCombo, sortCombo } from '../engine/combos.js';
import { suitCls, clbl } from '../engine/cards.js';
import { planTurn, shouldTakeDiscard } from '../ai/policy.js';
import { bestPlay } from '../engine/game.js';
import { worstCard } from '../engine/combos.js';

// ── module state ─────────────────────────────────────
let state;                 // authoritative engine state
let work = null;           // human draft {hand:[], table:[]} during own play phase
let UI = freshUI();
let SPEED = 'human';       // 'human' | 'fast'
let WINS = 0;
let baseSeed = 1;          // per-game seed
let gameLog = [];
let undoStack = [];
let dealing = false;
let aiTimer = null;
let aiSkip = false;

// cloud sync (offline-first: every fetch is best-effort, failures are ignored)
let gameId = null;
let roundHistory = [];
let roundStartScores = [];
const PLAYER = {
  id: localStorage.getItem('dz_player_id') || (() => { const id = (crypto.randomUUID && crypto.randomUUID()) || ('p' + Date.now() + Math.random()); localStorage.setItem('dz_player_id', id); return id; })(),
  name: localStorage.getItem('dz_player_name') || 'Jūs',
};
function seatPlayerId(seat) { return seat === 0 ? PLAYER.id : 'ai:' + state.players[seat].name; }

// Random Lithuanian first names for the AI seats (mixed).
const AI_NAMES = ['Gintaras', 'Rūta', 'Mindaugas', 'Aistė', 'Tomas', 'Eglė', 'Darius', 'Milda',
  'Rokas', 'Ieva', 'Kęstutis', 'Gabija', 'Vytautas', 'Austėja', 'Matas', 'Kotryna', 'Lukas',
  'Dovilė', 'Paulius', 'Greta', 'Andrius', 'Rasa', 'Marius', 'Simona', 'Julius', 'Neringa'];
function pickAiNames(n, avoid) {
  const pool = AI_NAMES.filter(x => x.toLowerCase() !== String(avoid || '').toLowerCase());
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

function freshUI() {
  return { handSel: [], comboTgt: -1, handOrder: [], glowIds: new Set(), handStartIds: new Set() };
}
const clone = x => structuredClone(x);

// ── current-view helpers (draft when it's the human's turn) ──────────────────
function humanPlay() { return state.current === 0 && state.phase === 'play' && !state.roundOver && work; }
function curHand() { return humanPlay() ? work.hand : state.players[0].hand; }
function curTable() { return humanPlay() ? work.table : state.table; }

// ═══════════════════════════════════════════════════
// GAME LIFECYCLE
// ═══════════════════════════════════════════════════
function newGame() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  aiSkip = false;
  baseSeed = (Math.floor(Math.random() * 2 ** 31)) >>> 0; // one random seed per game; game itself is then deterministic
  state = createGame(baseSeed, { players: 4, deal: 7, names: [PLAYER.name, ...pickAiNames(3, PLAYER.name)] });
  // Deal is done inside createGame; re-deal here visually by resetting hands to empty for the animation.
  work = null; UI = freshUI(); undoStack = []; gameLog = [];
  gameId = (crypto.randomUUID && crypto.randomUUID()) || ('g' + Date.now());
  roundHistory = []; roundStartScores = state.players.map(p => p.score);
  clearToasts();
  UI.handOrder = state.players[0].hand.map(c => c.id);
  togglePanes(false);
  coach('info', `🎴 Ratas ${state.round} — dalija ${state.players[state.dealer].name}`);
  renderAll();
  startTurn();
}

function startNextRound() {
  state = startRound(state, (baseSeed * 2654435761 + state.round) >>> 0);
  work = null; UI = freshUI(); undoStack = [];
  roundStartScores = state.players.map(p => p.score);
  UI.handOrder = state.players[0].hand.map(c => c.id);
  togglePanes(false);
  coach('info', `🎴 Ratas ${state.round} — dalija ${state.players[state.dealer].name}`);
  renderAll();
  startTurn();
}

// Begin whichever seat's turn it now is.
function startTurn() {
  if (state.gameOver || state.roundOver) return;
  if (state.current === 0) {
    work = null; // human draws first; draft created after draw
    renderAll();
  } else {
    scheduleAI();
  }
}

// ═══════════════════════════════════════════════════
// HUMAN ACTIONS
// ═══════════════════════════════════════════════════
function pushUndo() {
  undoStack.push({
    state: clone(state), work: work ? clone(work) : null,
    handSel: [...UI.handSel], comboTgt: UI.comboTgt, handOrder: [...UI.handOrder],
    glowIds: new Set(UI.glowIds), handStartIds: new Set(UI.handStartIds),
  });
  if (undoStack.length > 40) undoStack.shift();
}

function undoLast() {
  if (state.current !== 0 || state.roundOver || dealing) return;
  if (!undoStack.length) return;
  const s = undoStack.pop();
  state = s.state; work = s.work;
  UI.handSel = s.handSel; UI.comboTgt = s.comboTgt; UI.handOrder = s.handOrder;
  UI.glowIds = s.glowIds; UI.handStartIds = s.handStartIds;
  coach('info', '↩ Ėjimas atšauktas.');
  renderAll();
}

function playerDraw(src) {
  if (state.current !== 0 || state.phase !== 'draw' || state.roundOver || dealing) return;
  const top = state.discard[state.discard.length - 1];
  if (src === 'discard' && !state.discard.length) return;
  if (src === 'deck' && !state.deck.length) return;

  // coach note before drawing from deck
  if (src === 'deck' && top && shouldTakeDiscard(state.players[0].hand, top)) {
    coach('tip', `Atversta ${clbl(top)} galėjo padėti — ji sumažintų akis.`);
  }
  pushUndo();
  const fromEl = src === 'deck' ? document.getElementById('deck-el') : document.getElementById('disc-el');
  const drawn = top && src === 'discard' ? top : state.deck[state.deck.length - 1];
  ({ state } = applyAction(state, { type: 'draw', src }));
  // open the human draft now
  work = { hand: clone(state.players[0].hand), table: clone(state.table) };
  UI.handStartIds = new Set(state.players[0].hand.map(c => c.id));
  UI.handOrder = reconcileOrder(UI.handOrder, work.hand);
  const drawnCard = state.players[0].hand.find(c => c.id === state.drawnId);
  animFly(fromEl, document.getElementById('hand-wrap'), drawnCard, true, () => renderAll());
  coach('info', `Paėmėte: ${clbl(drawnCard)}${src === 'discard' ? ' (atversta)' : ''}`);
  addLog('Jūs', 'draw', `Paėmė: ${clbl(drawnCard)}${src === 'discard' ? ' (atversta)' : ''}`);
  renderAll();
}

function getSelCards() {
  const ids = new Set(UI.handSel);
  return curHand().filter(c => ids.has(c.id));
}

function doLay() {
  if (!humanPlay()) return;
  const sel = getSelCards();
  if (sel.length < 3) { coach('warn', 'Pasirinkite bent 3 kortas.'); return; }
  if (!isValidCombo(sel)) { coach('warn', 'Pasirinktos kortos nesudaro kombinacijos.'); return; }
  pushUndo();
  const ids = new Set(sel.map(c => c.id));
  work.hand = work.hand.filter(c => !ids.has(c.id));
  work.table.push({ owner: 0, cards: [...sel] });
  sel.forEach(c => UI.glowIds.add(c.id));
  UI.handSel = []; UI.comboTgt = -1;
  trackCombo(sel);
  addLog('Jūs', 'lay', `Padėjo: ${sel.map(clbl).join(' ')}`);
  coach('good', `Padėjote: ${sel.map(clbl).join(' ')}`);
  if (!checkDraftWin()) renderAll();
}

function doAdd() {
  if (!humanPlay()) return;
  if (UI.comboTgt < 0 || !work.table[UI.comboTgt]) { coach('warn', 'Pirmiau pažymėkite kombinaciją ant stalo.'); return; }
  const sel = getSelCards();
  if (!sel.length) { coach('warn', 'Pasirinkite kortą.'); return; }
  const g = work.table[UI.comboTgt];
  if (!isValidCombo([...g.cards, ...sel])) { coach('warn', 'Kombinacija taptų negaliojanti.'); return; }
  pushUndo();
  const ids = new Set(sel.map(c => c.id));
  work.hand = work.hand.filter(c => !ids.has(c.id));
  g.cards.push(...sel);
  sel.forEach(c => UI.glowIds.add(c.id));
  UI.handSel = [];
  addLog('Jūs', 'add', `Pridėjo: ${sel.map(clbl).join(' ')}`);
  coach('good', 'Korta pridėta.');
  if (!checkDraftWin()) renderAll();
}

// A card the human placed on the table this turn (from their hand) may return.
function stageCard(gi, cardId) {
  if (!humanPlay()) return;
  const g = work.table[gi]; if (!g) return;
  if (!UI.handStartIds.has(cardId)) {
    coach('warn', 'Šios kortos grąžinti negalima — ji jau buvo ant stalo.'); return;
  }
  const idx = g.cards.findIndex(c => c.id === cardId); if (idx < 0) return;
  pushUndo();
  const card = g.cards.splice(idx, 1)[0];
  if (g.cards.length === 0) work.table.splice(gi, 1);
  work.hand.push(card);
  if (!UI.handOrder.includes(card.id)) UI.handOrder.push(card.id);
  UI.glowIds.delete(card.id);
  coach('info', `${clbl(card)} grąžinta į ranką.`);
  renderAll();
}

function selectCombo(gi) {
  if (state.current !== 0 || state.roundOver) return;
  UI.comboTgt = UI.comboTgt === gi ? -1 : gi;
  renderAll();
}

function toggleHandSel(id) {
  if (state.current !== 0 || state.phase === 'draw' || state.roundOver) return;
  const i = UI.handSel.indexOf(id);
  if (i >= 0) UI.handSel.splice(i, 1); else UI.handSel.push(id);
  renderAll();
}

// If the draft leaves the hand empty and the table all valid → lay-down win.
function checkDraftWin() {
  if (work.hand.length === 0 && work.table.every(g => isValidCombo(g.cards))) {
    commitDraft();
    if (state.roundOver) { finishRound(); return true; }
  }
  return false;
}

// Push the human draft into the engine as one rearrange (validated).
function commitDraft() {
  const groups = work.table.map(g => ({ owner: g.owner, ids: g.cards.map(c => c.id) }));
  ({ state } = applyAction(state, { type: 'rearrange', groups }));
}

function doDiscard() {
  if (!humanPlay()) return;
  if (work.table.some(g => g.cards.length > 0 && !isValidCombo(g.cards))) {
    coach('warn', 'Ant stalo yra negaliojančių kombinacijų! Pataisykite prieš išmesdami.'); return;
  }
  if (UI.handSel.length !== 1) { coach('warn', 'Pasirinkite lygiai vieną kortą.'); return; }
  const discId = UI.handSel[0];
  if (!work.hand.some(c => c.id === discId)) { coach('warn', 'Pasirinkite kortą iš rankos.'); return; }

  const card = work.hand.find(c => c.id === discId);
  evalDiscard(card);
  pushUndo();
  commitDraft();
  const fromEl = document.getElementById('hand-wrap');
  ({ state } = applyAction(state, { type: 'discard', cardId: discId }));
  work = null; UI.handSel = []; UI.comboTgt = -1; UI.glowIds = new Set();
  addLog('Jūs', 'disc', `Išmetė: ${clbl(card)}`);
  animFly(fromEl, document.getElementById('disc-wrap'), card, true, null);
  renderAll();
  if (state.roundOver) { finishRound(); return; }
  aiTimer = setTimeout(() => startTurn(), 250);
}

// ═══════════════════════════════════════════════════
// AI TURNS
// ═══════════════════════════════════════════════════
function scheduleAI() {
  if (state.gameOver || state.roundOver) return;
  aiSkip = false;
  document.getElementById('skip-btn').classList.add('show');
  const delay = SPEED === 'fast' ? 350 : 900 + Math.random() * 900;
  aiTimer = setTimeout(runAI, delay);
}

async function runAI() {
  if (state.roundOver || state.current === 0) return;
  const pi = state.current;
  const plan = planTurn(state);
  for (const action of plan) {
    if (aiSkip) { applyPlanRest(plan, plan.indexOf(action)); break; }
    setAIStatus(pi, aiStatusFor(action));
    await wait(SPEED === 'fast' ? 180 : 380 + Math.random() * 260);
    const before = state;
    ({ state } = applyAction(state, action));
    animateAI(pi, action, before);
    logAI(pi, action);
    renderAll();
    if (state.roundOver) break;
  }
  setAIStatus(pi, '');
  document.getElementById('skip-btn').classList.remove('show');
  renderAll();
  if (state.roundOver) { finishRound(); return; }
  startTurn();
}

// apply the remainder instantly when the user hits Skip
function applyPlanRest(plan, fromIdx) {
  for (let i = fromIdx; i < plan.length; i++) {
    if (state.roundOver) break;
    ({ state } = applyAction(state, plan[i]));
    logAI(state.current, plan[i]);
  }
}

function aiStatusFor(a) {
  return a.type === 'draw' ? 'Ima kortą...' : a.type === 'lay' ? 'Dėlioja kombinaciją...'
    : a.type === 'add' ? 'Prideda kortą...' : a.type === 'discard' ? 'Išmeta kortą...' : '...';
}
function blinkPile(cardId) {
  const el = document.getElementById(cardId); if (!el) return;
  el.classList.remove('blink'); void el.offsetWidth; el.classList.add('blink');
  setTimeout(() => el.classList.remove('blink'), 700);
}
function animateAI(pi, action, before) {
  const panel = document.getElementById(`opp${pi - 1}p`);
  if (action.type === 'draw') {
    const src = action.src === 'discard' ? 'disc-wrap' : 'deck-wrap';
    const card = state.players[pi].hand[state.players[pi].hand.length - 1];
    blinkPile(action.src === 'discard' ? 'disc-el' : 'deck-el'); // flag which pile the card is taken from
    animFly(document.getElementById(src), panel, card, action.src === 'discard', null);
  } else if (action.type === 'discard') {
    const card = state.discard[state.discard.length - 1];
    animFly(panel, document.getElementById('disc-wrap'), card, true, null);
  }
}
function logAI(pi, a) {
  const name = state.players[pi].name;
  if (a.type === 'draw') {
    const card = state.players[pi].hand[state.players[pi].hand.length - 1];
    addLog(name, 'draw', a.src === 'discard' ? `Paėmė ${clbl(card)} (atversta)` : 'Paėmė iš malkos');
  }
  else if (a.type === 'lay') addLog(name, 'lay', 'Padėjo kombinaciją');
  else if (a.type === 'add') addLog(name, 'add', 'Pridėjo kortą');
  else if (a.type === 'discard') addLog(name, 'disc', `Išmetė: ${clbl(state.discard[state.discard.length - 1])}`);
}
function skipAI() { aiSkip = true; }
function setAIStatus(pi, msg) { const el = document.getElementById(`opp${pi - 1}status`); if (el) el.textContent = msg; }

// ═══════════════════════════════════════════════════
// ROUND / GAME END
// ═══════════════════════════════════════════════════
function finishRound() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  document.getElementById('skip-btn').classList.remove('show');
  renderAll();
  // capture this round's per-seat scores for trend tracking
  for (let seat = 0; seat < state.players.length; seat++) {
    roundHistory.push({
      roundNo: state.round, seat, playerId: seatPlayerId(seat),
      deadwood: Math.max(0, state.players[seat].score - (roundStartScores[seat] || 0)),
      running: state.players[seat].score,
    });
  }
  if (state.gameOver) {
    postGameResult();
    const champ = state.players[state.winnerSeat];
    if (champ.isHuman) { WINS++; document.getElementById('wins-lbl').textContent = `🏆 ${WINS}`; }
  }
  // Non-intrusive: board + revealed hands stay on screen; stats go to the right column.
  setTimeout(showResultPanel, 600);
}

// Right-column round/game summary: per-player gain this round + running total, candy pot.
function showResultPanel() {
  const rp = document.getElementById('result-pane');
  const closer = state.winnerSeat >= 0 && !state.gameOver ? state.players[state.winnerSeat].name : null;
  const champ = state.gameOver ? state.players[state.winnerSeat] : null;
  const rows = state.players.map((p, i) => {
    const gain = hpts(p.hand);                 // uncombined points added this round
    const danger = p.score >= 80;
    const win = !state.gameOver && i === state.winnerSeat;
    return `<div class="rp-row ${win ? 'rp-winner' : ''} ${danger ? 'rp-danger' : ''}">
      <span class="rp-name">${win ? '🏆 ' : ''}${p.name}</span>
      <span class="rp-gain ${gain === 0 ? 'rp-zero' : ''}">+${gain}</span>
      <span class="rp-total">${p.score}</span>
    </div>`;
  }).join('');
  const title = state.gameOver ? '🎉 Žaidimas baigtas!' : 'Ratas baigtas';
  const sub = state.gameOver ? `Laimi ${champ.name} — surenka ${state.candyPot} 🍬`
    : (closer ? `Ratą uždarė: ${closer}` : '');
  rp.innerHTML = `
    <div class="rp-title">${title}</div>
    <div class="rp-sub">${sub}</div>
    <div style="display:flex;font-size:0.58rem;color:#aaa;padding:0 7px 3px;justify-content:space-between">
      <span>Žaidėjas</span><span>+ratas · iš viso</span></div>
    ${rows}
    <div class="rp-candy">🍬 Bankas: ${state.candyPot}</div>
    <button class="rp-btn" id="rp-continue">${state.gameOver ? 'Naujas žaidimas' : 'Kitas ratas ▶'}</button>`;
  document.getElementById('rp-continue').onclick = () => {
    if (state.gameOver) newGame(); else startNextRound();
  };
  togglePanes(true);
}

// Show the result pane (round end) or restore the coach/log tabs (during play).
function togglePanes(showResult) {
  document.getElementById('result-pane').style.display = showResult ? 'flex' : 'none';
  document.getElementById('tabs-row').style.display = showResult ? 'none' : 'flex';
  if (showResult) {
    document.getElementById('coach-pane').style.display = 'none';
    document.getElementById('log-pane').style.display = 'none';
  } else {
    switchTab('coach');
  }
}

// ═══════════════════════════════════════════════════
// HAND REORDER DRAG
// ═══════════════════════════════════════════════════
let _dragId = null, _dragging = false;
function handDragStart(e, id) { _dragId = id; _dragging = true; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'h'); }
function handDragOver(e, id) { e.preventDefault(); const el = document.querySelector(`[data-cid="${id}"]`); if (el && id !== _dragId) el.classList.add('drag-over'); }
function handDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function handDrop(e, targetId) {
  e.preventDefault();
  if (_dragId === null || _dragId === targetId) return;
  const order = UI.handOrder;
  const si = order.indexOf(_dragId), ti = order.indexOf(targetId);
  if (si < 0 || ti < 0) return;
  // Insert before or after the target based on which half of it the pointer is
  // over — deterministic in both directions. Index is recomputed AFTER removing
  // the dragged id so the earlier splice can't shift it (the old left→right bug).
  const rect = e.currentTarget.getBoundingClientRect();
  const after = (e.clientX - rect.left) > rect.width / 2;
  order.splice(si, 1);
  order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, _dragId);
  renderHand();
}
function handDragEnd() { _dragId = null; setTimeout(() => _dragging = false, 30); document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); }

// ═══════════════════════════════════════════════════
// TABLE DRAG (free rearrange on the draft)
// ═══════════════════════════════════════════════════
let _tgi = -1, _tcid = null, _tTgt = null;
function tDragStart(e, gi, cardId) { _tgi = gi; _tcid = cardId; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 't'); }
function tDragOver(e, gi) { e.preventDefault(); e.stopPropagation(); document.querySelectorAll('.combo-grp').forEach(el => el.classList.remove('drag-tgt')); const el = document.querySelector(`[data-gi="${gi}"]`); if (el) el.classList.add('drag-tgt'); }
function tComboCardDragOver(gi, cid) { _tTgt = cid; }
function tDragOverNew(e) { e.preventDefault(); const z = document.getElementById('new-combo-zone'); if (z) z.classList.add('drag-tgt'); }
function tDragEnd() { _tgi = -1; _tcid = null; _tTgt = null; document.querySelectorAll('.combo-grp,.tdragging').forEach(el => el.classList.remove('drag-tgt', 'tdragging')); renderAll(); }

function tDrop(e, gi) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.combo-grp').forEach(el => el.classList.remove('drag-tgt'));
  if (!humanPlay() || _tgi < 0 || _tcid === null) { tDragEnd(); return; }
  const src = work.table[_tgi]; if (!src) { tDragEnd(); return; }
  const idx = src.cards.findIndex(c => c.id === _tcid); if (idx < 0) { tDragEnd(); return; }
  pushUndo();
  if (_tgi === gi) { // intra-group reorder
    const card = src.cards.splice(idx, 1)[0];
    const ti = _tTgt !== null ? src.cards.findIndex(c => c.id === _tTgt) : -1;
    if (ti >= 0) src.cards.splice(ti, 0, card); else src.cards.push(card);
  } else {
    const card = src.cards.splice(idx, 1)[0];
    if (src.cards.length === 0) { work.table.splice(_tgi, 1); if (gi > _tgi) gi--; }
    if (gi >= 0 && gi < work.table.length) work.table[gi].cards.push(card);
  }
  tDragEnd();
}
function tDropNew(e) {
  e.preventDefault(); e.stopPropagation();
  const z = document.getElementById('new-combo-zone'); if (z) z.classList.remove('drag-tgt');
  if (!humanPlay()) { tDragEnd(); return; }
  if (_tgi >= 0 && _tcid !== null) { // table card → new group
    const src = work.table[_tgi]; if (!src) return tDragEnd();
    const idx = src.cards.findIndex(c => c.id === _tcid); if (idx < 0) return tDragEnd();
    pushUndo();
    const card = src.cards.splice(idx, 1)[0];
    if (src.cards.length === 0) work.table.splice(work.table.indexOf(src), 1);
    work.table.push({ owner: 0, cards: [card] });
    return tDragEnd();
  }
  if (_dragId !== null) { // hand card → new group
    const card = work.hand.find(c => c.id === _dragId); if (!card) return tDragEnd();
    pushUndo();
    work.hand = work.hand.filter(c => c.id !== _dragId);
    UI.handSel = UI.handSel.filter(id => id !== card.id);
    work.table.push({ owner: 0, cards: [card] });
    _dragId = null; _dragging = false;
    return tDragEnd();
  }
  tDragEnd();
}
function tDropFromHand(e, gi) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.combo-grp').forEach(el => el.classList.remove('drag-tgt'));
  if (!humanPlay()) return tDragEnd();
  if (_tgi >= 0) return tDrop(e, gi);
  if (_dragId !== null) {
    const card = work.hand.find(c => c.id === _dragId);
    if (card && work.table[gi]) {
      pushUndo();
      work.hand = work.hand.filter(c => c.id !== _dragId);
      UI.handSel = UI.handSel.filter(id => id !== card.id);
      work.table[gi].cards.push(card);
      _dragId = null; _dragging = false;
      if (!checkDraftWin()) renderAll();
    }
  }
}

// ═══════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════
function renderAll() { renderHeader(); renderPiles(); renderTable(); renderHand(); renderOpponents(); renderCtrl(); updateTurnBanner(); }

function renderHeader() {
  document.getElementById('score-bar').innerHTML = state.players.map((p, i) =>
    `<div class="se ${p.score >= 80 ? 'danger' : ''} ${i === state.current ? 'active-p' : ''}">
      <div class="sn">${p.name}${i === state.current ? ' ▶' : ''}</div><div class="sv">${p.score}</div></div>`).join('');
  document.getElementById('candy-lbl').textContent = `🍬 ${state.candyPot}`;
  document.getElementById('round-lbl').innerHTML = `Ratas: ${state.round}<br>Dalija: ${state.players[state.dealer].name}`;
}

function renderPiles() {
  document.getElementById('deck-ct').textContent = `(${state.deck.length})`;
  const top = state.discard[state.discard.length - 1], prev = state.discard[state.discard.length - 2];
  const el = document.getElementById('disc-el'), prevEl = document.getElementById('disc-prev');
  if (top) { el.innerHTML = cHTML(top); el.className = 'card ' + suitCls(top); }
  else { el.innerHTML = '<span style="color:#ddd">—</span>'; el.className = 'card'; }
  if (prevEl) { if (prev) { prevEl.innerHTML = cHTML(prev); prevEl.className = 'card ' + suitCls(prev); prevEl.style.display = ''; } else prevEl.style.display = 'none'; }
  const myDraw = state.current === 0 && state.phase === 'draw' && !state.roundOver;
  document.getElementById('deck-wrap').classList.toggle('active-pile', myDraw && state.deck.length > 0);
  document.getElementById('disc-wrap').classList.toggle('active-pile', myDraw && state.discard.length > 0);
  document.getElementById('deck-wrap').classList.toggle('live', myDraw);
  document.getElementById('disc-wrap').classList.toggle('live', myDraw);
}

function renderTable() {
  const row = document.getElementById('combos-row');
  const myPlay = humanPlay();
  const table = curTable();
  let nz = document.getElementById('new-combo-zone');
  if (!table.length) {
    row.innerHTML = '<span style="color:#ccc;font-size:0.75rem">Kombinacijų nėra</span>';
    if (nz) nz.style.display = myPlay ? 'flex' : 'none';
  } else {
    const anyInvalid = myPlay && table.some(x => x.cards.length > 0 && !isValidCombo(x.cards));
    row.innerHTML = table.map((g, gi) => {
      const owner = state.players[g.owner]?.name || '';
      const invalid = g.cards.length > 0 && !isValidCombo(g.cards);
      const valid = myPlay && anyInvalid && !invalid && g.cards.length >= 3;
      const isTgt = UI.comboTgt === gi;
      // Display valid combos in true sequence (jokers in their real slot); leave
      // invalid/incomplete groups in raw order so mid-arrangement doesn't jump around.
      const disp = !invalid && g.cards.length >= 3 ? sortCombo(g.cards) : g.cards;
      return `<div class="combo-grp ${invalid ? 'invalid-grp' : ''} ${valid ? 'valid-grp' : ''} ${isTgt ? 'target' : ''}"
          data-gi="${gi}" onclick="selectCombo(${gi})" ondragover="tDragOver(event,${gi})"
          ondrop="tDropFromHand(event,${gi})" ondragleave="event.currentTarget.classList.remove('drag-tgt')">
        <span class="owner-tag">${owner}${invalid ? ' ⚠' : ''}</span>
        ${disp.map(c => `<div class="card ${suitCls(c)} ${myPlay ? 'stageable' : ''} ${UI.glowIds.has(c.id) ? 'glow-new' : ''}"
            data-tgi="${gi}" data-tcid="${c.id}" draggable="${myPlay ? 'true' : 'false'}"
            ondragstart="${myPlay ? `tDragStart(event,${gi},${c.id})` : ''}" ondragend="${myPlay ? 'tDragEnd()' : ''}"
            ondragover="${myPlay ? `event.preventDefault();tComboCardDragOver(${gi},${c.id})` : ''}"
            onclick="${myPlay ? `event.stopPropagation();stageCard(${gi},${c.id})` : ''}"
            title="${clbl(c)} — ${cpts(c)} ak." style="width:43px;height:61px;font-size:0.78rem">${cHTMLsm(c)}</div>`).join('')}
      </div>`;
    }).join('');
  }
  if (!nz) { nz = document.createElement('div'); nz.id = 'new-combo-zone'; row.parentNode.appendChild(nz); }
  nz.style.display = myPlay ? 'flex' : 'none'; nz.textContent = '+';
  nz.ondragover = tDragOverNew; nz.ondrop = tDropNew; nz.ondragleave = () => nz.classList.remove('drag-tgt');
}

function renderHand() {
  const hand = curHand();
  const sorted = sortedHand(hand);
  const selIds = new Set(UI.handSel);
  const canPlay = state.current === 0 && state.phase !== 'draw' && !state.roundOver;
  document.getElementById('hand-cards').innerHTML = sorted.map(c => {
    const isNew = c.id === state.drawnId;
    return `<div class="card clickable ${selIds.has(c.id) ? 'sel' : ''} ${isNew ? 'new-c' : ''} ${suitCls(c)}"
        data-cid="${c.id}" draggable="true" ondragstart="handDragStart(event,${c.id})" ondragover="handDragOver(event,${c.id})"
        ondrop="handDrop(event,${c.id})" ondragend="handDragEnd()" ondragleave="handDragLeave(event)"
        onclick="if(!window._dragging)toggleHandSel(${c.id})" title="${cpts(c)} ak.${isNew ? ' — nauja' : ''}">${cHTML(c)}</div>`;
  }).join('');
  const pts = hpts(hand);
  const b = document.getElementById('hand-pts'); b.textContent = `${pts} ak.`; b.className = 'pts-badge' + (pts >= 80 ? ' hot' : '');
}

function renderOpponents() {
  const reveal = state.roundOver; // at round end, flip opponents' remaining cards face-up
  for (let i = 1; i < state.players.length && i <= 3; i++) {
    const p = state.players[i], oi = i - 1;
    document.getElementById(`opp${oi}n`).textContent = p.name;
    document.getElementById(`opp${oi}c`).textContent = reveal ? `${hpts(p.hand)} ak.` : `${p.hand.length} k.`;
    document.getElementById(`opp${oi}h`).innerHTML = reveal
      ? p.hand.map(c => `<div class="card ${suitCls(c)}" style="width:36px;height:50px;font-size:0.62rem" title="${clbl(c)} — ${cpts(c)} ak.">${cHTMLsm(c)}</div>`).join('')
      : p.hand.map(() => '<div class="card back" style="width:26px;height:37px;border-radius:4px;flex-shrink:0"></div>').join('');
    // Opponent laid combos are shown on the shared table (Stalas) — no duplicate strip here.
    const cb = document.getElementById(`opp${oi}cb`); if (cb) cb.innerHTML = '';
    const op = document.getElementById(`opp${oi}p`);
    op.style.borderColor = state.current === i ? '#f90' : ''; op.style.boxShadow = state.current === i ? '0 0 0 2px #f902' : '';
  }
}

function renderCtrl() {
  const handIds = new Set(curHand().map(c => c.id));
  UI.handSel = UI.handSel.filter(id => handIds.has(id));
  const myTurn = state.current === 0 && !state.roundOver;
  const play = myTurn && state.phase === 'play' && !!work;
  const sel = getSelCards();
  const hasCombo = sel.length >= 3 && isValidCombo(sel);
  const tgt = UI.comboTgt >= 0 && curTable()[UI.comboTgt];
  const canAdd = play && sel.length > 0 && tgt && isValidCombo([...tgt.cards, ...sel]);
  const anyInvalid = play && curTable().some(g => g.cards.length > 0 && !isValidCombo(g.cards));
  const canDisc = play && UI.handSel.length === 1 && !anyInvalid;
  document.getElementById('btn-lay').disabled = !(play && hasCombo);
  document.getElementById('btn-add').disabled = !canAdd;
  document.getElementById('btn-disc').disabled = !canDisc;
  const ub = document.getElementById('btn-undo'); if (ub) ub.disabled = !undoStack.length || state.current !== 0 || state.roundOver || dealing;
  const pm = document.getElementById('phase-lbl');
  if (!myTurn && !state.roundOver) pm.textContent = `${state.players[state.current].name} galvoja...`;
  else if (state.roundOver) pm.textContent = 'Ratas baigtas.';
  else if (state.phase === 'draw') pm.textContent = 'Paimkite kortą.';
  else if (anyInvalid) pm.textContent = '⚠ Negaliojanti kombinacija — pataisykite arba ↩';
  else pm.textContent = 'Dėkite kombinacijas, pridėkite arba išmeskite.';
}

function updateTurnBanner() {
  const b = document.getElementById('turn-banner');
  if (state.roundOver) { b.textContent = state.gameOver ? 'Žaidimas baigtas' : 'Ratas baigtas'; b.className = 'round-over'; }
  else if (state.current === 0) { b.textContent = '▶ Jūsų ėjimas'; b.className = 'my-turn'; }
  else { b.textContent = `${state.players[state.current].name} ėjimas...`; b.className = 'ai-turn'; }
}

// hand order reconciliation (keep known order, append new ids)
function reconcileOrder(order, hand) {
  const ids = hand.map(c => c.id);
  const kept = order.filter(id => ids.includes(id));
  for (const id of ids) if (!kept.includes(id)) kept.push(id);
  return kept;
}
function sortedHand(hand) {
  const order = UI.handOrder;
  return [...hand].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
  });
}

// ═══════════════════════════════════════════════════
// CARD HTML
// ═══════════════════════════════════════════════════
function cHTML(c) {
  if (c.isJoker) return '<div class="ctlc">🃏</div><div style="font-size:1rem">🃏</div><div class="cbrc">🃏</div>';
  return `<div class="ctlc">${c.rank}<br>${c.suit}</div><div class="cr">${c.rank}</div><div class="cs">${c.suit}</div><div class="cbrc">${c.rank}<br>${c.suit}</div>`;
}
function cHTMLsm(c) {
  if (c.isJoker) return '<span style="font-size:1.1rem">🃏</span>';
  return `<div style="position:absolute;top:2px;left:3px;font-size:0.62rem;line-height:1.2">${c.rank}<br>${c.suit}</div><div style="font-size:0.78rem;line-height:1">${c.rank}</div><div style="font-size:1.05rem;line-height:1">${c.suit}</div>`;
}
function cHTMLxs(c) { return c.isJoker ? '🃏' : `<span style="font-size:0.56em">${c.rank}</span><span style="font-size:0.72em">${c.suit}</span>`; }

// ═══════════════════════════════════════════════════
// ANIMATION
// ═══════════════════════════════════════════════════
function animFly(fromEl, toEl, card, faceUp, cb) {
  if (!fromEl || !toEl || !card) { if (cb) cb(); return; }
  const fr = fromEl.getBoundingClientRect(), to = toEl.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'fly ' + suitCls(card);
  el.innerHTML = faceUp ? cHTMLsm(card) : '<span style="color:#4a6fa5;font-size:1.2rem">🂠</span>';
  if (!faceUp) el.style.background = 'repeating-linear-gradient(135deg,#4a6fa5,#4a6fa5 4px,#3a5f95 4px,#3a5f95 8px)';
  el.style.cssText += `;left:${fr.left}px;top:${fr.top}px;width:${Math.max(fr.width, 20)}px;height:${Math.max(fr.height, 28)}px;font-weight:700;`;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.left = (to.left + to.width / 2 - 22) + 'px'; el.style.top = (to.top + to.height / 2 - 30) + 'px';
    el.style.width = '44px'; el.style.height = '62px'; el.style.opacity = '0';
  }));
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); if (cb) cb(); }, 700);
}
// Stacking action toast: appears, holds, then gradually fades over 30s (CSS).
function pushToast(who, text) {
  const box = document.getElementById('toasts'); if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast' + (who === 'Jūs' ? ' t-me' : '');
  const tp = document.createElement('span'); tp.className = 'tp'; tp.textContent = who;
  t.appendChild(tp); t.appendChild(document.createTextNode(text || ''));
  box.appendChild(t);
  while (box.children.length > 8) box.removeChild(box.firstChild); // cap the stack
  const kill = () => { if (t.parentNode) t.parentNode.removeChild(t); };
  t.addEventListener('animationend', kill);
  setTimeout(kill, 30500); // fallback if animationend is missed
}
function clearToasts() { const b = document.getElementById('toasts'); if (b) b.innerHTML = ''; }

// ═══════════════════════════════════════════════════
// COACH + HINT
// ═══════════════════════════════════════════════════
function coach(type, msg) {
  const log = document.getElementById('coach-log');
  const d = document.createElement('div'); d.className = 'cm cm-' + type; d.textContent = msg;
  log.prepend(d); while (log.children.length > 28) log.removeChild(log.lastChild);
}
function evalDiscard(card) {
  const { combos } = bestPlay(curHand());
  if (combos.some(c => c.some(x => x.id === card.id))) { coach('warn', 'Išmetėte ' + clbl(card) + ' — dalyvavo kombinacijoje!'); return; }
  const nc = curHand().filter(c => !combos.some(cm => cm.some(x => x.id === c.id)));
  if (nc.length) {
    const w = nc.reduce((a, b) => cpts(a) >= cpts(b) ? a : b);
    if (w.id !== card.id && cpts(w) > cpts(card) + 2) { coach('tip', `Gal geriau buvo išmesti ${clbl(w)} (${cpts(w)}ak.) vietoj ${clbl(card)} (${cpts(card)}ak.)?`); return; }
  }
  coach('good', 'Geras išmetimas.');
}
function showHint() {
  if (state.current !== 0 || state.roundOver) return;
  const hand = curHand();
  const bp = bestPlay(hand);
  if (bp.combos.length) {
    const boost = learnedBoost(bp.combos[0]);
    coach('tip', 'Kombinacija: ' + bp.combos[0].map(clbl).join(' ') + ' | Likusios akys: ' + bp.rem + (boost > 2 ? ` ⭐ (žaidžiau ${boost}×)` : ''));
  } else {
    const ops = [];
    for (const c of hand) for (const g of curTable()) if (isValidCombo([...g.cards, c])) { ops.push(c); break; }
    if (ops.length) coach('tip', 'Galite pridėti: ' + ops.map(clbl).join(', ') + ' prie esamos kombinacijos.');
    else coach('tip', 'Išmeskite: ' + clbl(worstCard(hand)) + ' (' + cpts(worstCard(hand)) + 'ak.)');
  }
}

// ═══════════════════════════════════════════════════
// GAME LOG (localStorage)
// ═══════════════════════════════════════════════════
function addLog(player, action, detail) {
  const entry = { id: Date.now() + Math.random(), round: state.round, player, action, detail, ts: new Date().toLocaleTimeString('lt'), comment: '' };
  gameLog.push(entry);
  pushToast(player, detail);  // transient stacking toast for every action
  try {
    const stored = JSON.parse(localStorage.getItem('dz_game_log') || '[]');
    stored.push(entry); if (stored.length > 200) stored.splice(0, stored.length - 200);
    localStorage.setItem('dz_game_log', JSON.stringify(stored));
  } catch (e) {}
  const lp = document.getElementById('log-pane');
  if (lp && lp.style.display !== 'none') renderGameLog();
}
function renderGameLog() {
  const el = document.getElementById('game-log'); if (!el) return;
  el.innerHTML = [...gameLog].reverse().map(e => `<div class="log-entry ${e.player === 'Jūs' ? 'log-my' : 'log-ai'}">
    <span style="color:#aaa;font-size:0.6rem">R${e.round} ${e.ts}</span> <strong>${e.player}</strong>: ${e.detail}
    <button class="log-btn" onclick="editComment(${e.id})">💬</button>${e.comment ? `<div class="log-cmt">💬 ${e.comment}</div>` : ''}</div>`).join('');
}
function editComment(id) {
  const entry = gameLog.find(e => e.id === id); if (!entry) return;
  const cmt = prompt('Komentaras:', entry.comment || ''); if (cmt === null) return;
  entry.comment = cmt; renderGameLog();
}
function switchTab(tab) {
  document.getElementById('coach-pane').style.display = tab === 'coach' ? 'flex' : 'none';
  document.getElementById('log-pane').style.display = tab === 'log' ? 'flex' : 'none';
  document.getElementById('tab-coach').classList.toggle('active', tab === 'coach');
  document.getElementById('tab-log').classList.toggle('active', tab === 'log');
  if (tab === 'log') renderGameLog();
}

// ═══════════════════════════════════════════════════
// COMBO LEARNING (localStorage) — kept from v1; Phase 5 supersedes
// ═══════════════════════════════════════════════════
function comboKey(combo) {
  const real = combo.filter(c => !c.isJoker);
  if (!real.length) return 'jokers';
  if (real.length >= 2 && real.every(c => c.rank === real[0].rank)) return 'set:' + real[0].rank;
  const sorted = [...real].sort((a, b) => (a.rank).localeCompare(b.rank));
  return 'run:' + real[0].suit + ':' + sorted.map(c => c.rank).join('-');
}
function trackCombo(combo) {
  try {
    const log = JSON.parse(localStorage.getItem('dz_combos') || '[]');
    const key = comboKey(combo); const ex = log.find(x => x.key === key);
    if (ex) ex.n++; else log.push({ key, n: 1, eg: combo.map(clbl).join(' ') });
    localStorage.setItem('dz_combos', JSON.stringify(log));
  } catch (e) {}
}
function learnedBoost(combo) {
  try { const log = JSON.parse(localStorage.getItem('dz_combos') || '[]'); const ex = log.find(x => x.key === comboKey(combo)); return ex ? ex.n : 0; } catch (e) { return 0; }
}

// ═══════════════════════════════════════════════════
// OVERLAY + MISC
// ═══════════════════════════════════════════════════
function showOverlay(title, body, btns) {
  document.getElementById('ovtitle').textContent = title;
  document.getElementById('ovbody').textContent = body;
  const bc = document.getElementById('ovbtns'); bc.innerHTML = '';
  for (const b of btns) { const el = document.createElement('button'); el.className = 'btn bg'; el.textContent = b.lbl; el.onclick = b.fn; bc.appendChild(el); }
  document.getElementById('overlay').classList.add('on');
}
function closeOv() { document.getElementById('overlay').classList.remove('on'); }
function confirmNewGame() { if (confirm('Pradėti naują žaidimą? Dabartinis rezultatas bus prarastas.')) newGame(); }
function toggleSpeed() {
  SPEED = SPEED === 'fast' ? 'human' : 'fast';
  const b = document.getElementById('speed-btn');
  if (b) { b.textContent = SPEED === 'fast' ? '⚡ Kompiuteris' : '🐢 Žmogus'; }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════
// CLOUD SYNC (best-effort; game is fully playable offline)
// ═══════════════════════════════════════════════════
async function postGameResult() {
  try {
    const players = state.players.map((p, seat) => ({
      seat, id: seatPlayerId(seat), name: p.name, isAi: seat !== 0,
      finalScore: p.score, won: seat === state.winnerSeat ? 1 : 0,
    }));
    await fetch('/api/games', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: {
          id: gameId, seed: baseSeed, config: state.config, mode: 'solo',
          rounds: state.round, winnerPlayerId: seatPlayerId(state.winnerSeat), candyPot: state.candyPot,
        },
        players, roundScores: roundHistory,
      }),
    });
  } catch (e) { /* offline-first: ignore */ }
}

async function showStats() {
  let data = null;
  try { const r = await fetch('/api/stats'); if (r.ok) data = await r.json(); } catch (e) {}
  if (!data || !data.leaderboard) {
    showOverlay('📊 Rezultatai', 'Rezultatų serveris nepasiekiamas — žaidžiama vietoje.\nPaskelbus į debesį, čia matysis visų žaidėjų statistika.', [{ lbl: 'Gerai', fn: closeOv }]);
    return;
  }
  const rows = data.leaderboard.length
    ? data.leaderboard.map(r => `${r.is_ai ? '🤖 ' : '👤 '}${r.name}: ${r.wins || 0}/${r.games} laimėta (${r.win_pct || 0}%)  •  vid. ${r.avg_score} ak.`).join('\n')
    : 'Dar nėra baigtų žaidimų.';
  showOverlay('📊 Rezultatai', rows, [{ lbl: 'Gerai', fn: closeOv }]);
}

// ═══════════════════════════════════════════════════
// WINDOW EXPOSURE (inline onclick handlers) + INIT
// ═══════════════════════════════════════════════════
Object.assign(window, {
  playerDraw, doLay, doAdd, doDiscard, showHint, undoLast, toggleSpeed, confirmNewGame, skipAI,
  switchTab, editComment, selectCombo, toggleHandSel, stageCard,
  handDragStart, handDragOver, handDrop, handDragEnd, handDragLeave,
  tDragStart, tDragOver, tDrop, tDragEnd, tDropNew, tDragOverNew, tDropFromHand, tComboCardDragOver,
});
Object.defineProperty(window, '_dragging', { get: () => _dragging });

document.head.insertAdjacentHTML('beforeend', '<style>.ctlc{position:absolute;top:2px;left:4px;font-size:0.66rem;line-height:1.2;text-align:left;}.cbrc{position:absolute;bottom:2px;right:4px;font-size:0.66rem;line-height:1.2;text-align:right;transform:rotate(180deg);}</style>');

// leaderboard button in the header (cloud stats)
const _hr = document.getElementById('header-right');
if (_hr) { const b = document.createElement('button'); b.className = 'hbtn'; b.textContent = '📊'; b.title = 'Rezultatai'; b.onclick = showStats; _hr.insertBefore(b, _hr.firstChild); }

// version label — deploy.cmd stamps __BUILD__/__BUILDHASH__; unstamped local runs show "dev"
const _vl = document.getElementById('ver-lbl');
if (_vl && _vl.textContent.includes('__BUILD__')) { _vl.textContent = 'dev'; _vl.title = 'Local dev build (not deployed)'; }

// ═══════════════════════════════════════════════════
// LOGIN — name + 4-digit PIN (D1-backed, offline fallback)
// ═══════════════════════════════════════════════════
async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function randHex(n = 16) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
function getAccounts() { try { return JSON.parse(localStorage.getItem('dz_accounts') || '{}'); } catch (e) { return {}; } }
function saveAccount(key, rec) { const a = getAccounts(); a[key] = rec; localStorage.setItem('dz_accounts', JSON.stringify(a)); }

// local-only create/verify used when the server is unreachable
async function localAuth(name, pin) {
  const key = name.toLowerCase(), accs = getAccounts(), rec = accs[key];
  if (rec) {
    const h = await sha256hex(rec.salt + pin);
    return h === rec.hash ? { ok: true, player: { id: rec.id, name: rec.name } } : { ok: false, reason: 'wrong_pin' };
  }
  const salt = randHex(), hash = await sha256hex(salt + pin);
  const id = (crypto.randomUUID && crypto.randomUUID()) || ('p' + randHex(6));
  saveAccount(key, { id, name, salt, hash });
  return { ok: true, created: true, player: { id, name } };
}
async function nameExists(name) {
  try {
    const r = await fetch('/api/player?name=' + encodeURIComponent(name));
    if (r.ok) { const d = await r.json(); return { online: true, exists: !!d.exists }; }
  } catch (e) { /* offline */ }
  return { online: false, exists: !!getAccounts()[name.toLowerCase()] };
}
async function doAuth(name, pin) {
  try {
    const r = await fetch('/api/player', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, pin }),
    });
    if (r.ok) return await r.json();
    if (r.status === 400) return await r.json().catch(() => ({ ok: false, reason: 'bad_input' }));
    return await localAuth(name, pin); // 404/405/500/503 (no API/DB) → local fallback
  } catch (e) { return await localAuth(name, pin); } // network down → local
}

function initLogin() {
  const ov = document.getElementById('login-overlay');
  const $ = id => document.getElementById(id);
  let curName = '';
  ov.classList.add('on');

  const showForm = () => {
    $('lg-back').style.display = 'none'; $('lg-form').style.display = '';
    $('lg-step-pin').style.display = 'none'; $('lg-step-name').style.display = '';
    $('lg-name-err').textContent = ''; $('lg-err').textContent = '';
    setTimeout(() => $('lg-name-input').focus(), 30);
  };
  const showBack = (name) => {
    $('lg-form').style.display = 'none'; $('lg-back').style.display = '';
    $('lg-back-name').textContent = name;
  };
  const start = (created) => {
    ov.classList.remove('on');
    newGame();
    coach('info', `${created ? 'Sukurtas žaidėjas' : 'Sveiki'}, ${PLAYER.name}! Tempkite kortas perstatyti · ↩ atšaukti · 📋 žurnalas · 💡 patarimas.`);
  };
  const finalize = (player, created) => {
    PLAYER.id = player.id; PLAYER.name = player.name;
    localStorage.setItem('dz_player_id', PLAYER.id);
    localStorage.setItem('dz_player_name', PLAYER.name);
    localStorage.setItem('dz_authed', '1');
    start(created);
  };

  $('lg-next').onclick = async () => {
    const name = $('lg-name-input').value.trim();
    if (!name) { $('lg-name-err').textContent = 'Įveskite vardą.'; return; }
    curName = name; $('lg-next').disabled = true;
    const { exists } = await nameExists(name);
    $('lg-next').disabled = false;
    $('lg-pin-lbl').textContent = exists ? 'Įveskite savo PIN (4 skaitmenys)' : 'Sukurkite 4 skaitmenų PIN';
    $('lg-pin-input').value = ''; $('lg-err').textContent = '';
    $('lg-step-name').style.display = 'none'; $('lg-step-pin').style.display = '';
    setTimeout(() => $('lg-pin-input').focus(), 30);
  };
  $('lg-back-btn').onclick = () => {
    $('lg-step-pin').style.display = 'none'; $('lg-step-name').style.display = '';
    setTimeout(() => $('lg-name-input').focus(), 30);
  };
  $('lg-start').onclick = async () => {
    const pin = $('lg-pin-input').value.trim();
    if (!/^\d{4}$/.test(pin)) { $('lg-err').textContent = 'PIN turi būti 4 skaitmenys.'; return; }
    $('lg-start').disabled = true; $('lg-err').textContent = 'Tikrinama…';
    const res = await doAuth(curName, pin);
    $('lg-start').disabled = false;
    if (res && res.ok) { finalize(res.player, res.created); return; }
    $('lg-err').textContent = res && res.reason === 'wrong_pin' ? 'Neteisingas PIN. Bandykite dar.' : 'Klaida. Bandykite dar kartą.';
  };
  $('lg-play').onclick = () => start(false);
  $('lg-switch').onclick = () => { $('lg-name-input').value = ''; showForm(); };
  $('lg-name-input').onkeydown = e => { if (e.key === 'Enter') $('lg-next').click(); };
  $('lg-pin-input').onkeydown = e => { if (e.key === 'Enter') $('lg-start').click(); };

  const authed = localStorage.getItem('dz_authed') === '1';
  const savedName = localStorage.getItem('dz_player_name');
  const savedId = localStorage.getItem('dz_player_id');
  if (authed && savedName && savedId) { PLAYER.id = savedId; PLAYER.name = savedName; showBack(savedName); }
  else showForm();
}

initLogin();
