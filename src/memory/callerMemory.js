"use strict";

const { getPool } = require("./pg");
const { logger } = require("../utils/logger");

// Simple caller memory store in Postgres.
// Table: caller_profiles(caller TEXT PRIMARY KEY, profile_json JSONB, updated_at TIMESTAMPTZ)

let _initPromise = null;

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caller_profiles (
      caller TEXT PRIMARY KEY,
      profile_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureInitialized() {
  if (_initPromise) return _initPromise;

  const pool = getPool();
  _initPromise = ensureSchema(pool).catch((err) => {
    // Reset so we can retry later if transient.
    _initPromise = null;
    throw err;
  });

  return _initPromise;
}

async function getCallerProfile(caller) {
  if (!caller) return null;

  try {
    await ensureInitialized();
    const pool = getPool();
    const res = await pool.query(
      "SELECT profile_json FROM caller_profiles WHERE caller=$1",
      [caller]
    );
    return res.rows?.[0]?.profile_json ?? null;
  } catch (err) {
    logger.debug("Caller memory get failed", {
      caller,
      err: String(err?.message || err),
    });
    return null;
  }
}

async function upsertCallerProfile(caller, profile) {
  if (!caller || !profile) return false;

  try {
    await ensureInitialized();
    const pool = getPool();
    await pool.query(
      `
      INSERT INTO caller_profiles (caller, profile_json, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (caller) DO UPDATE
        SET profile_json = EXCLUDED.profile_json,
            updated_at = NOW()
      `,
      [caller, profile]
    );
    return true;
  } catch (err) {
    logger.debug("Caller memory upsert failed", {
      caller,
      err: String(err?.message || err),
    });
    return false;
  }
}

module.exports = {
  getCallerProfile,
  upsertCallerProfile,
};
