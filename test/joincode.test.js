// Joining by code, QR codes and keeping a dropped player's lobby place (26 October 2026).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/server.js';
import { joinCode, CODE_ALPHABET, normaliseCode } from '../src/ids.js';

const GRACE = 150; const HOLD = 600;
let server; let url; const clients = [];
before(async () => {
  server = createApp({ graceMs: GRACE, lobbyHoldMs: HOLD, emptyRoomTtlMs: 5000 });
  await new Promise((r) => server.http.listen(0, r));
  url = `http://localhost:${server.http.address().port}`;
});
after(async () => { clients.forEach((c) => c.close()); await new Promise((r) => server.io.close(r)); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  c.token = `tok-${Math.random()}`; c.last = null;
  c.on('room', (v) => { c.last = v; });
  clients.push(c);
  return c;
}
const call = (c, e, p) => new Promise((r) => c.emit(e, p, r));
async function waitFor(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(15); } assert.fail('timed out'); }
const settings = { roomName: 'Code Room', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 6, turnOrder: 'join' };
async function hostRoom() {
  const host = client();
  const res = await call(host, 'create', { settings, name: 'Ste', token: host.token });
  await waitFor(() => host.last);
  return { host, roomId: res.roomId };
}

test('JC1 codes are 6 characters with no look-alikes (0/O, 1/I/L)', () => {
  for (let i = 0; i < 200; i += 1) assert.match(joinCode(), /^[A-HJKMNP-Z2-9]{6}$/);
  assert.ok(!/[01OIL]/.test(CODE_ALPHABET));
  assert.equal(normaliseCode(' k7m-x2q '), 'K7MX2Q');
});
test('JC2 every room gets a code everyone in it can see', async () => {
  const { host } = await hostRoom();
  assert.match(host.last.code, /^[A-Z2-9]{6}$/);
});
test('JC3 a friend types the code (any case, spaces) and joins the private game', async () => {
  const { host, roomId } = await hostRoom();
  const p = client();
  const found = await call(p, 'findCode', { code: ` ${host.last.code.toLowerCase().slice(0, 3)} ${host.last.code.slice(3)} ` });
  assert.ok(found.ok, found.message);
  assert.equal(found.roomId, roomId);
  const res = await call(p, 'join', { roomId: found.roomId, name: 'Bee', token: p.token });
  assert.ok(res.ok);
  await waitFor(() => host.last.players.length === 2);
});
test('JC4 a wrong code gets a clear message', async () => {
  const p = client();
  const res = await call(p, 'findCode', { code: 'ZZZZZ2' });
  assert.equal(res.code, 'CODE_NOT_FOUND');
});
test('JC5 too many wrong codes from one address: blocked for a while, even the right one', async () => {
  const { host } = await hostRoom();
  const p = client();
  let last;
  for (let i = 0; i < 13; i += 1) last = await call(p, 'findCode', { code: `WRONG${i % 9 + 1}`.slice(0, 6) });
  assert.equal(last.code, 'TOO_MANY_TRIES');
  const right = await call(p, 'findCode', { code: host.last.code });
  assert.equal(right.code, 'TOO_MANY_TRIES');
});
test('JC6 QR code for a room is an SVG of its invite link; unknown rooms get 404', async () => {
  const { roomId } = await hostRoom();
  const ok = await fetch(`${url}/qr/${roomId}.svg`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await ok.text(), /<svg/);
  assert.equal((await fetch(`${url}/qr/nope.svg`)).status, 404);
});
test('JC7 /j/CODE serves the game page', async () => {
  const res = await fetch(`${url}/j/ABCDEF`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
});
test('WK1 a player whose phone locks in the lobby keeps their place past the grace period', async () => {
  const { host, roomId } = await hostRoom();
  const p = client();
  await call(p, 'join', { roomId, name: 'Kuma', token: p.token });
  await waitFor(() => host.last.players.length === 2);
  p.disconnect();
  await sleep(GRACE + 150);
  assert.equal(host.last.players.length, 2, 'still in the lobby after 30 s (scaled)');
  assert.equal(host.last.players.find((x) => x.name === 'Kuma').connected, false);
  // Back before the hold ends: same player, no new seat.
  const back = client(); back.token = p.token;
  await call(back, 'join', { roomId, name: 'Kuma', token: p.token });
  await waitFor(() => host.last.players.find((x) => x.name === 'Kuma')?.connected);
  assert.equal(host.last.players.length, 2);
});
test('WK2 still away when the hold ends: removed from the lobby', async () => {
  const { host, roomId } = await hostRoom();
  const p = client();
  await call(p, 'join', { roomId, name: 'Kuma', token: p.token });
  await waitFor(() => host.last.players.length === 2);
  p.disconnect();
  await waitFor(() => host.last.players.length === 1, HOLD + 1000);
});
test('WK3 the host’s phone locks in the lobby: hosting passes on after the grace period', async () => {
  const { host, roomId } = await hostRoom();
  const p = client();
  await call(p, 'join', { roomId, name: 'Bee', token: p.token });
  await waitFor(() => p.last?.players.length === 2);
  host.disconnect();
  await waitFor(() => p.last.isHost, GRACE + 1000);
  assert.equal(p.last.players.length, 2, 'the old host keeps their seat for now');
});
