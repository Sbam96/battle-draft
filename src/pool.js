// Community pool rules (R12, revised 10 Oct 2026).
//  - Sign in with a username or email only (no password). If it's on the approved list you can add
//    characters; otherwise you can request access, which the admin approves or denies.
//  - Characters belong to a verse. Adding one that's already there (same name, ignoring case and spaces):
//      no image yet + new link  -> the link is added to the existing character
//      has an image + a different link -> the contributor is told, and an image request goes to the admin
//  - Image links only (no uploads). Bulk add by paste or CSV/table.

import { nameKey } from './db.js';
import { parseText, CHAR_NAME_MAX } from './characters.js';
import { isProfane } from './profanity.js';
import { MAX_CHARACTERS } from './config.js';

export class PoolError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME = /^[A-Za-z0-9_.-]{3,30}$/;
export const VERSE_NAME_MAX = 40;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function validateIdentity(raw) {
  const identity = clean(raw);
  if (!identity) throw new PoolError('IDENTITY_EMPTY', 'Enter your username or email.');
  if (identity.length > 80) throw new PoolError('IDENTITY_LONG', 'That’s too long for a username or email.');
  const isEmail = identity.includes('@');
  if (isEmail && !EMAIL.test(identity)) throw new PoolError('IDENTITY_EMAIL', 'That email doesn’t look right. Check it and try again.');
  if (!isEmail && !USERNAME.test(identity)) throw new PoolError('IDENTITY_USERNAME', 'Usernames are 3–30 letters, numbers, dots, dashes or underscores.');
  if (!isEmail && isProfane(identity)) throw new PoolError('IDENTITY_PROFANE', 'That username isn’t allowed. Pick another.');
  return { identity, key: identity.toLowerCase() };
}

export function validateVerseName(raw) {
  const name = clean(raw);
  if (!name) throw new PoolError('VERSE_EMPTY', 'Give the verse a name, e.g. Jujutsu Kaisen.');
  if (name.length > VERSE_NAME_MAX) throw new PoolError('VERSE_LONG', `Verse names can be up to ${VERSE_NAME_MAX} characters.`);
  if (isProfane(name)) throw new PoolError('VERSE_PROFANE', 'That verse name isn’t allowed.');
  return name;
}

export class PoolStore {
  constructor(db) { this.db = db; }

  // ---------- browsing (anyone) ----------
  async listVerses() {
    const { rows } = await this.db.query(`
      SELECT v.id, v.name, count(c.id)::int AS count, count(c.image_url)::int AS with_images
      FROM verses v LEFT JOIN pool_characters c ON c.verse_id = v.id
      GROUP BY v.id ORDER BY count(c.id) DESC, v.name`);
    return rows.map((r) => ({ id: r.id, name: r.name, count: r.count, withImages: r.with_images }));
  }

  async verseCharacters(verseId) {
    const { rows } = await this.db.query(
      'SELECT id, name, image_url FROM pool_characters WHERE verse_id = $1 ORDER BY lower(name)', [Number(verseId)]);
    return rows.map((r) => ({ id: r.id, name: r.name, image: r.image_url }));
  }

  // For loading into a game: [{ verse, characters: [{ name, image }] }]
  async charactersForVerses(verseIds) {
    const ids = [...new Set((verseIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) throw new PoolError('NO_VERSES', 'Pick at least one verse.');
    const { rows } = await this.db.query(`
      SELECT v.id AS verse_id, v.name AS verse, c.name, c.image_url
      FROM verses v JOIN pool_characters c ON c.verse_id = v.id
      WHERE v.id = ANY($1::int[]) ORDER BY v.name, lower(c.name)`, [ids]);
    const byVerse = new Map();
    for (const r of rows) {
      if (!byVerse.has(r.verse_id)) byVerse.set(r.verse_id, { verse: r.verse, characters: [] });
      byVerse.get(r.verse_id).characters.push({ name: r.name, image: r.image_url });
    }
    return [...byVerse.values()];
  }

  // ---------- sign-in and access ----------
  async status(rawIdentity) {
    const { identity, key } = validateIdentity(rawIdentity);
    const approved = await this.isApproved(key);
    const { rows } = await this.db.query(
      `SELECT status FROM access_requests WHERE identity_key = $1 ORDER BY created_at DESC LIMIT 1`, [key]);
    return { identity, approved, request: approved ? null : rows[0]?.status ?? null };
  }

  async isApproved(key) {
    const { rowCount } = await this.db.query('SELECT 1 FROM contributors WHERE identity_key = $1', [key]);
    return rowCount > 0;
  }

  async requestAccess(rawIdentity, note) {
    const { identity, key } = validateIdentity(rawIdentity);
    if (await this.isApproved(key)) return { already: 'approved' };
    const text = clean(note).slice(0, 300) || null;
    const { rowCount } = await this.db.query(
      `INSERT INTO access_requests (identity, identity_key, note) VALUES ($1, $2, $3)
       ON CONFLICT (identity_key) WHERE status = 'pending' DO NOTHING`, [identity, key, text]);
    return { already: rowCount ? null : 'pending' };
  }

  // ---------- adding (approved contributors) ----------
  async #findOrCreateVerse(client, { verseId, verseName }, by) {
    if (verseId != null && verseId !== '') {
      const { rows } = await client.query('SELECT id, name FROM verses WHERE id = $1', [Number(verseId)]);
      if (!rows.length) throw new PoolError('NO_VERSE', 'That verse no longer exists.');
      return rows[0];
    }
    const name = validateVerseName(verseName);
    const { rows } = await client.query(
      `INSERT INTO verses (name, name_key, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (name_key) DO UPDATE SET name_key = EXCLUDED.name_key RETURNING id, name`,
      [name, nameKey(name), by]);
    return rows[0];
  }

  async addCharacters(rawIdentity, { verseId, verseName, text, source = 'paste' } = {}) {
    const { identity, key } = validateIdentity(rawIdentity);
    if (!(await this.isApproved(key))) throw new PoolError('NOT_APPROVED', 'You’re not on the approved list yet. Request access and the admin will review it.', 403);
    let parsed;
    try { parsed = parseText(text, { source: source === 'csv' ? 'csv' : 'paste' }); } catch (err) { throw new PoolError(err.code || 'BAD_LIST', err.message); }
    if (!parsed.entries.length) throw new PoolError('NO_CHARACTERS', 'No characters found. Put one name per line, or separate names with commas.');
    if (parsed.entries.length > MAX_CHARACTERS) throw new PoolError('TOO_MANY', `Add up to ${MAX_CHARACTERS} at a time.`);

    return this.db.tx(async (client) => {
      const verse = await this.#findOrCreateVerse(client, { verseId, verseName }, identity);
      const result = { verse: { id: verse.id, name: verse.name }, added: [], imagesAdded: [], imageRequests: [], duplicates: [], notes: parsed.notes };
      const seen = new Set();
      for (const e of parsed.entries) {
        const k = nameKey(e.name);
        if (seen.has(k)) { result.duplicates.push(e.name); continue; }
        seen.add(k);
        const { rows } = await client.query(
          'SELECT id, name, image_url FROM pool_characters WHERE verse_id = $1 AND name_key = $2', [verse.id, k]);
        const existing = rows[0];
        if (!existing) {
          await client.query(
            'INSERT INTO pool_characters (verse_id, name, name_key, image_url, added_by) VALUES ($1, $2, $3, $4, $5)',
            [verse.id, e.name, k, e.image || null, identity]);
          result.added.push(e.name);
        } else if (e.image && !existing.image_url) {
          await client.query('UPDATE pool_characters SET image_url = $1 WHERE id = $2', [e.image, existing.id]);
          result.imagesAdded.push(existing.name);
        } else if (e.image && existing.image_url !== e.image) {
          await client.query(
            `INSERT INTO image_requests (character_id, proposed_url, requested_by) VALUES ($1, $2, $3)
             ON CONFLICT (character_id, proposed_url) WHERE status = 'pending' DO NOTHING`,
            [existing.id, e.image, identity]);
          result.imageRequests.push(existing.name);
        } else {
          result.duplicates.push(e.name);
        }
      }
      return result;
    });
  }

  // ---------- contact and reports ----------
  async contact({ name, replyTo, message }) {
    const body = String(message ?? '').trim().slice(0, 2000);
    if (body.length < 5) throw new PoolError('MESSAGE_SHORT', 'Write a short message so the admin knows what you need.');
    const reply = clean(replyTo).slice(0, 120) || null;
    await this.db.query('INSERT INTO messages (from_name, reply_to, body) VALUES ($1, $2, $3)',
      [clean(name).slice(0, 40) || null, reply, body]);
  }

  async saveReport(r) {
    await this.db.query('INSERT INTO reports (room_name, reporter, target, reason) VALUES ($1, $2, $3, $4)',
      [r.roomName, r.reporter, r.target, r.reason]);
  }

  // ---------- admin ----------
  async adminOverview() {
    const q = (sql) => this.db.query(sql).then((r) => r.rows);
    const [requests, images, messages, reports, contributors, counts] = await Promise.all([
      q(`SELECT id, identity, note, created_at FROM access_requests WHERE status = 'pending' ORDER BY created_at`),
      q(`SELECT r.id, r.proposed_url, r.requested_by, r.created_at, c.id AS character_id, c.name, c.image_url, v.name AS verse
         FROM image_requests r JOIN pool_characters c ON c.id = r.character_id JOIN verses v ON v.id = c.verse_id
         WHERE r.status = 'pending' ORDER BY r.created_at`),
      q('SELECT id, from_name, reply_to, body, handled, created_at FROM messages ORDER BY handled, created_at DESC LIMIT 200'),
      q('SELECT id, room_name, reporter, target, reason, handled, created_at FROM reports ORDER BY handled, created_at DESC LIMIT 200'),
      q('SELECT id, identity, approved_by, approved_at FROM contributors ORDER BY approved_at DESC'),
      q(`SELECT (SELECT count(*) FROM verses)::int AS verses, (SELECT count(*) FROM pool_characters)::int AS characters,
                (SELECT count(*) FROM pool_characters WHERE image_url IS NOT NULL)::int AS with_images`),
    ]);
    return { requests, images, messages, reports, contributors, counts: counts[0] };
  }

  async decideAccess(id, approve, admin) {
    return this.db.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE access_requests SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING identity, identity_key`,
        [Number(id), approve ? 'approved' : 'denied']);
      if (!rows.length) throw new PoolError('NO_REQUEST', 'That request has already been dealt with.', 404);
      if (approve) {
        await client.query(
          `INSERT INTO contributors (identity, identity_key, approved_by) VALUES ($1, $2, $3) ON CONFLICT (identity_key) DO NOTHING`,
          [rows[0].identity, rows[0].identity_key, admin]);
      }
      return { identity: rows[0].identity };
    });
  }

  async addContributor(rawIdentity, admin) {
    const { identity, key } = validateIdentity(rawIdentity);
    await this.db.query(
      `INSERT INTO contributors (identity, identity_key, approved_by) VALUES ($1, $2, $3) ON CONFLICT (identity_key) DO NOTHING`,
      [identity, key, admin]);
    await this.db.query(`UPDATE access_requests SET status = 'approved', decided_at = now() WHERE identity_key = $1 AND status = 'pending'`, [key]);
  }

  async removeContributor(id) {
    await this.db.query('DELETE FROM contributors WHERE id = $1', [Number(id)]);
  }

  async decideImage(id, approve) {
    return this.db.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE image_requests SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING character_id, proposed_url`,
        [Number(id), approve ? 'approved' : 'denied']);
      if (!rows.length) throw new PoolError('NO_REQUEST', 'That request has already been dealt with.', 404);
      if (approve) {
        await client.query('UPDATE pool_characters SET image_url = $1 WHERE id = $2', [rows[0].proposed_url, rows[0].character_id]);
        // Other pending suggestions for the same character are now out of date.
        await client.query(`UPDATE image_requests SET status = 'superseded', decided_at = now() WHERE character_id = $1 AND status = 'pending'`, [rows[0].character_id]);
      }
    });
  }

  async setHandled(table, id, handled = true) {
    if (!['messages', 'reports'].includes(table)) throw new PoolError('BAD_TABLE', 'Unknown list.');
    await this.db.query(`UPDATE ${table} SET handled = $2 WHERE id = $1`, [Number(id), Boolean(handled)]);
  }

  async deleteCharacter(id) {
    await this.db.query('DELETE FROM pool_characters WHERE id = $1', [Number(id)]);
  }
}

export { CHAR_NAME_MAX };
