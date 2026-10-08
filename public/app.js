// Battle Draft client. Renders screens from server state; the server decides everything that matters.
/* global io */
import { Wheel } from './wheel.js';

const socket = io({ transports: ['websocket', 'polling'] });
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

// ---------- storage (wrapped: private browsing can block it) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* fine: in-memory only */ } },
};
function makeToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const token = store.get('bd-token') || makeToken();
store.set('bd-token', token);

// ---------- safe templating: every interpolated value is escaped unless wrapped in raw() ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v === false || v == null ? '' : esc(v));
const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

// ---------- state ----------
const ROLE_HINTS = ['Captain', 'Vice captain', 'Strategist', 'Support', 'Wildcard', 'Tank', 'Healer', 'Scout', 'Rival', 'Mentor'];
const state = {
  screen: 'home',
  config: { maxPlayers: { 5: 56, 10: 34 }, timerOptions: [15, 30, 45, 60] },
  view: null,
  roomId: null,
  peek: null,
  rooms: [],
  error: '',
  busy: false,
  tipOpen: false,
  reportFor: null,
  confirmKick: null,
  notice: null,
  characters: { version: -1, list: [] },
  charTab: 'paste',
  importResult: null,
  importing: false,
  confirmClear: null,
  // draft
  wheel: null,
  clockOffset: 0, // server time minus local time
  animatingSpin: null,
  shownSpinId: null,
  keepChoice: 'new',
  endMode: 'swap', // end phase: 'swap' | 'bin' | 'extra'
  endFirst: null, // first role picked for a swap
  binChoice: null, // character picked from the bin
  ballots: {}, // matchId -> { role: 'a' | 'b' }
  judgeDecision: {},
  img: new Map(), // charId -> 'loading' | 'ok' | 'fail'
  form: {
    name: store.get('bd-name') || '', roomName: '', visibility: 'private', roleCount: 5,
    roles: Array(10).fill(''), cap: 8, turnOrder: 'join', releasedHoldToBin: 'yes', timer: 'off',
    charName: '', charImage: '', charPaste: '', charVerse: '', charSearch: '',
  },
};

fetch('/config').then((r) => r.json()).then((c) => { state.config = c; if (state.screen === 'create') render(); }).catch(() => {});

// Waits briefly for the connection (e.g. straight after opening an invite link) before sending.
function connected(ms = 8000) {
  if (socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { socket.off('connect', ok); resolve(false); }, ms);
    function ok() { clearTimeout(t); resolve(true); }
    socket.once('connect', ok);
  });
}
const emit = async (event, payload = {}) => {
  if (!(await connected())) return { ok: false, message: 'You’re offline. Check your connection and try again.' };
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, message: 'No response from the server. Try again.' } : res));
  });
};

function toast(message, ok = false) {
  $toast.textContent = message;
  $toast.className = `show${ok ? ' ok' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.className = ''; }, 3200);
}

function setPath(path) { if (location.pathname !== path) history.pushState({}, '', path); }
const roomLink = (id) => `${location.origin}/r/${id}`;

function go(screen, extra = {}) {
  if (state.screen === 'browse' && screen !== 'browse') emit('unbrowse');
  Object.assign(state, { screen, error: '', ...extra });
  render();
  window.scrollTo(0, 0);
}

function notice(title, message) {
  state.view = null; state.roomId = null; state.characters = { version: -1, list: [] };
  setPath('/');
  go('notice', { notice: { title, message } });
}

// ---------- routing ----------
async function route() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)/);
  if (m) await openRoomLink(m[1]);
  else go('home');
}
window.addEventListener('popstate', route);

async function openRoomLink(id) {
  state.roomId = id;
  const res = await emit('peek', { roomId: id, token });
  if (!res.ok) return notice('Game not found', res.message || 'The link may be wrong, or the game has ended.');
  if (res.banned) return notice('You can’t rejoin this game', 'The host removed you from this game.');
  if (res.member) return enterRoom();
  if (res.room.phase !== 'lobby') return notice('This game has started', 'New players can’t join once the draft begins. Ask the host to restart, or start your own game.');
  if (res.room.full) return notice('This room is full', `${res.room.roomName} has reached its player cap.`);
  go('name', { peek: res.room });
}

async function enterRoom(name) {
  const res = await emit('join', { roomId: state.roomId, name, token });
  if (!res.ok) {
    if (state.screen === 'name') { state.error = res.message; render(); return; }
    return notice('Couldn’t join', res.message);
  }
  if (name) store.set('bd-name', name);
  setPath(`/r/${state.roomId}`);
}

// ---------- socket events ----------
socket.on('room', (view) => {
  if (view.draft) state.clockOffset = view.draft.serverNow - Date.now();
  if (view.draft?.turn?.stage === 'landed' || view.draft?.turn?.stage === 'spin') state.keepChoice = 'new';
  state.view = view;
  state.roomId = view.id;
  if (state.screen !== 'room') { state.screen = 'room'; state.error = ''; window.scrollTo(0, 0); }
  if (state.confirmKick && !view.players.some((p) => p.id === state.confirmKick)) state.confirmKick = null;
  if (state.reportFor && !view.players.some((p) => p.id === state.reportFor)) state.reportFor = null;
  render();
});
socket.on('characters', (payload) => {
  state.characters = { ...payload }; // a new object each time, so the name lookup always rebuilds
  if (state.screen === 'room') render();
});
socket.on('publicRooms', (rooms) => { state.rooms = rooms; if (state.screen === 'browse') render(); });
socket.on('admitted', () => enterRoom());
socket.on('declined', ({ roomName }) => notice('Not this time', `The host of ${roomName} didn’t let you in. Try another game.`));
socket.on('kicked', ({ roomName }) => notice('Removed from the game', `The host removed you from ${roomName}.`));
socket.on('connect', async () => {
  if (state.screen === 'room' && state.roomId) await enterRoom();
  else if (state.screen === 'browse') { const r = await emit('browse'); if (r.ok) { state.rooms = r.rooms; render(); } }
  else if (state.screen === 'waiting') await requestJoin(state.form.name);
  render();
});
socket.on('disconnect', () => render());

// ---------- actions ----------
async function requestJoin(name) {
  const res = await emit('requestJoin', { roomId: state.roomId, name, token });
  if (!res.ok) { state.error = res.message; if (state.screen !== 'name') go('name'); else render(); return; }
  store.set('bd-name', name);
  go('waiting');
}

async function importText(text, source, fileName) {
  state.importing = true; render();
  const res = await emit('addCharacters', { text, source, verse: state.form.charVerse });
  state.importing = false;
  state.importResult = res.ok ? { ...res, fileName } : { error: res.message };
  render();
  return res.ok;
}

const actions = {
  home: () => { setPath('/'); go('home'); },
  create: () => go('create'),
  async browse() {
    go('browse', { rooms: [] });
    const res = await emit('browse');
    if (res.ok) { state.rooms = res.rooms; render(); }
  },
  pickRoom(el) {
    const room = state.rooms.find((r) => r.id === el.dataset.id);
    if (!room) return;
    state.roomId = room.id;
    go('name', { peek: { ...room, visibility: 'public', phase: 'lobby' } });
  },
  roleCount(el) {
    state.form.roleCount = Number(el.value);
    state.form.cap = Math.min(state.form.cap, state.config.maxPlayers[state.form.roleCount]);
    render();
  },
  capStep(el) {
    const max = state.config.maxPlayers[state.form.roleCount];
    state.form.cap = Math.max(3, Math.min(max, Number(state.form.cap) + Number(el.dataset.step)));
    render();
  },
  tip() { state.tipOpen = !state.tipOpen; render(); },
  async cancelRequest() { await emit('cancelRequest'); notice('Request cancelled', 'You can ask to join another game any time.'); },
  async copyLink() {
    const url = roomLink(state.view.id);
    try { await navigator.clipboard.writeText(url); toast('Link copied', true); }
    catch { const i = document.getElementById('invite-link'); i.select(); toast('Press and hold to copy the link'); }
  },
  async shareLink() {
    try { await navigator.share({ title: 'Join my Battle Draft game', url: roomLink(state.view.id) }); } catch { /* cancelled */ }
  },
  async admit(el) { const r = await emit('admit', { requestId: el.dataset.id }); if (!r.ok) toast(r.message); },
  async decline(el) { const r = await emit('decline', { requestId: el.dataset.id }); if (!r.ok) toast(r.message); },
  askKick(el) { state.confirmKick = el.dataset.id; state.reportFor = null; render(); },
  cancelKick() { state.confirmKick = null; render(); },
  async kick(el) {
    const r = await emit('kick', { playerId: el.dataset.id });
    state.confirmKick = null;
    if (!r.ok) toast(r.message); else toast('Player removed', true);
    render();
  },
  askReport(el) { state.reportFor = el.dataset.id; state.confirmKick = null; render(); document.getElementById('report-reason')?.focus(); },
  cancelReport() { state.reportFor = null; render(); },
  async start() { const r = await emit('start'); if (!r.ok) toast(r.message); },
  async spin() { const r = await emit('spin'); if (!r.ok) toast(r.message); },
  async hold() { const r = await emit('hold'); if (!r.ok) toast(r.message); },
  async binIt() { const r = await emit('bin'); if (!r.ok) toast(r.message); },
  pickKeep(el) { state.keepChoice = el.dataset.choice; render(); },
  async placeRole(el) {
    const role = Number(el.dataset.role);
    const stage = state.view?.draft?.turn?.stage;
    const r = stage === 'compare' ? await emit('keep', { choice: state.keepChoice, role }) : await emit('place', { role });
    if (!r.ok) toast(r.message);
  },
  endMode(el) { state.endMode = el.dataset.mode; state.endFirst = null; state.binChoice = null; render(); },
  pickBinChar(el) { state.binChoice = el.dataset.id; render(); },
  async endRole(el) {
    const role = Number(el.dataset.role);
    const go = state.view?.end?.go;
    let r = { ok: true };
    if (go?.stage === 'extra') r = await emit('keepExtra', { role });
    else if (state.endMode === 'swap') {
      if (state.endFirst === null) { state.endFirst = role; render(); return; }
      if (state.endFirst === role) { state.endFirst = null; render(); return; }
      r = await emit('swap', { roleA: state.endFirst, roleB: role });
      state.endFirst = null;
    } else if (state.endMode === 'bin') {
      if (!state.binChoice) { toast('Pick a character from the bin first.'); return; }
      r = await emit('binPick', { charId: state.binChoice, role });
      state.binChoice = null;
    }
    if (!r.ok) toast(r.message);
    render();
  },
  async extraSpin() { const r = await emit('extraSpin'); if (!r.ok) toast(r.message); },
  async declineExtra() { const r = await emit('declineExtra'); if (!r.ok) toast(r.message); },
  async endDone() { const r = await emit('endDone'); if (!r.ok) toast(r.message); },
  pickVote(el) {
    const m = state.view?.faceoff?.match;
    if (!m) return;
    state.ballots[m.id] = { ...(state.ballots[m.id] || {}), [el.dataset.role]: el.dataset.side };
    render();
  },
  async submitVote() {
    const m = state.view?.faceoff?.match;
    const r = await emit('vote', { picks: state.ballots[m.id] || {} });
    if (!r.ok) toast(r.message);
  },
  pickJudge(el) {
    const m = state.view?.faceoff?.match;
    state.judgeDecision[m.id] = { ...(state.judgeDecision[m.id] || {}), [el.dataset.role]: el.dataset.side };
    render();
  },
  async submitJudge(el) {
    const m = state.view?.faceoff?.match;
    const decision = m.judge.kind === 'team' ? el.dataset.side : state.judgeDecision[m.id] || {};
    const r = await emit('judge', { decision });
    if (!r.ok) toast(r.message);
  },
  async restart() { const r = await emit('restart'); if (!r.ok) toast(r.message); },
  async nextMatch() { const r = await emit('nextMatch'); if (!r.ok) toast(r.message); },
  async voteKick(el) {
    const r = await emit('voteKick', { playerId: el.dataset.id });
    if (!r.ok) toast(r.message); else if (r.kicked) toast('Player removed by vote', true);
  },
  charTab(el) { state.charTab = el.dataset.tab; state.importResult = null; render(); },
  dismissResult() { state.importResult = null; render(); },
  async removeChar(el) { const r = await emit('removeCharacter', { id: el.dataset.id }); if (!r.ok) toast(r.message); },
  askClear(el) { state.confirmClear = el.dataset.verse ?? '*'; render(); },
  cancelClear() { state.confirmClear = null; render(); },
  async clearChars() {
    const verse = state.confirmClear === '*' ? undefined : state.confirmClear;
    const r = await emit('clearCharacters', verse === undefined ? {} : { verse });
    state.confirmClear = null; state.importResult = null;
    if (!r.ok) toast(r.message); else render();
  },
  async uploadFile(el) {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(file.name)) {
      state.importResult = { error: 'That’s a spreadsheet file. Save it as CSV first (File, Save As, CSV) and upload that.' }; render(); return;
    }
    if (!/\.(csv|txt|tsv)$/i.test(file.name) && !/^text\//.test(file.type)) {
      state.importResult = { error: `${file.name} isn’t a CSV or text file. Upload a .csv file with one character per row.` }; render(); return;
    }
    if (file.size > 1_000_000) { state.importResult = { error: 'That file is too big. Keep it to 500 characters.' }; render(); return; }
    await importText(await file.text(), 'csv', file.name);
  },
  async leave() {
    await emit('leave');
    state.view = null; state.roomId = null; state.characters = { version: -1, list: [] };
    setPath('/'); go('home');
  },
};

const forms = {
  async create(form) {
    const f = state.form;
    const settings = {
      roomName: f.roomName, visibility: f.visibility, roleCount: f.roleCount,
      roles: f.roles.slice(0, f.roleCount), cap: Number(f.cap), turnOrder: f.turnOrder,
      releasedHoldToBin: f.releasedHoldToBin === 'yes', timerEnabled: f.timer !== 'off', timerSeconds: Number(f.timer) || 30,
    };
    state.busy = true; render();
    const res = await emit('create', { settings, name: f.name, token });
    state.busy = false;
    if (!res.ok) { state.error = res.message; render(); form.querySelector('.error-text')?.scrollIntoView({ block: 'center' }); return; }
    store.set('bd-name', f.name.trim());
    state.roomId = res.roomId;
    setPath(`/r/${res.roomId}`);
  },
  async join() {
    const name = state.form.name;
    if (state.peek?.visibility === 'public') await requestJoin(name);
    else await enterRoom(name);
  },
  async addOne() {
    const f = state.form;
    const text = [f.charName, f.charImage].map((x) => x.trim()).filter(Boolean).map((x) => (x.includes(',') ? `"${x.replace(/"/g, '""')}"` : x)).join(',');
    if (!f.charName.trim()) { state.importResult = { error: 'Type a character name.' }; render(); return; }
    if (await importText(text, 'csv')) { f.charName = ''; f.charImage = ''; render(); document.querySelector('[data-field="charName"]')?.focus(); }
  },
  async addPaste() {
    if (await importText(state.form.charPaste, 'paste')) { state.form.charPaste = ''; render(); }
  },
  async report(form) {
    const r = await emit('report', { playerId: state.reportFor, reason: state.form.reportReason || '' });
    if (!r.ok) return toast(r.message);
    state.reportFor = null; state.form.reportReason = ''; render();
    toast('Report sent to the admin', true);
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el, e); }
});
$app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && actions[el.dataset.change]) actions[el.dataset.change](el, e);
});
$app.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.field) return;
  const [key, idx] = el.dataset.field.split('.');
  if (idx !== undefined) state.form[key][Number(idx)] = el.value;
  else state.form[key] = el.value;
  if (key === 'charSearch') render(); // filter as you type
});
$app.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(form);
});
document.addEventListener('click', (e) => {
  if (state.tipOpen && !e.target.closest('.info-wrap')) { state.tipOpen = false; render(); }
});

// ---------- screens ----------
const back = (action = 'home', label = 'Back') => html`<button class="back" data-action="${action}">‹ ${label}</button>`;

function homeScreen() {
  return html`
    <section class="hero">
      <h1 class="wordmark"><span>Battle</span><span>Draft</span></h1>
      <p class="tagline">Spin the wheel for anime characters, build your squad, and let the group decide who wins.</p>
      <div class="hero-actions">
        <button class="btn btn-primary btn-block" data-action="create">Create a game</button>
        <button class="btn btn-ghost btn-block" data-action="browse">Find a public game</button>
      </div>
      <p class="hero-foot">Got an invite link? Open it to join your friends.</p>
    </section>`;
}

function seg(name, field, options, current, change = '') {
  return html`<div class="segmented" role="radiogroup">${options.map(([value, label, sub], i) => html`
    <input type="radio" id="${name}-${i}" name="${name}" value="${value}" data-field="${field}" ${raw(change ? `data-change="${change}"` : '')} ${raw(String(current) === String(value) ? 'checked' : '')}>
    <label for="${name}-${i}">${label}${sub ? html`<small>${sub}</small>` : ''}</label>`)}</div>`;
}

function createScreen() {
  const f = state.form;
  const max = state.config.maxPlayers[f.roleCount];
  const timerOpts = [['off', 'Off'], ...state.config.timerOptions.map((s) => [String(s), `${s}s`])];
  return html`
    ${back()}
    <header class="screen-head"><h2>Create a game</h2><p>Set the rules, then share the link with your friends.</p></header>
    <form data-form="create" class="stack" novalidate>
      <section class="panel">
        <label class="field"><span class="label">Your gaming name</span>
          <input type="text" data-field="name" value="${f.name}" maxlength="20" autocomplete="nickname" required></label>
        <label class="field"><span class="label">Room name</span>
          <input type="text" data-field="roomName" value="${f.roomName}" maxlength="40" placeholder="e.g. Friday night draft" required></label>
        <div class="choice field"><span class="label">Who can join</span>
          ${seg('vis', 'visibility', [['private', 'Private', 'Anyone with the link'], ['public', 'Public', 'Listed; you admit players']], f.visibility)}</div>
      </section>

      <section class="panel">
        <h3>Team</h3>
        <div class="choice"><span class="label">Team size</span>
          ${seg('size', 'roleCount', [[5, '5 roles', '1 respin each'], [10, '10 roles', '2 respins each']], f.roleCount, 'roleCount')}</div>
        <div class="field"><span class="label">Role names <small>— in team order</small></span>
          <ol class="roles">${f.roles.slice(0, f.roleCount).map((r, i) => html`
            <li><span class="pos" aria-hidden="true">${i + 1}</span>
              <input type="text" data-field="roles.${i}" value="${r}" maxlength="30" aria-label="Role ${i + 1}" placeholder="e.g. ${ROLE_HINTS[i]}"></li>`)}</ol></div>
      </section>

      <section class="panel">
        <h3>Rules</h3>
        <div class="field"><span class="label">Player cap <small>— 3 to ${max}</small></span>
          <div class="stepper">
            <button type="button" class="btn" data-action="capStep" data-step="-1" aria-label="Fewer players">−</button>
            <input type="number" data-field="cap" value="${f.cap}" min="3" max="${max}" inputmode="numeric" aria-label="Player cap">
            <button type="button" class="btn" data-action="capStep" data-step="1" aria-label="More players">+</button>
          </div></div>
        <div class="choice"><span class="label">Turn order</span>
          ${seg('order', 'turnOrder', [['join', 'Order of joining'], ['shuffle', 'Shuffle at start']], f.turnOrder)}</div>
        <div class="choice info-wrap ${state.tipOpen ? 'open' : ''}"><span class="label">Bin characters released from a hold?
          <button type="button" class="info-btn" data-action="tip" aria-label="What does this mean?" aria-expanded="${state.tipOpen}" aria-controls="hold-tip">?</button></span>
          <p class="tooltip" id="hold-tip" role="tooltip">When you hold a character, spin again and keep the new one, the held character is let go. <strong>Yes:</strong> they go in the bin and are out for the rest of the game. <strong>No:</strong> they go back on the wheel and anyone can land them.</p>
          ${seg('hold', 'releasedHoldToBin', [['yes', 'Yes, bin them'], ['no', 'No, back on the wheel']], f.releasedHoldToBin)}</div>
        <div class="choice"><span class="label">Placement timer</span>
          ${seg('timer', 'timer', timerOpts, f.timer)}
          <p class="hint" style="margin-top:6px">If it runs out, the character goes back on the wheel and that turn is lost.</p></div>
      </section>

      ${state.error ? html`<p class="error-text" role="alert">${state.error}</p>` : ''}
      <button class="btn btn-primary btn-block" type="submit" ${raw(state.busy ? 'disabled' : '')}>Create game</button>
    </form>`;
}

function browseScreen() {
  return html`
    ${back()}
    <header class="screen-head"><h2>Public games</h2><p>Pick a game and ask the host to let you in.</p></header>
    ${state.rooms.length ? state.rooms.map((r) => html`
      <button class="room-card" data-action="pickRoom" data-id="${r.id}" ${raw(r.full ? 'disabled' : '')}>
        <div class="title">${r.roomName}</div>
        <div class="meta"><span>Hosted by ${r.host}</span><span>${r.players}/${r.cap} players</span><span>${r.roleCount} roles</span>${r.full ? html`<span class="badge full">Full</span>` : ''}</div>
      </button>`) : html`
      <div class="panel notice"><h3>No public games right now</h3>
        <p>Create one yourself, or ask a friend for their invite link.</p>
        <button class="btn btn-primary" data-action="create">Create a game</button></div>`}`;
}

function nameScreen() {
  const p = state.peek || {};
  const isPublic = p.visibility === 'public';
  return html`
    ${back(isPublic ? 'browse' : 'home')}
    <header class="screen-head"><h2>Join ${p.roomName}</h2><p>Hosted by ${p.host}. ${p.players}/${p.cap} players, ${p.roleCount} roles.</p></header>
    <form data-form="join" class="panel" novalidate>
      <label class="field"><span class="label">Your gaming name</span>
        <input type="text" data-field="name" value="${state.form.name}" maxlength="20" autocomplete="nickname" autofocus required></label>
      ${isPublic ? html`<p class="hint" style="margin-top:10px">The host will need to let you in.</p>` : ''}
      ${state.error ? html`<p class="error-text" role="alert">${state.error}</p>` : ''}
      <button class="btn btn-primary btn-block" type="submit" style="margin-top:18px">${isPublic ? 'Ask to join' : 'Join game'}</button>
    </form>`;
}

function waitingScreen() {
  const p = state.peek || {};
  return html`
    <div class="panel notice" style="margin-top:40px">
      <div class="waiting-dots" aria-hidden="true">• • •</div>
      <h2>Waiting for ${p.host}</h2>
      <p>You’ve asked to join ${p.roomName}. You’ll go straight in once the host lets you.</p>
      <button class="btn" data-action="cancelRequest">Cancel request</button>
    </div>`;
}

function noticeScreen() {
  const n = state.notice || {};
  return html`
    <div class="panel notice" style="margin-top:40px">
      <h2>${n.title}</h2><p>${n.message}</p>
      <button class="btn btn-primary" data-action="home">Back to home</button>
    </div>`;
}

function playerRow(p, v) {
  const me = p.id === v.you;
  const canModerate = v.isHost && !me;
  return html`
    <li class="${p.connected ? '' : 'away'}">
      <span class="grow">${p.name}</span>
      ${p.isHost ? html`<span class="badge">Host</span>` : ''}
      ${me ? html`<span class="badge you">You</span>` : ''}
      ${canModerate && state.confirmKick !== p.id && state.reportFor !== p.id ? html`
        <span class="row-actions">
          <button class="btn btn-small" data-action="askReport" data-id="${p.id}">Report</button>
          <button class="btn btn-small btn-danger" data-action="askKick" data-id="${p.id}">Remove</button>
        </span>` : ''}
    </li>
    ${state.confirmKick === p.id ? html`
      <li><div class="inline-form">
        <p>Remove ${p.name}? They won’t be able to rejoin this game.</p>
        <div class="row-actions" style="justify-content:flex-start">
          <button class="btn btn-small btn-danger" data-action="kick" data-id="${p.id}">Remove</button>
          <button class="btn btn-small" data-action="cancelKick">Cancel</button></div></div></li>` : ''}
    ${state.reportFor === p.id ? html`
      <li><form class="inline-form" data-form="report">
        <label class="label" for="report-reason">What did ${p.name} do?</label>
        <textarea id="report-reason" name="reason" data-field="reportReason" rows="2" maxlength="300" required>${state.form.reportReason || ''}</textarea>
        <div class="row-actions" style="justify-content:flex-start">
          <button class="btn btn-small btn-danger" type="submit">Send report</button>
          <button class="btn btn-small" type="button" data-action="cancelReport">Cancel</button></div></form></li>` : ''}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function importResultBox() {
  const r = state.importResult;
  if (!r) return '';
  if (r.error) return html`<div class="result result-error" role="alert"><p>${r.error}</p></div>`;
  const n = r.notes || {};
  const extra = [
    n.headerSkipped && 'The header row was skipped.',
    n.blankRows && `${plural(n.blankRows, 'blank row')} ignored.`,
    n.unsafeLinks && `${plural(n.unsafeLinks, 'link')} wasn’t a normal web link, so ${n.unsafeLinks === 1 ? 'it was' : 'they were'} dropped.`,
    n.longNames && `${plural(n.longNames, 'name')} over 60 characters skipped.`,
    n.linksWithoutName && `${plural(n.linksWithoutName, 'row')} had a link but no name, so ${n.linksWithoutName === 1 ? 'it was' : 'they were'} skipped.`,
  ].filter(Boolean);
  return html`
    <div class="result" role="status">
      <p><strong>Added ${plural(r.added, 'character')}</strong>${r.fileName ? html` from ${r.fileName}` : ''}. You now have ${r.total}.</p>
      ${r.duplicates?.length ? html`
        <p class="dup-head">${plural(r.duplicates.length, 'duplicate')} removed:</p>
        <ul class="dups">${r.duplicates.map((d) => html`<li class="dup">${d}</li>`)}</ul>` : ''}
      ${extra.map((t) => html`<p class="hint">${t}</p>`)}
      <button class="btn btn-small" data-action="dismissResult">OK</button>
    </div>`;
}

function poolStatus(v) {
  const have = state.characters.list.length;
  const players = Math.max(v.players.filter((p) => p.connected).length, 3);
  const enough = have >= v.poolNeeded;
  return html`
    <p class="pool ${enough ? 'pool-ok' : 'pool-low'}">${enough
      ? `Enough for ${players} players (needs ${v.poolNeeded}).`
      : `Add ${v.poolNeeded - have} more: ${players} players need ${v.poolNeeded}.`}</p>
    ${v.poolForCap > have && v.poolForCap !== v.poolNeeded ? html`<p class="hint">A full room of ${v.settings.cap} needs ${v.poolForCap}.</p>` : ''}`;
}

function characterList(v) {
  const q = state.form.charSearch.trim().toLowerCase();
  const all = state.characters.list;
  if (!all.length) return html`<p class="hint empty">${v.isHost ? 'No characters yet. Add some above.' : 'The host hasn’t added any characters yet.'}</p>`;
  const shown = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  const groups = new Map();
  for (const c of shown) { const k = c.verse || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const multi = new Set(all.map((c) => c.verse || '')).size > 1 || all.some((c) => c.verse);
  return html`
    <label class="sr-only" for="char-search">Search characters</label>
    <input type="text" id="char-search" data-field="charSearch" value="${state.form.charSearch}" placeholder="Search ${all.length} characters" autocomplete="off">
    <div class="char-scroll" tabindex="0" aria-label="Character list">
      ${shown.length ? [...groups].map(([verse, chars]) => html`
        ${multi ? html`<div class="verse-head"><span>${verse || 'No anime given'} <small>${chars.length}</small></span>
          ${v.isHost && !q ? (state.confirmClear === verse ? html`<span class="row-actions">
              <button class="btn btn-small btn-danger" data-action="clearChars">Remove all ${chars.length}</button>
              <button class="btn btn-small" data-action="cancelClear">Cancel</button></span>`
            : html`<button class="btn btn-small" data-action="askClear" data-verse="${verse}">Remove list</button>`) : ''}</div>` : ''}
        <ul class="char-list">${chars.map((c) => html`<li><span>${c.name}</span>${v.isHost ? html`<button class="x" data-action="removeChar" data-id="${c.id}" aria-label="Remove ${c.name}">×</button>` : ''}</li>`)}</ul>`)
      : html`<p class="hint empty">No characters match “${state.form.charSearch}”.</p>`}
    </div>
    ${v.isHost && !multi ? (state.confirmClear === '*' ? html`<div class="row-actions clear-row">
        <button class="btn btn-small btn-danger" data-action="clearChars">Remove all ${all.length}</button>
        <button class="btn btn-small" data-action="cancelClear">Cancel</button></div>`
      : html`<div class="clear-row"><button class="btn btn-small btn-ghost" data-action="askClear">Clear list</button></div>`) : ''}`;
}

function charactersPanel(v) {
  const n = state.characters.list.length;
  const tab = state.charTab;
  const busy = raw(state.importing ? 'disabled' : '');
  return html`
    <section class="panel chars">
      <div class="chars-head"><h3>Characters</h3><span class="count">${n}/500</span></div>
      ${poolStatus(v)}
      ${v.isHost ? html`
        <div class="add-box">
          <label class="field"><span class="label">Anime <small>— optional, groups this list</small></span>
            <input type="text" data-field="charVerse" value="${state.form.charVerse}" maxlength="40" placeholder="e.g. One Piece"></label>
          <div class="tabs" role="tablist" aria-label="How to add characters">
            ${[['type', 'Type'], ['paste', 'Paste'], ['upload', 'Upload CSV']].map(([k, label]) => html`
              <button class="tab" role="tab" aria-selected="${tab === k}" data-action="charTab" data-tab="${k}">${label}</button>`)}
          </div>
          ${tab === 'type' ? html`
            <form data-form="addOne" class="tab-body" novalidate>
              <input type="text" data-field="charName" value="${state.form.charName}" maxlength="60" placeholder="Character name" aria-label="Character name">
              <input type="text" data-field="charImage" value="${state.form.charImage}" placeholder="Image link (optional)" aria-label="Image link, optional" inputmode="url">
              <button class="btn btn-small btn-primary" type="submit" ${busy}>Add character</button>
            </form>` : ''}
          ${tab === 'paste' ? html`
            <form data-form="addPaste" class="tab-body" novalidate>
              <textarea data-field="charPaste" rows="5" aria-label="Paste characters" placeholder="${'One per line, or separated by commas:\nLuffy\nZoro, https://example.com/zoro.png\nNami, Usopp, Sanji'}">${state.form.charPaste}</textarea>
              <button class="btn btn-small btn-primary" type="submit" ${busy}>Add characters</button>
            </form>` : ''}
          ${tab === 'upload' ? html`
            <div class="tab-body">
              <label class="btn btn-small btn-primary file-btn">Choose a CSV file
                <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" data-change="uploadFile" class="sr-only" ${busy}></label>
              <p class="hint">One character per row. Put an image link in any column if you have one. Header rows are fine.</p>
            </div>` : ''}
          ${state.importing ? html`<p class="hint">Adding…</p>` : importResultBox()}
        </div>` : ''}
      ${characterList(v)}
    </section>`;
}

function lobbyScreen(v) {
  const s = v.settings;
  const host = v.players.find((p) => p.isHost);
  const link = roomLink(v.id);
  const canShare = typeof navigator.share === 'function';
  return html`
    <header class="lobby-title"><h2>${s.roomName}</h2>
      <p>${s.visibility === 'public' ? 'Public game' : 'Private game'}, hosted by ${host?.name}</p></header>
    <div class="stack">
      <section class="panel">
        <h3>Invite players</h3>
        <div class="invite">
          <input type="text" id="invite-link" value="${link}" readonly aria-label="Invite link">
          <button class="btn btn-small" data-action="copyLink">Copy</button>
        </div>
        ${canShare ? html`<button class="btn btn-small btn-block" style="margin-top:10px" data-action="shareLink">Share link</button>` : ''}
      </section>

      ${v.isHost && v.requests.length ? html`
      <section class="panel">
        <h3>Asking to join (${v.requests.length})</h3>
        <ul class="list">${v.requests.map((r) => html`
          <li><span class="grow">${r.name}</span>
            <span class="row-actions">
              <button class="btn btn-small" data-action="decline" data-id="${r.id}">Decline</button>
              <button class="btn btn-small btn-primary" data-action="admit" data-id="${r.id}">Let in</button></span></li>`)}</ul>
      </section>` : ''}

      <section class="panel">
        <h3>Players ${v.players.length}/${s.cap}</h3>
        <ul class="list">${v.players.map((p) => playerRow(p, v))}</ul>
      </section>

      <div class="two-col">
        <section class="panel">
          <h3>Roles</h3>
          <ol class="role-list">${s.roles.map((r, i) => html`<li><span class="pos" aria-hidden="true">${i + 1}</span><span>${r}</span></li>`)}</ol>
        </section>
        <section class="panel">
          <h3>Rules</h3>
          <dl class="summary">
            <dt>Respins</dt><dd>${s.roleCount === 10 ? 2 : 1} each</dd>
            <dt>Hold</dt><dd>1 each</dd>
            <dt>Turn order</dt><dd>${s.turnOrder === 'shuffle' ? 'Shuffled at start' : 'Order of joining'}</dd>
            <dt>Released holds</dt><dd>${s.releasedHoldToBin ? 'Go in the bin' : 'Back on the wheel'}</dd>
            <dt>Timer</dt><dd>${s.timerEnabled ? `${s.timerSeconds} seconds` : 'Off'}</dd>
          </dl>
        </section>
      </div>

      ${charactersPanel(v)}
    </div>

    <div class="start-zone">
      ${v.isHost ? html`
        <button class="btn btn-primary btn-block" data-action="start" ${raw(v.startBlockers.length ? 'disabled' : '')}>Start the draft</button>
        ${v.startBlockers.map((b) => html`<p class="why">${b}</p>`)}`
      : html`<p class="why">Waiting for ${host?.name} to start the draft.</p>`}
      <button class="btn btn-ghost btn-small" style="margin-top:18px" data-action="leave">Leave game</button>
    </div>`;
}

// ---------- draft screen ----------
const serverNow = () => Date.now() + state.clockOffset;
// The name lookup is rebuilt whenever a new list arrives. It is tied to the list itself (not its
// version number), because every room numbers its versions from 1.
const charById = () => {
  if (state.charMapSource !== state.characters) {
    state.charMap = new Map(state.characters.list.map((c) => [c.id, c]));
    state.charNameMap = new Map(state.characters.list.map((c) => [c.id, c.name]));
    state.charMapSource = state.characters;
  }
  return state.charMap;
};
// If a screen meets a character it doesn't know, fetch the list again (at most every 3 seconds).
function missingCharacter() {
  const now = Date.now();
  if (now - (state.lastCharRefetch || 0) < 3000) return;
  state.lastCharRefetch = now;
  emit('getCharacters').then((r) => { if (r.ok && r.list) { state.characters = { version: r.version, list: r.list }; render(); } });
}
const charName = (id) => {
  const c = charById().get(id);
  if (!c && id != null) missingCharacter();
  return c?.name ?? 'Loading…';
};
const pName = (v, id) => v.names?.[id] ?? 'A player';

// R7.4: load an image in the background; give up after 4 seconds and show the name instead.
function loadImage(id) {
  const c = charById().get(id);
  if (!c?.image || state.img.has(id)) return;
  state.img.set(id, 'loading');
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  const done = (ok) => { if (state.img.get(id) !== 'loading') return; state.img.set(id, ok ? 'ok' : 'fail'); render(); };
  img.onload = () => done(true);
  img.onerror = () => done(false);
  setTimeout(() => done(false), 4000);
  img.src = c.image;
}

function charCard(id, label, { selectable = false, choice = '', selected = false } = {}) {
  const c = charById().get(id);
  const showImg = c?.image && state.img.get(id) === 'ok';
  const inner = html`
    ${label ? html`<span class="card-label">${label}</span>` : ''}
    ${showImg ? html`<img src="${c.image}" alt="" referrerpolicy="no-referrer">` : ''}
    <span class="card-name">${c?.name ?? 'Unknown'}</span>
    ${c?.verse ? html`<span class="card-verse">${c.verse}</span>` : ''}`;
  return selectable
    ? html`<button class="char-card selectable ${selected ? 'selected' : ''}" data-action="pickKeep" data-choice="${choice}" aria-pressed="${selected}">${inner}</button>`
    : html`<div class="char-card">${inner}</div>`;
}

function formation(v, pid, { interactive = false, compact = false } = {}) {
  const team = v.draft.teams[pid] || [];
  return html`
    <ol class="formation ${compact ? 'compact' : ''}">${v.settings.roles.map((role, i) => {
      const id = team[i];
      const canPlace = interactive && id == null;
      return html`<li class="${id == null ? 'empty' : ''}">
        <span class="pos" aria-hidden="true">${i + 1}</span>
        <span class="slot-role">${role}</span>
        ${canPlace
          ? html`<button class="btn btn-small btn-primary place-btn" data-action="placeRole" data-role="${i}">Place here</button>`
          : html`<span class="slot-char">${id == null ? 'Empty' : charName(id)}</span>`}
      </li>`;
    })}</ol>`;
}

function logLine(v, e) {
  const p = html`<strong>${pName(v, e.playerId)}</strong>`;
  const role = (i) => v.settings.roles[i] ?? `role ${i + 1}`;
  switch (e.kind) {
    case 'placed': return html`${p} placed ${charName(e.charId)} as ${role(e.role)}.`;
    case 'held': return html`${p} is holding ${charName(e.charId)}.`;
    case 'binned': return html`${p} binned ${charName(e.charId)}.`;
    case 'keptNew': return html`${p} kept ${charName(e.charId)} as ${role(e.role)}. ${charName(e.released)} ${e.releasedTo === 'bin' ? 'went in the bin' : 'went back on the wheel'}.`;
    case 'keptHeld': return html`${p} kept ${charName(e.charId)} as ${role(e.role)}. ${charName(e.released)} went in the bin.`;
    case 'timeout': return html`${p} ${e.reason === 'inactive' ? 'was skipped after disconnecting' : 'ran out of time'}.${e.returned ? html` ${charName(e.returned)} went back on the wheel.` : ''}`;
    case 'timeoutHeld': return html`${p} ran out of time. Their held ${charName(e.charId)} went in as ${role(e.role)}.`;
    case 'removed': return html`${p} left the game. Their characters went back on the wheel.`;
    case 'swapped': return html`${p} swapped their ${role(e.roles[0])} and ${role(e.roles[1])}.`;
    case 'binPick': return html`${p} picked ${charName(e.charId)} from the bin as ${role(e.role)}. ${charName(e.replaced)} went in the bin.`;
    case 'extraKept': return html`${p} took an extra spin and kept ${charName(e.charId)} as ${role(e.role)}. ${charName(e.replaced)} went in the bin.`;
    case 'extraDeclined': return html`${p} ${e.timedOut ? 'ran out of time on an extra spin' : 'let an extra spin go'}. ${charName(e.charId)} went in the bin.`;
    case 'goTimeout': return html`${p}’s time ran out.`;
    default: return '';
  }
}

function actionArea(v) {
  const d = v.draft;
  const t = d.turn;
  if (!t) return '';
  const mine = t.playerId === v.you;
  const who = pName(v, t.playerId);
  const revealed = t.spin && state.shownSpinId === t.spin.id;
  const binsLeft = d.binsLeft[v.you] ?? 0;
  const holdsLeft = d.holdsLeft[v.you] ?? 0;

  if (t.stage === 'spin') {
    const afterBin = t.usedBailout;
    return mine
      ? html`<p class="prompt">${afterBin ? 'Binned. Spin again — this time you must place who you land.' : 'Your turn. Spin the wheel!'}</p>
          <button class="btn btn-primary btn-block spin-btn" data-action="spin">Spin</button>`
      : html`<p class="prompt">Waiting for ${who} to spin…</p>`;
  }
  if (t.stage === 'held') {
    return html`${charCard(t.held, 'Holding')}
      ${mine ? html`<p class="prompt">Spin again. Then keep whichever is better.</p><button class="btn btn-primary btn-block spin-btn" data-action="spin">Spin again</button>`
        : html`<p class="prompt">${who} is holding ${charName(t.held)} and spinning again…</p>`}`;
  }
  if (!revealed) return html`${t.held != null ? charCard(t.held, 'Holding') : ''}<p class="prompt">Spinning…</p>`;

  if (t.stage === 'landed') {
    return html`${charCard(t.landed, mine ? 'You landed' : `${who} landed`)}
      ${mine ? html`
        <p class="prompt">Tap an empty role to place ${charName(t.landed)}.</p>
        <div class="bail">
          <button class="btn" data-action="hold" ${raw(t.usedBailout || holdsLeft < 1 ? 'disabled' : '')}>Hold <small>${holdsLeft} left</small></button>
          <button class="btn btn-danger" data-action="binIt" ${raw(t.usedBailout || binsLeft < 1 ? 'disabled' : '')}>Bin <small>${binsLeft} left</small></button>
        </div>
        ${t.usedBailout ? html`<p class="hint center">One hold or bin per turn. Place this one.</p>` : ''}`
      : html`<p class="prompt">${who} is choosing a role…</p>`}`;
  }
  // compare: holding one, second spin landed
  const heldGoes = v.settings.releasedHoldToBin ? 'goes in the bin' : 'goes back on the wheel';
  return html`
    <div class="compare">
      ${charCard(t.held, 'Held', { selectable: mine, choice: 'held', selected: mine && state.keepChoice === 'held' })}
      ${charCard(t.landed, 'New spin', { selectable: mine, choice: 'new', selected: mine && state.keepChoice === 'new' })}
    </div>
    ${mine ? html`<p class="prompt">Keep ${charName(state.keepChoice === 'held' ? t.held : t.landed)}, then tap an empty role.</p>
      <p class="hint center">${state.keepChoice === 'held' ? `${charName(t.landed)} goes in the bin.` : `${charName(t.held)} ${heldGoes}.`}</p>`
    : html`<p class="prompt">${who} is choosing between them…</p>`}`;
}

function countdownFor(deadline, total) {
  if (!deadline) return '';
  return html`<div class="countdown" data-deadline="${deadline}" data-total="${total}"><div class="bar"></div><span class="secs"></span></div>`;
}
function countdown(v) { return countdownFor(v.draft.turn?.deadline, v.draft.timerMs); }

function tickCountdown() {
  const el = document.querySelector('.countdown');
  if (!el) return;
  const left = Math.max(0, Number(el.dataset.deadline) - serverNow());
  const total = Number(el.dataset.total) || 1;
  el.querySelector('.bar').style.width = `${Math.min(100, (left / total) * 100)}%`;
  el.querySelector('.secs').textContent = `${Math.ceil(left / 1000)}s`;
  el.classList.toggle('urgent', left < 5000);
}
setInterval(tickCountdown, 250);

function draftPlayers(v) {
  const d = v.draft;
  const t = d.turn;
  return html`<ul class="list">${d.order.map((pid) => {
    const p = v.players.find((x) => x.id === pid);
    if (!p) return '';
    const team = d.teams[pid] || [];
    const filled = team.filter((x) => x != null).length;
    const isActive = t?.playerId === pid;
    const votes = v.kickVotes?.[pid];
    const canVote = pid !== v.you && (!p.connected || (isActive && !d.timerMs));
    const iVoted = votes?.voters?.includes(v.you);
    return html`<li class="${p.connected ? '' : 'away'}">
      <span class="grow">${p.name}${isActive ? html` <span class="badge">Turn</span>` : ''}${pid === v.you ? html` <span class="badge you">You</span>` : ''}</span>
      <span class="progress">${filled}/${d.roleCount}</span>
      ${canVote ? html`<button class="btn btn-small" data-action="voteKick" data-id="${pid}" ${raw(iVoted ? 'disabled' : '')}>${iVoted ? 'Voted' : 'Vote to remove'}${votes ? ` ${votes.votes}/${votes.needed}` : ''}</button>` : ''}
      ${v.isHost && pid !== v.you && state.confirmKick !== pid ? html`<button class="btn btn-small btn-danger" data-action="askKick" data-id="${pid}">Remove</button>` : ''}
    </li>
    ${state.confirmKick === pid ? html`<li><div class="inline-form"><p>Remove ${p.name}? Their characters go back on the wheel.</p>
      <div class="row-actions" style="justify-content:flex-start"><button class="btn btn-small btn-danger" data-action="kick" data-id="${pid}">Remove</button>
      <button class="btn btn-small" data-action="cancelKick">Cancel</button></div></div></li>` : ''}`;
  })}</ul>`;
}

function draftScreen(v) {
  const d = v.draft;
  const t = d.turn;
  const mine = t?.playerId === v.you;
  const revealed = t?.spin && state.shownSpinId === t.spin.id;
  const interactive = mine && revealed && (t.stage === 'landed' || t.stage === 'compare');
  const round = t ? (d.turnsTaken[t.playerId] ?? 0) + 1 : d.roleCount;
  const myBins = d.binsLeft[v.you];
  return html`
    <header class="turn-banner">
      <p class="round">Round ${round} of ${d.roleCount}</p>
      <h2>${mine ? 'Your turn' : `${pName(v, t?.playerId)}’s turn`}</h2>
      ${myBins !== undefined ? html`<p class="tokens"><span>Respins left: ${myBins}</span><span>Hold: ${d.holdsLeft[v.you]}</span></p>` : ''}
      ${countdown(v)}
    </header>
    <div class="draft-grid">
      <section class="wheel-col">
        <div id="wheel-slot"></div>
        <div class="action-area">${actionArea(v)}</div>
      </section>
      <section class="team-col">
        <div class="panel">
          <h3>${mine ? 'Your team' : `${pName(v, t?.playerId)}’s team`}</h3>
          ${t ? formation(v, t.playerId, { interactive }) : ''}
        </div>
        ${!mine && d.teams[v.you] ? html`<div class="panel"><h3>Your team</h3>${formation(v, v.you, { compact: true })}</div>` : ''}
        <div class="panel">
          <h3>What’s happened</h3>
          ${d.log.length ? html`<ul class="feed">${[...d.log].reverse().slice(0, 8).map((e) => html`<li>${logLine(v, e)}</li>`)}</ul>` : html`<p class="hint">Nothing yet. ${pName(v, t?.playerId)} spins first.</p>`}
        </div>
        <div class="panel">
          <h3>Players</h3>
          ${draftPlayers(v)}
        </div>
        <details class="panel all-teams">
          <summary><h3>All teams</h3></summary>
          ${d.order.map((pid) => html`<div class="mini-team"><p class="mini-name">${pName(v, pid)}</p>${formation(v, pid, { compact: true })}</div>`)}
        </details>
      </section>
    </div>`;
}

// ---------- end phase (phase 4) ----------
function endPhaseScreen(v) {
  const d = v.draft;
  const e = v.end;
  const go = e.go;
  const mine = go?.playerId === v.you;
  const who = pName(v, go?.playerId);
  const tokens = e.tokens[v.you] ?? 0;
  const revealed = go?.spin && state.shownSpinId === go.spin.id;
  const team = d.teams[go?.playerId] || [];
  const mode = go?.stage === 'extra' ? 'extra' : state.endMode;
  // Which roles are tappable for the active player right now.
  const canTap = (i) => mine && team[i] != null && (go.stage === 'extra' ? revealed : mode === 'swap' || (mode === 'bin' && state.binChoice));
  const tapLabel = go?.stage !== 'extra' && mode === 'swap' ? (state.endFirst === null ? 'Swap' : 'Swap with') : 'Replace';
  const formationEnd = html`<ol class="formation">${v.settings.roles.map((role, i) => {
    const id = team[i];
    const picked = mine && mode === 'swap' && state.endFirst === i;
    return html`<li class="${id == null ? 'empty' : ''} ${picked ? 'picked' : ''}">
      <span class="pos" aria-hidden="true">${i + 1}</span><span class="slot-role">${role}</span>
      ${canTap(i)
        ? html`<button class="btn btn-small ${picked ? '' : 'btn-primary'} place-btn" data-action="endRole" data-role="${i}">${picked ? `${charName(id)} — tap to cancel` : html`${tapLabel} ${charName(id)}`}</button>`
        : html`<span class="slot-char">${id == null ? 'Empty (can’t be filled)' : charName(id)}</span>`}
    </li>`;
  })}</ol>`;

  let controls;
  if (!go) controls = html`<p class="prompt">Getting the face-off ready…</p>`;
  else if (!mine) controls = html`<p class="prompt">${who} is making final changes to their team.</p>`;
  else if (go.stage === 'extra') {
    controls = revealed
      ? html`${charCard(go.landed, 'Extra spin')}
          <p class="prompt">Tap a role below to replace it with ${charName(go.landed)}, or let it go.</p>
          <button class="btn" data-action="declineExtra">Don’t keep ${charName(go.landed)}</button>`
      : html`<p class="prompt">Spinning…</p>`;
  } else {
    const bin = d.bin;
    controls = html`
      <p class="prompt">You have ${tokens} ${tokens === 1 ? 'token' : 'tokens'} to spend.</p>
      <div class="tabs end-tabs" role="tablist" aria-label="How to use a token">
        ${[['swap', 'Swap two'], ['bin', 'Pick from bin'], ['extra', 'Extra spin']].map(([k, label]) => html`
          <button class="tab" role="tab" aria-selected="${mode === k}" data-action="endMode" data-mode="${k}">${label}</button>`)}
      </div>
      ${mode === 'swap' ? html`<p class="hint center">${state.endFirst === null ? 'Tap the first role to swap.' : `Now tap the role to swap ${charName(team[state.endFirst])} with.`}</p>` : ''}
      ${mode === 'bin' ? (bin.length ? html`
        <p class="hint center">${state.binChoice ? `Now tap the role ${charName(state.binChoice)} should replace.` : 'Pick a character from the bin.'}</p>
        <ul class="bin-list">${bin.map((id) => html`<li><button class="chip ${state.binChoice === id ? 'on' : ''}" data-action="pickBinChar" data-id="${id}" aria-pressed="${state.binChoice === id}">${charName(id)}</button></li>`)}</ul>`
        : html`<p class="hint center">The bin is empty, so there’s nobody to pick.</p>`) : ''}
      ${mode === 'extra' ? html`<p class="hint center">Spin once more. If you like who you land, they replace one of your characters.</p>
        <button class="btn btn-primary spin-btn" data-action="extraSpin" ${raw(d.pool.length ? '' : 'disabled')}>Extra spin</button>` : ''}
      <button class="btn btn-ghost btn-small" data-action="endDone">I’m done${tokens ? ` (lose ${tokens} unused)` : ''}</button>`;
  }

  return html`
    <header class="turn-banner">
      <p class="round">Final changes</p>
      <h2>${mine ? 'Your go' : `${who}’s go`}</h2>
      ${tokens && !mine ? html`<p class="tokens"><span>Your tokens: ${tokens}</span></p>` : ''}
      ${countdownFor(go?.deadline, e.goMs)}
    </header>
    <div class="draft-grid">
      <section class="wheel-col">
        <div id="wheel-slot"></div>
        <div class="action-area">${controls}</div>
      </section>
      <section class="team-col">
        <div class="panel"><h3>${mine ? 'Your team' : `${who}’s team`}</h3>${formationEnd}</div>
        <div class="panel">
          <h3>What’s happened</h3>
          ${d.log.length ? html`<ul class="feed">${[...d.log].reverse().slice(0, 8).map((x) => html`<li>${logLine(v, x)}</li>`)}</ul>` : ''}
        </div>
        <details class="panel all-teams">
          <summary><h3>All teams</h3></summary>
          ${d.order.map((pid) => html`<div class="mini-team"><p class="mini-name">${pName(v, pid)} <small>${e.tokens[pid] ? `${e.tokens[pid]} token${e.tokens[pid] === 1 ? '' : 's'}` : ''}</small></p>${formation(v, pid, { compact: true })}</div>`)}
        </details>
      </section>
    </div>`;
}

// ---------- face-off (phase 5) ----------
function bracket(v) {
  const f = v.faceoff;
  return html`<div class="bracket">${f.rounds.map((r) => html`
    <div class="round-col">
      <p class="round-name">${r.matches.length === 1 && !r.bye && r === f.rounds[f.rounds.length - 1] && (f.finished || f.alive.length <= 2) ? 'Final' : `Round ${r.number}`}</p>
      ${r.matches.map((m) => html`<div class="b-match ${f.match?.id === m.id ? 'live' : ''}">
        <span class="${m.winner === m.a ? 'won' : m.winner ? 'lost' : ''}">${pName(v, m.a)}</span>
        <span class="${m.winner === m.b ? 'won' : m.winner ? 'lost' : ''}">${pName(v, m.b)}</span>
      </div>`)}
      ${r.bye ? html`<div class="b-match bye"><span>${pName(v, r.bye)}</span><small>Bye</small></div>` : ''}
    </div>`)}</div>`;
}

function matchView(v) {
  const f = v.faceoff;
  const m = f.match;
  if (!m) return '';
  const A = pName(v, m.a); const B = pName(v, m.b);
  const battling = v.you === m.a || v.you === m.b;
  const canVote = m.stage === 'voting' && !battling && m.voters.includes(v.you) && !m.myBallot;
  const myPicks = state.ballots[m.id] || {};
  const judging = m.stage === 'judging' && m.judge.id === v.you;
  const jd = state.judgeDecision[m.id] || {};
  const roleName = (i) => v.settings.roles[i];
  const cell = (p, side) => {
    const id = side === 'a' ? p.a : p.b;
    const name = id == null ? 'Empty' : charName(id);
    if (canVote && p.auto === null) {
      return html`<button class="vote-pick ${myPicks[p.role] === side ? 'on' : ''}" data-action="pickVote" data-role="${p.role}" data-side="${side}" aria-pressed="${myPicks[p.role] === side}">${name}</button>`;
    }
    if (judging && m.judge.kind === 'pairings' && m.judge.roles.includes(p.role)) {
      return html`<button class="vote-pick ${jd[p.role] === side ? 'on' : ''}" data-action="pickJudge" data-role="${p.role}" data-side="${side}" aria-pressed="${jd[p.role] === side}">${name}</button>`;
    }
    const won = p.winner === side;
    return html`<span class="pick-static ${id == null ? 'none' : ''} ${won ? 'won' : ''}">${name}${p.votes ? html` <small>${p.votes[side]}</small>` : ''}</span>`;
  };
  const allPicked = m.pairings.filter((p) => p.auto === null).every((p) => myPicks[p.role]);
  const judgeComplete = m.judge?.kind === 'pairings' && m.judge.roles.every((r) => jd[r]);
  let status;
  if (m.paused) {
    const who = m.waitingFor.map((id) => pName(v, id)).join(' or ');
    status = html`<p class="prompt">Paused: waiting for ${who} to reconnect.</p>
      <p class="hint center">Only ${who} can ${m.stage === 'judging' ? 'judge' : 'vote on'} this match, so it carries on when they’re back. If they’ve gone for good, vote to remove them below.</p>`;
  } else if (m.stage === 'voting') {
    status = canVote
      ? html`<button class="btn btn-primary btn-block" data-action="submitVote" ${raw(allPicked ? '' : 'disabled')}>Submit votes</button>
          ${allPicked ? '' : html`<p class="hint center">Pick a winner in every row.</p>`}`
      : html`<p class="prompt">${battling ? 'You’re battling, so you sit this vote out.' : m.myBallot ? 'Votes in. Waiting for the others.' : 'Waiting for votes.'} ${m.voted.length}/${m.voters.length} voted.</p>`;
  } else if (m.stage === 'judging') {
    const judgeName = pName(v, m.judge.id);
    if (!judging) status = html`<p class="prompt">It’s a tie. ${judgeName} is deciding.</p>`;
    else if (m.judge.kind === 'pairings') status = html`<p class="prompt">You’re the judge. Pick the winner of each tied row.</p><button class="btn btn-primary btn-block" data-action="submitJudge" ${raw(judgeComplete ? '' : 'disabled')}>Decide</button>`;
    else status = html`<p class="prompt">You’re the judge. The match is level. Who wins?</p>
      <div class="bail"><button class="btn btn-primary" data-action="submitJudge" data-side="a">${A}</button><button class="btn btn-primary" data-action="submitJudge" data-side="b">${B}</button></div>`;
  } else {
    const w = pName(v, m.winner);
    status = html`<p class="match-winner">${m.winner ? `${w} wins${m.score ? ` ${Math.max(m.score.a, m.score.b)}–${Math.min(m.score.a, m.score.b)}` : ''}` : 'No winner'}</p>
      ${m.walkover ? html`<p class="hint center">Won by walkover: the other player left.</p>` : ''}
      ${m.judged ? html`<p class="hint center">Decided by the judge after a tie.</p>` : ''}
      ${m.noJudge ? html`<p class="hint center">Nobody outside this match was left to vote, so it was decided ${m.coinToss ? 'by a coin toss' : 'by the votes counted and filled roles'}.</p>` : ''}
      ${m.standIn ? html`<p class="hint center">${pName(v, m.standIn.by)} stood in for ${m.standIn.count} missing ${m.standIn.count === 1 ? 'vote' : 'votes'}.</p>` : ''}
      ${v.isHost ? html`<button class="btn btn-small" data-action="nextMatch">Next match now</button>` : ''}`;
  }
  return html`
    <section class="panel match">
      <div class="match-head"><span class="team-a">${A}</span><span class="vs">vs</span><span class="team-b">${B}</span></div>
      ${countdownFor(m.deadline, m.stage === 'voting' ? f.voteMs : m.stage === 'judging' ? 60_000 : 12_000)}
      <table class="pairings">
        <thead><tr><th scope="col">Role</th><th scope="col">${A}</th><th scope="col">${B}</th></tr></thead>
        <tbody>${m.pairings.map((p) => html`<tr>
          <th scope="row">${roleName(p.role)}${p.auto && p.auto !== 'none' ? html`<small>Automatic</small>` : p.auto === 'none' ? html`<small>No point</small>` : p.judged ? html`<small>Judge’s call</small>` : ''}</th>
          <td>${cell(p, 'a')}</td><td>${cell(p, 'b')}</td></tr>`)}</tbody>
      </table>
      <div class="match-status">${status}</div>
    </section>`;
}

function faceoffPlayers(v) {
  const away = v.players.filter((p) => !p.connected);
  if (!away.length) return '';
  return html`<section class="panel"><h3>Disconnected</h3><ul class="list">${away.map((p) => {
    const votes = v.kickVotes?.[p.id];
    const iVoted = votes?.voters?.includes(v.you);
    return html`<li class="away"><span class="grow">${p.name}</span>
      <button class="btn btn-small" data-action="voteKick" data-id="${p.id}" ${raw(iVoted ? 'disabled' : '')}>${iVoted ? 'Voted' : 'Vote to remove'}${votes ? ` ${votes.votes}/${votes.needed}` : ''}</button></li>`;
  })}</ul></section>`;
}

function faceoffScreen(v) {
  const f = v.faceoff;
  const out = v.draft.order.filter((pid) => !f.alive.includes(pid) && v.players.some((p) => p.id === pid));
  return html`
    <header class="turn-banner"><p class="round">Face-off</p><h2>${f.match ? `${pName(v, f.match.a)} vs ${pName(v, f.match.b)}` : 'Next match…'}</h2></header>
    <div class="stack">
      ${matchView(v)}
      <section class="panel"><h3>Bracket</h3>${bracket(v)}</section>
      ${faceoffPlayers(v)}
      ${out.length ? html`<p class="why center">Knocked out: ${out.map((id) => pName(v, id)).join(', ')}. Knocked-out players still vote on the other matches.</p>` : ''}
    </div>`;
}

// ---------- champion (phase 6) ----------
const TROPHY = `<svg class="trophy" viewBox="0 0 120 130" role="img" aria-label="Trophy">
  <path d="M30 14h60v26c0 22-13 38-30 38S30 62 30 40z" fill="#ffc93c" stroke="#1b1530" stroke-width="5" stroke-linejoin="round"/>
  <path d="M30 22H14c0 18 8 28 20 30M90 22h16c0 18-8 28-20 30" fill="none" stroke="#1b1530" stroke-width="5" stroke-linecap="round"/>
  <path d="M52 78h16v16H52z" fill="#e0a800" stroke="#1b1530" stroke-width="5" stroke-linejoin="round"/>
  <path d="M34 94h52l6 16H28z" fill="#ff4f79" stroke="#1b1530" stroke-width="5" stroke-linejoin="round"/>
  <path d="M24 110h72v12H24z" fill="#1b1530"/>
  <path d="m60 28 5 10 11 2-8 8 2 11-10-5-10 5 2-11-8-8 11-2z" fill="#fbf8ff" stroke="#1b1530" stroke-width="3" stroke-linejoin="round"/>
</svg>`;

function launchConfetti(key) {
  if (state.confettiKey === key) return;
  state.confettiKey = key;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ffc93c', '#ff4f79', '#2bb3a3', '#8f7cf7', '#fbf8ff', '#ff8a3d'];
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 110; i += 1) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 1.2}s`;
    p.style.animationDuration = `${2.6 + Math.random() * 2}s`;
    p.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    p.style.setProperty('--spin', `${(Math.random() - 0.5) * 1440}deg`);
    if (i % 3 === 0) p.style.borderRadius = '50%';
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 7000);
}

function finishedScreen(v) {
  const f = v.faceoff;
  const champ = f?.champion;
  const isMe = champ === v.you;
  const host = v.players.find((p) => p.isHost);
  const here = v.players.filter((p) => p.connected).length;
  setTimeout(() => launchConfetti(`${v.id}:${v.game}`), 0);
  return html`
    <section class="champion">
      ${raw(TROPHY)}
      <p class="champ-label">Champion</p>
      <h2 class="champ-name">${champ ? (isMe ? 'You win!' : pName(v, champ)) : 'No champion'}</h2>
      <p class="champ-sub">${champ ? (isMe ? 'Your squad beat everyone. Enjoy the bragging rights.' : `${pName(v, champ)} wins ${v.settings.roomName}.`) : 'Everyone left before the final.'}</p>
    </section>
    <div class="stack">
      ${champ && v.draft?.teams[champ] ? html`<section class="panel"><h3>The winning team</h3>${formation(v, champ, { compact: true })}</section>` : ''}
      <section class="panel"><h3>Final bracket</h3>${bracket(v)}</section>
    </div>
    <div class="start-zone">
      ${v.isHost ? html`
        <button class="btn btn-primary btn-block" data-action="restart" ${raw(here < 3 ? 'disabled' : '')}>Play again</button>
        <p class="why">${here < 3 ? `A rematch needs at least 3 players. ${here} ${here === 1 ? 'is' : 'are'} here.` : 'Same players, roles and characters. The bin is cleared and the wheel starts full.'}</p>`
      : html`<p class="why">Waiting for ${host?.name} to start a rematch.</p>`}
      <button class="btn btn-ghost btn-small" style="margin-top:18px" data-action="leave">Leave game</button>
    </div>`;
}

// Keeps the persistent wheel in step with the server: segments, and the spin animation.
function syncWheel(v) {
  const slot = document.getElementById('wheel-slot');
  if (!slot) return;
  if (!state.wheel) state.wheel = new Wheel();
  const w = state.wheel;
  if (w.el.parentNode !== slot) slot.appendChild(w.el);
  const d = v.draft;
  charById();
  const names = state.charNameMap; // rebuilt per list, so the wheel redraws its labels when it changes
  let spin = null;
  let held = null;
  if (v.phase === 'draft') {
    const t = d.turn;
    if (t?.spin && (t.stage === 'landed' || t.stage === 'compare')) spin = t.spin;
    held = t?.held ?? null;
  } else if (v.phase === 'endphase' && v.end?.go?.stage === 'extra') spin = v.end.go.spin;
  if (spin) {
    w.setSegments(spin.wheel, names);
    loadImage(spin.landed);
    if (state.shownSpinId !== spin.id && state.animatingSpin !== spin.id) {
      state.animatingSpin = spin.id;
      w.spinTo(spin.landed, {
        duration: d.spinMs, elapsed: serverNow() - spin.at, seed: spin.id,
        onDone: () => { state.shownSpinId = spin.id; state.animatingSpin = null; render(); },
      });
    } else if (!w.spinning) w.showName(charName(spin.landed));
  } else {
    w.setSegments(d.pool, names);
    if (!w.spinning) w.showName(held != null ? `Holding ${charName(held)}` : '');
  }
}

function offlineBar() {
  return socket.connected ? '' : html`<div class="panel" role="alert" style="margin-bottom:16px;background:var(--pink);color:#fff;text-align:center;padding:10px">Connection lost. Reconnecting…</div>`;
}

function render() {
  let body;
  switch (state.screen) {
    case 'create': body = createScreen(); break;
    case 'browse': body = browseScreen(); break;
    case 'name': body = nameScreen(); break;
    case 'waiting': body = waitingScreen(); break;
    case 'notice': body = noticeScreen(); break;
    case 'room': {
      const v = state.view;
      if (!v) body = html`<p>Loading…</p>`;
      else if (v.phase === 'lobby') body = lobbyScreen(v);
      else if (v.phase === 'draft') body = draftScreen(v);
      else if (v.phase === 'endphase') body = endPhaseScreen(v);
      else if (v.phase === 'faceoff') body = faceoffScreen(v);
      else body = finishedScreen(v);
      break;
    }
    default: body = homeScreen();
  }
  // Keep focus and cursor position across re-renders.
  const active = document.activeElement;
  const key = active?.dataset?.field || active?.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const wheelPhase = state.screen === 'room' && ['draft', 'endphase'].includes(state.view?.phase);
  $app.classList.toggle('wide', wheelPhase);
  $app.innerHTML = fmt(html`${state.screen === 'room' ? offlineBar() : ''}${body}`);
  if (wheelPhase) syncWheel(state.view);
  tickCountdown();
  if (key) {
    const el = $app.querySelector(`[data-field="${CSS.escape(key)}"]`) || document.getElementById(key);
    if (el && el.type !== 'radio') { el.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(...sel); } catch { /* number inputs */ } }
  }
}

route();
