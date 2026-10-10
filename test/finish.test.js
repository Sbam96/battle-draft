// Phase 6: champion, restart and admin. Test names start with the matrix ID they cover.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Room } from '../src/room.js';
import { createApp } from '../src/server.js';

const T0 = 1_000_000;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const names = Array.from({ length: 40 }, (_, i) => `Char ${i + 1}`);

function room() {
  const r = new Room({ id: 'r', hostName: 'Ste', hostToken: 'h', settings: { roomName: 'R', visibility: 'private', roleCount: 5, roles: ['Captain', 'Vice', 'Brains', 'Support', 'Wild'], cap: 8, turnOrder: 'join' } });
  const a = r.join('t2', 'Nami').player.id;
  const b = r.join('t3', 'Usopp').player.id;
  r.addCharacters(r.hostId, { text: names.join('\n') });
  r.start(r.hostId, Math.random, T0);
  return { r, a, b };
}

// Plays from wherever the game is to a champion. The first player in turn order bins once.
function playToChampion(r) {
  let binned = false;
  let guard = 0;
  while (r.phase !== 'finished' && guard < 500) {
    guard += 1;
    if (r.phase === 'draft') {
      const p = r.draft.turn.playerId;
      r.draftAction(p, 'spin', {}, T0);
      if (!binned) { binned = true; r.draftAction(p, 'bin', {}, T0); r.draftAction(p, 'spin', {}, T0); }
      r.draftAction(p, 'place', { role: r.draft.teams.get(p).indexOf(null) }, T0);
    } else if (r.phase === 'endphase') {
      for (const id of [...r.endPhase.players.keys()]) if (r.phase === 'endphase' && r.endPhase.players.get(id).stage !== 'done') r.endAction(id, 'endDone', {}, T0);
    } else if (r.phase === 'faceoff') {
      const m = r.faceoff.match;
      if (m.stage === 'voting') {
        for (const v of r.faceoff.eligibleVoters()) {
          if (m.ballots.has(v)) continue;
          r.faceoffAction(v, 'vote', { picks: Object.fromEntries(m.pairings.filter((p) => p.auto === null).map((p) => [p.role, 'a'])) }, T0);
          if (r.faceoff.match !== m || m.stage !== 'voting') break;
        }
      } else if (m.stage === 'judging') {
        r.faceoffAction(m.judge.id, 'judge', { decision: m.judge.kind === 'team' ? 'a' : Object.fromEntries(m.judge.roles.map((x) => [x, 'a'])) }, T0);
      } else r.faceoffAction(r.hostId, 'nextMatch', {}, T0);
    }
  }
  assert.equal(r.phase, 'finished');
}

test('T11.01 a full game ends with a champion everyone can see', () => {
  const { r, a } = room();
  playToChampion(r);
  const champ = r.faceoff.champion;
  assert.ok(champ);
  assert.equal(r.viewFor(a).faceoff.champion, champ);
});
test('T11.02 restart: same players and roles, original list, fresh draft', () => {
  const { r } = room();
  const players = r.players.map((p) => p.name);
  playToChampion(r);
  r.restart(r.hostId, Math.random, T0);
  assert.equal(r.phase, 'draft');
  assert.deepEqual(r.players.map((p) => p.name), players);
  assert.deepEqual(r.settings.roles, ['Captain', 'Vice', 'Brains', 'Support', 'Wild']);
  assert.equal(r.characters.length, 40);
});
test('T11.03 after restart the bin is empty and every character is back on the wheel', () => {
  const { r } = room();
  playToChampion(r);
  assert.ok(r.draft.binned.length > 0, 'something was binned in game 1');
  r.restart(r.hostId, Math.random, T0);
  assert.equal(r.draft.binned.length, 0);
  assert.equal(r.draft.pool.length, 40);
});
test('T4.26 restart: tokens reset to the normal count, nothing carried over', () => {
  const { r } = room();
  playToChampion(r);
  r.restart(r.hostId, Math.random, T0);
  for (const p of r.draft.order) assert.equal(r.draft.binsLeft.get(p), 1);
  assert.equal(r.endPhase, null);
});
test('T11.04 only the host can restart', () => {
  const { r, a } = room();
  playToChampion(r);
  assert.equal(code(() => r.restart(a)), 'NOT_HOST');
});
test('T11.05 fewer than 3 players left: restart blocked until 3', () => {
  const { r, b } = room();
  playToChampion(r);
  r.disconnect(b);
  assert.equal(code(() => r.restart(r.hostId)), 'CANT_RESTART');
  r.join('t3', 'Usopp');
  r.restart(r.hostId);
  assert.equal(r.phase, 'draft');
});
test('R11.2 restart is only for finished games', () => {
  const { r } = room();
  assert.equal(code(() => r.restart(r.hostId)), 'NOT_FINISHED');
});
test('T11.06 a full second game after restart behaves exactly like the first', () => {
  const { r } = room();
  playToChampion(r);
  r.restart(r.hostId, Math.random, T0);
  playToChampion(r);
  assert.ok(r.faceoff.champion);
  assert.equal(r.viewFor(r.hostId).game, 2);
});

// ---------- admin ----------
const servers = [];
async function serve(admin) {
  const s = createApp({ admin });
  await new Promise((res) => s.http.listen(0, res));
  servers.push(s);
  return { s, url: `http://localhost:${s.http.address().port}` };
}
after(async () => { for (const s of servers) await new Promise((r) => s.io.close(r)); });
const login = (url, username, password) => fetch(`${url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });

test('T6.25 admin signs in and sees reports', async () => {
  const { s, url } = await serve({ username: 'admin', password: 'correct horse battery' });
  s.reports.push({ id: 'x', roomName: 'R', reporter: 'Ste', target: 'Troll', reason: 'Abusive', at: T0 });
  const res = await login(url, 'admin', 'correct horse battery');
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const reports = await fetch(`${url}/admin/api/reports`, { headers: { cookie: cookie.split(';')[0] } }).then((r) => r.json());
  assert.equal(reports.reports[0].target, 'Troll');
});
test('T6.26 wrong password: rejected with no hint about which part was wrong', async () => {
  const { url } = await serve({ username: 'admin', password: 'correct horse battery' });
  const a = await login(url, 'admin', 'nope');
  const b = await login(url, 'nobody', 'correct horse battery');
  assert.equal(a.status, 401);
  assert.equal((await a.json()).message, (await b.json()).message);
});
test('T6.27 many wrong passwords: further attempts blocked for a while, even the right one', async () => {
  const { url } = await serve({ username: 'admin', password: 'correct horse battery' });
  for (let i = 0; i < 5; i += 1) await login(url, 'admin', `guess${i}`);
  const blocked = await login(url, 'admin', 'correct horse battery');
  assert.equal(blocked.status, 429);
});
test('T6.29 a normal player cannot read reports', async () => {
  const { url } = await serve({ username: 'admin', password: 'correct horse battery' });
  assert.equal((await fetch(`${url}/admin/api/reports`)).status, 401);
  assert.equal((await fetch(`${url}/admin/api/reports`, { headers: { cookie: 'bd_admin=made-up' } })).status, 401);
});
test('R6.9 with no credentials set, the admin area is switched off', async () => {
  const { url } = await serve({ username: '', password: '' });
  assert.deepEqual(await fetch(`${url}/admin/api/me`).then((r) => r.json()), { setup: false, loggedIn: false });
  assert.equal((await login(url, '', '')).status, 503);
});
test('R6.9 signing out ends the session', async () => {
  const { url } = await serve({ username: 'admin', password: 'correct horse battery' });
  const cookie = (await login(url, 'admin', 'correct horse battery')).headers.get('set-cookie').split(';')[0];
  await fetch(`${url}/admin/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal((await fetch(`${url}/admin/api/reports`, { headers: { cookie } })).status, 401);
});
test('T6.28 no admin credentials are written in the code', () => {
  const files = ['src', 'public'].flatMap((d) => readdirSync(new URL(`../${d}/`, import.meta.url)).map((f) => new URL(`../${d}/${f}`, import.meta.url)));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/ADMIN_PASSWORD\s*[:=]\s*['"][^'"]+['"]/.test(text), `credential-looking assignment in ${f.pathname}`);
  }
});
