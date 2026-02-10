const { Pool } = require('pg');

let _pool;

function parseBoolEnv(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function shouldForceSslByHeuristic(connectionString) {
  try {
    const u = new URL(connectionString);
    const host = (u.hostname || '').toLowerCase();
    // Render Postgres hostnames commonly start with dpg-...
    if (host.startsWith('dpg-')) return true;
    // Some managed providers
    if (host.endsWith('.render.com')) return true;
    if (host.endsWith('.neon.tech')) return true;
    if (host.endsWith('.supabase.co')) return true;
    return false;
  } catch {
    return false;
  }
}

function buildSslOption(connectionString) {
  const envOverride = parseBoolEnv(process.env.PGSSL);
  if (envOverride === false) return undefined;
  if (envOverride === true) return { rejectUnauthorized: false };

  // If the URL explicitly demands sslmode=require, honor it.
  const urlWantsSsl = /sslmode=require/i.test(connectionString || '');
  if (urlWantsSsl) return { rejectUnauthorized: false };

  // Otherwise, use a heuristic for managed DBs.
  if (connectionString && shouldForceSslByHeuristic(connectionString)) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

function getPool() {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL || process.env.DATABASE;
  if (!connectionString) {
    throw new Error('DATABASE_URL (or DATABASE) env var is missing');
  }

  const ssl = buildSslOption(connectionString);

  _pool = new Pool({
    connectionString,
    ssl,
    // Keep these conservative; caller memory must never block call flow.
    max: Number(process.env.PGPOOL_MAX || 3),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 4_000),
  });

  return _pool;
}

module.exports = { getPool };
