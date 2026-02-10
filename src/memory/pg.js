const { Pool } = require('pg');

let _pool = null;

function hasDb() {
  return !!process.env.DATABASE_URL;
}

function shouldEnableSsl(connectionString) {
  const forceSsl = (process.env.PGSSL || '').toLowerCase() === 'true';
  const urlWantsSsl = /sslmode=require/i.test(connectionString);

  // Render Postgres hostnames usually start with "dpg-" and require SSL when accessed externally.
  const looksLikeRenderPostgres = /\/\/[^@]+@dpg-[^/]+/i.test(connectionString);

  // Render sets environment variables like RENDER and RENDER_SERVICE_ID.
  const isRenderRuntime = !!process.env.RENDER || !!process.env.RENDER_SERVICE_ID || !!process.env.RENDER_INSTANCE_ID;

  return forceSsl || urlWantsSsl || looksLikeRenderPostgres || isRenderRuntime;
}

function getPool() {
  if (!hasDb()) return null;
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  const sslEnabled = shouldEnableSsl(url);

  const ssl = sslEnabled ? { rejectUnauthorized: false } : undefined;

  _pool = new Pool({
    connectionString: url,
    ssl,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  return _pool;
}

async function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  hasDb,
  getPool,
  withTimeout,
};
