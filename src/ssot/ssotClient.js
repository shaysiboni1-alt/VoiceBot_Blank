"use strict";

const { google } = require("googleapis");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

let _cache = null; // { loaded_at, settings, prompts, intents, ... }
let _loadedAtMs = 0;

function nowMs() {
  return Date.now();
}

function decodeServiceAccountJson() {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON_B64) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_B64 is empty");
  }
  const raw = Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON_B64 JSON");
  }
  return parsed;
}

async function getSheetsClient() {
  const sa = decodeServiceAccountJson();

  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });

  await jwt.authorize();

  return google.sheets({ version: "v4", auth: jwt });
}

// Reads a 2-col sheet: key/value
function parseKeyValue(rows) {
  const out = {};
  if (!rows || rows.length < 2) return out;

  // assume header row: key,value
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const k = (r[0] || "").toString().trim();
    const v = (r[1] || "").toString();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

// PROMPTS: PromptId/Content
function parsePrompts(rows) {
  const out = {};
  if (!rows || rows.length < 2) return out;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const id = (r[0] || "").toString().trim();
    const content = (r[1] || "").toString();
    if (!id) continue;
    out[id] = content;
  }
  return out;
}

// INTENTS: intent_id, intent_type, priority, triggers_*
function parseIntents(rows) {
  const intents = [];
  if (!rows || rows.length < 2) return intents;

  // header row
  const header = (rows[0] || []).map((h) => (h || "").toString().trim());
  const idx = (name) => header.indexOf(name);

  const i_intent_id = idx("intent_id");
  const i_intent_type = idx("intent_type");
  const i_priority = idx("priority");
  const i_triggers_he = idx("triggers_he");
  const i_triggers_en = idx("triggers_en");
  const i_triggers_ru = idx("triggers_ru");

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const intent_id = (r[i_intent_id] || "").toString().trim();
    if (!intent_id) continue;

    const intent = {
      intent_id,
      intent_type: (r[i_intent_type] || "").toString().trim(),
      priority: (r[i_priority] || "").toString().trim(),
      triggers_he: (r[i_triggers_he] || "").toString(),
      triggers_en: (r[i_triggers_en] || "").toString(),
      triggers_ru: (r[i_triggers_ru] || "").toString()
    };
    intents.push(intent);
  }

  return intents;
}

async function loadSSOT(force) {
  if (!env.GSHEET_ID) {
    throw new Error("GSHEET_ID is empty");
  }

  if (!force && _cache && nowMs() - _loadedAtMs < env.SSOT_TTL_MS) {
    return _cache;
  }

  const sheets = await getSheetsClient();

  // Using the tab names you showed:
  const ranges = [
    "SETTINGS!A:B",
    "PROMPTS!A:B",
    "INTENTS!A:F"
  ];

  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: env.GSHEET_ID,
    ranges
  });

  const valueRanges = resp.data.valueRanges || [];

  const settingsRows = valueRanges[0]?.values || [];
  const promptsRows = valueRanges[1]?.values || [];
  const intentsRows = valueRanges[2]?.values || [];

  const settings = parseKeyValue(settingsRows);
  const prompts = parsePrompts(promptsRows);
  const intents = parseIntents(intentsRows);

  const snap = {
    loaded_at: new Date().toISOString(),
    settings,
    prompts,
    intents,
    settings_keys: Object.keys(settings).length,
    prompt_ids: Object.keys(prompts),
    intents_count: intents.length
  };

  _cache = snap;
  _loadedAtMs = nowMs();

  logger.info("SSOT loaded", {
    settings_keys: snap.settings_keys,
    prompts_keys: snap.prompt_ids.length,
    intents: snap.intents_count
  });

  return snap;
}

function getSSOTSnapshot() {
  return _cache;
}

module.exports = { loadSSOT, getSSOTSnapshot };
