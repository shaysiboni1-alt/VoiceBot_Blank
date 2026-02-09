// src/routes/recordings.js
"use strict";

const express = require("express");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

const recordingsRouter = express.Router();

/**
 * Public proxy for Twilio recording media.
 * Why: Twilio Recording media URLs require basic auth (AccountSid/AuthToken).
 * This endpoint fetches the mp3 from Twilio with auth, and streams it publicly.
 *
 * URL: GET /recordings/:recordingSid.mp3
 *
 * NOTE (robustness): some clients (and older webhook payloads) mistakenly call
 *   /recording/<RecordingSid>.mp3
 *   /recordings/<RecordingSid>.mp3.mp3
 * We normalize the recording SID defensively.
 */
recordingsRouter.get("/recordings/:recordingSid.mp3", async (req, res) => {
  let recordingSid = String(req.params.recordingSid || "").trim();
  // tolerate accidental suffixes
  if (recordingSid.toLowerCase().endsWith(".mp3")) {
    recordingSid = recordingSid.slice(0, -4);
  }
  if (!recordingSid) return res.status(400).send("missing recordingSid");

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).send("missing TWILIO creds");
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      accountSid
    )}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;

    const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    // Twilio can return 404 while the recording is still being processed.
    // We do a short, bounded retry here so most users will get audio when they click.
    // IMPORTANT: this does not affect call flow or webhooks; it only affects the public proxy endpoint.
    const MAX_TRIES = 6;          // ~15s total with backoff below
    const BASE_DELAY_MS = 1500;

    let lastStatus = 0;
    let lastBody = "";
    let r;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      r = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Basic ${basic}`,
          "user-agent": "voicebot-blank/recording-proxy",
          accept: "audio/mpeg"
        }
      });

      if (r.ok) break;

      lastStatus = r.status;
      lastBody = await r.text().catch(() => "");

      // Only retry on "not ready" signals (404 is the typical one for Twilio media).
      if (r.status !== 404) break;

      // Backoff: 1.5s, 3s, 4.5s...
      const delay = BASE_DELAY_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (!r || !r.ok) {
      logger.warn("Recording proxy fetch failed", {
        status: lastStatus || r?.status,
        recordingSid,
        body: (lastBody || "")?.slice(0, 240)
      });

      // Preserve useful status codes:
      // - 404: Twilio says the media isn't available (yet) OR the recording is not under this account.
      // - 401/403: credentials mismatch.
      // Everything else: 502.
      const status = r?.status || lastStatus || 502;
      if (status === 404) return res.status(404).send("recording_not_ready_or_not_found");
      if (status === 401 || status === 403) return res.status(502).send("twilio_auth_failed");
      return res.status(502).send("twilio_fetch_failed");
    }

    res.status(200);
    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");

    // Stream through
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (err) {
    logger.error("Recording proxy error", { recordingSid, error: err?.message || String(err) });
    res.status(500).send("proxy error");
  }
});

// Compatibility aliases:
// 1) /recording/<RecordingSid>
// 2) /recording/<RecordingSid>.mp3
// (Older payloads and some users paste links in this form)
function redirectToCanonicalRecording(req, res) {
  let recordingSid = String(req.params.recordingSid || "").trim();
  if (recordingSid.toLowerCase().endsWith(".mp3")) {
    recordingSid = recordingSid.slice(0, -4);
  }
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return res.redirect(302, `/recordings/${encodeURIComponent(recordingSid)}.mp3`);
}

recordingsRouter.get("/recording/:recordingSid", redirectToCanonicalRecording);
recordingsRouter.get("/recording/:recordingSid.mp3", redirectToCanonicalRecording);

module.exports = { recordingsRouter };
