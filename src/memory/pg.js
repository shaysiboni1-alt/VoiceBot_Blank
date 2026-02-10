"use strict";

const { Pool } = require("pg");

// Create a singleton Pool.
// Notes:
// - Render Postgres commonly requires TLS; we default to ssl={rejectUnauthorized:false}
//   unless explicitly disabled via PGSSL_DISABLE=true.
// - We accept DATABASE_URL (preferred) and DATABASE as a fallback.

let pool = null;

function parseBool(v) {
  if (v == null) return false;
  return String(v).toLowerCase() === "true" || String(v) === "1";
}

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.DATABASE || null;
}

function shouldUseSSL(connStr) {
  if (parseBool(process.env.PGSSL_DISABLE)) return false;
  // If URL explicitly requests sslmode, respect it.
  if (connStr && /sslmode=require/i.test(connStr)) return true;
  // Default to true to work on hosted Postgres providers.
  return true;
}

function getPool() {
  if (pool) return pool;

  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL (or DATABASE) env var for Postgres memory store");
  }

  const ssl = shouldUseSSL(connectionString) ? { rejectUnauthorized: false } : undefined;

  pool = new Pool({
    connectionString,
    ssl,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 10_000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 5_000),
  });

  pool.on("error", (err) => {
    // Avoid crashing the process, but surface the issue in logs upstream.
    // This event fires for idle clients errors.
    // We keep it quiet here; callers should log failures per operation.
  });

  return pool;
}

module.exports = { getPool };
