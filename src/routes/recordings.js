// src/routes/recordings.js
"use strict";

const express = require("express");
const { logger } = require("../utils/logger");
const { proxyRecordingMp3 } = require("../utils/twilioRecordings");

const recordingsRouter = express.Router();

/**
 * Public proxy for Twilio recording media (NO Twilio URL exposure / NO Auth exposure).
 *
 * Canonical:
 *   GET /recording/:sid.mp3
 *
 * Compatibility:
 *   GET /recordings/:sid.mp3
 *   GET /recording/:sid
 *   GET /recordings/:sid
 *
 * We normalize common mistakes:
 *   - sid ends with ".mp3"
 *   - sid ends with ".mp3.mp3"
 */
function normalizeRecordingSid(raw) {
  let sid = String(raw || "").trim();
  if (!sid) return "";

  // tolerate suffixes
  while (sid.toLowerCase().endsWith(".mp3")) {
    sid = sid.slice(0, -4);
  }

  return sid.trim();
}

async function handleProxy(req, res) {
  const sid = normalizeRecordingSid(req.params.sid || req.params.recordingSid);
  if (!sid) return res.status(400).send("missing_recordingSid");

  try {
    // Streams bytes directly; does not buffer in memory.
    await proxyRecordingMp3(sid, res, logger);
  } catch (e) {
    logger.warn("recording proxy handler failed", { sid, err: String(e) });
    if (!res.headersSent) res.status(500).send("proxy_error");
  }
}

// Canonical
recordingsRouter.get("/recording/:sid.mp3", handleProxy);

// Compatibility (your pasted link format)
recordingsRouter.get("/recordings/:sid.mp3", handleProxy);

// Extra compatibility (people paste without .mp3)
recordingsRouter.get("/recording/:sid", (req, res) => {
  const sid = normalizeRecordingSid(req.params.sid);
  if (!sid) return res.status(400).send("missing_recordingSid");
  return res.redirect(302, `/recording/${encodeURIComponent(sid)}.mp3`);
});

recordingsRouter.get("/recordings/:sid", (req, res) => {
  const sid = normalizeRecordingSid(req.params.sid);
  if (!sid) return res.status(400).send("missing_recordingSid");
  return res.redirect(302, `/recording/${encodeURIComponent(sid)}.mp3`);
});

module.exports = { recordingsRouter };
