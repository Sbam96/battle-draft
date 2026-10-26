// Trade phase and market (iteration 2, section 17). Runs after the auction on the same squads and funds.
//  - No timer. Players propose trades to each other: characters and/or funds, one-sided allowed.
//    One proposal waiting per player at a time; it disappears if declined, cancelled or not answered in 30 s.
//    On Accept it happens at once, if it is still valid (nothing in it has changed hands, funds and squad
//    space are there).
//  - Market: unsold and swapped-out characters. Only a player whose roles and bench are all full can buy,
//    at the tier price, swapping one out (to the market); at most 2 buys each. Anyone can sell for half the
//    tier price, rounded half up.
//  - Players mark "done" (and can change their mind). When everyone is done the tournament starts. The host
//    can end trading for everyone after 90 seconds. The host can't approve or block trades.

import { DraftError } from './draft.js';
import { sellPrice } from './tiers.js';
import { TRADE_MIN_MS, PROPOSAL_MS, MARKET_BUY_LIMIT, BENCH_SPOTS } from './config.js';

const ints = (n) => Number.isInteger(n) && n >= 0;

export class TradePhase {
  // auction: the finished Auction (squads, funds, market, tiers, log). ctx: { connected(pid) }
  constructor(auction, { now, ctx = { connected: () => true } }) {
    this.a = auction;
    this.ctx = ctx;
    this.startedAt = now;
    this.done = new Set();
    this.buys = new Map();
    this.proposals = new Map(); // from -> { id, from, to, give: { chars, funds }, get: { chars, funds }, at, expiresAt }
    this.seq = 0;
    this.finished = false;
  }

  get players() { return this.a.players; }
  #note(entry, now) { this.a.log.push({ ...entry, at: now }); if (this.a.log.length > 40) this.a.log.shift(); }
  #open() { if (this.finished) throw new DraftError('TRADING_OVER', 'Trading has ended.'); }
  #player(pid) {
    const p = this.players.get(pid);
    if (!p) throw new DraftError('NOT_PLAYING', 'You’re not in this game.');
    return p;
  }
  #slotOf(pid, charId) {
    const p = this.players.get(pid);
    if (!p) return null;
    for (const area of ['roles', 'bench']) { const i = p[area].indexOf(charId); if (i !== -1) return { area, index: i }; }
    return null;
  }

  // Checks a trade against the current squads and funds. Throws with the reason if it can't happen.
  #check(t) {
    const from = this.players.get(t.from); const to = this.players.get(t.to);
    if (!from || !to) throw new DraftError('NOT_PLAYING', 'That player has left the game.');
    for (const c of t.give.chars) if (!this.#slotOf(t.from, c)) throw new DraftError('CHANGED', 'Something in this trade has changed hands. Make a new offer.');
    for (const c of t.get.chars) if (!this.#slotOf(t.to, c)) throw new DraftError('CHANGED', 'Something in this trade has changed hands. Make a new offer.');
    if (t.give.funds > from.funds) throw new DraftError('NO_FUNDS', `The offer includes ${t.give.funds} but only ${from.funds} is available.`);
    if (t.get.funds > to.funds) throw new DraftError('NO_FUNDS', 'The other player doesn’t have those funds.');
    const cap = this.a.roleCount + BENCH_SPOTS;
    if (this.a.owned(t.from).length - t.give.chars.length + t.get.chars.length > cap) throw new DraftError('NO_SPACE', 'That would leave the person offering with more characters than roles + bench.');
    if (this.a.owned(t.to).length - t.get.chars.length + t.give.chars.length > cap) throw new DraftError('NO_SPACE', 'That would give the other player more characters than roles + bench.');
  }

  propose(from, to, offer, now) {
    this.#open();
    this.#player(from);
    if (from === to) throw new DraftError('SELF_TRADE', 'Pick another player to trade with.');
    if (!this.players.has(to)) throw new DraftError('NOT_PLAYING', 'That player isn’t in this game.');
    if (this.proposals.has(from)) throw new DraftError('ONE_AT_A_TIME', 'You already have an offer waiting. Cancel it or wait for an answer.');
    const norm = (side) => ({
      chars: [...new Set(Array.isArray(side?.chars) ? side.chars.map(String) : [])],
      funds: side?.funds == null || side.funds === '' ? 0 : Number(side.funds),
    });
    const give = norm(offer?.give); const get = norm(offer?.get);
    if (!ints(give.funds) || !ints(get.funds)) throw new DraftError('BAD_FUNDS', 'Funds are whole numbers.');
    if (!give.chars.length && !get.chars.length && !give.funds && !get.funds) throw new DraftError('EMPTY_TRADE', 'Add something to the trade.');
    const t = { id: (this.seq += 1), from, to, give, get, at: now, expiresAt: now + PROPOSAL_MS };
    this.#check(t);
    this.proposals.set(from, t);
    return t;
  }

  cancel(from) {
    if (!this.proposals.delete(from)) throw new DraftError('NO_OFFER', 'You have no offer waiting.');
  }

  respond(pid, offerFrom, accept, now) {
    this.#open();
    const t = this.proposals.get(offerFrom);
    if (!t || t.to !== pid) throw new DraftError('NO_OFFER', 'That offer is no longer there.');
    this.proposals.delete(offerFrom);
    if (!accept) return { declined: true };
    this.#check(t);
    // Swap characters into each other's places where possible, then fill gaps (role first, then bench).
    const A = this.players.get(t.from); const B = this.players.get(t.to);
    const out = (pid2, chars) => chars.map((c) => { const s = this.#slotOf(pid2, c); this.players.get(pid2)[s.area][s.index] = null; return s; });
    const freedA = out(t.from, t.give.chars);
    const freedB = out(t.to, t.get.chars);
    const put = (pid2, chars, freed) => {
      const p = this.players.get(pid2);
      for (const c of chars) {
        const s = freed.shift() || (p.roles.indexOf(null) !== -1 ? { area: 'roles', index: p.roles.indexOf(null) } : { area: 'bench', index: p.bench.indexOf(null) });
        p[s.area][s.index] = c;
      }
    };
    put(t.from, t.get.chars, freedA);
    put(t.to, t.give.chars, freedB);
    A.funds += t.get.funds - t.give.funds;
    B.funds += t.give.funds - t.get.funds;
    this.#note({ kind: 'trade', a: t.from, b: t.to, toA: t.get.chars, toB: t.give.chars, fundsToA: t.get.funds, fundsToB: t.give.funds }, now);
    this.#dropStale();
    return { accepted: true };
  }

  // Offers that can no longer happen (a character in them has moved) are removed straight away.
  #dropStale() {
    for (const [from, t] of this.proposals) {
      try { this.#check(t); } catch { this.proposals.delete(from); }
    }
  }

  buy(pid, charId, swap, now) {
    this.#open();
    const p = this.#player(pid);
    if (!this.a.isFull(pid)) throw new DraftError('NOT_FULL', 'Only players with every role and bench spot filled can buy from the market.');
    if ((this.buys.get(pid) || 0) >= MARKET_BUY_LIMIT) throw new DraftError('BUY_LIMIT', `You’ve already bought ${MARKET_BUY_LIMIT} from the market.`);
    const at = this.a.market.indexOf(charId);
    if (at === -1) throw new DraftError('GONE', 'Someone else just bought that character.');
    const price = this.a.priceOf(charId);
    if (price > p.funds) throw new DraftError('NO_FUNDS', `You need ${price} and have ${p.funds}.`);
    const i = Number(swap?.index);
    const area = swap?.area;
    if (!['roles', 'bench'].includes(area) || !Number.isInteger(i) || i < 0 || i >= p[area].length) throw new DraftError('BAD_SLOT', 'Pick who to swap out.');
    const out = p[area][i];
    this.a.market.splice(at, 1);
    this.a.market.push(out);
    p[area][i] = charId;
    p.funds -= price;
    this.buys.set(pid, (this.buys.get(pid) || 0) + 1);
    this.#note({ kind: 'bought', playerId: pid, charId, amount: price, replaced: out }, now);
    this.#dropStale();
  }

  sell(pid, slot, now) {
    this.#open();
    const p = this.#player(pid);
    const area = slot?.area; const i = Number(slot?.index);
    if (!['roles', 'bench'].includes(area) || !Number.isInteger(i) || i < 0 || i >= p[area].length || p[area][i] == null) throw new DraftError('BAD_SLOT', 'Pick a character to sell.');
    const c = p[area][i];
    const price = sellPrice(this.a.tierOf(c));
    p[area][i] = null;
    p.funds += price;
    this.a.market.push(c);
    this.#note({ kind: 'sold', playerId: pid, charId: c, amount: price }, now);
    this.#dropStale();
  }

  setDone(pid, done, now) {
    this.#open();
    this.#player(pid);
    if (done) this.done.add(pid); else this.done.delete(pid);
    this.#checkAllDone(now);
  }

  // Everyone still in the game who is connected has marked done (players away count as done).
  #checkAllDone(now) {
    const active = [...this.players.keys()].filter((pid) => this.ctx.connected(pid));
    if (active.length && active.every((pid) => this.done.has(pid))) this.#end(now, 'allDone');
  }

  canHostEnd(now) { return now - this.startedAt >= TRADE_MIN_MS; }

  hostEnd(now) {
    this.#open();
    if (!this.canHostEnd(now)) throw new DraftError('TOO_SOON', `You can end trading ${Math.ceil((TRADE_MIN_MS - (now - this.startedAt)) / 1000)} seconds from now.`);
    this.#end(now, 'host');
  }

  #end(now, reason) {
    this.proposals.clear();
    this.finished = true;
    this.#note({ kind: 'tradingOver', reason }, now);
  }

  dueAt() {
    if (this.finished || !this.proposals.size) return null;
    return Math.min(...[...this.proposals.values()].map((t) => t.expiresAt));
  }

  timeout(now) {
    let changed = false;
    for (const [from, t] of this.proposals) if (t.expiresAt <= now) { this.proposals.delete(from); changed = true; }
    return changed;
  }

  // Disconnects and removals: their offers (made or received) are cancelled; then check if everyone's done.
  refresh(now) {
    if (this.finished) return false;
    for (const [from, t] of this.proposals) if (!this.ctx.connected(from) || !this.ctx.connected(t.to)) this.proposals.delete(from);
    this.#checkAllDone(now);
    return true;
  }

  removePlayer(pid, now) {
    this.done.delete(pid);
    this.a.removePlayer(pid, now);
    for (const [from, t] of this.proposals) if (from === pid || t.to === pid) this.proposals.delete(from);
    this.#checkAllDone(now);
  }

  // Only the two players in a waiting offer see it (R17.3).
  view(forPid) {
    const mine = [...this.proposals.values()].filter((t) => t.from === forPid || t.to === forPid)
      .map((t) => ({ id: t.id, from: t.from, to: t.to, give: { ...t.give, chars: [...t.give.chars] }, get: { ...t.get, chars: [...t.get.chars] }, expiresAt: t.expiresAt }));
    return {
      startedAt: this.startedAt,
      canEndAt: this.startedAt + TRADE_MIN_MS,
      done: [...this.done],
      buys: Object.fromEntries(this.buys),
      buyLimit: MARKET_BUY_LIMIT,
      offers: mine,
      waiting: [...this.proposals.keys()].length,
      finished: this.finished,
      proposalMs: PROPOSAL_MS,
    };
  }
}
