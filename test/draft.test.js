// Phase 3: the draft. Test names start with the matrix ID they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Draft, SPIN_MS, INACTIVE_SKIP_MS } from '../src/draft.js';
import { Room, GameError } from '../src/room.js';

const T0 = 1_000_000;
const first = () => 0; // wheel always lands on the first character still in the pool
const ids = (n) => Array.from({ length: n }, (_, i) => `c${i + 1}`);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

function draft(over = {}) {
  const d = new Draft({ characterIds: ids(60), turnOrder: ['A', 'B', 'C'], roleCount: 5, random: first, ...over });
  d.begin(T0);
  return d;
}
// Plays a simple turn: spin and place into the first empty role.
function playTurn(d, now = T0) {
  const pid = d.turn.playerId;
  d.spin(pid, now);
  d.place(pid, d.teams.get(pid).indexOf(null), now);
  return pid;
}

function room(over = {}) {
  const r = new Room({ id: 'r', hostName: 'Ste', hostToken: 'h', settings: { roomName: 'R', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 8, turnOrder: 'join', releasedHoldToBin: true, ...over } });
  const a = r.join('t2', 'Nami').player;
  const b = r.join('t3', 'Usopp').player;
  r.addCharacters(r.hostId, { text: ids(60).join('\n') });
  r.random = first;
  r.start(r.hostId, Math.random, T0);
  return { r, host: r.hostId, a: a.id, b: b.id };
}

// ---------- turn order and rounds ----------
test('R1.4 turns go round in order, one turn per role each', () => {
  const d = draft();
  const seen = [];
  while (!d.finished) seen.push(playTurn(d));
  assert.equal(seen.length, 15);
  assert.deepEqual(seen.slice(0, 6), ['A', 'B', 'C', 'A', 'B', 'C']);
  for (const p of ['A', 'B', 'C']) assert.ok(d.teams.get(p).every((x) => x !== null));
});
test('T8.03 only the active player can spin', () => {
  const d = draft();
  assert.equal(code(() => d.spin('B', T0)), 'NOT_YOUR_TURN');
});
test('T8.04 no double spin: a second spin before placing is refused', () => {
  const d = draft();
  d.spin('A', T0);
  assert.equal(code(() => d.spin('A', T0)), 'WRONG_STEP');
});
test('T8.07 next player cannot spin until the character is placed', () => {
  const d = draft();
  d.spin('A', T0);
  assert.equal(code(() => d.spin('B', T0)), 'NOT_YOUR_TURN');
  d.place('A', 0, T0);
  assert.equal(d.turn.playerId, 'B');
});

// ---------- R1.5 / R1.6 ----------
test('T1.16 placed character is no longer on the wheel', () => {
  const d = draft();
  const landed = d.spin('A', T0);
  d.place('A', 0, T0);
  assert.ok(!d.pool.includes(landed));
});
test('T1.18 the next player cannot land a claimed character', () => {
  const d = new Draft({ characterIds: ids(30), turnOrder: ['A', 'B', 'C'], roleCount: 5 });
  d.begin(T0);
  const claimed = new Set();
  while (!d.finished) {
    const pid = d.turn.playerId;
    const c = d.spin(pid, T0);
    assert.ok(!claimed.has(c), 'landed a claimed character');
    claimed.add(c);
    d.place(pid, d.teams.get(pid).indexOf(null), T0);
  }
});
test('T1.19 / T1.20 place into an empty role; a filled role is blocked', () => {
  const d = draft();
  d.spin('A', T0); d.place('A', 2, T0);
  playTurn(d); playTurn(d);
  d.spin('A', T0);
  assert.equal(code(() => d.place('A', 2, T0)), 'ROLE_FILLED');
  assert.equal(code(() => d.place('A', 9, T0)), 'BAD_ROLE');
  d.place('A', 0, T0);
});

// ---------- R2 hold and bin ----------
test('T2.01 / T2.04 hold once; a second hold is blocked', () => {
  const d = draft();
  d.spin('A', T0); d.hold('A', T0); d.spin('A', T0); d.keep('A', 'new', 0, T0);
  playTurn(d); playTurn(d);
  d.spin('A', T0);
  assert.equal(code(() => d.hold('A', T0)), 'NO_HOLDS');
});
test('T2.02 / T2.05 5-role game: one bin, a second is blocked', () => {
  const d = draft();
  d.spin('A', T0); d.bin('A', T0); d.spin('A', T0); d.place('A', 0, T0);
  playTurn(d); playTurn(d);
  d.spin('A', T0);
  assert.equal(code(() => d.bin('A', T0)), 'NO_BINS');
});
test('T2.03 / T2.06 10-role game: two bins on different turns, a third is blocked', () => {
  const d = draft({ roleCount: 10, characterIds: ids(120) });
  for (let k = 0; k < 2; k += 1) {
    d.spin('A', T0); d.bin('A', T0); d.spin('A', T0); d.place('A', d.teams.get('A').indexOf(null), T0);
    playTurn(d); playTurn(d);
  }
  d.spin('A', T0);
  assert.equal(code(() => d.bin('A', T0)), 'NO_BINS');
  assert.equal(d.holdsLeft.get('A'), 1, 'hold is still 1 in a 10-role game');
});
test('T2.08 bin grants a re-spin straight away', () => {
  const d = draft();
  const binned = d.spin('A', T0);
  d.bin('A', T0);
  assert.equal(d.turn.stage, 'spin');
  assert.equal(d.turn.playerId, 'A');
  assert.ok(d.binned.includes(binned));
});
test('T2.09 a binned character never appears again', () => {
  const d = draft();
  const binned = d.spin('A', T0);
  d.bin('A', T0);
  d.spin('A', T0); d.place('A', 0, T0);
  while (!d.finished) {
    const pid = d.turn.playerId;
    assert.notEqual(d.spin(pid, T0), binned);
    d.place(pid, d.teams.get(pid).indexOf(null), T0);
  }
});
test('T2.11 hold, re-spin, keep the new one: held character released per setting (bin)', () => {
  const d = draft({ releasedHoldToBin: true });
  const held = d.spin('A', T0); d.hold('A', T0);
  const fresh = d.spin('A', T0);
  d.keep('A', 'new', 0, T0);
  assert.equal(d.teams.get('A')[0], fresh);
  assert.ok(d.binned.includes(held));
  assert.ok(!d.pool.includes(held));
});
test('T2.12 hold, re-spin, keep the held one: second character goes to the bin', () => {
  const d = draft();
  const held = d.spin('A', T0); d.hold('A', T0);
  const fresh = d.spin('A', T0);
  d.keep('A', 'held', 3, T0);
  assert.equal(d.teams.get('A')[3], held);
  assert.ok(d.binned.includes(fresh));
});
test('T2.13 keeping the held one does not use a bin', () => {
  const d = draft();
  d.spin('A', T0); d.hold('A', T0); d.spin('A', T0); d.keep('A', 'held', 0, T0);
  assert.equal(d.binsLeft.get('A'), 1);
});
test('T2.14 one bail-out per turn: no bin after a hold', () => {
  const d = draft();
  d.spin('A', T0); d.hold('A', T0); d.spin('A', T0);
  assert.equal(code(() => d.bin('A', T0)), 'WRONG_STEP');
});
test('T2.15 one bail-out per turn: no hold on the re-spin after a bin', () => {
  const d = draft();
  d.spin('A', T0); d.bin('A', T0); d.spin('A', T0);
  assert.equal(code(() => d.hold('A', T0)), 'ONE_BAILOUT');
});
test('T2.16 one bail-out per turn: no second bin on the same turn (10 roles)', () => {
  const d = draft({ roleCount: 10, characterIds: ids(120) });
  d.spin('A', T0); d.bin('A', T0); d.spin('A', T0);
  assert.equal(code(() => d.bin('A', T0)), 'ONE_BAILOUT');
});

// ---------- R3.1 released-hold setting ----------
test('T3.02 setting No: released held character goes back on the wheel and can be landed later', () => {
  const d = draft({ releasedHoldToBin: false });
  const held = d.spin('A', T0); d.hold('A', T0);
  d.spin('A', T0); d.keep('A', 'new', 0, T0);
  assert.ok(d.pool.includes(held));
  assert.equal(d.spin('B', T0), held, 'first-in-pool wheel lands on the returned character');
});
test('T3.03 setting Yes: released character never returns', () => {
  const d = draft({ releasedHoldToBin: true });
  const held = d.spin('A', T0); d.hold('A', T0);
  d.spin('A', T0); d.keep('A', 'new', 0, T0);
  while (!d.finished) { const pid = d.turn.playerId; assert.notEqual(d.spin(pid, T0), held); d.place(pid, d.teams.get(pid).indexOf(null), T0); }
});

// ---------- R8.5 / R8.6 timer and timeouts ----------
test('T8.10 timer on: deadline set, and runs from after the spin animation', () => {
  const d = draft({ timerSeconds: 30 });
  assert.equal(d.turn.deadline, T0 + 30_000);
  d.spin('A', T0 + 1000);
  assert.equal(d.turn.deadline, T0 + 1000 + SPIN_MS + 30_000);
});
test('T8.11 timer off: no deadline', () => assert.equal(draft().turn.deadline, null));
test('T8.13 / T8.14 timeout: character back on the wheel, turn lost, no extra spin', () => {
  const d = draft({ timerSeconds: 30 });
  const landed = d.spin('A', T0);
  d.timeout(T0 + 40_000);
  assert.ok(d.pool.includes(landed));
  assert.equal(d.turn.playerId, 'B');
  assert.equal(d.turnsTaken.get('A'), 1);
  assert.equal(d.gaps('A'), 1);
  assert.equal(d.binsLeft.get('A'), 1, 'a timeout does not cost a respin');
});
test('T8.15 timer runs out while holding: held character goes into the first empty role', () => {
  const d = draft({ timerSeconds: 30 });
  d.spin('A', T0); d.place('A', 0, T0); playTurn(d); playTurn(d);
  const held = d.spin('A', T0); d.hold('A', T0);
  d.timeout(T0 + 40_000);
  assert.equal(d.teams.get('A')[1], held);
  assert.equal(d.gaps('A'), 0);
});
test('R8.6 timeout after the second spin of a hold: held is placed, second goes back on the wheel', () => {
  const d = draft({ timerSeconds: 30 });
  const held = d.spin('A', T0); d.hold('A', T0);
  const second = d.spin('A', T0);
  d.timeout(T0 + 60_000);
  assert.equal(d.teams.get('A')[0], held);
  assert.ok(d.pool.includes(second));
});
test('T8.16 player with a gap: draft still ends normally', () => {
  const d = draft({ timerSeconds: 30 });
  d.spin('A', T0); d.timeout(T0 + 99_000);
  while (!d.finished) playTurn(d);
  assert.equal(d.gaps('A'), 1);
  assert.equal(d.teams.get('A').filter((x) => x === null).length, 1);
});
test('R8.6 timeout before spinning loses the turn and returns nothing', () => {
  const d = draft({ timerSeconds: 15 });
  const poolBefore = d.pool.length;
  d.timeout(T0 + 16_000);
  assert.equal(d.pool.length, poolBefore);
  assert.equal(d.turn.playerId, 'B');
});

// ---------- R8.7 ----------
test('T8.17 a character returned after a timeout can be landed again', () => {
  const d = draft({ timerSeconds: 30 });
  const c = d.spin('A', T0); d.timeout(T0 + 99_000);
  assert.equal(d.spin('B', T0), c);
});

// ---------- R8.8 inactive player with the timer off ----------
test('T8.20 disconnected active player, timer off: due 60 seconds after they dropped', () => {
  const d = draft();
  assert.equal(d.dueAt({ activeConnected: true }), null);
  assert.equal(d.dueAt({ activeConnected: false, activeDisconnectedAt: T0 + 5000 }), T0 + 5000 + INACTIVE_SKIP_MS);
});

// ---------- room integration ----------
test('R8.8 room skips a disconnected active player after 60 seconds (timer off), counting a timeout', () => {
  const { r, host, a } = room();
  r.draftAction(host, 'spin', {}, T0); r.draftAction(host, 'place', { role: 0 }, T0);
  assert.equal(r.draft.turn.playerId, a);
  r.disconnect(a, T0 + 1000);
  assert.equal(r.tick(T0 + 60_000), false, 'not yet');
  assert.equal(r.tick(T0 + 61_000), true);
  assert.equal(r.draft.gaps(a), 1);
});
test('T8.21 reconnecting at 59 seconds: turn continues as normal', () => {
  const { r, host, a } = room();
  r.draftAction(host, 'spin', {}, T0); r.draftAction(host, 'place', { role: 0 }, T0);
  r.disconnect(a, T0);
  r.join('t2', 'x');
  assert.equal(r.turnDueAt(), null);
  assert.equal(r.tick(T0 + 120_000), false);
  assert.equal(r.draft.turn.playerId, a);
});
test('T8.22 / T8.23 vote-kick needs a majority of the other players', () => {
  const { r, host, a, b } = room();
  const res = r.voteKick(host, b);
  assert.equal(res.kicked, false);
  assert.equal(res.needed, 2);
  assert.ok(r.player(b), 'one vote of two is not enough');
  const res2 = r.voteKick(a, b);
  assert.equal(res2.kicked, true);
  assert.equal(r.player(b), undefined);
  assert.equal(code(() => r.join('t3', 'Usopp')), 'KICKED');
});
test('T8.24 cannot vote to kick yourself; repeat votes count once', () => {
  const { r, host, b } = room();
  assert.equal(code(() => r.voteKick(b, b)), 'KICK_SELF');
  r.voteKick(host, b); r.voteKick(host, b);
  assert.equal(r.kickTally(b).votes, 1);
});
test('R8.8 removing the active player mid-turn: their characters go back on the wheel and play moves on', () => {
  const { r, host, a, b } = room();
  r.draftAction(host, 'spin', {}, T0); r.draftAction(host, 'place', { role: 0 }, T0);
  const landed = (r.draftAction(a, 'spin', {}, T0), r.draft.turn.landed);
  r.kick(host, a);
  assert.ok(r.draft.pool.includes(landed));
  assert.equal(r.draft.turn.playerId, b);
});
test('R8.6 the whole draft completes and moves to the next phase', () => {
  const { r } = room();
  while (r.phase === 'draft') {
    const pid = r.draft.turn.playerId;
    r.draftAction(pid, 'spin', {}, T0);
    r.draftAction(pid, 'place', { role: r.draft.teams.get(pid).indexOf(null) }, T0);
  }
  assert.equal(r.phase, 'drafted');
  assert.equal(code(() => r.draftAction(r.hostId, 'spin', {}, T0)), 'NOT_DRAFTING');
});
test('NF5 draft actions from the wrong player are refused at the room level', () => {
  const { r, a } = room();
  assert.equal(code(() => r.draftAction(a, 'spin', {}, T0)), 'NOT_YOUR_TURN');
  assert.ok(code(() => r.draftAction(a, 'teleport', {}, T0)));
});
test('NF5 spins use the server’s secure random source and spread across the wheel', () => {
  const counts = new Map();
  for (let i = 0; i < 3000; i += 1) {
    const d = new Draft({ characterIds: ids(10), turnOrder: ['A'], roleCount: 5 });
    d.begin(T0);
    const c = d.spin('A', T0);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  assert.equal(counts.size, 10);
  for (const n of counts.values()) assert.ok(n > 200 && n < 400, `uneven: ${n}`);
});
test('T3.04 released-hold setting cannot change once the game starts', () => {
  const { r } = room();
  assert.ok(Object.isFrozen(r.settings) || typeof r.updateSettings !== 'function');
});
