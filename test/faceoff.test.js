// Phase 5: the face-off and tie-breaks. Test names start with the matrix ID they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Faceoff, RESULT_MS, JUDGE_MS } from '../src/faceoff.js';

const T0 = 1_000_000;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

// players: ids; host: id; teams: optional overrides { A: ['x', null, ...] }
function setup({ players = ['A', 'B', 'C'], host = players[0], roleCount = 5, teams = {}, random, offline = [] } = {}) {
  const t = new Map(players.map((p) => [p, teams[p] ?? Array.from({ length: roleCount }, (_, i) => `${p}${i}`)]));
  const list = players.map((id) => ({ id, connected: !offline.includes(id) }));
  const ctx = { players: () => list, hostId: () => host };
  const f = new Faceoff({ order: players, teams: t, roleCount, ctx, ...(random ? { random } : {}) });
  f.begin(T0);
  return { f, list };
}
const neutrals = (f) => f.eligibleVoters();
const ballot = (f, pick) => Object.fromEntries(f.match.pairings.filter((p) => p.auto === null).map((p) => [p.role, typeof pick === 'function' ? pick(p.role) : pick]));
// Every neutral votes the same way, so the result is decided.
const voteAll = (f, pick, now = T0) => { for (const v of neutrals(f)) f.vote(v, ballot(f, pick), now); };

// ---------- R9.1 bracket ----------
test('T9.01 brackets differ between games', () => {
  const firsts = new Set();
  for (let i = 0; i < 30; i += 1) {
    const { f } = setup({ players: ['A', 'B', 'C', 'D'] });
    firsts.add(f.rounds[0].matches.map((m) => [m.a, m.b].sort().join('')).sort().join('|'));
  }
  assert.ok(firsts.size > 1);
});
test('T9.02 every team appears exactly once in the first round', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] });
  const r = f.rounds[0];
  const seen = [...r.matches.flatMap((m) => [m.a, m.b]), r.bye].filter(Boolean).sort();
  assert.deepEqual(seen, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
});
test('T9.04 5 players: a bye in each odd round, and a champion is reached', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D', 'E'] });
  let guard = 0;
  while (!f.finished && guard < 50) {
    guard += 1;
    if (f.match.stage === 'voting') voteAll(f, 'a');
    else if (f.match.stage === 'judging') f.judge(f.match.judge.id, f.match.judge.kind === 'team' ? 'a' : Object.fromEntries(f.match.judge.roles.map((r) => [r, 'a'])), T0);
    else f.next(T0);
  }
  assert.ok(f.champion);
  assert.ok(f.rounds[0].bye, 'round 1 (5 teams) has a bye');
});
test('T9.05 3 players: one bye, then a final', () => {
  const { f } = setup();
  assert.equal(f.rounds[0].matches.length, 1);
  assert.ok(f.rounds[0].bye);
  voteAll(f, 'a'); f.next(T0);
  assert.equal(f.rounds.length, 2);
  assert.equal(f.rounds[1].matches.length, 1, 'the final');
  assert.equal(f.rounds[1].bye, null);
});
test('T9.06 byes rotate: nobody gets a second while others have none', () => {
  for (let k = 0; k < 20; k += 1) {
    const { f } = setup({ players: ['A', 'B', 'C', 'D', 'E'] });
    const firstBye = f.rounds[0].bye;
    while (f.rounds.length < 2) { if (f.match.stage === 'voting') voteAll(f, 'a'); else if (f.match.stage === 'result') f.next(T0); else f.judge(f.match.judge.id, 'a', T0); }
    assert.notEqual(f.rounds[1].bye, firstBye, 'second-round bye goes to someone else');
  }
});

// ---------- R9.2 / R9.3 voting ----------
test('T9.07 a match is role vs role', () => {
  const { f } = setup();
  const { a, b } = f.match;
  for (const p of f.match.pairings) { assert.equal(p.a, `${a}${p.role}`); assert.equal(p.b, `${b}${p.role}`); }
});
test('T9.08 every pairing is voted in one go; an incomplete ballot is refused', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D'] });
  const [v] = neutrals(f);
  assert.equal(code(() => f.vote(v, { 0: 'a', 1: 'b' }, T0)), 'INCOMPLETE');
  f.vote(v, ballot(f, 'a'), T0);
  assert.ok(f.match.ballots.has(v));
});
test('T9.09 battlers cannot vote on their own match', () => {
  const { f } = setup();
  assert.equal(code(() => f.vote(f.match.a, ballot(f, 'a'), T0)), 'BATTLER_VOTE');
});
test('T9.10 voting twice counts once', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D'] });
  const [v] = neutrals(f);
  f.vote(v, ballot(f, 'a'), T0);
  assert.equal(code(() => f.vote(v, ballot(f, 'b'), T0)), 'ALREADY_VOTED');
});
test('T9.14 a team that wins 3 of 5 roles advances', () => {
  const { f } = setup();
  const { a, b } = f.match;
  voteAll(f, (r) => (r < 3 ? 'a' : 'b'));
  assert.equal(f.match.stage, 'result');
  assert.equal(f.match.winner, a);
  assert.ok(!f.alive.has(b));
});
test('T9.17 filled role vs empty role: the filled one wins without a vote', () => {
  const teams = { A: ['A0', 'A1', null, 'A3', 'A4'], B: ['B0', 'B1', 'B2', 'B3', 'B4'], C: ['C0', null, 'C2', 'C3', 'C4'] };
  const { f } = setup({ teams });
  const m = f.match;
  for (const p of m.pairings) {
    const ea = teams[m.a][p.role] == null; const eb = teams[m.b][p.role] == null;
    if (ea !== eb) assert.equal(p.auto, ea ? 'b' : 'a');
  }
});
test('T9.18 both teams have the same role empty: neither gets the point', () => {
  const teams = { A: [null, 'A1', 'A2', 'A3', 'A4'], B: [null, 'B1', 'B2', 'B3', 'B4'], C: [null, 'C1', 'C2', 'C3', 'C4'] };
  const { f } = setup({ teams });
  assert.equal(f.match.pairings[0].auto, 'none');
  voteAll(f, (r) => (r % 2 ? 'a' : 'b')); // roles 1,3 to a; 2,4 to b => 2-2
  assert.deepEqual(f.match.score, { a: 2, b: 2 });
  assert.equal(f.match.stage, 'judging', 'level match goes to the judge');
});
test('T9.19 every role empty on one side: the match is decided without any vote', () => {
  const teams = { A: ['A0', 'A1', 'A2', 'A3', 'A4'], B: [null, null, null, null, null], C: ['C0', 'C1', 'C2', 'C3', 'C4'] };
  for (let k = 0; k < 10; k += 1) {
    const { f } = setup({ teams });
    if (f.match.stage !== 'result') continue; // this round's match may not involve B
    assert.notEqual(f.match.winner, 'B');
  }
});

// ---------- vote timer and stand-ins ----------
test('T9.20 voting time is 50 s for 5 roles and 100 s for 10', () => {
  assert.equal(setup().f.dueAt(), T0 + 50_000);
  assert.equal(setup({ roleCount: 10 }).f.dueAt(), T0 + 100_000);
});
test('T9.21 a voter who never votes: the host’s ballot stands in when the time runs out', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D', 'E'], host: 'A', random: () => 0 });
  const m = f.match;
  const voters = neutrals(f);
  if (!voters.includes('A')) return; // host is battling in this bracket: covered by the next test
  f.vote('A', ballot(f, 'b'), T0);
  f.timeout(T0 + 50_000);
  assert.equal(m.standIn.by, 'A');
  assert.equal(f.match.winner, m.b);
});
test('T9.22 host is battling: another neutral who voted stands in', () => {
  // Force the host into the first match by giving a 3-player bracket where the host is never the bye.
  for (let k = 0; k < 40; k += 1) {
    const { f } = setup({ players: ['A', 'B', 'C', 'D'], host: 'A' });
    if (f.match.a !== 'A' && f.match.b !== 'A') continue;
    const [v1] = neutrals(f); // the other neutral never votes
    f.vote(v1, ballot(f, 'a'), T0);
    f.timeout(T0 + 60_000);
    assert.equal(f.match.standIn.by, v1, 'the neutral who voted stands in, not the battling host');
    assert.equal(f.match.winner, f.match.a);
    return;
  }
  assert.fail('host never drawn into the first match');
});
test('T9.23 a voter disconnects mid-vote: treated as not voting, passes on after the time limit', () => {
  const { f, list } = setup({ players: ['A', 'B', 'C', 'D'] });
  const [v1, v2] = neutrals(f);
  f.vote(v1, ballot(f, 'a'), T0);
  list.find((p) => p.id === v2).connected = false;
  assert.equal(f.match.stage, 'voting');
  f.timeout(T0 + 50_000);
  assert.notEqual(f.match.stage, 'voting');
});

// ---------- R10 tie-breaks ----------
function levelMatch(opts) {
  const { f, list } = setup({ teams: Object.fromEntries((opts.players || ['A', 'B', 'C']).map((p) => [p, [null, `${p}1`, `${p}2`, `${p}3`, `${p}4`]])), ...opts });
  return { f, list };
}
test('T10.01 tie with the host neutral: the host decides', () => {
  for (let k = 0; k < 40; k += 1) {
    const { f } = levelMatch({ players: ['A', 'B', 'C', 'D'], host: 'A' });
    if (f.match.a === 'A' || f.match.b === 'A') continue;
    voteAll(f, (r) => (r % 2 ? 'a' : 'b'));
    assert.equal(f.match.stage, 'judging');
    assert.equal(f.match.judge.id, 'A');
    f.judge('A', 'b', T0);
    assert.equal(f.match.winner, f.match.b);
    return;
  }
  assert.fail('no bracket with a neutral host');
});
test('T10.02 tie with the host battling: the host is not offered the decision', () => {
  for (let k = 0; k < 40; k += 1) {
    const { f } = levelMatch({ players: ['A', 'B', 'C', 'D'], host: 'A' });
    if (f.match.a !== 'A' && f.match.b !== 'A') continue;
    voteAll(f, (r) => (r % 2 ? 'a' : 'b'));
    assert.notEqual(f.match.judge.id, 'A');
    assert.equal(code(() => f.judge('A', 'a', T0)), 'NOT_JUDGE');
    return;
  }
  assert.fail('host never battling');
});
test('T10.03 3-player game, host battling: the lone neutral decides', () => {
  for (let k = 0; k < 40; k += 1) {
    const { f } = levelMatch({ players: ['A', 'B', 'C'], host: 'A' });
    if (f.match.a !== 'A' && f.match.b !== 'A') continue;
    const [lone] = neutrals(f);
    voteAll(f, (r) => (r % 2 ? 'a' : 'b'));
    assert.equal(f.match.judge.id, lone);
    return;
  }
  assert.fail('host never battling');
});
test('T10.04 / T10.05 5-player game, host battling: a random neutral decides, never a battler', () => {
  const judges = new Set();
  for (let k = 0; k < 80; k += 1) {
    const { f } = levelMatch({ players: ['A', 'B', 'C', 'D', 'E'], host: 'A' });
    if (f.match.a !== 'A' && f.match.b !== 'A') continue;
    voteAll(f, (r) => (r % 2 ? 'a' : 'b'));
    assert.ok(![f.match.a, f.match.b].includes(f.match.judge.id));
    judges.add(f.match.judge.id);
  }
  assert.ok(judges.size > 1, 'the appointment varies');
});
test('T10.06 the appointed judge does not answer: another neutral is appointed', () => {
  for (let k = 0; k < 40; k += 1) {
    const { f } = levelMatch({ players: ['A', 'B', 'C', 'D', 'E'], host: 'A' });
    if (f.match.a !== 'A' && f.match.b !== 'A') continue;
    voteAll(f, (r) => (r % 2 ? 'a' : 'b'));
    const firstJudge = f.match.judge.id;
    assert.equal(f.dueAt(), T0 + JUDGE_MS);
    f.timeout(T0 + JUDGE_MS);
    assert.notEqual(f.match.judge.id, firstJudge);
    return;
  }
  assert.fail('host never battling');
});
test('R10 a tied pairing is decided by the judge before the score', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D'], host: 'A' });
  const [v1, v2] = neutrals(f);
  f.vote(v1, ballot(f, 'a'), T0);
  f.vote(v2, ballot(f, (r) => (r === 0 ? 'b' : 'a')), T0); // role 0 is 1–1
  assert.equal(f.match.stage, 'judging');
  assert.equal(f.match.judge.kind, 'pairings');
  assert.deepEqual(f.match.judge.roles, [0]);
  f.judge(f.match.judge.id, { 0: 'b' }, T0);
  assert.equal(f.match.stage, 'result');
  assert.equal(f.match.winner, f.match.a);
});

// ---------- flow ----------
test('R9.4 result stays up, then the next match starts on its own (or when the host presses next)', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D'] });
  voteAll(f, 'a');
  assert.equal(f.dueAt(), T0 + RESULT_MS);
  const firstId = f.match.id;
  f.timeout(T0 + RESULT_MS);
  assert.notEqual(f.match.id, firstId);
});
test('R9 a battler removed mid-match: the opponent wins by walkover', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D'] });
  const { a, b } = f.match;
  f.removePlayer(a, T0);
  assert.equal(f.match.winner, b);
  assert.equal(f.match.walkover, true);
});
test('R9 votes stay secret until the match is decided', () => {
  const { f } = setup({ players: ['A', 'B', 'C', 'D'] });
  const [v1] = neutrals(f);
  f.vote(v1, ballot(f, 'a'), T0);
  const view = f.view('B');
  assert.ok(view.match.pairings.every((p) => p.votes === null && p.winner === null || p.auto !== null));
  assert.deepEqual(view.match.voted, [v1]);
});
