// Regression tests for bugs found in play-testing (8 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.js';

const T0 = 1_000_000;
const names = Array.from({ length: 40 }, (_, i) => `Char ${i + 1}`);

// Plays a 3- or 4-player game up to the first face-off match. Returns the room and who is where.
function toFaceoff(playerCount = 3) {
  const r = new Room({ id: 'r', hostName: 'Host', hostToken: 'th', settings: { roomName: 'R', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 8, turnOrder: 'join' } });
  for (let i = 2; i <= playerCount; i += 1) r.join(`t${i}`, `P${i}`);
  r.addCharacters(r.hostId, { text: names.join('\n') });
  r.start(r.hostId, Math.random, T0);
  while (r.phase === 'draft') {
    const p = r.draft.turn.playerId;
    r.draftAction(p, 'spin', {}, T0);
    r.draftAction(p, 'place', { role: r.draft.teams.get(p).indexOf(null) }, T0);
  }
  while (r.phase === 'endphase') r.endAction(r.endPhase.go.playerId, 'endDone', {}, T0);
  assert.equal(r.phase, 'faceoff');
  const m = r.faceoff.match;
  const neutrals = r.players.map((p) => p.id).filter((id) => id !== m.a && id !== m.b);
  const tokenOf = (id) => r.player(id).token;
  return { r, m, neutrals, tokenOf };
}
// Keeps trying until the host is one of the two battlers in the first match.
function hostBattling(playerCount = 3) {
  for (let k = 0; k < 200; k += 1) {
    const s = toFaceoff(playerCount);
    if (s.m.a === s.r.hostId || s.m.b === s.r.hostId) return s;
  }
  throw new Error('host never drawn into the first match');
}
const allA = (m) => Object.fromEntries(m.pairings.filter((p) => p.auto === null).map((p) => [p.role, 'a']));
const allB = (m) => Object.fromEntries(m.pairings.filter((p) => p.auto === null).map((p) => [p.role, 'b']));

test('BUG 2: 3 players, host battling, the only voter drops: the match pauses instead of the host winning', () => {
  const { r, m, neutrals } = hostBattling(3);
  const [lone] = neutrals;
  r.disconnect(lone, T0 + 1000);
  assert.equal(Boolean(r.faceoff.match.paused), true);
  assert.equal(r.turnDueAt(), null, 'no timer runs while paused');
  assert.equal(r.tick(T0 + 10 * 60_000), false, 'nothing is decided, however long it waits');
  assert.equal(r.faceoff.match.winner, undefined);
  assert.equal(r.viewFor(r.hostId).faceoff.match.waitingFor[0], lone);
  void m;
});

test('BUG 2: the voter reconnects: voting resumes with the time that was left, and their vote decides', () => {
  const { r, m, neutrals, tokenOf } = hostBattling(3);
  const [lone] = neutrals;
  r.tick(T0); // nothing due yet
  r.disconnect(lone, T0 + 20_000); // 30 s of the 50 s left
  r.join(tokenOf(lone), 'x', T0 + 200_000);
  assert.equal(Boolean(r.faceoff.match.paused), false);
  assert.equal(r.turnDueAt(), T0 + 200_000 + 30_000);
  const loser = r.hostId;
  const pick = m.a === loser ? allB(m) : allA(m);
  r.faceoffAction(lone, 'vote', { picks: pick }, T0 + 205_000);
  assert.notEqual(r.faceoff.match.winner, r.hostId, 'the vote decides, not join order');
});

test('BUG 2: a voter who drops for a moment and comes back is never skipped', () => {
  const { r, neutrals, tokenOf } = hostBattling(3);
  const [lone] = neutrals;
  r.disconnect(lone, T0 + 1000);
  r.join(tokenOf(lone), 'x', T0 + 4000);
  r.tick(T0 + 49_000);
  assert.equal(r.faceoff.match.stage, 'voting');
});

test('BUG 2: if the absent voter is removed for good, the result is never decided by who joined first', () => {
  let hostWins = 0; let total = 0;
  for (let k = 0; k < 120; k += 1) {
    const { r, neutrals } = hostBattling(3);
    const [lone] = neutrals;
    r.disconnect(lone, T0);
    const [x, y] = r.players.filter((p) => p.id !== lone).map((p) => p.id);
    r.voteKick(x, lone, T0); r.voteKick(y, lone, T0);
    assert.equal(r.player(lone), undefined);
    const fm = r.faceoff.view(r.hostId).match;
    assert.ok(fm === null || fm.stage === 'result' || r.phase === 'finished');
    total += 1;
    const first = r.faceoff.rounds[0].matches[0];
    if (first.winner === r.hostId) hostWins += 1;
    assert.ok(first.noJudge, 'labelled as decided with no judge');
  }
  assert.ok(hostWins > total * 0.25 && hostWins < total * 0.75, `host won ${hostWins}/${total}: should be a fair coin toss with equal teams`);
});

test('BUG 2: 4 players, one neutral drops: the other neutral still votes, no pause', () => {
  const { r, m, neutrals } = toFaceoff(4);
  const [n1, n2] = neutrals;
  r.disconnect(n2, T0 + 1000);
  assert.equal(Boolean(r.faceoff.match.paused), false);
  r.faceoffAction(n1, 'vote', { picks: allA(m) }, T0 + 2000);
  r.tick(T0 + 50_000);
  assert.equal(r.faceoff.match.winner, m.a);
});

test('BUG 2: the judge drops mid-decision: the next neutral is asked straight away', () => {
  for (let k = 0; k < 200; k += 1) {
    const { r, m, neutrals } = toFaceoff(4);
    if (neutrals.includes(r.hostId)) continue; // want the host battling so the judge is a random neutral
    const [n1, n2] = neutrals;
    const split = Object.fromEntries(m.pairings.filter((p) => p.auto === null).map((p) => [p.role, p.role % 2 ? 'a' : 'b']));
    r.faceoffAction(n1, 'vote', { picks: split }, T0);
    r.faceoffAction(n2, 'vote', { picks: Object.fromEntries(Object.entries(split).map(([k2, v]) => [k2, v === 'a' ? 'b' : 'a'])) }, T0);
    assert.equal(r.faceoff.match.stage, 'judging');
    const judge = r.faceoff.match.judge.id;
    r.disconnect(judge, T0 + 1000);
    const next = r.faceoff.match.judge.id;
    assert.ok(next && next !== judge, 'another neutral is asked');
    return;
  }
  assert.fail('setup not found');
});

test('BUG 2: the only possible judge drops mid-decision: the match pauses, then they decide when back', () => {
  const { r, m, neutrals, tokenOf } = hostBattling(3);
  const [lone] = neutrals;
  const split = Object.fromEntries(m.pairings.filter((p) => p.auto === null).map((p) => [p.role, p.role % 2 ? 'a' : 'b']));
  r.faceoffAction(lone, 'vote', { picks: split }, T0);
  if (r.faceoff.match.stage !== 'judging') return; // only when the split vote is level
  r.disconnect(lone, T0 + 1000);
  assert.equal(Boolean(r.faceoff.match.paused), true);
  r.join(tokenOf(lone), 'x', T0 + 90_000);
  assert.equal(r.faceoff.match.judge.id, lone);
  assert.equal(Boolean(r.faceoff.match.paused), false);
});
