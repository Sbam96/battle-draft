// Iteration 2, phase 1: character tiers (R15). Test names start with the matrix ID they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseText, mergeCharacters } from '../src/characters.js';
import { tierFrom, sellPrice, TIER_PRICE } from '../src/tiers.js';
import { Room } from '../src/room.js';

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const room = () => {
  const r = new Room({ id: 'r', hostName: 'Ste', hostToken: 'h', settings: { roomName: 'R', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 8, turnOrder: 'join' } });
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  return r;
};

test('T15.01 opening prices: Diamond 7, Gold 5, Silver 3, Bronze 1', () => assert.deepEqual(TIER_PRICE, { Diamond: 7, Gold: 5, Silver: 3, Bronze: 1 }));
test('T15.04 a tier column sets the tier', () => {
  const e = parseText('Gol D. Roger, Diamond\nNami, Silver').entries;
  assert.deepEqual(e.map((x) => [x.name, x.tier]), [['Gol D. Roger', 'Diamond'], ['Nami', 'Silver']]);
});
test('T15.05 older words still work: World breaker, Top, Mid, Low', () => {
  const e = parseText('Garp, World breaker\nZoro, Top\nUsopp, Mid\nBuggy, Low').entries;
  assert.deepEqual(e.map((x) => x.tier), ['Diamond', 'Gold', 'Silver', 'Bronze']);
});
test('T15.06 no tier: Bronze; an unknown extra column is reported', () => {
  const { entries, notes } = parseText('Name,Image,Tier\nBuggy,,Clown\nAlvida', { source: 'csv' });
  const merged = mergeCharacters([], entries).added;
  assert.deepEqual(merged.map((c) => c.tier), ['Bronze', 'Bronze']);
  assert.equal(notes.unknownTiers, 1);
  assert.equal(notes.headerSkipped, true);
});
test('T15.07 name, image link and tier in any order after the name', () => {
  const [a] = parseText('Zoro, https://x.y/z.png, Gold').entries;
  const [b] = parseText('Zoro, Gold, https://x.y/z.png').entries;
  assert.deepEqual(a, { name: 'Zoro', image: 'https://x.y/z.png', tier: 'Gold' });
  assert.deepEqual(b, a);
});
test('T15.07a a row of plain names is still several characters', () => {
  assert.deepEqual(parseText('Luffy, Zoro, Sanji').entries.map((x) => x.name), ['Luffy', 'Zoro', 'Sanji']);
});
test('T15.07b a character actually called "Gold" in the first column stays a name', () => {
  assert.deepEqual(parseText('Gold, Silver').entries, [{ name: 'Gold', image: null, tier: 'Silver' }]);
});
test('R15.3 tier words are matched whatever the case or spacing', () => {
  assert.equal(tierFrom('  WORLD   breaker '), 'Diamond');
  assert.equal(tierFrom('Clown'), null);
});
test('R17.7 selling prices: half the tier price, rounded half up', () => {
  assert.deepEqual(['Diamond', 'Gold', 'Silver', 'Bronze'].map(sellPrice), [4, 3, 2, 1]);
});
test('T15.11 host changes a tier in the lobby; everyone gets it with the list and in view tiers', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: 'Roger, Diamond\nNami' });
  const nami = r.characters.find((c) => c.name === 'Nami');
  assert.equal(r.charactersPayload().list.find((c) => c.id === nami.id).tier, 'Bronze');
  r.setTier(r.hostId, nami.id, 'Silver');
  assert.equal(r.charactersPayload().list.find((c) => c.id === nami.id).tier, 'Silver');
});
test('T15.12 a non-host cannot change a tier, nor the host after starting, nor to a made-up tier', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: Array.from({ length: 40 }, (_, i) => `C${i}`).join('\n') });
  const id = r.characters[0].id;
  assert.equal(code(() => r.setTier(r.players[1].id, id, 'Gold')), 'NOT_HOST');
  assert.equal(code(() => r.setTier(r.hostId, id, 'Mythic')), 'BAD_TIER');
  r.start(r.hostId);
  assert.equal(code(() => r.setTier(r.hostId, id, 'Gold')), 'GAME_STARTED');
});
test('T15.03 wheel game: tiers change nothing in the rules, but views carry tiers for colours', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: Array.from({ length: 40 }, (_, i) => `C${i}, ${['Diamond', 'Gold', 'Silver', 'Bronze'][i % 4]}`).join('\n') });
  r.start(r.hostId);
  r.draftAction(r.hostId, 'spin', {});
  const landed = r.draft.turn.landed;
  const v = r.viewFor(r.players[1].id);
  assert.equal(v.charTiers[landed], r.characters.find((c) => c.id === landed).tier);
});
