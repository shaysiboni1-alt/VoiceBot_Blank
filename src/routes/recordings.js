// src/routes/recordings.js
"use strict";

const express = require("express");
const { Readable } = require("stream");
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
 * Notes:
 * - We MUST use timeouts + abort to avoid "infinite loading" (hanging fetch / client).
 * - We support HTTP Range to allow browser audio players to seek / load efficiently.
 * - We stream (pipe) instead of buffering the entire mp3 in memory.
 *
 * Compatibility aliases:
 *   /recording/<RecordingSid>
 *   /recording/<RecordingSid>.mp3
 * We normalize the recording SID defensively.
 */

const FETCH_TIMEOUT_MS = 15000; // hard timeout (ms)
const RES_SOCKET_TIMEOUT_MS = 20000; // hard timeout (ms)

function normalizeRecordingSid(raw) {
  let recordingSid = String(raw || "").trim();
  // tolerate accidental suffixes
  if (recordingSid.toLowerCase().endsWith(".mp3")) {
    recordingSid = recordingSid.slice(0, -4);
  }
  return recordingSid;
}

recordingsRouter.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const recordingSid = normalizeRecordingSid(req.params.recordingSid);
  if (!recordingSid) return res.status(400).send("missing recordingSid");

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).send("missing TWILIO creds");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    accountSid
  )}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;

  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  // Support Range requests (Chrome/Audio players).
  const range = req.headers.range;

  // Ensure we never hang the HTTP response forever.
  res.setTimeout(RES_SOCKET_TIMEOUT_MS);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        authorization: `Basic ${basic}`,
        "user-agent": "voicebot-blank/recording-proxy",
        ...(range ? { range } : {})
      }
    });

    clearTimeout(t);

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.warn("Recording proxy fetch failed", {
        status: r.status,
        recordingSid,
        range: range || null,
        body: body?.slice(0, 240)
      });
      return res.status(502).send("twilio fetch failed");
    }

    // Forward useful headers (do NOT blindly forward all headers).
    // Twilio may return 200 or 206 (Partial Content).
    res.status(r.status);

    const contentType = r.headers.get("content-type") || "audio/mpeg";
    res.setHeader("content-type", contentType);

    const contentLength = r.headers.get("content-length");
    if (contentLength) res.setHeader("content-length", contentLength);

    const acceptRanges = r.headers.get("accept-ranges");
    if (acceptRanges) res.setHeader("accept-ranges", acceptRanges);

    const contentRange = r.headers.get("content-range");
    if (contentRange) res.setHeader("content-range", contentRange);

    // Cache publicly; recordings are immutable by SID.
    res.setHeader("cache-control", "public, max-age=31536000, immutable");

    if (!r.body) {
      logger.warn("Recording proxy: empty body from Twilio", { recordingSid, status: r.status });
      return res.status(502).send("twilio empty body");
    }

    const nodeStream = Readable.fromWeb(r.body);

    // If client closes the connection, abort upstream fetch + stream quickly.
    res.on("close", () => {
      try {
        controller.abort();
      } catch (_) {}
      try {
        nodeStream.destroy();
      } catch (_) {}
    });

    nodeStream.on("error", (err) => {
      logger.error("Recording proxy stream error", {
        recordingSid,
        error: err?.message || String(err)
      });
      if (!res.headersSent) res.status(500);
      try {
        res.end();
      } catch (_) {}
    });

    // Pipe to client
    nodeStream.pipe(res);
  } catch (err) {
    clearTimeout(t);
    const isAbort = err?.name === "AbortError";
    logger.error("Recording proxy error", {
      recordingSid,
      aborted: isAbort,
      error: err?.message || String(err)
    });
    res.status(isAbort ? 504 : 500).send(isAbort ? "proxy timeout" : "proxy error");
  }
});

// Compatibility aliases:
// 1) /recording/<RecordingSid>
// 2) /recording/<RecordingSid>.mp3
function redirectToCanonicalRecording(req, res) {
  const recordingSid = normalizeRecordingSid(req.params.recordingSid);
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return res.redirect(302, `/recordings/${encodeURIComponent(recordingSid)}.mp3`);
}

recordingsRouter.get("/recording/:recordingSid", redirectToCanonicalRecording);
recordingsRouter.get("/recording/:recordingSid.mp3", redirectToCanonicalRecording);

module.exports = { recordingsRouter };
