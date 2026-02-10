// Caller memory is OPTIONAL. We load the DB helper defensively so the service
// never breaks if the DB helper is missing or exported in an unexpected shape.
const pgMod = require('./pg');

// Support both shapes:
// 1) module.exports = { getPool, hasDb, withTimeout }
// 2) module.exports = getPool (or any other function/object)
// In all cases, we expose safe fallbacks.
// If the helper isn't present, we treat DB as unavailable (even if DATABASE_URL exists),
// because we can't safely operate without a pool.
const _hasPoolHelper = typeof pgMod.getPool === 'function';
const getPool = _hasPoolHelper ? pgMod.getPool : (() => null);

// withTimeout helper signature in this repo is: withTimeout(label, ms, fn)
const withTimeout = (typeof pgMod.withTimeout === 'function')
  ? pgMod.withTimeout
  : async (_label, _ms, fn) => fn();

const hasDb = (typeof pgMod.hasDb === 'function')
  ? pgMod.hasDb
  : () => (_hasPoolHelper && Boolean(process.env.DATABASE_URL));

// Lightweight caller "memory" to support caller recognition.
// No new ENV flags: if DATABASE_URL is present, memory is enabled.

async function ensureSchema() {
  if (!hasDb()) return;
  const pool = getPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caller_memory (
      caller_e164 TEXT PRIMARY KEY,
      last_full_name TEXT NULL,
      last_subject TEXT NULL,
      last_notes TEXT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getCallerMemory(callerE164) {
  if (!hasDb() || !callerE164) return null;
  const pool = getPool();
  if (!pool) return null;
  const res = await pool.query(
    `SELECT caller_e164, last_full_name, last_subject, last_notes, last_seen_at
     FROM caller_memory
     WHERE caller_e164 = $1
     LIMIT 1`,
    [callerE164]
  );
  return res.rows[0] || null;
}

async function upsertCallerMemory({ callerE164, fullName, subject, notes }) {
  if (!hasDb() || !callerE164) return;
  const pool = getPool();
  if (!pool) return;

  // We only overwrite fields when we actually have data.
  await pool.query(
    `INSERT INTO caller_memory (caller_e164, last_full_name, last_subject, last_notes, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (caller_e164)
     DO UPDATE SET
       last_full_name = COALESCE(EXCLUDED.last_full_name, caller_memory.last_full_name),
       last_subject = COALESCE(EXCLUDED.last_subject, caller_memory.last_subject),
       last_notes = COALESCE(EXCLUDED.last_notes, caller_memory.last_notes),
       last_seen_at = NOW()`,
    [callerE164, fullName || null, subject || null, notes || null]
  );
}

async function getCallerMemoryFast(callerE164, timeoutMs = 150) {
  if (!hasDb() || !callerE164) return null;
  try {
    // withTimeout signature: (label, ms, fn)
    return await withTimeout('caller_memory_timeout', timeoutMs, () => getCallerMemory(callerE164));
  } catch {
    return null;
  }
}

module.exports = {
  ensureSchema,
  getCallerMemory,
  getCallerMemoryFast,
  upsertCallerMemory,
  // Backwards-compatible aliases (older call sites)
  getCallerProfile: getCallerMemory,
  upsertCallerProfile: upsertCallerMemory,
};
