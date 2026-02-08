// src/routes/recordings.js
"use strict";

const express = require("express");
const { logger } = require("../utils/logger");
const { proxyRecordingMp3 } = require("../utils/twilioRecordings");

const recordingsRouter = express.Router();

function normalizeSid(raw) {
  let sid = String(raw || "").trim();
  if (!sid) return "";
  // tolerate ".mp3" or ".mp3.mp3"
  while (sid.toLowerCase().endsWith(".mp3")) sid = sid.slice(0, -4);
  return sid.trim();
}

async function handleProxy(req, res) {
  const sid = normalizeSid(req.params.recordingSid || req.params.sid);
  if (!sid) return res.status(400).send("missing_recordingSid");

  try {
    // streaming proxy (no buffering)
    await proxyRecordingMp3(sid, res, logger);
  } catch (e) {
    logger.warn("recording proxy handler failed", { sid, err: String(e) });
    if (!res.headersSent) res.status(500).send("proxy_error");
  }
}

// Canonical per spec (what you want to send to CRM)
recordingsRouter.get("/recording/:sid.mp3", handleProxy);
recordingsRouter.get("/recording/:sid", (req, res) => {
  const sid = normalizeSid(req.params.sid);
  if (!sid) return res.status(400).send("missing_recordingSid");
  return res.redirect(302, `/recording/${encodeURIComponent(sid)}.mp3`);
});

// Compatibility with your current shared links
recordingsRouter.get("/recordings/:recordingSid.mp3", handleProxy);
recordingsRouter.get("/recordings/:recordingSid", (req, res) => {
  const sid = normalizeSid(req.params.recordingSid);
  if (!sid) return res.status(400).send("missing_recordingSid");
  return res.redirect(302, `/recording/${encodeURIComponent(sid)}.mp3`);
});

module.exports = { recordingsRouter };
