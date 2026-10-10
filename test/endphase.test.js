// Phase 4: the end phase. Test names start with the matrix ID they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Draft } from '../src/draft.js';
import { EndPhase } from '../src/endphase.js';
import { Room } from '../src/room.js';

const T0 = 1_000_000;
const first = () => 0;
const ids = (n) => Array.from({ length: n }, (_, i) => `c${i + 1}`);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

// Plays a whole draft. `binners` maps player -> number of turns on which they bin first.
function finishedDraft({ roleCount = 5, players = ['A', 'B', 'C'], binners = {}, timeoutFor = {} } = {}) {
  const d = new Draft({ characterIds: ids(roleCount * players.length * 3 + 20), turnOrder: players, roleCount, random: first });
  d.begin(T0);
  const binsUsed = {};
  const timeouts = {};
  while (!d.finished) {
    const p = d.turn.playerId;
    if ((timeouts[p] || 0) < (timeoutFor[p] || 0)) { timeouts[p] = (timeouts[p] || 0) + 1; d.timeout(T0); continue; }
    d.spin(p, T0);
    if ((binsUsed[p] || 0) < (binners[p] || 0)) { binsUsed[p] = (binsUsed[p] || 0) + 1; d.bin(p, T0); d.spin(p, T0); }
    d.place(p, d.teams.get(p).indexOf(null), T0);
  }
  return d;
}
const endPhase = (opts) => { const d = finishedDraft(opts); const e = new EndPhase(d, { random: first }); e.begin(T0); return { d, e }; };

const st = (e, pid) => e.players.get(pid).stage;

test('T4.05 after the last spin the end phase opens for everyone at once', () => {
  const { e } = endPhase();
  assert.deepEqual(['A', 'B', 'C'].map((p) => st(e, p)), ['choose', 'choose', 'choose']);
  e.swap('C', 0, 1, T0); // C doesn't wait for A or B
  assert.equal(st(e, 'C'), 'done');
});
test('T4.04 end-phase actions are not available mid-draft', () => {
  const r = new Room({ id: 'r', hostName: 'Ste', hostToken: 'h', settings: { roomName: 'R', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 8, turnOrder: 'join' } });
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.addCharacters(r.hostId, { text: ids(40).join('\n') });
  r.start(r.hostId);
  assert.equal(code(() => r.endAction(r.hostId, 'extraSpin')), 'NOT_END_PHASE');
});
test('T4.06 10-role game, 1 bin used: 1 token', () => assert.equal(endPhase({ roleCount: 10, binners: { A: 1 } }).e.tokens.get('A'), 1));
test('T4.07 10-role game, no bins used: 2 tokens', () => assert.equal(endPhase({ roleCount: 10 }).e.tokens.get('A'), 2));
test('T4.08 5-role game, no bin used: 1 token', () => assert.equal(endPhase().e.tokens.get('B'), 1));
test('T4.09 all bins used: no tokens, so that player is done from the start', () => {
  const { e } = endPhase({ binners: { A: 1 } });
  assert.equal(e.tokens.get('A'), 0);
  assert.equal(st(e, 'A'), 'done');
  assert.equal(st(e, 'B'), 'choose');
});

test('T4.10 swap two roles: they trade places, one token used, done when tokens run out', () => {
  const { d, e } = endPhase();
  const [x, , y] = d.teams.get('A');
  e.swap('A', 0, 2, T0);
  assert.equal(d.teams.get('A')[0], y);
  assert.equal(d.teams.get('A')[2], x);
  assert.equal(e.tokens.get('A'), 0);
  assert.equal(st(e, 'A'), 'done');
});
test('T4.11 swapping a role with itself is blocked and costs nothing', () => {
  const { e } = endPhase();
  assert.equal(code(() => e.swap('A', 1, 1, T0)), 'SAME_ROLE');
  assert.equal(e.tokens.get('A'), 1);
});
test('T4.12 a player can only change their own team; a finished player cannot act again', () => {
  const { d, e } = endPhase();
  const bBefore = [...d.teams.get('B')];
  e.swap('A', 0, 1, T0);
  assert.deepEqual(d.teams.get('B'), bBefore, 'A’s swap only touches A’s team');
  assert.equal(code(() => e.swap('A', 0, 1, T0)), 'YOU_ARE_DONE');
  assert.equal(code(() => e.swap('Z', 0, 1, T0)), 'NOT_PLAYING');
});
test('T4.13 pick from the bin: replaces one of yours; the replaced one goes in the bin', () => {
  const { d, e } = endPhase({ binners: { B: 1 } });
  const binnedChar = d.binned[0];
  const old = d.teams.get('A')[3];
  e.pickFromBin('A', binnedChar, 3, T0);
  assert.equal(d.teams.get('A')[3], binnedChar);
  assert.ok(d.binned.includes(old));
  assert.ok(!d.binned.includes(binnedChar));
});
test('T4.14 extra spin, kept: replaces one of yours; replaced one goes in the bin', () => {
  const { d, e } = endPhase();
  const old = d.teams.get('A')[1];
  e.extraSpin('A', T0);
  const landed = e.players.get('A').landed;
  assert.ok(!d.pool.includes(landed));
  e.keepExtra('A', 1, T0);
  assert.equal(d.teams.get('A')[1], landed);
  assert.ok(d.binned.includes(old));
});
test('T4.15 extra spin, not kept: team unchanged, spun character to the bin, token used', () => {
  const { d, e } = endPhase();
  const before = [...d.teams.get('A')];
  e.extraSpin('A', T0);
  const landed = e.players.get('A').landed;
  e.declineExtra('A', T0);
  assert.deepEqual(d.teams.get('A'), before);
  assert.ok(d.binned.includes(landed));
  assert.equal(e.tokens.get('A'), 0);
});
test('T4.16 10-role game with 2 tokens: one extra spin and one swap', () => {
  const { d, e } = endPhase({ roleCount: 10 });
  e.extraSpin('A', T0); e.keepExtra('A', 4, T0);
  assert.equal(st(e, 'A'), 'choose', 'still deciding with a token left');
  const [x, y] = d.teams.get('A');
  e.swap('A', 0, 1, T0);
  assert.deepEqual(d.teams.get('A').slice(0, 2), [y, x]);
  assert.equal(st(e, 'A'), 'done');
});
test('T4.17 two players want the same binned character: whoever asks first gets it', () => {
  const { d, e } = endPhase({ binners: { C: 1 } });
  const wanted = d.binned[0];
  e.pickFromBin('B', wanted, 0, T0); // B asks first, even though A is earlier in turn order
  assert.equal(code(() => e.pickFromBin('A', wanted, 0, T0)), 'NOT_IN_BIN');
  assert.equal(e.tokens.get('A'), 1, 'the loser keeps their token');
});
test('T4.18 picking from the bin with no tokens is not possible', () => {
  const { e } = endPhase();
  e.swap('A', 0, 1, T0); // spends A's only token
  assert.equal(code(() => e.pickFromBin('A', 'c1', 0, T0)), 'YOU_ARE_DONE');
});
test('T4.19 bin empty: bin pick refused', () => {
  const { d, e } = endPhase();
  assert.equal(d.binned.length, 0);
  assert.equal(code(() => e.pickFromBin('A', 'c999', 0, T0)), 'NOT_IN_BIN');
});
test('T4.20–T4.22 tokens never fill an empty role', () => {
  const { d, e } = endPhase({ timeoutFor: { A: 1 } });
  const gap = d.teams.get('A').indexOf(null);
  assert.ok(gap >= 0, 'A has a gap from the timeout');
  const filled = d.teams.get('A').findIndex((x) => x !== null);
  assert.equal(code(() => e.swap('A', gap, filled, T0)), 'EMPTY_ROLE');
  e.extraSpin('A', T0);
  assert.equal(code(() => e.keepExtra('A', gap, T0)), 'EMPTY_ROLE');
  e.keepExtra('A', filled, T0);
  assert.equal(d.teams.get('A')[gap], null, 'the gap is still there');
});
test('T4.23 player with a gap and tokens can still use them on filled roles', () => {
  const { e } = endPhase({ timeoutFor: { B: 1 } });
  assert.equal(st(e, 'B'), 'choose');
  assert.equal(e.tokens.get('B'), 1);
});
test('T4.24 doing nothing: everyone’s time ends at 50 s (5 roles), unused tokens lost', () => {
  const { e } = endPhase();
  assert.equal(e.dueAt(), T0 + 50_000);
  e.timeout(T0 + 50_000);
  assert.deepEqual(['A', 'B', 'C'].map((p) => e.tokens.get(p)), [0, 0, 0]);
  assert.equal(e.finished, true);
});
test('R4.2 10-role games give 100 seconds', () => assert.equal(endPhase({ roleCount: 10 }).e.dueAt(), T0 + 100_000));
test('T4.25 the timer is shared: it does not restart when one player finishes', () => {
  const { e } = endPhase();
  e.done('A', T0 + 3000);
  assert.equal(e.dueAt(), T0 + 50_000);
});
test('T4.31 everyone finishing early ends the phase straight away', () => {
  const { e } = endPhase();
  e.done('A', T0); e.swap('B', 0, 1, T0);
  assert.equal(e.finished, false);
  e.done('C', T0);
  assert.equal(e.finished, true);
  assert.equal(e.dueAt(), null);
});
test('T4.32 two players spin at once: they never land the same character', () => {
  const { e } = endPhase();
  e.extraSpin('A', T0); e.extraSpin('B', T0);
  assert.notEqual(e.players.get('A').landed, e.players.get('B').landed);
  assert.equal(st(e, 'A'), 'extra'); assert.equal(st(e, 'B'), 'extra');
});
test('T4.33 a spin near the end extends the shared timer so the player can decide', () => {
  const { e } = endPhase();
  e.extraSpin('A', T0 + 49_000);
  assert.ok(e.dueAt() >= T0 + 49_000 + 13_500);
});
test('R4.4 timing out mid extra-spin bins the spun character', () => {
  const { d, e } = endPhase();
  e.extraSpin('A', T0);
  const landed = e.players.get('A').landed;
  e.timeout(T0 + 200_000);
  assert.ok(d.binned.includes(landed));
});
test('T4.34 a player leaving mid-phase does not hold everyone up', () => {
  const { e } = endPhase();
  e.done('A', T0); e.done('B', T0);
  e.removePlayer('C');
  assert.equal(e.finished, true);
});
test('T4.35 in a room, every player can act during the same moment', () => {
  const r = new Room({ id: 'r', hostName: 'Ste', hostToken: 'h', settings: { roomName: 'R', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 8, turnOrder: 'join' } });
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.addCharacters(r.hostId, { text: ids(40).join('\n') });
  r.start(r.hostId, Math.random, T0);
  while (r.phase === 'draft') { const p = r.draft.turn.playerId; r.draftAction(p, 'spin', {}, T0); r.draftAction(p, 'place', { role: r.draft.teams.get(p).indexOf(null) }, T0); }
  assert.equal(r.phase, 'endphase');
  const [a, b, c] = r.players.map((p) => p.id);
  r.endAction(c, 'extraSpin', {}, T0);
  r.endAction(a, 'swap', { roleA: 0, roleB: 1 }, T0);
  const v = r.viewFor(b);
  assert.equal(v.end.players[c].stage, 'extra');
  assert.ok(v.charNames[v.end.players[c].landed], 'names for the spun character');
  r.endAction(b, 'endDone', {}, T0);
  r.endAction(c, 'keepExtra', { role: 2 }, T0);
  assert.equal(r.phase, 'faceoff');
});
