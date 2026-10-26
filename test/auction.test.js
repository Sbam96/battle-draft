// Iteration 2: auction settings, auction, trade phase and market (sections 14, 16, 17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, validateSettings } from '../src/room.js';
import { Auction, raiseStep, RESULT_MS } from '../src/auction.js';
import { TradePhase } from '../src/trade.js';
import { auctionLotSize, BID_MS, TRADE_MIN_MS, PROPOSAL_MS } from '../src/config.js';
import { SPIN_MS } from '../src/draft.js';

const T0 = 1_000_000;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const base = (over = {}) => ({ roomName: 'Auction night', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 8, turnOrder: 'join', gameType: 'auction', ...over });
const TIERS = ['Diamond', 'Gold', 'Silver', 'Bronze'];

// A bare auction: lot c1..cN, tiers cycle Diamond, Gold, Silver, Bronze unless given.
function auction({ players = ['A', 'B', 'C'], lotSize = 20, funds = 100, roleCount = 5, placementMs = 0, tiers, connected = () => true, pick = 0 } = {}) {
  const lot = Array.from({ length: lotSize }, (_, i) => `c${i + 1}`);
  const t = tiers || Object.fromEntries(lot.map((id, i) => [id, TIERS[i % 4]]));
  const a = new Auction({ lot, tiers: t, order: players, roleCount, funds, placementMs, ctx: { connected }, random: () => pick });
  a.begin(T0);
  return a;
}
const open = (a) => a.lot.opensAt; // when bidding opens for the current lot
// Sells the current lot to `pid` at its opening price and places it in the first empty spot.
function buyNow(a, pid, now = open(a)) {
  a.bid(pid, a.minBid(), now);
  a.timeout(a.deadline);
  const p = a.players.get(pid);
  const area = p.roles.includes(null) ? 'roles' : 'bench';
  a.place(pid, area, p[area].indexOf(null), a.deadline ?? now);
  a.timeout(a.deadline); // result shown -> next spin
}

// ---------- R14 settings ----------
test('T14.01 auction settings are accepted; wheel stays the default', () => {
  const s = validateSettings(base({ funds: 80, currency: 'Beli' }));
  assert.deepEqual([s.gameType, s.funds, s.currency], ['auction', 80, 'Beli']);
  const w = validateSettings({ ...base(), gameType: undefined });
  assert.equal(w.gameType, 'wheel');
});
test('T14.04 funds default to 100, currency to £', () => {
  const s = validateSettings(base());
  assert.deepEqual([s.funds, s.currency], [100, '£']);
});
test('T14.05 funds outside 50–100 or not a step of 10, and unknown currencies, are refused', () => {
  for (const funds of [45, 105, 75, 0, 'lots']) assert.equal(code(() => validateSettings(base({ funds }))), 'FUNDS');
  assert.equal(code(() => validateSettings(base({ currency: '₿' }))), 'CURRENCY');
  assert.equal(code(() => validateSettings(base({ gameType: 'poker' }))), 'GAME_TYPE');
});
test('T14.09 lot size: 4 players × 5 roles + 20% = 24; 3 × 10 = 36', () => {
  assert.equal(auctionLotSize(4, 5), 24);
  assert.equal(auctionLotSize(3, 10), 36);
  assert.equal(auctionLotSize(3, 5), 18);
});
test('T14.09a the host can start an auction once the list holds a full lot', () => {
  const r = new Room({ id: 'r', hostName: 'Ste', hostToken: 'h', settings: base() });
  r.join('t2', 'Bee'); r.join('t3', 'Kuma');
  r.addCharacters(r.hostId, { text: Array.from({ length: 17 }, (_, i) => `C${i}`).join('\n') });
  assert.match(r.startBlockers()[0], /17 of 18/);
  r.addCharacters(r.hostId, { text: 'C17' });
  assert.deepEqual(r.startBlockers(), []);
  r.start(r.hostId, Math.random, T0);
  assert.equal(r.phase, 'auction');
  assert.equal(r.auction.lotTotal, 18);
});

// ---------- R16 auction ----------
test('T16.01 each lot spins over what is left; no character comes up twice', () => {
  const a = auction({ lotSize: 6, pick: 0 });
  const seen = [];
  while (!a.finished) { seen.push(a.lot.charId); assert.ok(!a.remaining.includes(a.lot.charId)); a.timeout(a.deadline); if (a.stage === 'result') a.timeout(a.deadline); }
  assert.equal(new Set(seen).size, 6);
});
test('T16.03 first bid is the tier price; 10 s timer starts then', () => {
  const a = auction(); // c1 is Diamond
  assert.equal(a.minBid(), 7);
  assert.equal(code(() => a.bid('A', 7, T0 + 100)), 'NOT_OPEN', 'not while the wheel is spinning');
  assert.equal(code(() => a.bid('A', 6, open(a))), 'BID_LOW');
  a.bid('A', 7, open(a) + 2000);
  assert.equal(a.deadline, open(a) + 2000 + BID_MS);
});
test('T16.04 a bid at 9.9 s restarts the timer', () => {
  const a = auction();
  a.bid('A', 7, open(a));
  a.bid('B', 8, open(a) + 9900);
  assert.equal(a.deadline, open(a) + 9900 + BID_MS);
});
test('T16.05 when the timer runs out the top bidder wins and pays', () => {
  const a = auction();
  a.bid('A', 7, open(a)); a.bid('B', 9, open(a) + 1000);
  a.timeout(a.deadline);
  assert.equal(a.players.get('B').funds, 91);
  assert.deepEqual(a.pending, { playerId: 'B', charId: 'c1', paid: 9 });
});
test('T16.07 raises: +1 under 10, +2 from 10 (8→9→10→12→14)', () => {
  assert.deepEqual([8, 9, 10, 12].map((b) => b + raiseStep(b)), [9, 10, 12, 14]);
  const a = auction();
  a.bid('A', 9, open(a));
  assert.equal(a.minBid(), 10);
  a.bid('B', 10, open(a));
  assert.equal(code(() => a.bid('A', 11, open(a))), 'BID_LOW');
  a.bid('A', 12, open(a));
});
test('T16.08 typing a bigger amount is fine; below the step or above your funds is refused', () => {
  const a = auction({ funds: 50 });
  a.bid('A', 30, open(a));
  assert.equal(code(() => a.bid('B', 31, open(a))), 'BID_LOW');
  assert.equal(code(() => a.bid('B', 51, open(a))), 'NO_FUNDS');
  a.bid('B', 50, open(a));
});
test('T16.09 the top bidder cannot raise their own bid', () => {
  const a = auction();
  a.bid('A', 7, open(a));
  assert.equal(code(() => a.bid('A', 8, open(a))), 'ALREADY_TOP');
});
test('T16.10 tampered bids are refused (decimal, negative, text, someone not playing)', () => {
  const a = auction();
  for (const amt of [7.5, -7, 'seven']) assert.ok(['BAD_BID', 'BID_LOW'].includes(code(() => a.bid('A', amt, open(a)))));
  assert.equal(code(() => a.bid('Z', 7, open(a))), 'NOT_PLAYING');
});
test('T16.11 funds 5, a Gold opens at 5: can bid 5, cannot raise past 5', () => {
  const a = auction({ funds: 5, tiers: { c1: 'Gold' } });
  a.bid('A', 5, open(a));
  assert.equal(code(() => a.bid('B', 6, open(a))), 'NO_FUNDS');
});
test('T16.12 a player can spend everything and keep empty roles', () => {
  const a = auction({ funds: 50, lotSize: 3, tiers: { c1: 'Bronze', c2: 'Bronze', c3: 'Bronze' } });
  a.bid('A', 50, open(a)); a.timeout(a.deadline); a.place('A', 'roles', 0, a.deadline ?? T0); a.timeout(a.deadline);
  assert.equal(a.players.get('A').funds, 0);
  assert.equal(a.players.get('A').roles.filter(Boolean).length, 1);
});
test('T16.13 the winner places into a role or bench spot; rearranging is free', () => {
  const a = auction();
  a.bid('A', 7, open(a)); a.timeout(a.deadline);
  a.place('A', 'bench', 2, T0);
  assert.equal(a.players.get('A').bench[2], 'c1');
  a.move('A', { area: 'bench', index: 2 }, { area: 'roles', index: 4 });
  assert.equal(a.players.get('A').roles[4], 'c1');
  assert.equal(a.players.get('A').bench[2], null);
});
test('T16.15 a full squad can still bid; on winning they replace someone, who goes to the market', () => {
  const a = auction({ lotSize: 12 });
  for (let i = 0; i < 8; i += 1) buyNow(a, 'A');
  assert.equal(a.isFull('A'), true);
  a.bid('A', a.minBid(), open(a)); a.timeout(a.deadline);
  const out = a.players.get('A').roles[0];
  a.place('A', 'roles', 0, T0);
  assert.ok(a.market.includes(out));
});
test('T16.16 nobody bids for 10 seconds: unsold, to the market, next lot spins', () => {
  const a = auction();
  assert.equal(a.deadline, open(a) + BID_MS);
  a.timeout(a.deadline);
  assert.deepEqual(a.market, ['c1']);
  assert.equal(a.stage, 'result');
  a.timeout(a.deadline);
  assert.equal(a.stage, 'bidding');
  assert.equal(a.lot.charId, 'c2');
});
test('T16.17 placement timer runs out: first empty role, then bench; if full, to the market', () => {
  const a = auction({ placementMs: 15_000, lotSize: 12 });
  a.bid('A', 7, open(a)); a.timeout(a.deadline);
  assert.equal(a.stage, 'placing');
  a.timeout(a.deadline);
  assert.equal(a.players.get('A').roles[0], 'c1');
  const p = a.players.get('A');
  p.roles = p.roles.map((x, i) => x ?? `x${i}`); p.bench = ['y1', 'y2', 'y3'];
  a.timeout(a.deadline); // next spin
  a.bid('A', a.minBid(), open(a)); a.timeout(a.deadline); a.timeout(a.deadline);
  assert.ok(a.market.includes('c2'), 'full squad: the new character goes to the market');
});
test('T16.17a placement timer off: the auction waits for the winner to place', () => {
  const a = auction();
  a.bid('A', 7, open(a)); a.timeout(a.deadline);
  assert.equal(a.dueAt(), null);
});
test('T16.18 the auction ends when every character in the lot has been spun', () => {
  const a = auction({ lotSize: 2 });
  a.timeout(a.deadline); a.timeout(a.deadline); a.timeout(a.deadline); a.timeout(a.deadline);
  assert.equal(a.finished, true);
  assert.deepEqual(a.market, ['c1', 'c2']);
});
test('T16.20 top bidder disconnects: still wins and pays; placed for them', () => {
  let away = false;
  const a = auction({ connected: (pid) => !(away && pid === 'B') });
  a.bid('B', 7, open(a));
  away = true;
  a.timeout(a.deadline);
  assert.equal(a.players.get('B').funds, 93);
  assert.equal(a.players.get('B').roles[0], 'c1');
  assert.equal(a.stage, 'result');
});
test('T16.20a the winner drops while placing: placed for them straight away', () => {
  let away = false;
  const a = auction({ connected: (pid) => !(away && pid === 'A') });
  a.bid('A', 7, open(a)); a.timeout(a.deadline);
  away = true;
  assert.equal(a.refresh(T0), true);
  assert.equal(a.players.get('A').roles[0], 'c1');
});
test('R16.11 a player removed mid-auction: their top bid is withdrawn and their characters go to the market', () => {
  const a = auction({ lotSize: 6 });
  buyNow(a, 'C');
  a.bid('C', a.minBid(), open(a));
  a.removePlayer('C', open(a) + 1000);
  assert.equal(a.lot.leader, null);
  assert.ok(a.market.includes('c1'));
});

// ---------- in a room ----------
function auctionRoom(players = 3, extra = {}) {
  const r = new Room({ id: 'r', hostName: 'Ste', hostToken: 'h', settings: base(extra) });
  for (let i = 2; i <= players; i += 1) r.join(`t${i}`, `P${i}`);
  r.addCharacters(r.hostId, { text: Array.from({ length: 40 }, (_, i) => `C${i}, ${TIERS[i % 4]}`).join('\n') });
  r.start(r.hostId, Math.random, T0);
  return r;
}
test('T16.21 room: bids over the wire update everyone’s view; names come with it', () => {
  const r = auctionRoom();
  const [a, b] = r.players.map((p) => p.id);
  const opens = r.auction.lot.opensAt;
  r.auctionAction(a, 'bid', { amount: r.auction.minBid() }, opens);
  const v = r.viewFor(b);
  assert.equal(v.auction.lot.leader, a);
  assert.ok(v.charNames[v.auction.lot.charId]);
  assert.ok(v.charTiers[v.auction.lot.charId]);
});
// Plays a room's auction to the end: player 0 buys everything they can at the opening price.
function finishAuction(r, now = T0) {
  let t = now;
  const a0 = r.players[0].id;
  for (let guard = 0; guard < 500 && r.phase === 'auction'; guard += 1) {
    const a = r.auction;
    if (a.stage === 'bidding') {
      t = Math.max(t, a.lot.opensAt);
      if (!a.lot.leader && a.minBid() <= a.players.get(a0).funds && !a.isFull(a0)) r.auctionAction(a0, 'bid', { amount: a.minBid() }, t);
      t = a.deadline; r.tick(t);
    } else if (a.stage === 'placing') {
      const p = a.players.get(a.pending.playerId);
      const area = p.roles.includes(null) ? 'roles' : 'bench';
      r.auctionAction(a.pending.playerId, 'place', { area, index: p[area].indexOf(null) }, t);
    } else { t = a.deadline; r.tick(t); }
  }
  return t;
}
test('T16.19 auction over: the trade phase opens', () => {
  const r = auctionRoom();
  finishAuction(r);
  assert.equal(r.phase, 'trade');
  assert.ok(r.viewFor(r.hostId).trade);
});

// ---------- R17 trade phase ----------
// A trade phase on a hand-made auction: A has a1..a5 in roles, B has b1..b5, C has c1..c3; market m1 (Gold).
function trading({ fullA = false } = {}) {
  const tiers = { a1: 'Diamond', a2: 'Gold', a3: 'Silver', a4: 'Bronze', a5: 'Bronze', b1: 'Gold', b2: 'Silver', b3: 'Bronze', b4: 'Bronze', b5: 'Bronze', c1: 'Silver', m1: 'Gold', m2: 'Bronze', m3: 'Diamond', x1: 'Bronze', x2: 'Bronze', x3: 'Bronze' };
  const a = new Auction({ lot: [], tiers, order: ['A', 'B', 'C'], roleCount: 5, funds: 50, random: () => 0 });
  a.players.get('A').roles = ['a1', 'a2', 'a3', 'a4', 'a5'];
  if (fullA) a.players.get('A').bench = ['x1', 'x2', 'x3'];
  a.players.get('B').roles = ['b1', 'b2', 'b3', 'b4', 'b5'];
  a.players.get('C').roles = ['c1', null, null, null, null];
  a.market.push('m1', 'm2', 'm3');
  a.begin(T0); // empty lot: finishes straight away
  const online = new Set(['A', 'B', 'C']);
  const t = new TradePhase(a, { now: T0, ctx: { connected: (pid) => online.has(pid) } });
  return { a, t, online };
}
test('T17.01 a trade of characters plus funds happens at once on Accept', () => {
  const { a, t } = trading();
  t.propose('A', 'B', { give: { chars: ['a4'], funds: 10 }, get: { chars: ['b1'] } }, T0);
  t.respond('B', 'A', true, T0 + 1000);
  assert.equal(a.players.get('A').roles[3], 'b1', 'takes the place of the one traded away');
  assert.equal(a.players.get('B').roles[0], 'a4');
  assert.equal(a.players.get('A').funds, 40);
  assert.equal(a.players.get('B').funds, 60);
  const e = a.log.at(-1);
  assert.deepEqual([e.kind, e.toA, e.toB, e.fundsToB], ['trade', ['b1'], ['a4'], 10]);
});
test('T17.02 one-sided trades are allowed (funds for nothing)', () => {
  const { a, t } = trading();
  t.propose('A', 'C', { give: { funds: 5 } }, T0);
  t.respond('C', 'A', true, T0);
  assert.equal(a.players.get('C').funds, 55);
});
test('T17.03 declined: nothing changes and they can offer again', () => {
  const { a, t } = trading();
  t.propose('A', 'B', { give: { chars: ['a1'] }, get: { chars: ['b1'] } }, T0);
  t.respond('B', 'A', false, T0);
  assert.equal(a.players.get('A').roles[0], 'a1');
  t.propose('A', 'B', { give: { chars: ['a2'] } }, T0);
});
test('T17.04 an offer not answered in 30 seconds disappears', () => {
  const { t } = trading();
  t.propose('A', 'B', { give: { chars: ['a1'] } }, T0);
  assert.equal(t.dueAt(), T0 + PROPOSAL_MS);
  t.timeout(T0 + PROPOSAL_MS);
  assert.equal(code(() => t.respond('B', 'A', true, T0 + PROPOSAL_MS)), 'NO_OFFER');
});
test('T17.05 only one offer waiting at a time', () => {
  const { t } = trading();
  t.propose('A', 'B', { give: { chars: ['a1'] } }, T0);
  assert.equal(code(() => t.propose('A', 'C', { give: { chars: ['a2'] } }, T0)), 'ONE_AT_A_TIME');
  t.cancel('A');
  t.propose('A', 'C', { give: { chars: ['a2'] } }, T0);
});
test('T17.06 a trade that would overfill a squad is refused', () => {
  const { t } = trading({ fullA: true });
  assert.equal(code(() => t.propose('B', 'A', { give: { chars: ['b1'] } }, T0)), 'NO_SPACE');
});
test('T17.07 offering more funds than you have, or empty and self trades, are refused', () => {
  const { t } = trading();
  assert.equal(code(() => t.propose('A', 'B', { give: { funds: 51 } }, T0)), 'NO_FUNDS');
  assert.equal(code(() => t.propose('A', 'B', {}, T0)), 'EMPTY_TRADE');
  assert.equal(code(() => t.propose('A', 'A', { give: { funds: 1 } }, T0)), 'SELF_TRADE');
  assert.equal(code(() => t.propose('A', 'B', { give: { funds: 1.5 } }, T0)), 'BAD_FUNDS');
});
test('T17.08 selling a character that is in a waiting offer cancels the offer', () => {
  const { t } = trading();
  t.propose('A', 'B', { give: { chars: ['a5'] } }, T0);
  t.sell('A', { area: 'roles', index: 4 }, T0);
  assert.equal(code(() => t.respond('B', 'A', true, T0)), 'NO_OFFER');
});
test('T17.10 a full squad buys from the market at the tier price, swapping one out', () => {
  const { a, t } = trading({ fullA: true });
  t.buy('A', 'm1', { area: 'bench', index: 0 }, T0);
  assert.equal(a.players.get('A').bench[0], 'm1');
  assert.equal(a.players.get('A').funds, 45);
  assert.ok(a.market.includes('x1'));
});
test('T17.11 a third market purchase is refused', () => {
  const { t } = trading({ fullA: true });
  t.buy('A', 'm1', { area: 'bench', index: 0 }, T0);
  t.buy('A', 'm2', { area: 'bench', index: 1 }, T0);
  assert.equal(code(() => t.buy('A', 'm3', { area: 'bench', index: 2 }, T0)), 'BUY_LIMIT');
});
test('T17.12 two buyers, one character: the second is told it’s gone', () => {
  const { a, t } = trading({ fullA: true });
  a.players.get('B').bench = ['y1', 'y2', 'y3'];
  t.buy('A', 'm1', { area: 'bench', index: 0 }, T0);
  assert.equal(code(() => t.buy('B', 'm1', { area: 'bench', index: 0 }, T0)), 'GONE');
});
test('T17.13 selling pays half the tier price, rounded half up (4, 3, 2, 1)', () => {
  const { a, t } = trading();
  for (const i of [0, 1, 2, 3]) t.sell('A', { area: 'roles', index: i }, T0);
  assert.equal(a.players.get('A').funds, 50 + 4 + 3 + 2 + 1);
  assert.ok(['a1', 'a2', 'a3', 'a4'].every((c) => a.market.includes(c)));
});
test('T17.14 a player without a full squad cannot buy from the market (but can still trade)', () => {
  const { t } = trading();
  assert.equal(code(() => t.buy('C', 'm1', { area: 'roles', index: 1 }, T0)), 'NOT_FULL');
  t.propose('C', 'B', { give: { funds: 1 } }, T0);
});
test('T17.16 everyone marks done: trading ends; someone can change their mind first', () => {
  const { t } = trading();
  t.setDone('A', true, T0); t.setDone('B', true, T0); t.setDone('A', false, T0);
  t.setDone('C', true, T0);
  assert.equal(t.finished, false);
  t.setDone('A', true, T0);
  assert.equal(t.finished, true);
});
test('T17.18 the host can end trading at 90 seconds, not at 89', () => {
  const { t } = trading();
  assert.equal(code(() => t.hostEnd(T0 + 89_000)), 'TOO_SOON');
  t.hostEnd(T0 + TRADE_MIN_MS);
  assert.equal(t.finished, true);
});
test('T17.19 trading ends with an offer waiting: the offer is cancelled', () => {
  const { t } = trading();
  t.propose('A', 'B', { give: { chars: ['a1'] } }, T0);
  t.hostEnd(T0 + TRADE_MIN_MS);
  assert.equal(t.proposals.size, 0);
});
test('T17.22 a player disconnects: their offers are cancelled and they count as done while away', () => {
  const { t, online } = trading();
  t.propose('A', 'B', { give: { chars: ['a1'] } }, T0);
  t.setDone('B', true, T0); t.setDone('C', true, T0);
  online.delete('A');
  t.refresh(T0);
  assert.equal(t.proposals.size, 0);
  assert.equal(t.finished, true);
});
test('R17.3 only the two players in an offer can see it', () => {
  const { t } = trading();
  t.propose('A', 'B', { give: { chars: ['a1'] } }, T0);
  assert.equal(t.view('A').offers.length, 1);
  assert.equal(t.view('B').offers.length, 1);
  assert.equal(t.view('C').offers.length, 0);
});

// ---------- R17.11 to the tournament ----------
test('T17.20 tournament: only role characters fight; the bench is left out', () => {
  const r = auctionRoom();
  let t = finishAuction(r);
  const host = r.hostId;
  const benchBefore = r.auction.players.get(host).bench.filter(Boolean);
  for (const p of r.players) r.tradeAction(p.id, 'done', {}, t);
  assert.equal(r.phase, 'faceoff');
  const team = r.faceoff.teams.get(host);
  assert.equal(team.length, 5);
  for (const c of benchBefore) assert.ok(!team.includes(c));
  void t;
});
test('T17.21 play again: a new lot is drawn and funds reset', () => {
  const r = auctionRoom();
  const t = finishAuction(r);
  for (const p of r.players) r.tradeAction(p.id, 'done', {}, t);
  r.phase = 'finished'; // skip the face-off for this test
  r.restart(r.hostId, Math.random, t + 1000);
  assert.equal(r.phase, 'auction');
  assert.ok([...r.auction.players.values()].every((p) => p.funds === 100));
  assert.equal(r.auction.lotTotal, 18);
});
test('R17.9 the host has no special trade powers beyond ending trading', () => {
  const r = auctionRoom();
  const t = finishAuction(r);
  const [, b] = r.players.map((p) => p.id);
  assert.equal(code(() => r.tradeAction(b, 'end', {}, t + TRADE_MIN_MS)), 'NOT_HOST');
});
test('RESULT_MS and SPIN_MS keep each lot moving', () => { assert.ok(RESULT_MS < 5000); assert.ok(SPIN_MS < 5000); });
