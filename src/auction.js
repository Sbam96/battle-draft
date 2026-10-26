// Auction (iteration 2, sections 14 and 16). The server runs everything; screens only show it.
//  - The lot is drawn by the room (roles x players + 20%). One character at a time is spun from what's left.
//  - Once the wheel stops, anyone can bid. The first bid is the tier price; raises are +1 under 10 and +2
//    from 10 (or any larger whole amount). The 10-second timer starts at the first bid and restarts on each bid.
//    No bid within 10 seconds of landing: unsold, to the market.
//  - The winner pays and places the character in an empty role or bench spot, or replaces someone, who goes
//    to the market. Placement timer (if on) or a disconnected winner: first empty role, then bench; if all
//    full, the new character goes to the market.
//  - Squads can be rearranged freely at any time.

import { randomInt } from 'node:crypto';
import { DraftError, SPIN_MS } from './draft.js';
import { TIER_PRICE, tierOrDefault } from './tiers.js';
import { BID_MS, BENCH_SPOTS } from './config.js';

export const RESULT_MS = 2500; // how long a sold/unsold result shows before the next spin
export const raiseStep = (bid) => (bid < 10 ? 1 : 2);
const AREAS = ['roles', 'bench'];

export class Auction {
  // characters: [{ id, tier }] for the lot; order: player ids; ctx: { connected: (pid) => bool }
  constructor({ lot, tiers, order, roleCount, funds, placementMs = 0, ctx = { connected: () => true }, random = (n) => randomInt(n) }) {
    this.tiers = new Map(Object.entries(tiers || {}));
    this.remaining = [...lot];
    this.lotTotal = lot.length;
    this.roleCount = roleCount;
    this.startFunds = funds;
    this.placementMs = placementMs;
    this.ctx = ctx;
    this.random = random;
    this.players = new Map(order.map((pid) => [pid, { funds, roles: Array(roleCount).fill(null), bench: Array(BENCH_SPOTS).fill(null), paid: {} }]));
    this.market = [];
    this.sold = 0;
    this.stage = 'idle'; // spin -> bidding -> placing / result -> ... -> finished
    this.lot = null; // { charId, spin, bid, leader, opensAt, deadline }
    this.pending = null; // { playerId, charId, paid }
    this.deadline = null;
    this.spinCount = 0;
    this.finished = false;
    this.log = [];
  }

  tierOf(id) { return tierOrDefault(this.tiers.get(id)); }
  priceOf(id) { return TIER_PRICE[this.tierOf(id)]; }

  #note(entry, now) { this.log.push({ ...entry, at: now }); if (this.log.length > 40) this.log.shift(); }
  #player(pid) {
    const p = this.players.get(pid);
    if (!p) throw new DraftError('NOT_PLAYING', 'You’re not in this game.');
    return p;
  }

  owned(pid) { const p = this.players.get(pid); return p ? [...p.roles, ...p.bench].filter((x) => x != null) : []; }
  isFull(pid) { return this.owned(pid).length === this.roleCount + BENCH_SPOTS; }

  begin(now) { this.#spin(now); }

  #spin(now) {
    this.pending = null;
    if (!this.remaining.length) { this.#finish(now); return; }
    const wheel = [...this.remaining];
    const landed = wheel[this.random(wheel.length)];
    this.remaining = this.remaining.filter((id) => id !== landed);
    this.spinCount += 1;
    const opensAt = now + SPIN_MS;
    this.lot = { charId: landed, spin: { id: this.spinCount, wheel, landed, at: now }, bid: 0, leader: null, opensAt, deadline: opensAt + BID_MS };
    this.stage = 'bidding';
    this.deadline = this.lot.deadline;
  }

  // The lowest bid anyone can make right now.
  minBid() {
    if (!this.lot) return null;
    return this.lot.leader ? this.lot.bid + raiseStep(this.lot.bid) : this.priceOf(this.lot.charId);
  }

  bid(pid, amount, now) {
    const p = this.#player(pid);
    if (this.stage !== 'bidding' || !this.lot) throw new DraftError('NOT_BIDDING', 'Bidding is closed.');
    if (now < this.lot.opensAt) throw new DraftError('NOT_OPEN', 'Wait for the wheel to stop.');
    if (this.lot.leader === pid) throw new DraftError('ALREADY_TOP', 'You already hold the top bid.');
    const n = Number(amount);
    const min = this.minBid();
    if (!Number.isInteger(n) || n < 1) throw new DraftError('BAD_BID', 'Bids are whole numbers.');
    if (n < min) throw new DraftError('BID_LOW', `The lowest bid now is ${min}.`);
    if (n > p.funds) throw new DraftError('NO_FUNDS', `You only have ${p.funds}.`);
    this.lot.bid = n;
    this.lot.leader = pid;
    this.lot.deadline = now + BID_MS;
    this.deadline = this.lot.deadline;
    this.#note({ kind: 'bid', playerId: pid, charId: this.lot.charId, amount: n }, now);
  }

  #close(now) {
    const { charId, leader, bid } = this.lot;
    if (!leader) {
      this.market.push(charId);
      this.#note({ kind: 'unsold', charId }, now);
      this.#toResult(now);
      return;
    }
    const p = this.players.get(leader);
    p.funds -= bid;
    p.paid[charId] = bid;
    this.sold += 1;
    this.#note({ kind: 'won', playerId: leader, charId, amount: bid }, now);
    this.pending = { playerId: leader, charId, paid: bid };
    this.stage = 'placing';
    this.deadline = this.placementMs ? now + this.placementMs : null;
    if (!this.ctx.connected(leader)) this.#autoPlace(now, 'away');
  }

  #toResult(now) { this.stage = 'result'; this.deadline = now + RESULT_MS; }

  #slot(area, index) {
    if (!AREAS.includes(area)) throw new DraftError('BAD_SLOT', 'Pick a role or a bench spot.');
    const i = Number(index);
    const size = area === 'roles' ? this.roleCount : BENCH_SPOTS;
    if (!Number.isInteger(i) || i < 0 || i >= size) throw new DraftError('BAD_SLOT', 'Pick a role or a bench spot.');
    return i;
  }

  // The winner places their new character. Replacing someone sends them to the market.
  place(pid, area, index, now) {
    if (this.stage !== 'placing' || this.pending?.playerId !== pid) throw new DraftError('NOT_PLACING', 'You have nothing to place.');
    const i = this.#slot(area, index);
    const p = this.players.get(pid);
    const replaced = p[area][i];
    if (replaced != null) this.market.push(replaced);
    p[area][i] = this.pending.charId;
    this.#note({ kind: 'placed', playerId: pid, charId: this.pending.charId, area, index: i, replaced }, now);
    this.#toResult(now);
    this.pending = null;
  }

  // Placement timer ran out, or the winner is away: first empty role, then bench; if full, to the market.
  #autoPlace(now, reason) {
    const { playerId, charId } = this.pending;
    const p = this.players.get(playerId);
    let area = 'roles'; let i = p.roles.indexOf(null);
    if (i === -1) { area = 'bench'; i = p.bench.indexOf(null); }
    if (i === -1) {
      this.market.push(charId);
      this.#note({ kind: 'autoMarket', playerId, charId, reason }, now);
    } else {
      p[area][i] = charId;
      this.#note({ kind: 'autoPlaced', playerId, charId, area, index: i, reason }, now);
    }
    this.pending = null;
    this.#toResult(now);
  }

  // R16.5: free rearranging between roles and bench (also used in the trade phase).
  move(pid, from, to) {
    const p = this.#player(pid);
    const a = this.#slot(from?.area, from?.index);
    const b = this.#slot(to?.area, to?.index);
    if (p[from.area][a] == null) throw new DraftError('EMPTY_SLOT', 'There’s nobody there to move.');
    [p[from.area][a], p[to.area][b]] = [p[to.area][b], p[from.area][a]];
  }

  dueAt() { return this.finished ? null : this.deadline; }

  timeout(now) {
    if (this.finished) return false;
    if (this.stage === 'bidding') this.#close(now);
    else if (this.stage === 'placing') this.#autoPlace(now, 'timer');
    else if (this.stage === 'result') this.#spin(now);
    return true;
  }

  // A winner who disconnects before placing is placed for (R16.11).
  refresh(now) {
    if (this.stage === 'placing' && this.pending && !this.ctx.connected(this.pending.playerId)) { this.#autoPlace(now, 'away'); return true; }
    return false;
  }

  // A player removed from the game: their characters go to the market; a top bid of theirs is withdrawn.
  removePlayer(pid, now) {
    const p = this.players.get(pid);
    if (!p) return;
    if (this.stage === 'bidding' && this.lot?.leader === pid) {
      this.lot.leader = null; this.lot.bid = 0;
      this.lot.deadline = Math.max(now, this.lot.opensAt) + BID_MS;
      this.deadline = this.lot.deadline;
    }
    if (this.stage === 'placing' && this.pending?.playerId === pid) {
      this.market.push(this.pending.charId);
      this.pending = null;
      this.#toResult(now);
    }
    this.market.push(...this.owned(pid));
    this.players.delete(pid);
  }

  #finish(now) {
    this.finished = true;
    this.stage = 'finished';
    this.lot = null;
    this.deadline = null;
    this.#note({ kind: 'auctionOver' }, now);
  }

  referenced() {
    const ids = new Set();
    const add = (x) => { if (x != null) ids.add(x); };
    if (this.lot) add(this.lot.charId); // the wheel's other names come from the full list, like the draft
    for (const p of this.players.values()) { p.roles.forEach(add); p.bench.forEach(add); }
    this.market.forEach(add);
    for (const e of this.log) { add(e.charId); add(e.replaced); (e.toA || []).forEach(add); (e.toB || []).forEach(add); }
    return ids;
  }

  view() {
    return {
      stage: this.stage,
      finished: this.finished,
      lot: this.lot && { ...this.lot, spin: { ...this.lot.spin }, price: this.priceOf(this.lot.charId), min: this.stage === 'bidding' ? this.minBid() : null },
      pending: this.pending && { ...this.pending },
      deadline: this.deadline,
      players: Object.fromEntries([...this.players].map(([pid, p]) => [pid, { funds: p.funds, roles: [...p.roles], bench: [...p.bench] }])),
      market: [...this.market],
      remaining: [...this.remaining],
      lotTotal: this.lotTotal,
      lotNumber: this.lotTotal - this.remaining.length,
      roleCount: this.roleCount,
      bench: BENCH_SPOTS,
      spinMs: SPIN_MS,
      bidMs: BID_MS,
      resultMs: RESULT_MS,
      placementMs: this.placementMs,
      log: this.log.slice(-15),
    };
  }
}
