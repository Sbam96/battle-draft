// Community pool, against a real Postgres. Set TEST_DATABASE_URL to run; skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { openDb } from '../src/db.js';
import { PoolStore, validateIdentity } from '../src/pool.js';
import { SEED_VERSES } from '../src/seed.js';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'set TEST_DATABASE_URL to run the pool tests';
let db; let store;

export async function freshDb(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS image_requests, pool_characters, verses, contributors, access_requests, messages, reports CASCADE');
  await c.end();
  return openDb(url);
}

before(async () => { if (URL) { db = await freshDb(URL); store = new PoolStore(db); } });
after(async () => { if (db) await db.close(); });

const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };
const verseId = async (name) => (await store.listVerses()).find((v) => v.name === name).id;
const approve = async (who) => { await store.requestAccess(who); const r = (await store.adminOverview()).requests.find((x) => x.identity === who); await store.decideAccess(r.id, true, 'admin'); };

test('P1 the five starter verses are there, names only', { skip }, async () => {
  const verses = await store.listVerses();
  for (const [name, list] of Object.entries(SEED_VERSES)) {
    const v = verses.find((x) => x.name === name);
    assert.ok(v, name);
    assert.equal(v.count, list.length);
    assert.equal(v.withImages, 0);
  }
});
test('P2 seeding again does not duplicate or restore deleted characters', { skip }, async () => {
  const id = await verseId('Bleach');
  const kon = (await store.verseCharacters(id)).find((c) => c.name === 'Kon');
  await store.deleteCharacter(kon.id);
  const again = await openDb(URL);
  await again.close();
  const after2 = await store.verseCharacters(id);
  assert.equal(after2.length, SEED_VERSES.Bleach.length - 1);
  assert.ok(!after2.some((c) => c.name === 'Kon'));
});
test('P3 every starter verse alone is enough for a 3-player, 5-role game', { skip }, async () => {
  for (const v of await store.listVerses()) assert.ok(v.count >= 27, `${v.name} has ${v.count}`);
});

// ---------- sign-in ----------
test('P4 sign in with a username or an email; bad ones are refused with a reason', { skip }, async () => {
  assert.equal(validateIdentity('ste_96').key, 'ste_96');
  assert.equal(validateIdentity('  Ste@Example.com ').key, 'ste@example.com');
  for (const bad of ['', 'ab', 'has space', 'x@y', 'f*ck']) assert.ok(await code(Promise.resolve().then(() => validateIdentity(bad))), bad);
});
test('P5 not approved: cannot add; can request access once (repeat requests do not pile up)', { skip }, async () => {
  assert.equal(await code(store.addCharacters('newbie', { verseId: await verseId('Naruto'), text: 'Boruto Uzumaki' })), 'NOT_APPROVED');
  await store.requestAccess('newbie', 'I know my JJK');
  assert.deepEqual(await store.requestAccess('NEWBIE'), { already: 'pending' });
  const pending = (await store.adminOverview()).requests.filter((r) => r.identity.toLowerCase() === 'newbie');
  assert.equal(pending.length, 1);
  assert.equal((await store.status('newbie')).request, 'pending');
});
test('P6 admin approves: the name goes on the approved list and they can add', { skip }, async () => {
  await approve('ste_96');
  assert.equal((await store.status('STE_96')).approved, true);
  const res = await store.addCharacters('ste_96', { verseId: await verseId('Naruto'), text: 'Boruto Uzumaki\nKawaki' });
  assert.deepEqual(res.added, ['Boruto Uzumaki', 'Kawaki']);
});
test('P7 admin denies: not approved, and they can ask again later', { skip }, async () => {
  await store.requestAccess('troll99');
  const r = (await store.adminOverview()).requests.find((x) => x.identity === 'troll99');
  await store.decideAccess(r.id, false, 'admin');
  assert.equal((await store.status('troll99')).approved, false);
  assert.equal((await store.status('troll99')).request, 'denied');
  assert.equal(await code(store.decideAccess(r.id, true, 'admin')), 'NO_REQUEST', 'a decided request cannot be decided again');
});

// ---------- adding ----------
test('P8 add to a brand-new verse by name', { skip }, async () => {
  const res = await store.addCharacters('ste_96', { verseName: 'Jujutsu Kaisen', text: 'Gojo Satoru, Ryomen Sukuna\nYuji Itadori' });
  assert.equal(res.verse.name, 'Jujutsu Kaisen');
  assert.equal(res.added.length, 3);
  const again = await store.addCharacters('ste_96', { verseName: 'jujutsu  kaisen', text: 'Megumi Fushiguro' });
  assert.equal(again.verse.id, res.verse.id, 'same verse, not a second one');
});
test('P9 bulk CSV with links: new characters get their image', { skip }, async () => {
  const res = await store.addCharacters('ste_96', { verseName: 'Jujutsu Kaisen', source: 'csv', text: 'Name,Image\nMaki Zenin,https://img.example/maki.png\nToge Inumaki,https://img.example/toge.png' });
  assert.deepEqual(res.added, ['Maki Zenin', 'Toge Inumaki']);
  const maki = (await store.verseCharacters(res.verse.id)).find((c) => c.name === 'Maki Zenin');
  assert.equal(maki.image, 'https://img.example/maki.png');
});
test('P10 existing character with no image + a link: the link is added to it (no duplicate)', { skip }, async () => {
  const id = await verseId('One Piece');
  const res = await store.addCharacters('ste_96', { verseId: id, source: 'csv', text: 'monkey d. luffy,https://img.example/luffy.png' });
  assert.deepEqual(res.imagesAdded, ['Monkey D. Luffy']);
  assert.deepEqual(res.added, []);
  const luffy = (await store.verseCharacters(id)).filter((c) => c.name === 'Monkey D. Luffy');
  assert.equal(luffy.length, 1);
  assert.equal(luffy[0].image, 'https://img.example/luffy.png');
});
test('P11 existing image + a different link: told, and an image request goes to the admin', { skip }, async () => {
  const id = await verseId('One Piece');
  const res = await store.addCharacters('ste_96', { verseId: id, source: 'csv', text: 'Monkey D. Luffy,https://img.example/luffy-gear5.png' });
  assert.deepEqual(res.imageRequests, ['Monkey D. Luffy']);
  const req = (await store.adminOverview()).images.find((r) => r.name === 'Monkey D. Luffy');
  assert.equal(req.image_url, 'https://img.example/luffy.png');
  assert.equal(req.proposed_url, 'https://img.example/luffy-gear5.png');
  const dup = await store.addCharacters('ste_96', { verseId: id, source: 'csv', text: 'Monkey D. Luffy,https://img.example/luffy-gear5.png' });
  assert.deepEqual(dup.imageRequests, ['Monkey D. Luffy']);
  assert.equal((await store.adminOverview()).images.filter((r) => r.name === 'Monkey D. Luffy').length, 1, 'same suggestion only queued once');
});
test('P12 admin approves an image request: the image is swapped and other suggestions close', { skip }, async () => {
  const id = await verseId('One Piece');
  await store.addCharacters('ste_96', { verseId: id, source: 'csv', text: 'Monkey D. Luffy,https://img.example/luffy-other.png' });
  const reqs = (await store.adminOverview()).images.filter((r) => r.name === 'Monkey D. Luffy');
  assert.equal(reqs.length, 2);
  await store.decideImage(reqs.find((r) => r.proposed_url.endsWith('gear5.png')).id, true);
  const luffy = (await store.verseCharacters(id)).find((c) => c.name === 'Monkey D. Luffy');
  assert.equal(luffy.image, 'https://img.example/luffy-gear5.png');
  assert.equal((await store.adminOverview()).images.filter((r) => r.name === 'Monkey D. Luffy').length, 0);
});
test('P13 same name and same link (or no link): counted as a duplicate', { skip }, async () => {
  const id = await verseId('One Piece');
  const res = await store.addCharacters('ste_96', { verseId: id, source: 'csv', text: 'Monkey D. Luffy,https://img.example/luffy-gear5.png\nNami\nnami' });
  assert.deepEqual(res.duplicates, ['Monkey D. Luffy', 'Nami', 'nami']);
});
test('P14 variants are separate characters (Pre-TS / Post-TS)', { skip }, async () => {
  const res = await store.addCharacters('ste_96', { verseId: await verseId('One Piece'), text: 'Pre-TS Luffy\nPost-TS Luffy' });
  assert.equal(res.added.length, 2);
});
test('P15 unsafe links are dropped; the name is still added', { skip }, async () => {
  const res = await store.addCharacters('ste_96', { verseId: await verseId('Bleach'), source: 'csv', text: 'Nelliel Tu Odelschwanck,javascript:alert(1)' });
  assert.deepEqual(res.added, ['Nelliel Tu Odelschwanck']);
  assert.equal(res.notes.unsafeLinks, 1);
});
test('P16 a profane verse name is refused', { skip }, async () => {
  assert.equal(await code(store.addCharacters('ste_96', { verseName: 'shit anime', text: 'X' })), 'VERSE_PROFANE');
});

// ---------- loading into games ----------
test('P17 load verses for a game: names and images come through, grouped by verse', { skip }, async () => {
  const groups = await store.charactersForVerses([await verseId('One Piece'), await verseId('Dragon Ball')]);
  assert.deepEqual(groups.map((g) => g.verse).sort(), ['Dragon Ball', 'One Piece']);
  const op = groups.find((g) => g.verse === 'One Piece');
  assert.equal(op.characters.find((c) => c.name === 'Monkey D. Luffy').image, 'https://img.example/luffy-gear5.png');
});

// ---------- admin and contact ----------
test('P18 contact form message reaches the admin; too-short messages are refused', { skip }, async () => {
  assert.equal(await code(store.contact({ message: 'hi' })), 'MESSAGE_SHORT');
  await store.contact({ name: 'Nami', replyTo: 'nami@example.com', message: 'Can you add Chainsaw Man as a verse?' });
  const m = (await store.adminOverview()).messages[0];
  assert.equal(m.reply_to, 'nami@example.com');
  await store.setHandled('messages', m.id, true);
  assert.equal((await store.adminOverview()).messages.find((x) => x.id === m.id).handled, true);
});
test('P19 admin can add someone to the approved list directly, or remove them', { skip }, async () => {
  await store.addContributor('robin@example.com', 'admin');
  assert.equal((await store.status('Robin@Example.com')).approved, true);
  const c = (await store.adminOverview()).contributors.find((x) => x.identity === 'robin@example.com');
  await store.removeContributor(c.id);
  assert.equal((await store.status('robin@example.com')).approved, false);
});
test('P20 reports are stored and survive restarts', { skip }, async () => {
  await store.saveReport({ roomName: 'R', reporter: 'Ste', target: 'Troll', reason: 'Abusive names' });
  const again = await openDb(URL);
  const s2 = new PoolStore(again);
  assert.ok((await s2.adminOverview()).reports.some((r) => r.target === 'Troll'));
  await again.close();
});
test('P21 admin removes a pool character', { skip }, async () => {
  const id = await verseId('Jujutsu Kaisen');
  const toge = (await store.verseCharacters(id)).find((c) => c.name === 'Toge Inumaki');
  await store.deleteCharacter(toge.id);
  assert.ok(!(await store.verseCharacters(id)).some((c) => c.name === 'Toge Inumaki'));
});
