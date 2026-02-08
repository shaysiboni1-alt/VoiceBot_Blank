const express = require("express");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

// Public (no-auth) endpoint for playing a Twilio Recording via our server.
// We authenticate to Twilio using TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN and proxy the media.
// Notes:
// - Twilio often responds with a 302 redirect to a CDN URL. In that case we do a 2-step fetch:
//   (1) authenticated request to Twilio to get the redirect URL
//   (2) unauthenticated request to the redirect URL (usually a signed CDN URL) and stream it.

const recordingsRouter = express.Router();

function sanitizeRecordingSid(raw) {
  let sid = String(raw || "").trim();
  // tolerate accidental suffixes
  sid = sid.replace(/\.mp3$/i, "").replace(/\.wav$/i, "");
  return sid;
}

function buildTwilioMediaUrl(recordingSid, format) {
  const ext = format === "wav" ? "wav" : "mp3";
  return `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.${ext}`;
}

function basicAuthHeader() {
  const sid = String(env.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(env.TWILIO_AUTH_TOKEN || "").trim();
  const b64 = Buffer.from(`${sid}:${token}`).toString("base64");
  return `Basic ${b64}`;
}

async function proxyRecording(req, res, { recordingSid, format }) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return res.status(500).send("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing");
  }

  const twilioUrl = buildTwilioMediaUrl(recordingSid, format);

  try {
    // Step 1: ask Twilio for the media URL (may return 200 stream, or 302 redirect)
    const r1 = await fetch(twilioUrl, {
      method: "GET",
      headers: { Authorization: basicAuthHeader() },
      redirect: "manual",
    });

    let streamResponse = r1;
    const isRedirect = [301, 302, 303, 307, 308].includes(r1.status);

    if (isRedirect) {
      const loc = r1.headers.get("location");
      if (!loc) {
        logger.warn("Twilio recording redirect without Location", { recordingSid, status: r1.status });
        return res.status(502).send("Twilio redirect missing location");
      }
      // Step 2: fetch the signed CDN URL (typically no-auth)
      streamResponse = await fetch(loc, { method: "GET" });
    }

    if (!streamResponse.ok || !streamResponse.body) {
      const text = await streamResponse.text().catch(() => "");
      logger.warn("Twilio recording fetch failed", {
        recordingSid,
        status: streamResponse.status,
        statusText: streamResponse.statusText,
        preview: text ? text.slice(0, 160) : undefined,
      });
      return res.status(502).send("Failed to fetch recording from Twilio");
    }

    // Headers
    res.setHeader("Content-Type", format === "wav" ? "audio/wav" : "audio/mpeg");
    res.setHeader("Content-Disposition", `inline; filename=\"${recordingSid}.${format === "wav" ? "wav" : "mp3"}\"`);
    res.setHeader("Cache-Control", "public, max-age=3600");

    // Stream to client
    const { Readable } = require("stream");
    Readable.fromWeb(streamResponse.body).pipe(res);
  } catch (err) {
    logger.error("Error proxying Twilio recording", { recordingSid, err: String(err?.message || err) });
    return res.status(502).send("Error proxying recording");
  }
}

// Canonical endpoints
recordingsRouter.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const recordingSid = sanitizeRecordingSid(req.params.recordingSid);
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return proxyRecording(req, res, { recordingSid, format: "mp3" });
});

recordingsRouter.get("/recordings/:recordingSid.wav", async (req, res) => {
  const recordingSid = sanitizeRecordingSid(req.params.recordingSid);
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return proxyRecording(req, res, { recordingSid, format: "wav" });
});

// Backward/forward compatible aliases (NO redirects; some in-app browsers don't follow 302 for media)
recordingsRouter.get("/recording/:recordingSid.mp3", async (req, res) => {
  const recordingSid = sanitizeRecordingSid(req.params.recordingSid);
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return proxyRecording(req, res, { recordingSid, format: "mp3" });
});

recordingsRouter.get("/recording/:recordingSid.wav", async (req, res) => {
  const recordingSid = sanitizeRecordingSid(req.params.recordingSid);
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return proxyRecording(req, res, { recordingSid, format: "wav" });
});

module.exports = { recordingsRouter };
