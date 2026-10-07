// End phase (R4): after the draft, each unused bin/respin is one token. In turn order, each player gets
// one timed go to spend tokens on: swapping two of their characters, picking from the bin, or one extra spin.
// Tokens only work on roles that already have a character — they never fill a gap left by a timeout.
// Works directly on the finished draft's teams, pool and bin.

import { randomInt } from 'node:crypto';
import { DraftError, SPIN_MS } from './draft.js';

export class EndPhase {
  constructor(draft, { random = (n) => randomInt(n) } = {}) {
    this.d = draft;
    this.random = random;
    this.goMs = draft.roleCount * 10_000; // 50 s for 5 roles, 100 s for 10 (same as voting)
    this.tokens = new Map(draft.order.map((p) => [p, draft.binsLeft.get(p) ?? 0]));
    this.hadGo = new Set();
    this.go = null;
    this.lastIndex = -1;
    this.finished = false;
  }

  #filled(pid) { return (this.d.teams.get(pid) || []).filter((x) => x !== null).length; }

  // A player only gets a go if they have tokens and at least one placed character.
  begin(now) { this.#nextGo(now); }

  #nextGo(now) {
    this.go = null;
    const order = this.d.order;
    for (let step = 1; step <= order.length; step += 1) {
      const i = (this.lastIndex + step) % order.length;
      const pid = order[i];
      if (this.hadGo.has(pid)) continue;
      if ((this.tokens.get(pid) ?? 0) > 0 && this.#filled(pid) > 0) {
        this.lastIndex = i;
        this.go = { playerId: pid, stage: 'choose', landed: null, spin: null, startedAt: now, deadline: now + this.goMs };
        return;
      }
      this.hadGo.add(pid); // nothing to spend: skip
    }
    this.finished = true;
  }

  #require(pid, stage) {
    if (this.finished || !this.go) throw new DraftError('END_OVER', 'The end phase is over.');
    if (this.go.playerId !== pid) throw new DraftError('NOT_YOUR_GO', 'It’s not your go.');
    if (stage && this.go.stage !== stage) throw new DraftError('WRONG_STEP', 'Finish what you’re doing first.');
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

  #endGoIfSpent(now) {
    if ((this.tokens.get(this.go.playerId) ?? 0) === 0 && this.go.stage === 'choose') this.#finishGo(now);
  }

  #finishGo(now) {
    const pid = this.go.playerId;
    this.hadGo.add(pid);
    this.tokens.set(pid, 0); // unused tokens are lost when the go ends
    this.#nextGo(now);
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
    this.#endGoIfSpent(now);
  }

  pickFromBin(pid, charId, role, now) {
    this.#require(pid, 'choose');
    const r = this.#filledRole(pid, role);
    if (!this.d.binned.includes(charId)) throw new DraftError('NOT_IN_BIN', 'That character isn’t in the bin any more.');
    this.#spend(pid);
    const team = this.d.teams.get(pid);
    const replaced = team[r];
    team[r] = charId;
    this.d.binned = this.d.binned.filter((id) => id !== charId);
    this.d.binned.push(replaced);
    this.#note({ kind: 'binPick', playerId: pid, charId, replaced, role: r }, now);
    this.#endGoIfSpent(now);
  }

  extraSpin(pid, now) {
    this.#require(pid, 'choose');
    if (!this.d.pool.length) throw new DraftError('POOL_EMPTY', 'The wheel is empty.');
    this.#spend(pid);
    const wheel = [...this.d.pool];
    const landed = wheel[this.random(wheel.length)];
    this.d.pool = this.d.pool.filter((id) => id !== landed);
    this.d.spinCount += 1;
    this.go.stage = 'extra';
    this.go.landed = landed;
    this.go.spin = { id: this.d.spinCount, wheel, landed, at: now };
    this.go.deadline = Math.max(this.go.deadline, now + SPIN_MS + 10_000); // always time to decide after the spin
  }

  // After an extra spin: put the new character in a filled role (replaced one goes to the bin), or let it go.
  keepExtra(pid, role, now) {
    this.#require(pid, 'extra');
    const r = this.#filledRole(pid, role);
    const team = this.d.teams.get(pid);
    const replaced = team[r];
    team[r] = this.go.landed;
    this.d.binned.push(replaced);
    this.#note({ kind: 'extraKept', playerId: pid, charId: this.go.landed, replaced, role: r }, now);
    this.go.stage = 'choose'; this.go.landed = null;
    this.#endGoIfSpent(now);
  }

  declineExtra(pid, now) {
    this.#require(pid, 'extra');
    this.d.binned.push(this.go.landed);
    this.#note({ kind: 'extraDeclined', playerId: pid, charId: this.go.landed }, now);
    this.go.stage = 'choose'; this.go.landed = null;
    this.#endGoIfSpent(now);
  }

  done(pid, now) {
    this.#require(pid);
    if (this.go.stage === 'extra') this.declineExtra(pid, now);
    if (this.go?.playerId === pid) this.#finishGo(now);
  }

  dueAt() { return this.go?.deadline ?? null; }

  timeout(now) {
    if (!this.go) return false;
    const pid = this.go.playerId;
    if (this.go.stage === 'extra') { this.d.binned.push(this.go.landed); this.#note({ kind: 'extraDeclined', playerId: pid, charId: this.go.landed, timedOut: true }, now); }
    this.#note({ kind: 'goTimeout', playerId: pid }, now);
    this.#finishGo(now);
    return true;
  }

  removePlayer(pid, now) {
    this.tokens.delete(pid);
    this.hadGo.add(pid);
    if (this.go?.playerId === pid) {
      if (this.go.stage === 'extra') this.d.binned.push(this.go.landed);
      this.#nextGo(now);
    }
  }

  view() {
    return { tokens: Object.fromEntries(this.tokens), go: this.go && { ...this.go }, goMs: this.goMs, finished: this.finished, hadGo: [...this.hadGo] };
  }
}
