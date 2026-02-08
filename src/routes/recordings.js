// src/routes/recordings.js
const express = require("express");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

const recordingsRouter = express.Router();

function normalizeRecordingSid(input) {
  let sid = String(input || "").trim();
  if (!sid) return sid;
  // If someone passed RE...mp3 as part of the SID, strip extensions safely.
  if (sid.toLowerCase().endsWith(".mp3")) sid = sid.slice(0, -4);
  return sid;
}

/**
 * Proxy Twilio recording as public MP3.
 * URL: GET /recordings/:recordingSid.mp3
 */
recordingsRouter.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const raw = String(req.params.recordingSid || "").trim();
  const recordingSid = normalizeRecordingSid(raw);

  if (!recordingSid || !recordingSid.startsWith("RE")) {
    return res.status(400).send("Bad recording SID");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;

  try {
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");

    const r = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        "User-Agent": "VoiceBot_Blank/recording-proxy",
      },
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.warn("Twilio recording fetch failed", {
        status: r.status,
        recordingSid,
        body_snippet: body.slice(0, 300),
      });
      return res.status(404).send("Recording not found");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");

    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).end(buf);
  } catch (e) {
    logger.error("Recording proxy error", { recordingSid, err: String(e?.message || e) });
    return res.status(500).send("Error fetching recording");
  }
});

/**
 * Compatibility redirect:
 * - /recording/:recordingSid
 * - /recording/:recordingSid.mp3   (this is what you were testing)
 */
recordingsRouter.get("/recording/:recordingSid", (req, res) => {
  const raw = String(req.params.recordingSid || "").trim();
  const recordingSid = normalizeRecordingSid(raw);
  return res.redirect(302, `/recordings/${recordingSid}.mp3`);
});

recordingsRouter.get("/recording/:recordingSid.mp3", (req, res) => {
  const raw = String(req.params.recordingSid || "").trim();
  const recordingSid = normalizeRecordingSid(raw);
  return res.redirect(302, `/recordings/${recordingSid}.mp3`);
});

module.exports = { recordingsRouter };
