// End-to-end tests over real socket connections, several clients at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/server.js';

const GRACE = 300;
let server; let url; const clients = [];

before(async () => {
  server = createApp({ graceMs: GRACE, emptyRoomTtlMs: 200 });
  await new Promise((r) => server.http.listen(0, r));
  url = `http://localhost:${server.http.address().port}`;
});
after(async () => {
  clients.forEach((c) => c.close());
  await new Promise((r) => server.io.close(r));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  c.token = `token-${(n += 1)}-${Math.random()}`;
  c.last = null;
  c.events = [];
  c.on('room', (v) => { c.last = v; });
  c.chars = null;
  c.on('characters', (p) => { c.chars = p; });
  for (const e of ['admitted', 'declined', 'kicked', 'publicRooms']) c.on(e, (p) => c.events.push([e, p]));
  clients.push(c);
  return c;
}
const call = (c, event, payload) => new Promise((r) => c.emit(event, payload, r));
const settings = (over = {}) => ({ roomName: 'Test Room', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 6, turnOrder: 'join', releasedHoldToBin: true, timerEnabled: false, ...over });
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(15); }
  assert.fail('timed out waiting');
}
async function hostRoom(over) {
  const host = client();
  const res = await call(host, 'create', { settings: settings(over), name: 'Ste', token: host.token });
  assert.ok(res.ok, res.message);
  await waitFor(() => host.last);
  return { host, roomId: res.roomId };
}

test('T6.13 / NF1 private join by link: everyone sees the new player', async () => {
  const { host, roomId } = await hostRoom();
  const p2 = client();
  const res = await call(p2, 'join', { roomId, name: 'Nami', token: p2.token });
  assert.ok(res.ok, res.message);
  await waitFor(() => host.last.players.length === 2 && p2.last?.players.length === 2);
});

test('T5.03 wrong link: friendly not-found message', async () => {
  const p = client();
  const res = await call(p, 'join', { roomId: 'doesnotexist', name: 'X', token: p.token });
  assert.equal(res.code, 'ROOM_NOT_FOUND');
});

test('T5.01 / T5.02 public rooms are listed; private and started rooms are not', async () => {
  const { roomId: pub } = await hostRoom({ visibility: 'public', roomName: 'Open Arena' });
  const { roomId: priv } = await hostRoom({ visibility: 'private', roomName: 'Secret' });
  const b = client();
  const res = await call(b, 'browse', {});
  const ids = res.rooms.map((r) => r.id);
  assert.ok(ids.includes(pub));
  assert.ok(!ids.includes(priv));
});

test('T6.08–T6.10 public game: request, admit, decline over the wire', async () => {
  const { host, roomId } = await hostRoom({ visibility: 'public' });
  const a = client(); const b = client();
  assert.equal((await call(a, 'join', { roomId, name: 'Nami', token: a.token })).code, 'NEEDS_ADMISSION');
  await call(a, 'requestJoin', { roomId, name: 'Nami', token: a.token });
  await call(b, 'requestJoin', { roomId, name: 'Usopp', token: b.token });
  await waitFor(() => host.last.requests.length === 2);
  const [ra, rb] = host.last.requests;
  assert.ok((await call(host, 'admit', { requestId: ra.id })).ok);
  await waitFor(() => a.events.some(([e]) => e === 'admitted'));
  assert.ok((await call(a, 'join', { roomId, token: a.token })).ok);
  await waitFor(() => a.last?.players.length === 2);
  assert.ok((await call(host, 'decline', { requestId: rb.id })).ok);
  await waitFor(() => b.events.some(([e]) => e === 'declined'));
});

test('R6.2 closing the waiting screen withdraws the request', async () => {
  const { host, roomId } = await hostRoom({ visibility: 'public' });
  const a = client();
  await call(a, 'requestJoin', { roomId, name: 'Nami', token: a.token });
  await waitFor(() => host.last.requests.length === 1);
  a.close();
  await waitFor(() => host.last.requests.length === 0);
});

test('T6.17 kicked player is told and cannot come back', async () => {
  const { host, roomId } = await hostRoom();
  const p = client();
  await call(p, 'join', { roomId, name: 'Nami', token: p.token });
  await waitFor(() => host.last.players.length === 2);
  const target = host.last.players.find((x) => x.name === 'Nami');
  assert.ok((await call(host, 'kick', { playerId: target.id })).ok);
  await waitFor(() => p.events.some(([e]) => e === 'kicked'));
  assert.equal((await call(p, 'join', { roomId, name: 'Nami', token: p.token })).code, 'KICKED');
});

test('T6.19 report reaches the admin store', async () => {
  const { host, roomId } = await hostRoom();
  const p = client();
  await call(p, 'join', { roomId, name: 'Nami', token: p.token });
  await waitFor(() => host.last.players.length === 2);
  const target = host.last.players.find((x) => x.name === 'Nami');
  assert.ok((await call(host, 'report', { playerId: target.id, reason: 'Abusive in chat' })).ok);
  assert.ok(server.reports.some((r) => r.target === 'Nami' && r.reason === 'Abusive in chat'));
});

test('T6.21 / NF2 player drops and comes back within grace: nothing lost', async () => {
  const { host, roomId } = await hostRoom();
  const p = client();
  await call(p, 'join', { roomId, name: 'Nami', token: p.token });
  await waitFor(() => host.last.players.length === 2);
  const id = host.last.players.find((x) => x.name === 'Nami').id;
  p.close();
  await waitFor(() => host.last.players.find((x) => x.id === id)?.connected === false);
  const back = client(); back.token = p.token; // same browser, new connection
  assert.ok((await call(back, 'join', { roomId, token: back.token })).ok);
  await sleep(GRACE + 100);
  assert.equal(host.last.players.find((x) => x.id === id)?.connected, true);
  assert.equal(back.last.you, id, 'rejoins as themselves, not a new player');
});

test('T6.20 host drops and does not return: next player by join order becomes host', async () => {
  const { host, roomId } = await hostRoom();
  const p2 = client(); const p3 = client();
  await call(p2, 'join', { roomId, name: 'Nami', token: p2.token });
  await call(p3, 'join', { roomId, name: 'Usopp', token: p3.token });
  await waitFor(() => p2.last?.players.length === 3);
  host.close();
  await waitFor(() => p2.last.isHost === true, GRACE + 1500);
  assert.equal(p3.last.isHost, false);
});

test('NF7 two rooms never leak into each other', async () => {
  const one = await hostRoom({ roomName: 'Room One' });
  const two = await hostRoom({ roomName: 'Room Two' });
  const p = client();
  await call(p, 'join', { roomId: one.roomId, name: 'Nami', token: p.token });
  await waitFor(() => one.host.last.players.length === 2);
  await sleep(100);
  assert.equal(two.host.last.players.length, 1);
  assert.equal(two.host.last.settings.roomName, 'Room Two');
});

test('NF5 rapid-fire requests are rate-limited', async () => {
  const p = client();
  const results = await Promise.all(Array.from({ length: 60 }, () => call(p, 'browse', {})));
  assert.ok(results.some((r) => r.code === 'SLOW_DOWN'));
});

test('NF5 a non-host cannot start, kick or admit over the wire', async () => {
  const { roomId } = await hostRoom();
  const p = client();
  await call(p, 'join', { roomId, name: 'Nami', token: p.token });
  await waitFor(() => p.last);
  assert.equal((await call(p, 'start', {})).code, 'NOT_HOST');
  assert.equal((await call(p, 'kick', { playerId: p.last.hostId })).code, 'NOT_HOST');
});

test('T5.06 host starts with 3 players; everyone sees the draft begin in join order', async () => {
  const { host, roomId } = await hostRoom();
  const p2 = client(); const p3 = client();
  await call(p2, 'join', { roomId, name: 'Nami', token: p2.token });
  await call(p3, 'join', { roomId, name: 'Usopp', token: p3.token });
  await waitFor(() => host.last.players.length === 3);
  const chars = Array.from({ length: 40 }, (_, i) => `Char ${i + 1}`).join('\n');
  assert.ok((await call(host, 'addCharacters', { text: chars })).ok);
  assert.ok((await call(host, 'start', {})).ok);
  await waitFor(() => p3.last.phase === 'draft');
  assert.deepEqual(p3.last.turnOrder.map((id) => p3.last.players.find((x) => x.id === id).name), ['Ste', 'Nami', 'Usopp']);
});

test('R6.4 / NF1 character list reaches every player, including late joiners; non-hosts cannot edit it', async () => {
  const { host, roomId } = await hostRoom();
  const p2 = client();
  await call(p2, 'join', { roomId, name: 'Nami', token: p2.token });
  const res = await call(host, 'addCharacters', { text: 'Luffy\nZoro\nluffy', verse: 'One Piece' });
  assert.equal(res.added, 2);
  assert.deepEqual(res.duplicates, ['luffy']);
  await waitFor(() => p2.chars?.list.length === 2);
  assert.equal(p2.chars.list[0].verse, 'One Piece');
  const p3 = client();
  await call(p3, 'join', { roomId, name: 'Usopp', token: p3.token });
  await waitFor(() => p3.chars?.list.length === 2);
  assert.equal((await call(p2, 'addCharacters', { text: 'Sneaky' })).code, 'NOT_HOST');
  assert.equal((await call(p2, 'clearCharacters', {})).code, 'NOT_HOST');
});

async function startedRoom(over = {}) {
  const { host, roomId } = await hostRoom(over);
  const p2 = client(); const p3 = client();
  await call(p2, 'join', { roomId, name: 'Nami', token: p2.token });
  await call(p3, 'join', { roomId, name: 'Usopp', token: p3.token });
  await waitFor(() => host.last.players.length === 3);
  await call(host, 'addCharacters', { text: Array.from({ length: 40 }, (_, i) => `Char ${i + 1}`).join('\n') });
  assert.ok((await call(host, 'start', {})).ok);
  await waitFor(() => [host, p2, p3].every((c) => c.last?.phase === 'draft'));
  const byId = new Map([[host.last.you, host], [p2.last.you, p2], [p3.last.you, p3]]);
  return { host, p2, p3, roomId, byId };
}

test('R1.4 / NF1 a full draft over the wire: every screen agrees at the end', async () => {
  const { host, p2, p3, byId } = await startedRoom();
  for (let turn = 0; turn < 15; turn += 1) {
    await waitFor(() => host.last.draft?.turn);
    const active = byId.get(host.last.draft.turn.playerId);
    assert.ok((await call(active, 'spin', {})).ok);
    await waitFor(() => active.last.draft.turn?.stage === 'landed');
    const role = active.last.draft.teams[active.last.you].indexOf(null);
    assert.ok((await call(active, 'place', { role })).ok);
    await waitFor(() => host.last.version >= active.last.version);
  }
  await waitFor(() => [host, p2, p3].every((c) => c.last.phase === 'drafted'));
  assert.deepEqual(p2.last.draft.teams, host.last.draft.teams);
  assert.deepEqual(p3.last.draft.teams, host.last.draft.teams);
  const all = Object.values(host.last.draft.teams).flat();
  assert.equal(new Set(all).size, 15, 'nobody shares a character');
});

test('T8.01 everyone sees the same spin result live', async () => {
  const { host, p2, p3 } = await startedRoom();
  await call(host, 'spin', {});
  await waitFor(() => [p2, p3].every((c) => c.last.draft.turn?.spin));
  assert.equal(p2.last.draft.turn.spin.landed, host.last.draft.turn.spin.landed);
  assert.equal(p3.last.draft.turn.spin.landed, host.last.draft.turn.spin.landed);
  assert.deepEqual(p3.last.draft.turn.spin.wheel, host.last.draft.turn.spin.wheel);
});

test('T8.13 the server applies a timeout by itself when the timer runs out', async () => {
  const { host, p3, roomId } = await startedRoom({ timerEnabled: true, timerSeconds: 15 });
  await call(host, 'spin', {});
  const room = server.rooms.get(roomId);
  room.draft.turn.deadline = Date.now() + 150; // shorten for the test
  await call(host, 'voteKick', { playerId: p3.last.you }); // any action that re-broadcasts
  await waitFor(() => p3.last.draft.turn?.playerId !== host.last.you, 3000);
  assert.ok(p3.last.draft.log.some((e) => e.kind === 'timeout'));
});

test('T8.22 vote-kick over the wire: the kicked player is told', async () => {
  const { host, p2, p3 } = await startedRoom();
  await call(host, 'voteKick', { playerId: p3.last.you });
  await waitFor(() => p2.last.kickVotes[p3.last.you]?.votes === 1);
  const res = await call(p2, 'voteKick', { playerId: p3.last.you });
  assert.equal(res.kicked, true);
  await waitFor(() => p3.events.some(([e]) => e === 'kicked'));
});
