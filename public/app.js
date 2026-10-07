// Battle Draft client. Renders screens from server state; the server decides everything that matters.
/* global io */

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
  form: {
    name: store.get('bd-name') || '', roomName: '', visibility: 'private', roleCount: 5,
    roles: Array(10).fill(''), cap: 8, turnOrder: 'join', releasedHoldToBin: 'yes', timer: 'off',
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
  state.view = null; state.roomId = null;
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
  state.view = view;
  state.roomId = view.id;
  if (state.screen !== 'room') { state.screen = 'room'; state.error = ''; window.scrollTo(0, 0); }
  if (state.confirmKick && !view.players.some((p) => p.id === state.confirmKick)) state.confirmKick = null;
  if (state.reportFor && !view.players.some((p) => p.id === state.reportFor)) state.reportFor = null;
  render();
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
  async leave() {
    await emit('leave');
    state.view = null; state.roomId = null;
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

      <section class="panel">
        <h3>Characters</h3>
        <p class="hint">Loading the character list arrives in the next build phase.</p>
      </section>
    </div>

    <div class="start-zone">
      ${v.isHost ? html`
        <button class="btn btn-primary btn-block" data-action="start" ${raw(v.startBlockers.length ? 'disabled' : '')}>Start the draft</button>
        ${v.startBlockers.length ? html`<p class="why">${v.startBlockers[0]}</p>` : ''}`
      : html`<p class="why">Waiting for ${host?.name} to start the draft.</p>`}
      <button class="btn btn-ghost btn-small" style="margin-top:18px" data-action="leave">Leave game</button>
    </div>`;
}

function draftScreen(v) {
  const name = (id) => v.players.find((p) => p.id === id)?.name ?? 'Left the game';
  return html`
    <header class="lobby-title"><h2>The draft has begun</h2><p>${v.settings.roomName}</p></header>
    <section class="panel">
      <h3>Turn order</h3>
      <ol class="role-list">${v.turnOrder.map((id, i) => html`<li><span class="pos" aria-hidden="true">${i + 1}</span><span>${name(id)}${id === v.you ? ' (you)' : ''}</span></li>`)}</ol>
      <p class="hint" style="margin-top:14px">The wheel arrives in build phase 3.</p>
    </section>`;
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
    case 'room': body = state.view?.phase === 'lobby' ? lobbyScreen(state.view) : state.view ? draftScreen(state.view) : html`<p>Loading…</p>`; break;
    default: body = homeScreen();
  }
  // Keep focus and cursor position across re-renders.
  const active = document.activeElement;
  const key = active?.dataset?.field || active?.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  $app.innerHTML = fmt(html`${state.screen === 'room' ? offlineBar() : ''}${body}`);
  if (key) {
    const el = $app.querySelector(`[data-field="${CSS.escape(key)}"]`) || document.getElementById(key);
    if (el && el.type !== 'radio') { el.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(...sel); } catch { /* number inputs */ } }
  }
}

route();
