// The draft: players take turns spinning the shared wheel and placing characters into roles.
// Pure logic with an injectable clock and random source, so every rule is unit-tested.
//
// A turn moves through stages:
//   spin     -> waiting for the player to spin (also after a bin, waiting for the re-spin)
//   landed   -> a character landed: place it, hold it, or bin it
//   held     -> holding a character, waiting for the second spin
//   compare  -> holding one and the second spin landed: keep one, the other goes (R2.3)
// Each player gets one turn per role. A turn either fills a role or, on timeout, leaves a gap.

import { randomInt } from 'node:crypto';

export const SPIN_MS = 3500; // wheel animation length; timers start after it
export const INACTIVE_SKIP_MS = 60_000; // R8.8: disconnected active player with the timer off

export class DraftError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const secureRandom = (n) => randomInt(n);

export class Draft {
  constructor({ characterIds, turnOrder, roleCount, timerSeconds = 0, releasedHoldToBin = true, random = secureRandom }) {
    this.roleCount = roleCount;
    this.timerMs = timerSeconds > 0 ? timerSeconds * 1000 : 0;
    this.releasedHoldToBin = releasedHoldToBin;
    this.random = random;
    this.charOrder = new Map(characterIds.map((id, i) => [id, i]));
    this.pool = [...characterIds];
    this.binned = []; // characters out until the game ends
    this.order = [...turnOrder];
    this.teams = new Map(this.order.map((p) => [p, Array(roleCount).fill(null)]));
    this.binsLeft = new Map(this.order.map((p) => [p, roleCount === 10 ? 2 : 1]));
    this.holdsLeft = new Map(this.order.map((p) => [p, 1]));
    this.turnsTaken = new Map(this.order.map((p) => [p, 0]));
    this.turn = null;
    this.lastIndex = -1;
    this.spinCount = 0;
    this.log = [];
    this.finished = false;
  }

  // ---------- turn flow ----------
  begin(now) { this.#nextTurn(now); }

  #nextTurn(now) {
    this.turn = null;
    const n = this.order.length;
    for (let step = 1; step <= n; step += 1) {
      const i = (this.lastIndex + step) % n;
      const pid = this.order[i];
      if (this.turnsTaken.get(pid) < this.roleCount) {
        this.lastIndex = i;
        this.turn = { playerId: pid, stage: 'spin', landed: null, held: null, usedBailout: false, startedAt: now, deadline: this.#deadline(now, false), spin: null };
        return;
      }
    }
    this.finished = true;
  }

  #deadline(now, afterSpin) {
    return this.timerMs ? now + this.timerMs + (afterSpin ? SPIN_MS : 0) : null;
  }

  #requireTurn(pid, ...stages) {
    if (this.finished) throw new DraftError('DRAFT_OVER', 'The draft is over.');
    if (!this.turn || this.turn.playerId !== pid) throw new DraftError('NOT_YOUR_TURN', 'It’s not your turn.');
    if (stages.length && !stages.includes(this.turn.stage)) throw new DraftError('WRONG_STEP', 'You can’t do that right now.');
    return this.turn;
  }

  #emptyRole(pid, roleIndex) {
    const team = this.teams.get(pid);
    const r = Number(roleIndex);
    if (!Number.isInteger(r) || r < 0 || r >= this.roleCount) throw new DraftError('BAD_ROLE', 'Pick one of your roles.');
    if (team[r] !== null) throw new DraftError('ROLE_FILLED', 'That role is already filled. Pick an empty one.');
    return r;
  }

  #returnToPool(id) {
    if (id == null || this.pool.includes(id)) return;
    this.pool.push(id);
    this.pool.sort((a, b) => this.charOrder.get(a) - this.charOrder.get(b));
  }

  #endTurn(now) {
    const pid = this.turn.playerId;
    this.turnsTaken.set(pid, this.turnsTaken.get(pid) + 1);
    this.#nextTurn(now);
  }

  #note(entry, now) {
    this.log.push({ ...entry, at: now });
    if (this.log.length > 30) this.log.shift();
  }

  // ---------- player actions ----------
  spin(pid, now) {
    const turn = this.#requireTurn(pid, 'spin', 'held');
    if (!this.pool.length) throw new DraftError('POOL_EMPTY', 'The wheel is empty.');
    const wheel = [...this.pool];
    const landed = wheel[this.random(wheel.length)];
    this.pool = this.pool.filter((id) => id !== landed);
    turn.landed = landed;
    turn.stage = turn.stage === 'held' ? 'compare' : 'landed';
    this.spinCount += 1;
    turn.spin = { id: this.spinCount, wheel, landed, at: now };
    turn.deadline = this.#deadline(now, true);
    return landed;
  }

  place(pid, roleIndex, now) {
    const turn = this.#requireTurn(pid, 'landed');
    const r = this.#emptyRole(pid, roleIndex);
    this.teams.get(pid)[r] = turn.landed;
    this.#note({ kind: 'placed', playerId: pid, charId: turn.landed, role: r }, now);
    this.#endTurn(now);
  }

  hold(pid, now) {
    const turn = this.#requireTurn(pid, 'landed');
    if (turn.usedBailout) throw new DraftError('ONE_BAILOUT', 'You’ve already used a hold or bin this turn.');
    if (this.holdsLeft.get(pid) < 1) throw new DraftError('NO_HOLDS', 'You’ve used your hold.');
    this.holdsLeft.set(pid, 0);
    turn.held = turn.landed;
    turn.landed = null;
    turn.usedBailout = true;
    turn.stage = 'held';
    turn.deadline = this.#deadline(now, false);
    this.#note({ kind: 'held', playerId: pid, charId: turn.held }, now);
  }

  bin(pid, now) {
    const turn = this.#requireTurn(pid, 'landed');
    if (turn.usedBailout) throw new DraftError('ONE_BAILOUT', 'You’ve already used a hold or bin this turn.');
    if (this.binsLeft.get(pid) < 1) throw new DraftError('NO_BINS', 'You’ve used all your bins.');
    this.binsLeft.set(pid, this.binsLeft.get(pid) - 1);
    this.binned.push(turn.landed);
    this.#note({ kind: 'binned', playerId: pid, charId: turn.landed }, now);
    turn.landed = null;
    turn.usedBailout = true;
    turn.stage = 'spin';
    turn.deadline = this.#deadline(now, false);
  }

  // After a hold and a second spin: keep 'held' or 'new' and place it.
  keep(pid, choice, roleIndex, now) {
    const turn = this.#requireTurn(pid, 'compare');
    if (choice !== 'held' && choice !== 'new') throw new DraftError('BAD_CHOICE', 'Choose which character to keep.');
    const r = this.#emptyRole(pid, roleIndex);
    if (choice === 'new') {
      this.teams.get(pid)[r] = turn.landed;
      if (this.releasedHoldToBin) this.binned.push(turn.held); else this.#returnToPool(turn.held); // R3.1
      this.#note({ kind: 'keptNew', playerId: pid, charId: turn.landed, released: turn.held, role: r, releasedTo: this.releasedHoldToBin ? 'bin' : 'pool' }, now);
    } else {
      this.teams.get(pid)[r] = turn.held;
      this.binned.push(turn.landed); // R2.3: the unkept second spin is binned, at no cost
      this.#note({ kind: 'keptHeld', playerId: pid, charId: turn.held, released: turn.landed, role: r, releasedTo: 'bin' }, now);
    }
    this.#endTurn(now);
  }

  // ---------- running out of time ----------
  // When the current turn is due to be cut short, or null.
  dueAt({ activeConnected = true, activeDisconnectedAt = null } = {}) {
    if (!this.turn) return null;
    if (this.turn.deadline) return this.turn.deadline;
    if (!activeConnected && activeDisconnectedAt != null) {
      return Math.max(activeDisconnectedAt, this.turn.startedAt) + INACTIVE_SKIP_MS; // R8.8
    }
    return null;
  }

  // R8.6: the turn is lost. A landed character goes back on the wheel; no re-spin is given.
  // A held character is placed in the first empty role so it isn't lost.
  timeout(now, reason = 'timer') {
    const turn = this.turn;
    if (!turn) return false;
    const pid = turn.playerId;
    const team = this.teams.get(pid);
    if (turn.held != null) {
      const r = team.indexOf(null);
      team[r] = turn.held;
      this.#returnToPool(turn.landed);
      this.#note({ kind: 'timeoutHeld', playerId: pid, charId: turn.held, role: r, returned: turn.landed, reason }, now);
    } else {
      this.#returnToPool(turn.landed);
      this.#note({ kind: 'timeout', playerId: pid, returned: turn.landed, reason }, now);
    }
    this.#endTurn(now);
    return true;
  }

  // ---------- players leaving mid-draft (kicked or voted out) ----------
  removePlayer(pid, now) {
    const idx = this.order.indexOf(pid);
    if (idx === -1) return;
    const wasTurn = this.turn?.playerId === pid;
    if (wasTurn) { this.#returnToPool(this.turn.landed); this.#returnToPool(this.turn.held); this.turn = null; }
    for (const id of this.teams.get(pid)) this.#returnToPool(id);
    for (const m of [this.teams, this.binsLeft, this.holdsLeft, this.turnsTaken]) m.delete(pid);
    this.order.splice(idx, 1);
    if (idx <= this.lastIndex) this.lastIndex -= 1;
    this.#note({ kind: 'removed', playerId: pid }, now);
    if (!this.order.length) { this.finished = true; this.turn = null; return; }
    if (wasTurn) this.#nextTurn(now);
  }

  // ---------- views ----------
  // Empty roles caused by timeouts so far (turns taken that didn't fill a role).
  gaps(pid) {
    const team = this.teams.get(pid) || [];
    return (this.turnsTaken.get(pid) || 0) - team.filter((x) => x !== null).length;
  }

  view(now) {
    const obj = (m) => Object.fromEntries(m);
    return {
      pool: this.pool,
      bin: this.binned,
      order: this.order,
      teams: obj(this.teams),
      binsLeft: obj(this.binsLeft),
      holdsLeft: obj(this.holdsLeft),
      turnsTaken: obj(this.turnsTaken),
      turn: this.turn && { ...this.turn },
      roleCount: this.roleCount,
      log: this.log.slice(-12),
      finished: this.finished,
      spinMs: SPIN_MS,
      timerMs: this.timerMs,
      serverNow: now,
    };
  }
}
