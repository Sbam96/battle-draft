// Face-off (R9, R10): a random knockout bracket. Matches are played one at a time, role vs role.
// Neutral players vote on every pairing in one go; the two battlers sit out.
//  - One side's role empty: the other side wins that pairing automatically. Both empty: nobody scores.
//  - Voting time: 10 s per role (50 s / 100 s). Missing ballots are filled by the host's ballot
//    (or another neutral's if the host is battling or didn't vote).
//  - Tied pairings, then a level match, go to a judge: the host if neutral; otherwise the lone neutral
//    (3 players) or a randomly appointed neutral (4+). A judge who doesn't answer is replaced.
//  - Odd number of teams in a round: one gets a bye, rotating so nobody gets two while others have none.

import { randomInt } from 'node:crypto';
import { DraftError } from './draft.js';

export const RESULT_MS = 12_000; // how long a match result stays up before the next match
export const JUDGE_MS = 60_000;

export class Faceoff {
  // ctx: { players: () => [{ id, connected }], hostId: () => id }
  constructor({ order, teams, roleCount, ctx, random = (n) => randomInt(n) }) {
    this.roleCount = roleCount;
    this.voteMs = roleCount * 10_000;
    this.ctx = ctx;
    this.random = random;
    this.teams = new Map(order.map((p) => [p, [...(teams.get(p) || Array(roleCount).fill(null))]]));
    this.alive = new Set(order);
    this.seedOrder = [...order];
    this.byes = new Map(order.map((p) => [p, 0]));
    this.rounds = [];
    this.roundIdx = -1;
    this.matchIdx = 0;
    this.match = null;
    this.champion = null;
    this.finished = false;
    this.matchCount = 0;
    this.log = [];
  }

  #shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) { const j = this.random(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  begin(now) { this.#nextRound(now); }

  #nextRound(now) {
    const teams = this.seedOrder.filter((p) => this.alive.has(p));
    if (teams.length <= 1) { this.#crown(teams[0] ?? null, now); return; }
    let entrants = this.#shuffle(teams);
    let bye = null;
    if (entrants.length % 2 === 1) {
      const fewest = Math.min(...entrants.map((p) => this.byes.get(p)));
      const options = entrants.filter((p) => this.byes.get(p) === fewest);
      bye = options[this.random(options.length)];
      this.byes.set(bye, this.byes.get(bye) + 1);
      entrants = entrants.filter((p) => p !== bye);
    }
    const matches = [];
    for (let i = 0; i < entrants.length; i += 2) {
      this.matchCount += 1;
      matches.push({ id: this.matchCount, a: entrants[i], b: entrants[i + 1], winner: null, score: null, walkover: false });
    }
    this.rounds.push({ number: this.rounds.length + 1, matches, bye });
    this.roundIdx = this.rounds.length - 1;
    this.matchIdx = 0;
    this.#startMatch(now);
  }

  get currentMeta() { return this.rounds[this.roundIdx]?.matches[this.matchIdx]; }

  #startMatch(now) {
    const meta = this.currentMeta;
    if (!meta) { this.#nextRound(now); return; }
    const { a, b } = meta;
    if (!this.alive.has(a) || !this.alive.has(b)) {
      this.#finish(this.alive.has(a) ? a : this.alive.has(b) ? b : null, now, { walkover: true });
      return;
    }
    const ta = this.teams.get(a); const tb = this.teams.get(b);
    const pairings = Array.from({ length: this.roleCount }, (_, i) => {
      const ca = ta[i]; const cb = tb[i];
      const auto = ca != null && cb != null ? null : ca != null ? 'a' : cb != null ? 'b' : 'none';
      return { role: i, a: ca, b: cb, auto, winner: auto === 'none' ? null : auto, votes: null };
    });
    this.match = { id: meta.id, a, b, stage: 'voting', pairings, ballots: new Map(), deadline: now + this.voteMs, judge: null, startedAt: now };
    if (!pairings.some((p) => p.auto === null)) this.#resolveVotes(now);
  }

  eligibleVoters() {
    if (!this.match) return [];
    return this.ctx.players().map((p) => p.id).filter((id) => id !== this.match.a && id !== this.match.b);
  }

  vote(pid, picks, now) {
    const m = this.match;
    if (!m || m.stage !== 'voting') throw new DraftError('NOT_VOTING', 'There’s nothing to vote on right now.');
    if (pid === m.a || pid === m.b) throw new DraftError('BATTLER_VOTE', 'You can’t vote on your own match.');
    if (!this.eligibleVoters().includes(pid)) throw new DraftError('NOT_VOTER', 'You can’t vote on this match.');
    if (m.ballots.has(pid)) throw new DraftError('ALREADY_VOTED', 'You’ve already voted on this match.');
    const ballot = {};
    for (const p of m.pairings.filter((x) => x.auto === null)) {
      const choice = picks?.[p.role];
      if (choice !== 'a' && choice !== 'b') throw new DraftError('INCOMPLETE', 'Vote on every pairing before submitting.');
      ballot[p.role] = choice;
    }
    m.ballots.set(pid, ballot);
    const all = this.eligibleVoters();
    if (all.every((v) => m.ballots.has(v))) this.#resolveVotes(now);
  }

  #resolveVotes(now) {
    const m = this.match;
    const voters = this.eligibleVoters();
    const missing = voters.filter((v) => !m.ballots.has(v));
    if (missing.length) {
      // The host stands in for missing voters; if the host is battling or didn't vote, another neutral who voted does.
      const host = this.ctx.hostId();
      const voted = voters.filter((v) => m.ballots.has(v));
      const stand = voted.includes(host) ? host : voted.length ? voted[this.random(voted.length)] : null;
      if (stand) for (const v of missing) m.ballots.set(v, { ...m.ballots.get(stand), standIn: stand });
      m.standIn = stand ? { by: stand, count: missing.length } : null;
    }
    const ties = [];
    for (const p of m.pairings) {
      if (p.auto !== null) continue;
      let a = 0; let b = 0;
      for (const ballot of m.ballots.values()) { if (ballot[p.role] === 'a') a += 1; else if (ballot[p.role] === 'b') b += 1; }
      p.votes = { a, b };
      p.winner = a > b ? 'a' : b > a ? 'b' : null;
      if (a === b) ties.push(p.role);
    }
    if (ties.length) this.#askJudge('pairings', ties, now);
    else this.#score(now);
  }

  #score(now) {
    const m = this.match;
    const a = m.pairings.filter((p) => p.winner === 'a').length;
    const b = m.pairings.filter((p) => p.winner === 'b').length;
    m.score = { a, b };
    if (a === b) this.#askJudge('team', [], now);
    else this.#finish(a > b ? m.a : m.b, now);
  }

  // R10: who breaks ties.
  #judgeCandidates() {
    const m = this.match;
    const host = this.ctx.hostId();
    const neutrals = this.ctx.players().filter((p) => p.connected && p.id !== m.a && p.id !== m.b).map((p) => p.id);
    const hostNeutral = neutrals.includes(host);
    const others = this.#shuffle(neutrals.filter((id) => id !== host));
    return hostNeutral ? [host, ...others] : others;
  }

  #askJudge(kind, roles, now) {
    const m = this.match;
    const tried = m.judge?.tried || [];
    const next = this.#judgeCandidates().find((id) => !tried.includes(id));
    if (!next) { this.#fallback(kind, roles, now); return; }
    m.stage = 'judging';
    m.judge = { id: next, kind, roles, tried: [...tried, next] };
    m.deadline = now + JUDGE_MS;
  }

  // Only if nobody is available to judge: tied pairings score for nobody; a level match goes to the
  // team with more filled roles, then the higher seed.
  #fallback(kind, roles, now) {
    const m = this.match;
    this.log.push({ kind: 'noJudge', matchId: m.id, at: now });
    if (kind === 'pairings') { for (const r of roles) m.pairings[r].winner = null; this.#score(now); return; }
    const filled = (p) => this.teams.get(p).filter((x) => x != null).length;
    const winner = filled(m.a) !== filled(m.b) ? (filled(m.a) > filled(m.b) ? m.a : m.b) : (this.seedOrder.indexOf(m.a) < this.seedOrder.indexOf(m.b) ? m.a : m.b);
    this.#finish(winner, now, { fallback: true });
  }

  judge(pid, decision, now) {
    const m = this.match;
    if (!m || m.stage !== 'judging') throw new DraftError('NOT_JUDGING', 'There’s nothing to decide right now.');
    if (m.judge.id !== pid) throw new DraftError('NOT_JUDGE', 'You’re not the judge for this decision.');
    if (m.judge.kind === 'pairings') {
      for (const r of m.judge.roles) if (decision?.[r] !== 'a' && decision?.[r] !== 'b') throw new DraftError('INCOMPLETE', 'Decide every tied pairing.');
      for (const r of m.judge.roles) { m.pairings[r].winner = decision[r]; m.pairings[r].judged = true; }
      m.judge.decided = true;
      this.#score(now);
    } else {
      if (decision !== 'a' && decision !== 'b') throw new DraftError('INCOMPLETE', 'Pick the winning team.');
      m.judge.decided = true;
      this.#finish(decision === 'a' ? m.a : m.b, now, { judged: true });
    }
  }

  #finish(winner, now, extra = {}) {
    const meta = this.currentMeta;
    const m = this.match || { id: meta.id, a: meta.a, b: meta.b, pairings: [] };
    const loser = winner === meta.a ? meta.b : meta.a;
    meta.winner = winner;
    meta.score = m.score || null;
    Object.assign(meta, extra);
    if (winner) this.alive.delete(loser); else { this.alive.delete(meta.a); this.alive.delete(meta.b); }
    this.match = { ...m, stage: 'result', winner, deadline: now + RESULT_MS, ...extra };
    this.log.push({ kind: 'matchResult', matchId: meta.id, winner, loser, at: now, ...extra });
  }

  // Result shown: move to the next match (on the timer, or when the host presses next).
  next(now) {
    if (this.match?.stage !== 'result') throw new DraftError('NOT_DONE', 'This match isn’t finished.');
    this.matchIdx += 1;
    this.match = null;
    if (this.matchIdx >= this.rounds[this.roundIdx].matches.length) this.#nextRound(now);
    else this.#startMatch(now);
  }

  #crown(pid, now) {
    this.champion = pid;
    this.finished = true;
    this.match = null;
    this.log.push({ kind: 'champion', playerId: pid, at: now });
  }

  dueAt() { return this.match?.deadline ?? null; }

  timeout(now) {
    const m = this.match;
    if (!m) return false;
    if (m.stage === 'voting') this.#resolveVotes(now);
    else if (m.stage === 'judging') this.#askJudge(m.judge.kind, m.judge.roles, now);
    else if (m.stage === 'result') this.next(now);
    return true;
  }

  // A player removed mid-face-off forfeits; if they're battling now, the opponent wins by walkover.
  removePlayer(pid, now) {
    if (!this.alive.has(pid) && !this.teams.has(pid)) return;
    const m = this.match;
    this.alive.delete(pid);
    if (m && m.stage !== 'result' && (m.a === pid || m.b === pid)) { this.#finish(m.a === pid ? m.b : m.a, now, { walkover: true }); return; }
    if (m?.stage === 'voting') { m.ballots.delete(pid); if (this.eligibleVoters().every((v) => m.ballots.has(v))) this.#resolveVotes(now); }
    if (m?.stage === 'judging' && m.judge.id === pid) this.#askJudge(m.judge.kind, m.judge.roles, now);
  }

  view(forPlayer) {
    const m = this.match;
    const showVotes = m && m.stage !== 'voting';
    return {
      rounds: this.rounds.map((r) => ({ number: r.number, bye: r.bye, matches: r.matches.map((x) => ({ ...x })) })),
      teams: Object.fromEntries(this.teams),
      alive: [...this.alive],
      champion: this.champion,
      finished: this.finished,
      voteMs: this.voteMs,
      match: m && {
        id: m.id, a: m.a, b: m.b, stage: m.stage, deadline: m.deadline, winner: m.winner ?? null,
        score: m.score ?? null, walkover: Boolean(m.walkover), judged: Boolean(m.judged), fallback: Boolean(m.fallback),
        pairings: m.pairings.map((p) => ({ role: p.role, a: p.a, b: p.b, auto: p.auto, winner: showVotes ? p.winner : null, votes: showVotes ? p.votes : null, judged: Boolean(p.judged) })),
        voted: [...(m.ballots?.keys() || [])].filter((id) => !m.ballots.get(id).standIn),
        voters: this.eligibleVoters(),
        myBallot: m.ballots?.get(forPlayer) && !m.ballots.get(forPlayer).standIn ? m.ballots.get(forPlayer) : null,
        standIn: showVotes ? m.standIn ?? null : null,
        judge: m.judge ? { id: m.judge.id, kind: m.judge.kind, roles: m.judge.roles } : null,
      },
    };
  }
}
