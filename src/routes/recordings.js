const express = require("express");
const path = require("path");
const fs = require("fs");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

const router = express.Router();

function recordingsDir() {
  return env.RECORDINGS_DIR || "/tmp/recordings";
}

function twilioAuthHeader() {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  const b64 = Buffer.from(`${sid}:${token}`).toString("base64");
  return `Basic ${b64}`;
}

async function streamFromTwilio(recordingSid, res, { alsoCacheTo } = {}) {
  const auth = twilioAuthHeader();
  if (!auth) {
    res.status(500).send("Missing TWILIO credentials");
    return;
  }

  // Twilio provides the recording media as mp3 via `.mp3` suffix on the Recording resource URL.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;

  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    res.status(r.status).send(body || `Twilio fetch failed: ${r.status}`);
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  // allow streaming/preview in browsers
  res.setHeader("Content-Disposition", `inline; filename="${recordingSid}.mp3"`);

  // Optional cache-to-disk (best-effort)
  let outStream = null;
  if (alsoCacheTo) {
    try {
      fs.mkdirSync(path.dirname(alsoCacheTo), { recursive: true });
      outStream = fs.createWriteStream(alsoCacheTo);
    } catch (e) {
      logger.warn?.("Recording cache create failed", { error: e?.message || String(e) });
      outStream = null;
    }
  }

  const reader = r.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        if (outStream) outStream.write(Buffer.from(value));
      }
    }
  } finally {
    if (outStream) outStream.end();
    res.end();
  }
}

router.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const { recordingSid } = req.params;
  if (!recordingSid) return res.status(400).send("missing recordingSid");

  const filePath = path.join(recordingsDir(), `${recordingSid}.mp3`);
  try {
    if (fs.existsSync(filePath)) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `inline; filename="${recordingSid}.mp3"`);
      return res.sendFile(filePath);
    }
  } catch (e) {
    logger.warn?.("Recording local read failed", { recordingSid, error: e?.message || String(e) });
  }

  // Fallback: proxy from Twilio on-demand (GilSport parity).
  try {
    return await streamFromTwilio(recordingSid, res, { alsoCacheTo: filePath });
  } catch (e) {
    logger.error?.("Recording proxy failed", { recordingSid, error: e?.message || String(e) });
    return res.status(500).send("recording proxy failed");
  }
});

module.exports = router;
