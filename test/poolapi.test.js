// Community pool through the real endpoints and a live game room. Needs TEST_DATABASE_URL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { io as connect } from 'socket.io-client';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'set TEST_DATABASE_URL to run';
let server; let base; let db;
const clients = [];

before(async () => {
  if (!URL) return;
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS image_requests, pool_characters, verses, contributors, access_requests, messages, reports CASCADE');
  await c.end();
  db = await openDb(URL);
  server = createApp({ db, admin: { username: 'admin', password: 'test-password-123' } });
  await new Promise((r) => server.http.listen(0, r));
  base = `http://localhost:${server.http.address().port}`;
});
after(async () => {
  clients.forEach((c) => c.close());
  if (server) await new Promise((r) => server.io.close(r));
  if (db) await db.close();
});

const get = (p, headers = {}) => fetch(base + p, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));
let adminCookie;
const adminLogin = async () => { adminCookie ||= (await post('/admin/api/login', { username: 'admin', password: 'test-password-123' })).headers.get('set-cookie').split(';')[0]; return { cookie: adminCookie }; };

test('API1 /config says the pool is on; anyone can browse verses and characters', { skip }, async () => {
  assert.equal((await get('/config')).body.pool, true);
  const { body } = await get('/api/pool/verses');
  assert.ok(body.verses.length >= 5);
  const naruto = body.verses.find((v) => v.name === 'Naruto');
  const chars = (await get(`/api/pool/verses/${naruto.id}`)).body.characters;
  assert.ok(chars.some((c) => c.name === 'Naruto Uzumaki'));
});

test('API2 sign in → request access → admin approves → can add', { skip }, async () => {
  assert.deepEqual((await post('/api/pool/status', { identity: 'nami@example.com' })).body, { identity: 'nami@example.com', approved: false, request: null });
  const blocked = await post('/api/pool/add', { identity: 'nami@example.com', verseName: 'Chainsaw Man', text: 'Denji' });
  assert.equal(blocked.status, 403);
  await post('/api/pool/request', { identity: 'nami@example.com', note: 'Big CSM fan' });
  assert.equal((await post('/api/pool/status', { identity: 'nami@example.com' })).body.request, 'pending');
  const h = await adminLogin();
  const overview = (await get('/admin/api/overview', h)).body;
  const req = overview.requests.find((r) => r.identity === 'nami@example.com');
  assert.equal(req.note, 'Big CSM fan');
  assert.equal((await post(`/admin/api/access/${req.id}`, { approve: true }, h)).status, 200);
  assert.equal((await post('/api/pool/status', { identity: 'NAMI@example.com' })).body.approved, true);
  const added = await post('/api/pool/add', { identity: 'nami@example.com', verseName: 'Chainsaw Man', source: 'csv', text: 'Denji,https://img.example/denji.png\nPower\nMakima' });
  assert.equal(added.status, 200);
  assert.equal(added.body.added.length, 3);
});

test('API3 image clash shows up for the admin, who can approve the swap', { skip }, async () => {
  await post('/api/pool/add', { identity: 'nami@example.com', verseName: 'Chainsaw Man', source: 'csv', text: 'Denji,https://img.example/denji-2.png' });
  const h = await adminLogin();
  const img = (await get('/admin/api/overview', h)).body.images.find((r) => r.name === 'Denji');
  assert.equal(img.image_url, 'https://img.example/denji.png');
  await post(`/admin/api/images/${img.id}`, { approve: true }, h);
  const csm = (await get('/api/pool/verses')).body.verses.find((v) => v.name === 'Chainsaw Man');
  const denji = (await get(`/api/pool/verses/${csm.id}`)).body.characters.find((c) => c.name === 'Denji');
  assert.equal(denji.image, 'https://img.example/denji-2.png');
});

test('API4 contact form reaches the admin', { skip }, async () => {
  assert.equal((await post('/api/contact', { name: 'Usopp', message: 'The wheel froze on my iPad' })).status, 200);
  const h = await adminLogin();
  assert.ok((await get('/admin/api/overview', h)).body.messages.some((m) => m.body === 'The wheel froze on my iPad'));
});

test('API5 admin endpoints refuse anyone not signed in', { skip }, async () => {
  assert.equal((await get('/admin/api/overview')).status, 401);
  assert.equal((await post('/admin/api/access/1', { approve: true })).status, 401);
  assert.equal((await post('/admin/api/contributors', { identity: 'sneaky' })).status, 401);
});

test('API6 host loads verses into a game; players see them; non-hosts cannot', { skip }, async () => {
  const mk = () => { const c = connect(base, { transports: ['websocket'], forceNew: true }); c.token = `t-${Math.random()}`; c.on('room', (v) => { c.last = v; }); c.on('characters', (p) => { c.chars = p; }); clients.push(c); return c; };
  const call = (c, e, p) => new Promise((r) => c.emit(e, p, r));
  const waitFor = async (fn) => { for (let i = 0; i < 200; i += 1) { if (fn()) return; await new Promise((r) => setTimeout(r, 15)); } assert.fail('timeout'); };
  const host = mk(); const p2 = mk();
  const { roomId } = await call(host, 'create', { name: 'Ste', token: host.token, settings: { roomName: 'Pool test', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 6, turnOrder: 'join' } });
  await call(p2, 'join', { roomId, name: 'Nami', token: p2.token });
  const verses = (await get('/api/pool/verses')).body.verses;
  const op = verses.find((v) => v.name === 'One Piece'); const db2 = verses.find((v) => v.name === 'Dragon Ball');
  assert.equal((await call(p2, 'loadPool', { verseIds: [op.id] })).code, 'NOT_HOST');
  const res = await call(host, 'loadPool', { verseIds: [op.id, db2.id] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.total, op.count + db2.count);
  await waitFor(() => p2.chars?.list.length === res.total);
  assert.ok(p2.chars.list.some((c) => c.name === 'Goku' && c.verse === 'Dragon Ball'));
  const again = await call(host, 'loadPool', { verseIds: [op.id] });
  assert.equal(again.added, 0, 'loading the same verse twice adds nothing');
  assert.equal(again.duplicates.length, op.count);
});

test('API7 loading past 500 is refused and adds nothing', { skip }, async () => {
  const c = connect(base, { transports: ['websocket'], forceNew: true }); clients.push(c);
  const call = (e, p) => new Promise((r) => c.emit(e, p, r));
  await call('create', { name: 'Big', token: 'tok-big', settings: { roomName: 'Big list', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 6, turnOrder: 'join' } });
  await call('addCharacters', { text: Array.from({ length: 480 }, (_, i) => `Filler ${i}`).join('\n') });
  const op = (await get('/api/pool/verses')).body.verses.find((v) => v.name === 'One Piece');
  const res = await call('loadPool', { verseIds: [op.id] });
  assert.equal(res.code, 'TOO_MANY');
  assert.equal((await call('getCharacters', {})).list.length, 480);
});

test('API8 without a database the game still runs and the pool says it is off', async () => {
  const s = createApp({ db: null });
  await new Promise((r) => s.http.listen(0, r));
  const b = `http://localhost:${s.http.address().port}`;
  assert.equal((await fetch(`${b}/config`).then((r) => r.json())).pool, false);
  const r = await fetch(`${b}/api/pool/verses`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'POOL_OFF');
  await new Promise((r2) => s.io.close(r2));
});
