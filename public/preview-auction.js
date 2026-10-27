// Auction preview (iteration 2 mock-up). Runs entirely in the browser: you bid against computer players.
// Rules follow the agreed spec (sections 14–16): tier opening prices, 10 s bid timer restarting on each bid,
// raises of +1 under 10 and +2 from 10, roles + 3 bench, full squads swap out to the market, unsold to market.
// Not in the preview: the trade phase and market buying/selling (shown as "coming next").
import { Wheel } from '/wheel.js';

const TIERS = { Diamond: 7, Gold: 5, Silver: 3, Bronze: 1 };
const ROLE_NAMES = {
  5: ['Captain', 'Vice captain', 'Strategist', 'Support', 'Wildcard'],
  10: ['Captain', 'Vice captain', 'Strategist', 'Swordsman', 'Navigator', 'Sniper', 'Doctor', 'Shipwright', 'Musician', 'Wildcard'],
};
const BOT_NAMES = ['Bee', 'Nami-chan', 'Zolo', 'Kuma', 'Yasopp Jr'];
const BENCH = 3;
const BID_MS = 10_000;
const SPIN_MS = 3500;

const $view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rand = (n) => Math.floor(Math.random() * n);
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i -= 1) { const j = rand(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const step = (bid) => (bid < 10 ? 1 : 2);

let chars = [];
const byId = new Map();
const setup = { name: 'Ste', funds: 100, currency: 'Beli', roles: 5, bots: 3 };
let g = null; // the game
let wheel = null;

function money(n) {
  if (setup.currency === 'Beli') return `฿${n}M`;
  return `${setup.currency}${n}`;
}
const tierChip = (t) => `<span class="tier t-${t}">${t}</span>`;
const thumb = (c) => `<span class="thumb t-${c.tier}">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;

// ---------------- setup ----------------
function renderSetup() {
  const pick = (key, opts, fmt = (x) => x) => `<div class="pick" role="group">${opts.map((o) => `<button type="button" class="btn btn-small" data-set="${key}" data-val="${o}" aria-pressed="${String(setup[key]) === String(o)}">${fmt(o)}</button>`).join('')}</div>`;
  $view.innerHTML = `
    <section class="setup"><div class="panel">
      <label class="field"><span class="label">Your name</span><input type="text" id="pv-name" value="${esc(setup.name)}" maxlength="20"></label>
      <div><span class="label">Funds per player</span>${pick('funds', [50, 60, 70, 80, 90, 100])}</div>
      <div><span class="label">Currency</span>${pick('currency', ['£', '$', '€', '¥', 'Beli'])}
        <p class="hint" style="margin:6px 0 0">Beli is counted in millions: everyone starts with ฿${setup.funds}M.</p></div>
      <div class="row2">
        <div><span class="label">Roles</span>${pick('roles', [5, 10])}</div>
        <div><span class="label">Computer players</span>${pick('bots', [2, 3, 4, 5])}</div>
      </div>
      <p class="hint" style="margin:0">Auction lot: ${lotSize()} characters (${setup.roles} roles × ${setup.bots + 1} players + 20%), drawn at random from ${chars.length} One Piece characters.</p>
      <button class="btn btn-primary" id="pv-start">Start the auction</button>
    </div></section>`;
}
const lotSize = () => Math.ceil(setup.roles * (setup.bots + 1) * 1.2);

$view.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.set) {
    const v = b.dataset.val;
    setup[b.dataset.set] = Number.isNaN(Number(v)) ? v : Number(v);
    setup.name = document.getElementById('pv-name')?.value || setup.name;
    renderSetup();
  } else if (b.id === 'pv-start') { setup.name = document.getElementById('pv-name').value.trim() || 'You'; start(); }
  else if (b.dataset.act) actions[b.dataset.act](b);
});

// ---------------- game ----------------
function start() {
  const players = [{ id: 'you', name: setup.name, bot: false }, ...BOT_NAMES.slice(0, setup.bots).map((n, i) => ({ id: `b${i}`, name: n, bot: true }))];
  for (const p of players) {
    p.funds = setup.funds;
    p.roles = Array(setup.roles).fill(null); // { id, paid }
    p.bench = Array(BENCH).fill(null);
    if (p.bot) p.greed = 0.8 + Math.random() * 0.9; // how far over the opening price this bot will go
  }
  g = {
    players, lot: shuffle(chars).slice(0, lotSize()).map((c) => c.id), done: [], market: [], log: [],
    stage: 'spin', current: null, bid: 0, leader: null, endsAt: 0, landedAt: 0, pending: null, timers: [],
  };
  renderGame();
  setTimeout(spinNext, 600);
}
const you = () => g.players[0];
const owned = (p) => [...p.roles, ...p.bench].filter(Boolean);
const full = (p) => owned(p).length === p.roles.length + BENCH;
const note = (html) => { g.log.unshift(html); g.log = g.log.slice(0, 12); };
const clearTimers = () => { g.timers.forEach(clearTimeout); g.timers = []; };

function spinNext() {
  clearTimers();
  if (!g.lot.length) { g.stage = 'end'; renderGame(); return; }
  g.stage = 'spinning'; g.bid = 0; g.leader = null; g.pending = null;
  const landed = g.lot[rand(g.lot.length)];
  g.current = landed;
  renderGame();
  const names = new Map(g.lot.map((id) => [id, byId.get(id).name]));
  wheel.setSegments(g.lot, names);
  wheel.spinTo(landed, { duration: SPIN_MS, seed: g.done.length + 1, onDone: () => {
    g.stage = 'bidding'; g.landedAt = Date.now(); g.endsAt = g.landedAt + BID_MS;
    renderGame();
    scheduleBots();
    tick();
  } });
}

function tick() {
  if (g.stage !== 'bidding') return;
  if (Date.now() >= g.endsAt) { closeLot(); return; }
  updateTimer();
  g.timers.push(setTimeout(tick, 200));
}

function placeBid(p, amount) {
  const c = byId.get(g.current);
  const min = g.leader ? g.bid + step(g.bid) : TIERS[c.tier];
  if (g.stage !== 'bidding') return 'Bidding is closed.';
  if (g.leader === p.id) return 'You already hold the top bid.';
  if (!Number.isInteger(amount) || amount < min) return `The lowest bid now is ${money(min)}.`;
  if (amount > p.funds) return `You only have ${money(p.funds)}.`;
  g.bid = amount; g.leader = p.id; g.endsAt = Date.now() + BID_MS;
  note(`<b>${esc(p.name)}</b> bid ${money(amount)} on ${esc(c.name)}`);
  renderGame();
  scheduleBots();
  return null;
}

// Simple computer bidders: each values a character at its opening price × their greed (more for Diamond/Gold),
// never spends what they don't have, and bids after a short human-like pause.
function scheduleBots() {
  const c = byId.get(g.current);
  for (const p of g.players.filter((x) => x.bot && x.id !== g.leader)) {
    const base = TIERS[c.tier];
    const want = Math.floor(base * p.greed * (c.tier === 'Diamond' ? 2.4 : c.tier === 'Gold' ? 1.8 : 1.3) + rand(3));
    const emptyRoles = p.roles.filter((x) => !x).length;
    const reserve = Math.max(0, emptyRoles - 1); // bots keep ~1 per empty role, so they don't strand themselves
    const cap = Math.min(want, p.funds - reserve);
    const next = g.leader ? g.bid + step(g.bid) : base;
    if (next > cap || (full(p) && Math.random() < 0.7)) continue;
    const delay = 900 + rand(Math.min(7000, Math.max(1200, g.endsAt - Date.now() - 600)));
    g.timers.push(setTimeout(() => { if (g.stage === 'bidding' && g.leader !== p.id) placeBid(p, next); }, delay));
  }
}

function closeLot() {
  clearTimers();
  const c = byId.get(g.current);
  g.lot = g.lot.filter((id) => id !== c.id);
  if (!g.leader) {
    g.market.push(c.id);
    note(`Nobody bid on ${esc(c.name)}. It goes to the market.`);
    g.done.push(c.id);
    g.stage = 'result'; renderGame();
    g.timers.push(setTimeout(spinNext, 1800));
    return;
  }
  const p = g.players.find((x) => x.id === g.leader);
  p.funds -= g.bid;
  note(`<b>${esc(p.name)}</b> won ${esc(c.name)} for ${money(g.bid)}`);
  g.done.push(c.id);
  const item = { id: c.id, paid: g.bid };
  if (p.bot) { botPlace(p, item); g.stage = 'result'; renderGame(); g.timers.push(setTimeout(spinNext, 2200)); return; }
  g.stage = 'placing'; g.pending = item; renderGame();
}

function botPlace(p, item) {
  let i = p.roles.indexOf(null);
  if (i >= 0) { p.roles[i] = item; return; }
  i = p.bench.indexOf(null);
  if (i >= 0) { p.bench[i] = item; return; }
  // Full: drop the weakest bench character to the market.
  const order = ['Bronze', 'Silver', 'Gold', 'Diamond'];
  let worst = 0;
  p.bench.forEach((x, k) => { if (order.indexOf(byId.get(x.id).tier) < order.indexOf(byId.get(p.bench[worst].id).tier)) worst = k; });
  g.market.push(p.bench[worst].id);
  note(`${esc(p.name)} swapped ${esc(byId.get(p.bench[worst].id).name)} out to the market`);
  p.bench[worst] = item;
}

// ---------------- your actions ----------------
let selected = null; // for rearranging: { area, i }
const actions = {
  bidOpen() { const c = byId.get(g.current); flash(placeBid(you(), TIERS[c.tier])); },
  raise() { flash(placeBid(you(), g.bid + step(g.bid))); },
  bidAmount() {
    const raw = document.getElementById('pv-amount').value.trim().replace(/[,฿£$€¥\s]/g, '');
    let n = Number(raw);
    flash(placeBid(you(), n));
  },
  slot(b) {
    const area = b.dataset.area; const i = Number(b.dataset.i);
    const p = you();
    if (g.stage === 'placing' && g.pending) {
      const old = p[area][i];
      if (old) { g.market.push(old.id); note(`${esc(p.name)} swapped ${esc(byId.get(old.id).name)} out to the market`); }
      p[area][i] = g.pending; g.pending = null; g.stage = 'result';
      renderGame();
      g.timers.push(setTimeout(spinNext, 1200));
      return;
    }
    // Free rearranging: tap one slot, then another, to swap them.
    if (!selected) { if (p[area][i]) { selected = { area, i }; renderGame(); } return; }
    const a = p[selected.area][selected.i];
    p[selected.area][selected.i] = p[area][i];
    p[area][i] = a;
    selected = null; renderGame();
  },
  again() { start(); },
  setupAgain() { clearTimers(); g = null; renderSetup(); },
};
function flash(err) { if (err) { const el = document.getElementById('pv-msg'); if (el) el.textContent = err; } }

// ---------------- rendering ----------------
function lotCard() {
  const c = g.current && byId.get(g.current);
  if (!c || g.stage === 'spinning') return '<p class="hint center" style="color:var(--on-dark-muted)">Spinning for the next character…</p>';
  const leader = g.players.find((x) => x.id === g.leader);
  const won = g.stage !== 'bidding' && leader;
  return `<div class="lot t-${c.tier} ${won ? 'won' : ''}">
    <div class="pic">${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'No picture',className:'hint'}))">` : ''}</div>
    <div>
      ${tierChip(c.tier)}
      <h2>${esc(c.name)}</h2>
      <p class="open">Opening price ${money(TIERS[c.tier])}</p>
      <p class="bidline">${leader ? `${won ? 'Sold to' : 'Top bid'} <b>${esc(leader.name)}</b>: <strong>${money(g.bid)}</strong>` : g.stage === 'bidding' ? 'No bids yet' : '<b>Unsold</b>: goes to the market'}</p>
    </div>
  </div>`;
}

function controls() {
  if (g.stage === 'placing') return `<p class="place-prompt">You won ${esc(byId.get(g.pending.id).name)}. Tap a role or bench spot in your squad to place them${full(you()) ? '. Your squad is full, so whoever you replace goes to the market' : ''}.</p>`;
  if (g.stage !== 'bidding') return '';
  const c = byId.get(g.current);
  const p = you();
  const leading = g.leader === p.id;
  const next = g.leader ? g.bid + step(g.bid) : TIERS[c.tier];
  const can = !leading && next <= p.funds;
  return `<div class="bid-controls">
    <div class="timer" id="pv-timer"><i style="width:100%"></i></div>
    <p class="timer-label" id="pv-timer-label">10s</p>
    ${g.leader
      ? `<button class="btn btn-primary main" data-act="raise" ${can ? '' : 'disabled'}>${leading ? 'You hold the top bid' : `Raise to ${money(next)}`}</button>`
      : `<button class="btn btn-primary main" data-act="bidOpen" ${can ? '' : 'disabled'}>Bid ${money(next)}</button>`}
    <div class="amount">
      <input type="text" id="pv-amount" inputmode="numeric" placeholder="Or type an amount (${money(next)} or more)" aria-label="Bid amount">
      <button class="btn btn-small" data-act="bidAmount" ${leading ? 'disabled' : ''}>Bid</button>
    </div>
    <p class="hint center" id="pv-msg" style="color:var(--on-dark-muted);margin:0">${next > p.funds && !leading ? `You have ${money(p.funds)}: not enough to bid.` : `Raises go up by ${money(step(g.bid || TIERS[c.tier]))} at this price.`}</p>
  </div>`;
}

function updateTimer() {
  const left = Math.max(0, g.endsAt - Date.now());
  const bar = document.getElementById('pv-timer');
  if (!bar) return;
  bar.firstElementChild.style.width = `${(left / BID_MS) * 100}%`;
  bar.classList.toggle('low', left < 3000);
  document.getElementById('pv-timer-label').textContent = `${Math.ceil(left / 1000)}s${g.leader ? '' : ' to open the bidding'}`;
}

function squad(p) {
  const row = (area, i, item, label) => {
    const c = item && byId.get(item.id);
    const tap = g.stage === 'placing' || item || selected;
    const sel = selected && selected.area === area && selected.i === i;
    return `<li class="${area === 'bench' ? 'bench' : ''}">
      ${c ? thumb(c) : '<span class="thumb"></span>'}
      <span class="role">${label}</span>
      <span class="who ${c ? '' : 'empty'}">${c ? `${esc(c.name)} ${tierChip(c.tier)}` : 'Empty'}</span>
      ${tap ? `<button class="btn btn-small ${sel ? 'btn-primary' : ''}" data-act="slot" data-area="${area}" data-i="${i}">${g.stage === 'placing' ? (c ? 'Replace' : 'Place') : sel ? 'Cancel' : selected ? 'Move here' : 'Move'}</button>` : '<span></span>'}
    </li>`;
  };
  return `<ul class="slots">
    ${p.roles.map((x, i) => row('roles', i, x, ROLE_NAMES[setup.roles][i])).join('')}
    ${p.bench.map((x, i) => row('bench', i, x, `Bench ${i + 1}`)).join('')}
  </ul>`;
}

function playersList() {
  return `<ul class="players">${g.players.map((p) => `<li>
    <span class="nm">${esc(p.name)}${p.bot ? '' : ' (you)'}${g.leader === p.id && g.stage === 'bidding' ? ' · top bid' : ''}</span>
    <span class="funds">${money(p.funds)}</span>
    <span class="mini">${p.roles.filter(Boolean).map((x) => `<span class="chipc t-${byId.get(x.id).tier}">${esc(byId.get(x.id).name)}</span>`).join('')}${p.bench.filter(Boolean).map((x) => `<span class="chipc bench t-${byId.get(x.id).tier}">${esc(byId.get(x.id).name)}</span>`).join('')}</span>
  </li>`).join('')}</ul>`;
}

function endScreen() {
  const rows = g.players.map((p) => {
    const filled = p.roles.filter(Boolean).length;
    return `<li><span class="nm">${esc(p.name)}</span><span class="funds">${filled}/${p.roles.length} roles · ${money(p.funds)} left</span>
      <span class="mini">${p.roles.filter(Boolean).map((x) => `<span class="chipc t-${byId.get(x.id).tier}">${esc(byId.get(x.id).name)}</span>`).join('')}</span></li>`;
  }).join('');
  return `<div class="panel end">
    <h2>Auction over</h2>
    <p>Next in the real game: the trade phase. Players swap characters and funds, buy up to 2 from the market (full squads only) and sell to it for half price. Then the tournament.</p>
    <ul class="players">${rows}</ul>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn btn-primary" data-act="again">Play again</button><button class="btn" data-act="setupAgain">Change settings</button></div>
  </div>`;
}

function renderGame() {
  if (!g) return;
  if (!wheel) wheel = new Wheel();
  const p = you();
  const typed = document.getElementById('pv-amount')?.value || '';
  const total = g.done.length + g.lot.length;
  const number = Math.min(total, g.done.length + (['result', 'end', 'placing'].includes(g.stage) ? 0 : 1));
  $view.innerHTML = `
    <div class="grid">
      <section class="left">
        <div class="status"><span>Character ${Math.max(1, number)} of ${total}</span><span>Your funds ${money(p.funds)}</span><span>${setup.roles} roles + ${BENCH} bench</span></div>
        <div id="wheel-slot"></div>
        ${g.stage === 'end' ? endScreen() : `${lotCard()}${controls()}`}
      </section>
      <section class="right">
        <div class="panel"><h3>Your squad</h3>${selected ? '<p class="hint" style="margin:0 0 8px">Now tap where they should go.</p>' : ''}${squad(p)}</div>
        <div class="panel"><h3>Players</h3>${playersList()}</div>
        <div class="panel"><h3>Market (${g.market.length})</h3>${g.market.length ? `<div class="market">${g.market.map((id) => `<span class="chipc t-${byId.get(id).tier}">${esc(byId.get(id).name)}</span>`).join('')}</div>` : '<p class="hint" style="margin:0">Unsold and swapped-out characters land here. In the real game they can be bought in the trade phase.</p>'}</div>
        <div class="panel"><h3>What’s happened</h3>${g.log.length ? `<ul class="feed">${g.log.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p class="hint" style="margin:0">Bids and wins appear here.</p>'}</div>
      </section>
    </div>`;
  document.getElementById('wheel-slot').appendChild(wheel.el);
  if (!wheel.spinning) wheel.setSegments(g.lot.length ? g.lot : g.done, new Map(chars.map((c) => [c.id, c.name])));
  if (g.stage === 'bidding') updateTimer();
  const amt = document.getElementById('pv-amount');
  if (amt && typed) amt.value = typed;
}

// ---------------- load ----------------
fetch('/preview-onepiece.json').then((r) => r.json()).then((list) => {
  chars = list;
  for (const c of chars) byId.set(c.id, c);
  renderSetup();
}).catch(() => { $view.innerHTML = '<p>Couldn’t load the character list. Refresh to try again.</p>'; });
