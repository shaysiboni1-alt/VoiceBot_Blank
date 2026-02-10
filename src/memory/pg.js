const { Pool } = require('pg');

let _pool = null;

function hasDb() {
  return !!process.env.DATABASE_URL;
}

function getPool() {
  if (!hasDb()) return null;
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  const forceSsl = (process.env.PGSSL || '').toLowerCase() === 'true';
  const urlWantsSsl = /sslmode=require/i.test(url);

  // Managed Postgres commonly needs SSL. When in doubt, enable it.
  const ssl = (forceSsl || urlWantsSsl)
    ? { rejectUnauthorized: false }
    : undefined;

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
