const { Pool } = require('pg');
const { logger } = require('../utils/logger');

// Caller Memory (Postgres)
// Goals:
// - Never break the runtime if DB is missing/unavailable.
// - Stable API: ensureCallerMemorySchema / getCallerProfile / upsertCallerProfile
// - Use short timeouts so DB work never blocks call flow.

const DEFAULT_TIMEOUT_MS = 1500;

let pool = null;

function hasDb() {
  return Boolean(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());
}

function getPool() {
  if (!hasDb()) return null;
  if (pool) return pool;

  // Render Postgres usually requires SSL; local dev often doesn't.
  const ssl = process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false };

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 2_000,
  });

  pool.on('error', (err) => {
    logger.warn('Caller memory pool error', { error: String(err?.message || err) });
  });

  return pool;
}

async function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout_after_${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function ensureCallerMemorySchema() {
  const p = getPool();
  if (!p) return;

  // If a legacy `caller_profiles` table exists without the expected `caller_id`
  // column, every read/write will fail. CREATE TABLE IF NOT EXISTS does not
  // repair an existing incompatible table, so we rename it out of the way and
  // create a fresh one.
  try {
    const reg = await withTimeout(
      p.query("SELECT to_regclass('public.caller_profiles') AS reg"),
      2_000
    );
    const exists = Boolean(reg?.rows?.[0]?.reg);
    if (exists) {
      const col = await withTimeout(
        p.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='caller_profiles' AND column_name='caller_id' LIMIT 1"
        ),
        2_000
      );
      const hasCallerId = (col?.rows?.length || 0) > 0;
      if (!hasCallerId) {
        const legacyName = `caller_profiles_legacy_${Date.now()}`;
        await withTimeout(
          p.query(`ALTER TABLE caller_profiles RENAME TO "${legacyName}"`),
          3_000
        );
        logger.warn('Caller memory: renamed legacy caller_profiles table', {
          legacy_table: legacyName,
        });
      }
    }
  } catch (e) {
    // Do not block the call flow if this check fails; schema creation below may
    // still succeed.
    logger.warn('Caller memory schema precheck failed', {
      error: e?.message || String(e),
    });
  }

  // Keep schema minimal, but also support in-place upgrades if an older
  // table exists (Render Postgres persists across deploys).
  const sql = `
    CREATE TABLE IF NOT EXISTS caller_profiles (
      caller_id TEXT PRIMARY KEY,
      display_name TEXT,
      last_seen TIMESTAMPTZ,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE caller_profiles
      ADD COLUMN IF NOT EXISTS display_name TEXT;

    ALTER TABLE caller_profiles
      ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

    ALTER TABLE caller_profiles
      ADD COLUMN IF NOT EXISTS meta JSONB;

    ALTER TABLE caller_profiles
      ALTER COLUMN meta SET DEFAULT '{}'::jsonb;

    ALTER TABLE caller_profiles
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

    ALTER TABLE caller_profiles
      ALTER COLUMN created_at SET DEFAULT NOW();

    ALTER TABLE caller_profiles
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    ALTER TABLE caller_profiles
      ALTER COLUMN updated_at SET DEFAULT NOW();

    CREATE INDEX IF NOT EXISTS caller_profiles_last_seen_idx
      ON caller_profiles(last_seen DESC);
  `;

  await withTimeout(p.query(sql), 3_000);
}

async function getCallerProfile(callerId) {
  const p = getPool();
  if (!p) return null;

  const cid = String(callerId || '').trim();
  if (!cid) return null;

  try {
    const { rows } = await withTimeout(
      p.query(
        `SELECT caller_id, display_name, last_seen, meta
         FROM caller_profiles
         WHERE caller_id = $1
         LIMIT 1`,
        [cid]
      )
    );

    if (!rows || rows.length === 0) return null;
    return rows[0];
  } catch (err) {
    (typeof logger.debug === 'function' ? logger.debug : logger.warn)(
      'Caller memory read failed',
      { error: String(err?.message || err) }
    );
    return null;
  }
}

/**
 * Upsert profile.
 * @param {string} callerId
 * @param {{ display_name?: string|null, meta_patch?: object|null }} patch
 */
async function upsertCallerProfile(callerId, patch = {}) {
  const p = getPool();
  if (!p) return false;

  const cid = String(callerId || '').trim();
  if (!cid) return false;

  const displayName = (patch.display_name ?? null);
  const metaPatch = (patch.meta_patch && typeof patch.meta_patch === 'object') ? patch.meta_patch : null;

  // jsonb merge: meta = meta || metaPatch
  const metaExpr = metaPatch ? 'caller_profiles.meta || $3::jsonb' : 'caller_profiles.meta';
  const params = metaPatch ? [cid, displayName, JSON.stringify(metaPatch)] : [cid, displayName];

  const sql = metaPatch
    ? `
      INSERT INTO caller_profiles (caller_id, display_name, last_seen, meta)
      VALUES ($1, $2, NOW(), $3::jsonb)
      ON CONFLICT (caller_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, caller_profiles.display_name),
        last_seen = NOW(),
        meta = ${metaExpr},
        updated_at = NOW();
    `
    : `
      INSERT INTO caller_profiles (caller_id, display_name, last_seen)
      VALUES ($1, $2, NOW())
      ON CONFLICT (caller_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, caller_profiles.display_name),
        last_seen = NOW(),
        updated_at = NOW();
    `;

  try {
    await withTimeout(p.query(sql, params));
    return true;
  } catch (err) {
    (typeof logger.debug === 'function' ? logger.debug : logger.warn)(
      'Caller memory write failed',
      { error: String(err?.message || err) }
    );
    return false;
  }
}

module.exports = {
  ensureCallerMemorySchema,
  getCallerProfile,
  upsertCallerProfile,
  // exported for diagnostics
  hasDb,
  getPool,
  withTimeout,
};
