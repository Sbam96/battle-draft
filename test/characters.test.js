// Phase 2: loading characters. Test names start with the matrix ID they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseText, mergeCharacters, splitRow } from '../src/characters.js';
import { Room, GameError } from '../src/room.js';
import { minimumPool } from '../src/config.js';

const names = (text, source) => parseText(text, { source }).entries.map((e) => e.name);
const room = (over = {}) => new Room({
  id: 'r', hostName: 'Ste', hostToken: 'h',
  settings: { roomName: 'R', visibility: 'private', roleCount: 5, roles: ['A', 'B', 'C', 'D', 'E'], cap: 8, turnOrder: 'join', ...over },
});
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof GameError || e.code, e.message); return e.code; } return null; };
const list = (n, prefix = 'Char') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
const IMG = 'https://example.com/luffy.png';

// ---------- R7.1 input methods ----------
test('T7.01 typed characters are added one at a time', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: 'Luffy' });
  r.addCharacters(r.hostId, { text: `Zoro, ${IMG}` });
  assert.deepEqual(r.characters.map((c) => c.name), ['Luffy', 'Zoro']);
  assert.equal(r.characters[1].image, IMG);
});
test('T7.02 pasted list, one per line', () => assert.deepEqual(names('Luffy\nZoro\nNami'), ['Luffy', 'Zoro', 'Nami']));
test('T7.03 pasted list, comma-separated', () => assert.deepEqual(names('Luffy, Zoro, Nami'), ['Luffy', 'Zoro', 'Nami']));
test('T7.04 pasted mix of lines and commas', () => assert.deepEqual(names('Luffy, Zoro\nNami\nUsopp, Sanji, Robin'), ['Luffy', 'Zoro', 'Nami', 'Usopp', 'Sanji', 'Robin']));
test('T7.05 CSV upload, one per row', () => {
  const r = room();
  const res = r.addCharacters(r.hostId, { text: `Luffy,${IMG}\nZoro,https://example.com/zoro.jpg\nNami`, source: 'csv' });
  assert.equal(res.added, 3);
  assert.equal(r.characters[0].image, IMG);
  assert.equal(r.characters[2].image, null);
});
test('R7.1 rows copied from a spreadsheet (tabs) are one character per row', () => {
  assert.deepEqual(parseText(`Luffy\tOne Piece\t${IMG}\nGoku\tDragon Ball Z`).entries, [{ name: 'Luffy', image: IMG }, { name: 'Goku', image: null }]);
});

// ---------- R7.3 working out the columns ----------
test('T7.06 CSV with no headers', () => {
  const { entries } = parseText(`Luffy,${IMG}\nZoro,https://ex.com/z.png`, { source: 'csv' });
  assert.deepEqual(entries, [{ name: 'Luffy', image: IMG }, { name: 'Zoro', image: 'https://ex.com/z.png' }]);
});
test('T7.07 header row is skipped, not added as a character', () => {
  const { entries, notes } = parseText(`Name,Image URL\nLuffy,${IMG}`, { source: 'csv' });
  assert.deepEqual(entries.map((e) => e.name), ['Luffy']);
  assert.equal(notes.headerSkipped, true);
});
test('R7.3 a character genuinely called “Character” in row 2 is kept', () => {
  assert.deepEqual(names('Luffy\nCharacter', 'csv'), ['Luffy', 'Character']);
});
test('T7.08 columns in reverse order (link first)', () => {
  assert.deepEqual(parseText(`${IMG},Luffy`, { source: 'csv' }).entries, [{ name: 'Luffy', image: IMG }]);
});
test('T7.09 names only', () => assert.deepEqual(names('Luffy\nZoro', 'csv'), ['Luffy', 'Zoro']));
test('T7.10 only some rows have links', () => {
  const { entries } = parseText(`Luffy,${IMG}\nZoro\nNami,www.example.com/nami.png`, { source: 'csv' });
  assert.equal(entries[0].image, IMG);
  assert.equal(entries[1].image, null);
  assert.equal(entries[2].image, 'https://www.example.com/nami.png');
});

// ---------- R7.1 bad files ----------
test('T7.11 empty file: clear message, nothing loaded', () => {
  const r = room();
  assert.equal(code(() => r.addCharacters(r.hostId, { text: '\n\n  \n', source: 'csv' })), 'NO_CHARACTERS');
  assert.equal(r.characters.length, 0);
});
test('T7.12 binary file (e.g. an image) is rejected', () => {
  assert.equal(code(() => parseText('\u0089PNG\r\n\u001a\n\u0000\u0000')), 'NOT_CSV');
});
test('T7.13 Excel file gets a “save as CSV” message', () => {
  try { parseText('PK\u0003\u0004 rest of xlsx'); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'NOT_CSV'); assert.match(e.message, /save it as CSV/); }
});

// ---------- R7.2 tricky names ----------
test('T7.14 quoted name containing a comma stays as one name', () => {
  assert.deepEqual(parseText(`"Luffy, Monkey D.",${IMG}`, { source: 'csv' }).entries, [{ name: 'Luffy, Monkey D.', image: IMG }]);
  assert.deepEqual(names('"Luffy, Monkey D."\nZoro'), ['Luffy, Monkey D.', 'Zoro']);
});
test('R7.2 escaped quotes inside quoted names', () => assert.deepEqual(names('"The ""Pirate"" King"', 'csv'), ['The "Pirate" King']));
test('T7.15 Japanese and accented names display correctly', () => assert.deepEqual(names('ルフィ\nPokémon Trainer Ash'), ['ルフィ', 'Pokémon Trainer Ash']));
test('T7.16 extra spaces are trimmed', () => assert.deepEqual(names('   Roronoa    Zoro   \n\tNami  '), ['Roronoa Zoro', 'Nami']));
test('R7.2 byte-order mark and Windows line endings handled', () => assert.deepEqual(names('﻿Luffy\r\nZoro\r\n', 'csv'), ['Luffy', 'Zoro']));
test('R7.2 overlong names are skipped and counted', () => {
  const { entries, notes } = parseText(`${'x'.repeat(61)}\nLuffy`);
  assert.deepEqual(entries.map((e) => e.name), ['Luffy']);
  assert.equal(notes.longNames, 1);
});
test('R6.6 character names are not profanity-filtered', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: 'Dick Grayson\nBitch-chan' });
  assert.equal(r.characters.length, 2);
});

// ---------- R7.6 duplicates ----------
test('T7.17 same character twice: one kept, duplicate reported', () => {
  const r = room();
  const res = r.addCharacters(r.hostId, { text: 'Luffy\nZoro\nLuffy' });
  assert.equal(res.added, 2);
  assert.deepEqual(res.duplicates, ['Luffy']);
});
test('T7.18 duplicates differing by case or spaces count as duplicates', () => {
  const { added, duplicates } = mergeCharacters([], parseText('Luffy\n luffy \nLUFFY\nMonkey  D. Luffy\nmonkey d. luffy').entries);
  assert.deepEqual(added.map((c) => c.name), ['Luffy', 'Monkey D. Luffy']);
  assert.deepEqual(duplicates, ['luffy', 'monkey d. luffy']);
});
test('T7.19 Pre-TS Luffy and Post-TS Luffy are both kept', () => {
  const r = room();
  const res = r.addCharacters(r.hostId, { text: 'Pre-TS Luffy\nPost-TS Luffy' });
  assert.equal(res.added, 2);
  assert.deepEqual(res.duplicates, []);
});
test('R7.6 duplicates against the existing list are reported too', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: 'Luffy\nZoro' });
  const res = r.addCharacters(r.hostId, { text: 'zoro\nNami' });
  assert.deepEqual(res.duplicates, ['zoro']);
  assert.equal(r.characters.length, 3);
});
test('T7.20 removing duplicates drops the list below the minimum: start is blocked with the new count', () => {
  const r = room();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  const need = minimumPool(3, 5);
  r.addCharacters(r.hostId, { text: `${list(need - 1)}\nChar 1` });
  assert.equal(r.characters.length, need - 1);
  assert.match(r.startBlockers()[0], new RegExp(`${need - 1} of ${need} needed`));
});

// ---------- R1.3 limits ----------
test('T1.10 list exactly at the minimum is accepted', () => {
  const r = room();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.addCharacters(r.hostId, { text: list(minimumPool(3, 5)) });
  assert.deepEqual(r.startBlockers(), []);
});
test('T1.11 one below the minimum: host warned with the required count', () => {
  const r = room();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.addCharacters(r.hostId, { text: list(26) });
  assert.match(r.startBlockers()[0], /26 of 27 needed for 3 players/);
});
test('T1.12 exactly 500 accepted', () => {
  const r = room();
  assert.equal(r.addCharacters(r.hostId, { text: list(500) }).total, 500);
});
test('T1.13 501 rejected with a message', () => {
  const r = room();
  assert.equal(code(() => r.addCharacters(r.hostId, { text: list(501) })), 'TOO_MANY');
  assert.equal(r.characters.length, 0, 'nothing is added from a rejected import');
  r.addCharacters(r.hostId, { text: list(490) });
  assert.equal(code(() => r.addCharacters(r.hostId, { text: list(11, 'Extra') })), 'TOO_MANY');
  assert.equal(r.characters.length, 490);
});
test('T1.14 blank rows are ignored and not counted', () => {
  const { entries, notes } = parseText('Luffy\n\n\nZoro\n   \n');
  assert.equal(entries.length, 2);
  assert.equal(notes.blankRows, 3, 'the final line break is not counted');
});
test('T5.16 more players join than the list supports: host warned before starting', () => {
  const r = room();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.addCharacters(r.hostId, { text: list(minimumPool(3, 5)) });
  assert.deepEqual(r.startBlockers(), []);
  r.join('t4', 'Robin');
  assert.match(r.startBlockers()[0], new RegExp(`of ${minimumPool(4, 5)} needed for 4 players`));
});

// ---------- link safety ----------
test('T7.21 javascript: links are rejected; the name is kept without an image', () => {
  const { entries, notes } = parseText('Luffy,javascript:alert(1)', { source: 'csv' });
  assert.deepEqual(entries, [{ name: 'Luffy', image: null }]);
  assert.equal(notes.unsafeLinks, 1);
});
test('NF5 data: and file: links are never used as images', () => {
  for (const bad of ['data:text/html,<b>x</b>', 'file:///etc/passwd', 'vbscript:x']) {
    assert.equal(parseText(`Luffy,${bad}`, { source: 'csv' }).entries[0].image, null, bad);
  }
});
test('R7.3 a name like “Re:Zero Subaru” is not mistaken for a link', () => assert.deepEqual(names('Re:Zero Subaru'), ['Re:Zero Subaru']));

// ---------- R7.5 per-anime lists, host controls ----------
test('R7.5 lists are tagged with the anime they came from', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: 'Luffy\nZoro', verse: 'One Piece' });
  r.addCharacters(r.hostId, { text: 'Goku', verse: 'Dragon Ball Z' });
  assert.deepEqual(r.characters.map((c) => c.verse), ['One Piece', 'One Piece', 'Dragon Ball Z']);
  r.clearCharacters(r.hostId, 'One Piece');
  assert.deepEqual(r.characters.map((c) => c.name), ['Goku']);
});
test('R7.1 host can remove one character or clear the list', () => {
  const r = room();
  r.addCharacters(r.hostId, { text: 'Luffy\nZoro\nNami' });
  r.removeCharacter(r.hostId, r.characters[1].id);
  assert.deepEqual(r.characters.map((c) => c.name), ['Luffy', 'Nami']);
  r.clearCharacters(r.hostId);
  assert.equal(r.characters.length, 0);
});
test('NF5 only the host can change the character list', () => {
  const r = room();
  const { player } = r.join('t2', 'Nami');
  assert.equal(code(() => r.addCharacters(player.id, { text: 'Luffy' })), 'NOT_HOST');
  r.addCharacters(r.hostId, { text: 'Luffy' });
  assert.equal(code(() => r.removeCharacter(player.id, r.characters[0].id)), 'NOT_HOST');
  assert.equal(code(() => r.clearCharacters(player.id)), 'NOT_HOST');
});
test('R7.1 list is locked once the draft starts', () => {
  const r = room();
  r.join('t2', 'Nami'); r.join('t3', 'Usopp');
  r.addCharacters(r.hostId, { text: list(30) });
  r.start(r.hostId);
  assert.equal(code(() => r.addCharacters(r.hostId, { text: 'Late' })), 'GAME_STARTED');
});

// ---------- performance ----------
test('T7.22 a 500-row CSV loads in well under 2 seconds', () => {
  const csv = Array.from({ length: 500 }, (_, i) => `"Character, number ${i}",https://example.com/img/${i}.png`).join('\n');
  const r = room();
  const t = performance.now();
  r.addCharacters(r.hostId, { text: csv, source: 'csv' });
  const ms = performance.now() - t;
  assert.equal(r.characters.length, 500);
  assert.ok(ms < 200, `took ${ms.toFixed(1)}ms`);
});
test('R7.2 splitRow basics', () => assert.deepEqual(splitRow(' a , "b, c" ,, d '), ['a', 'b, c', 'd']));
