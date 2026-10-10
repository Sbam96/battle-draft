// End phase (R4, revised 10 Oct 2026): after the draft, each unused bin/respin is one token.
// Everyone spends their tokens AT THE SAME TIME, against one shared timer (50 s for 5 roles,
// 100 s for 10). Each token buys one of: swap two of your characters, pick a character from the bin,
// or one extra spin. Tokens only work on roles that already have a character — never on a gap.
// The phase ends when everyone is done (or out of tokens), or when the timer runs out.
// Clashes are first come, first served: if two players want the same binned character, the first
// request the server receives gets it. Extra spins draw from the shared wheel, so no one lands the same character.

import { randomInt } from 'node:crypto';
import { DraftError, SPIN_MS } from './draft.js';

const AFTER_SPIN_MS = SPIN_MS + 10_000; // a player who spins near the end always gets time to decide

export class EndPhase {
  constructor(draft, { random = (n) => randomInt(n) } = {}) {
    this.d = draft;
    this.random = random;
    this.goMs = draft.roleCount * 10_000;
    this.tokens = new Map(draft.order.map((p) => [p, draft.binsLeft.get(p) ?? 0]));
    this.players = new Map(); // pid -> { stage: 'choose' | 'extra' | 'done', landed, spin }
    this.deadline = null;
    this.finished = false;
  }

  #filled(pid) { return (this.d.teams.get(pid) || []).filter((x) => x !== null).length; }

  begin(now) {
    for (const pid of this.d.order) {
      const active = (this.tokens.get(pid) ?? 0) > 0 && this.#filled(pid) > 0;
      this.players.set(pid, { stage: active ? 'choose' : 'done', landed: null, spin: null });
      if (!active) this.tokens.set(pid, 0);
    }
    this.deadline = now + this.goMs;
    this.#checkFinished();
  }

  #state(pid) {
    if (this.finished) throw new DraftError('END_OVER', 'The end phase is over.');
    const p = this.players.get(pid);
    if (!p) throw new DraftError('NOT_PLAYING', 'You’re not in this game.');
    if (p.stage === 'done') throw new DraftError('YOU_ARE_DONE', 'You’ve finished your changes.');
    return p;
  }

  #require(pid, stage) {
    const p = this.#state(pid);
    if (p.stage !== stage) throw new DraftError('WRONG_STEP', 'Finish what you’re doing first.');
    return p;
  }

  #spend(pid) {
    const left = this.tokens.get(pid) ?? 0;
    if (left < 1) throw new DraftError('NO_TOKENS', 'You have no tokens left.');
    this.tokens.set(pid, left - 1);
  }

  #filledRole(pid, role) {
    const r = Number(role);
    const team = this.d.teams.get(pid);
    if (!Number.isInteger(r) || r < 0 || r >= this.d.roleCount) throw new DraftError('BAD_ROLE', 'Pick one of your roles.');
    if (team[r] === null) throw new DraftError('EMPTY_ROLE', 'Tokens only work on roles that already have a character.');
    return r;
  }

  #note(entry, now) { this.d.log.push({ ...entry, at: now }); if (this.d.log.length > 30) this.d.log.shift(); }

  // A player who has spent everything (and isn't mid-spin) is done.
  #doneIfSpent(pid) {
    const p = this.players.get(pid);
    if (p && p.stage === 'choose' && (this.tokens.get(pid) ?? 0) === 0) p.stage = 'done';
    this.#checkFinished();
  }

  #finish(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    p.stage = 'done'; p.landed = null;
    this.tokens.set(pid, 0); // unused tokens are lost
    this.#checkFinished();
  }

  #checkFinished() {
    if ([...this.players.values()].every((p) => p.stage === 'done')) { this.finished = true; this.deadline = null; }
  }

  swap(pid, roleA, roleB, now) {
    this.#require(pid, 'choose');
    const a = this.#filledRole(pid, roleA);
    const b = this.#filledRole(pid, roleB);
    if (a === b) throw new DraftError('SAME_ROLE', 'Pick two different roles to swap.');
    this.#spend(pid);
    const team = this.d.teams.get(pid);
    [team[a], team[b]] = [team[b], team[a]];
    this.#note({ kind: 'swapped', playerId: pid, roles: [a, b] }, now);
    this.#doneIfSpent(pid);
  }

  pickFromBin(pid, charId, role, now) {
    this.#require(pid, 'choose');
    const r = this.#filledRole(pid, role);
    if (!this.d.binned.includes(charId)) throw new DraftError('NOT_IN_BIN', 'Someone else just took that character, or it’s no longer in the bin. Pick another.');
    this.#spend(pid);
    const team = this.d.teams.get(pid);
    const replaced = team[r];
    team[r] = charId;
    this.d.binned = this.d.binned.filter((id) => id !== charId);
    this.d.binned.push(replaced);
    this.#note({ kind: 'binPick', playerId: pid, charId, replaced, role: r }, now);
    this.#doneIfSpent(pid);
  }

  extraSpin(pid, now) {
    const p = this.#require(pid, 'choose');
    if (!this.d.pool.length) throw new DraftError('POOL_EMPTY', 'The wheel is empty.');
    this.#spend(pid);
    const wheel = [...this.d.pool];
    const landed = wheel[this.random(wheel.length)];
    this.d.pool = this.d.pool.filter((id) => id !== landed);
    this.d.spinCount += 1;
    p.stage = 'extra';
    p.landed = landed;
    p.spin = { id: this.d.spinCount, wheel, landed, at: now };
    this.deadline = Math.max(this.deadline ?? 0, now + AFTER_SPIN_MS);
  }

  // After an extra spin: put the new character in a filled role (the replaced one goes to the bin), or let it go.
  keepExtra(pid, role, now) {
    const p = this.#require(pid, 'extra');
    const r = this.#filledRole(pid, role);
    const team = this.d.teams.get(pid);
    const replaced = team[r];
    team[r] = p.landed;
    this.d.binned.push(replaced);
    this.#note({ kind: 'extraKept', playerId: pid, charId: p.landed, replaced, role: r }, now);
    p.stage = 'choose'; p.landed = null;
    this.#doneIfSpent(pid);
  }

  declineExtra(pid, now) {
    const p = this.#require(pid, 'extra');
    this.d.binned.push(p.landed);
    this.#note({ kind: 'extraDeclined', playerId: pid, charId: p.landed }, now);
    p.stage = 'choose'; p.landed = null;
    this.#doneIfSpent(pid);
  }

  done(pid, now) {
    const p = this.#state(pid);
    if (p.stage === 'extra') this.declineExtra(pid, now);
    this.#finish(pid);
  }

  dueAt() { return this.finished ? null : this.deadline; }

  // Time's up for everyone still deciding: any extra-spin character they haven't placed goes to the bin.
  timeout(now) {
    if (this.finished) return false;
    for (const [pid, p] of this.players) {
      if (p.stage === 'done') continue;
      if (p.stage === 'extra') { this.d.binned.push(p.landed); this.#note({ kind: 'extraDeclined', playerId: pid, charId: p.landed, timedOut: true }, now); }
      this.#note({ kind: 'goTimeout', playerId: pid }, now);
      p.stage = 'done'; p.landed = null;
      this.tokens.set(pid, 0);
    }
    this.finished = true;
    this.deadline = null;
    return true;
  }

  removePlayer(pid) {
    const p = this.players.get(pid);
    if (p?.stage === 'extra') this.d.binned.push(p.landed);
    this.players.delete(pid);
    this.tokens.delete(pid);
    this.#checkFinished();
  }

  view() {
    const players = {};
    for (const [pid, p] of this.players) players[pid] = { stage: p.stage, landed: p.landed, spin: p.spin && { ...p.spin } };
    return { tokens: Object.fromEntries(this.tokens), players, deadline: this.deadline, goMs: this.goMs, finished: this.finished };
  }
}
