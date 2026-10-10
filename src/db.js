// Database connection and schema for the community pool (Postgres: Neon in production).
// The game itself still runs in memory; only the pool and admin records are stored here.

import pg from 'pg';
import { SEED_VERSES } from './seed.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS verses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pool_characters (
  id SERIAL PRIMARY KEY,
  verse_id INTEGER NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  image_url TEXT,
  added_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (verse_id, name_key)
);
-- The approved list: anyone whose username or email is here can add to the pool.
CREATE TABLE IF NOT EXISTS contributors (
  id SERIAL PRIMARY KEY,
  identity TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  approved_by TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_requests (
  id SERIAL PRIMARY KEY,
  identity TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request ON access_requests (identity_key) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS image_requests (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES pool_characters(id) ON DELETE CASCADE,
  proposed_url TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_image ON image_requests (character_id, proposed_url) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  from_name TEXT,
  reply_to TEXT,
  body TEXT NOT NULL,
  handled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  room_name TEXT,
  reporter TEXT,
  target TEXT,
  reason TEXT NOT NULL,
  handled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const nameKey = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function openDb(url) {
  if (!url) return null;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: true }, // Neon requires TLS
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000, // Neon may take a few seconds to wake up
  });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  const db = {
    pool,
    query: (text, params) => pool.query(text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
  await db.query(SCHEMA);
  await seed(db);
  return db;
}

// Adds each starter verse once, the first time it's missing. After that the verse belongs to the
// community: anything the admin removes stays removed after a restart.
async function seed(db) {
  for (const [verse, names] of Object.entries(SEED_VERSES)) {
    const { rows } = await db.query(
      `INSERT INTO verses (name, name_key, created_by) VALUES ($1, $2, 'starter list')
       ON CONFLICT (name_key) DO NOTHING RETURNING id`,
      [verse, nameKey(verse)],
    );
    if (!rows.length) continue; // already there
    const verseId = rows[0].id;
    await db.query(
      `INSERT INTO pool_characters (verse_id, name, name_key, added_by)
       SELECT $1, n, lower(regexp_replace(btrim(n), '\\s+', ' ', 'g')), 'starter list' FROM unnest($2::text[]) AS n
       ON CONFLICT (verse_id, name_key) DO NOTHING`,
      [verseId, names],
    );
  }
}
