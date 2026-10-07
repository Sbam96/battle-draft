// Phase 1 rule tests. Test names start with the matrix ID they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, GameError, validateName, validateSettings } from '../src/room.js';
import { minimumPool, maxPlayersFor } from '../src/config.js';
import { roomId } from '../src/ids.js';

const roles5 = ['Captain', 'Vice', 'Support', 'Support', 'Wildcard'];
const roles10 = Array.from({ length: 10 }, (_, i) => `Role ${i + 1}`);
const base = (over = {}) => ({ roomName: 'Friday Draft', visibility: 'private', roleCount: 5, roles: roles5, cap: 8, turnOrder: 'join', releasedHoldToBin: true, timerEnabled: false, ...over });
const makeRoom = (over) => new Room({ id: 'r1', settings: base(over), hostName: 'Ste', hostToken: 'tok-host' });
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof GameError, e.message); return e.code; } return null; };

// ---------- R1.2 / R5.3 roles ----------
test('T1.01 5-role game accepted', () => assert.equal(validateSettings(base()).roles.length, 5));
test('T1.02 10-role game accepted', () => assert.equal(validateSettings(base({ roleCount: 10, roles: roles10 })).roles.length, 10));
test('T1.03 only 5 or 10 roles allowed', () => {
  assert.equal(code(() => validateSettings(base({ roleCount: 7, roles: roles5.concat('a', 'b') }))), 'ROLE_COUNT');
  assert.equal(code(() => validateSettings(base({ roleCount: 4, roles: roles5.slice(0, 4) }))), 'ROLE_COUNT');
});
test('T1.04 10-role game with only 9 named is blocked', () => {
  assert.equal(code(() => validateSettings(base({ roleCount: 10, roles: roles10.slice(0, 9) }))), 'ROLES_MISSING');
});
test('T1.05 blank role name blocked', () => {
  assert.equal(code(() => validateSettings(base({ roles: ['A', '  ', 'C', 'D', 'E'] }))), 'ROLE_EMPTY');
});
test('T1.06 duplicate role names allowed', () => {
  assert.deepEqual(validateSettings(base()).roles.filter((r) => r === 'Support').length, 2);
});
test('T1.07 overlong role name limited', () => {
  assert.equal(code(() => validateSettings(base({ roles: ['x'.repeat(61), 'B', 'C', 'D', 'E'] }))), 'ROLE_LONG');
});
test('T1.08 emoji and Japanese role names kept intact', () => {
  assert.equal(validateSettings(base({ roles: ['船長 🏴‍☠️', 'B', 'C', 'D', 'E'] })).roles[0], '船長 🏴‍☠️');
});
test('T1.09 script tags stored as plain text (escaped on display)', () => {
  assert.equal(validateSettings(base({ roles: ['<script>alert(1)</script>', 'B', 'C', 'D', 'E'] })).roles[0], '<script>alert(1)</script>');
});
test('T6.x profane role name rejected', () => {
  assert.equal(code(() => validateSettings(base({ roles: ['fuck', 'B', 'C', 'D', 'E'] }))), 'ROLE_PROFANE');
});

// ---------- R5.4 cap, R5.6 minimum pool ----------
test('T5.08 cap below 3 rejected', () => assert.equal(code(() => validateSettings(base({ cap: 2 }))), 'CAP_LOW'));
test('T5.09 cap limited so the minimum list stays within 500', () => {
  assert.equal(maxPlayersFor(10), 34);
  assert.equal(maxPlayersFor(5), 56);
  assert.ok(minimumPool(34, 10) <= 500 && minimumPool(35, 10) > 500);
  assert.equal(code(() => validateSettings(base({ roleCount: 10, roles: roles10, cap: 35 }))), 'CAP_HIGH');
});
test('T5.14 8 players, 10 roles needs 115', () => assert.equal(minimumPool(8, 10), 115));
test('T5.15 3 players, 5 roles needs 27', () => assert.equal(minimumPool(3, 5), 27));
test('R5.6 exact multiples round correctly (no float drift)', () => assert.equal(minimumPool(5, 17), 110));

// ---------- R6.1 names ----------
test('T6.01 valid name accepted and tidied', () => assert.equal(validateName('  Zoro   Fan '), 'Zoro Fan'));
test('T6.02 empty name blocked', () => assert.equal(code(() => validateName('   ')), 'NAME_EMPTY'));
test('T6.03 name length limit', () => {
  assert.equal(validateName('x'.repeat(20)).length, 20);
  assert.equal(code(() => validateName('x'.repeat(21))), 'NAME_LONG');
});
test('T6.05 profane names and symbol swaps rejected', () => {
  for (const n of ['fuck', 'f*ck', 'sh1t', 'b1tch']) assert.equal(code(() => validateName(n)), 'NAME_PROFANE', n);
});
test('T6.07 clean names with rude substrings accepted', () => {
  for (const n of ['Scunthorpe', 'Assassin', 'Dickson', 'Hancock', 'Sanji']) assert.equal(validateName(n), n);
});

test('T6.04 taken name rejected, including different case', () => {
  const r = makeRoom();
  r.join('t2', 'Nami');
  assert.equal(code(() => r.join('t3', 'nami')), 'NAME_TAKEN');
  assert.equal(code(() => r.join('t4', 'STE')), 'NAME_TAKEN');
});
test('T6.06 a leaver’s name can be reused', () => {
  const r = makeRoom();
  const { player } = r.join('t2', 'Nami');
  r.leave(player.id);
  assert.ok(r.join('t3', 'Nami').player);
});

// ---------- R6.2 admission ----------
test('T6.08 public game needs the host to admit', () => {
  const r = makeRoom({ visibility: 'public' });
  assert.equal(code(() => r.join('t2', 'Nami')), 'NEEDS_ADMISSION');
  const req = r.requestJoin('t2', 'Nami');
  assert.equal(r.viewFor(r.hostId).requests.length, 1);
  const { player } = r.admit(r.hostId, req.id);
  assert.equal(player.name, 'Nami');
  assert.equal(r.players.length, 2);
});
test('T6.10 host declines a request', () => {
  const r = makeRoom({ visibility: 'public' });
  const req = r.requestJoin('t2', 'Nami');
  r.decline(r.hostId, req.id);
  assert.equal(r.requests.length, 0);
  assert.equal(r.players.length, 1);
});
test('R6.2 only the host can admit', () => {
  const r = makeRoom({ visibility: 'public' });
  const a = r.requestJoin('t2', 'Nami');
  const { player } = r.admit(r.hostId, a.id);
  const b = r.requestJoin('t3', 'Usopp');
  assert.equal(code(() => r.admit(player.id, b.id)), 'NOT_HOST');
});
test('T6.12 pending request can be cancelled', () => {
  const r = makeRoom({ visibility: 'public' });
  r.requestJoin('t2', 'Nami');
  r.cancelRequest('t2');
  assert.equal(r.requests.length, 0);
});
test('R6.2 a pending request reserves its name', () => {
  const r = makeRoom({ visibility: 'public' });
  r.requestJoin('t2', 'Nami');
  assert.equal(code(() => r.requestJoin('t3', 'NAMI')), 'NAME_TAKEN');
});
test('T6.11 game in progress cannot be joined', () => {
  const r = makeRoom();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.start(r.hostId);
  assert.equal(code(() => r.join('t4', 'Robin')), 'GAME_STARTED');
});

// ---------- R5.4 min players and cap ----------
test('T5.05 2 players: start blocked with a reason', () => {
  const r = makeRoom();
  r.join('t2', 'Nami');
  assert.match(r.startBlockers()[0], /2 of at least 3/);
  assert.equal(code(() => r.start(r.hostId)), 'CANT_START');
});
test('T5.06 3 players: start allowed', () => {
  const r = makeRoom();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  assert.deepEqual(r.startBlockers(), []);
  r.start(r.hostId);
  assert.equal(r.phase, 'draft');
});
test('T5.07 full room blocks joining', () => {
  const r = makeRoom({ cap: 3 });
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  assert.equal(code(() => r.join('t4', 'Robin')), 'ROOM_FULL');
});
test('T6.16 only the host can start', () => {
  const r = makeRoom();
  const { player } = r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  assert.equal(code(() => r.start(player.id)), 'NOT_HOST');
});

// ---------- R5.5 turn order ----------
test('T5.10 join order', () => {
  const r = makeRoom();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.start(r.hostId);
  assert.deepEqual(r.turnOrder.map((id) => r.player(id).name), ['Ste', 'Nami', 'Usopp']);
});
test('T5.11 shuffle gives a random order that is then fixed', () => {
  const orders = new Set();
  for (let i = 0; i < 30; i += 1) {
    const r = makeRoom({ turnOrder: 'shuffle' });
    r.join('t2', 'Nami'); r.join('t3', 'Usopp'); r.join('t4', 'Robin');
    r.start(r.hostId);
    orders.add(r.turnOrder.map((id) => r.player(id).name).join(','));
  }
  assert.ok(orders.size > 1, 'shuffle should produce different orders');
});

// ---------- R6.6 kick and report ----------
test('T6.17 host kicks a player, who cannot rejoin with the same link', () => {
  const r = makeRoom();
  const { player } = r.join('t2', 'Nami');
  r.kick(r.hostId, player.id);
  assert.equal(r.players.length, 1);
  assert.equal(code(() => r.join('t2', 'Nami')), 'KICKED');
});
test('R6.6 kicked player cannot request to rejoin a public game', () => {
  const r = makeRoom({ visibility: 'public' });
  const { player } = r.admit(r.hostId, r.requestJoin('t2', 'Nami').id);
  r.kick(r.hostId, player.id);
  assert.equal(code(() => r.requestJoin('t2', 'Nami')), 'KICKED');
});
test('R6.6 only the host can kick, and not themselves', () => {
  const r = makeRoom();
  const { player } = r.join('t2', 'Nami');
  assert.equal(code(() => r.kick(player.id, r.hostId)), 'NOT_HOST');
  assert.equal(code(() => r.kick(r.hostId, r.hostId)), 'KICK_SELF');
});
test('T6.19 host reports a player', () => {
  const r = makeRoom();
  const { player } = r.join('t2', 'Nami');
  const rep = r.report(r.hostId, player.id, 'Spamming slurs');
  assert.equal(rep.target, 'Nami');
  assert.equal(rep.reporter, 'Ste');
});

// ---------- R6.7 / R6.8 grace and host handover ----------
test('T6.21 reconnect within grace keeps everything', () => {
  const r = makeRoom();
  const { player } = r.join('t2', 'Nami');
  r.disconnect(player.id);
  r.join('t2', 'ignored');
  assert.equal(r.expireGrace(player.id), false);
  assert.equal(r.player(player.id).name, 'Nami');
});
test('T6.20 host disconnects in lobby: host passes by join order after grace', () => {
  const r = makeRoom();
  const { player: nami } = r.join('t2', 'Nami');
  r.join('t3', 'Usopp');
  const oldHost = r.hostId;
  r.disconnect(oldHost);
  assert.equal(r.hostId, oldHost, 'still host during grace');
  r.expireGrace(oldHost);
  assert.equal(r.hostId, nami.id);
});
test('T6.22 next in join order has left: host goes to the one after', () => {
  const r = makeRoom();
  const { player: nami } = r.join('t2', 'Nami');
  const { player: usopp } = r.join('t3', 'Usopp');
  r.disconnect(nami.id);
  r.disconnect(r.hostId);
  r.expireGrace(r.hostId);
  assert.equal(r.hostId, usopp.id);
});
test('T6.23 host reconnects within grace keeps host', () => {
  const r = makeRoom();
  r.join('t2', 'Nami');
  const host = r.hostId;
  r.disconnect(host);
  r.join('tok-host', 'Ste');
  r.expireGrace(host);
  assert.equal(r.hostId, host);
});
test('T6.24 host disconnects mid-draft: game continues, old host returns as normal player', () => {
  const r = makeRoom();
  const { player: nami } = r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.start(r.hostId);
  const oldHost = r.hostId;
  r.disconnect(oldHost);
  r.expireGrace(oldHost);
  assert.equal(r.hostId, nami.id);
  assert.ok(r.player(oldHost), 'player keeps their seat mid-game');
  r.join('tok-host', 'Ste');
  assert.equal(r.viewFor(oldHost).isHost, false);
});
test('R6.8 lobby player who does not return is removed after grace', () => {
  const r = makeRoom();
  const { player } = r.join('t2', 'Nami');
  r.disconnect(player.id);
  r.expireGrace(player.id);
  assert.equal(r.player(player.id), undefined);
});
test('T6.15 host explicitly leaves: host passes immediately', () => {
  const r = makeRoom();
  const { player: nami } = r.join('t2', 'Nami');
  r.leave(r.hostId);
  assert.equal(r.hostId, nami.id);
});

// ---------- NF5 ----------
test('NF5 room ids are long and random', () => {
  const ids = new Set(Array.from({ length: 1000 }, roomId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{12}$/);
});
test('NF5 only the host sees join requests', () => {
  const r = makeRoom({ visibility: 'public' });
  const { player } = r.admit(r.hostId, r.requestJoin('t2', 'Nami').id);
  r.requestJoin('t3', 'Usopp');
  assert.equal(r.viewFor(r.hostId).requests.length, 1);
  assert.equal(r.viewFor(player.id).requests.length, 0);
});
test('NF5 views never expose player tokens', () => {
  const r = makeRoom();
  r.join('t2', 'Nami');
  assert.ok(!JSON.stringify(r.viewFor(r.hostId)).includes('tok-host'));
  assert.ok(!JSON.stringify(r.publicSummary()).includes('tok-host'));
});
