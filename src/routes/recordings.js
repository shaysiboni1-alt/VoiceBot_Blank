// src/routes/recordings.js
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { prefetchTwilioRecordingToDisk } = require("../stage4/twilioRecordings");

const recordingsRouter = express.Router();

/**
 * Public proxy for Twilio recording media.
 * Why: Twilio Recording media URLs require basic auth (AccountSid/AuthToken).
 * This endpoint fetches the mp3 from Twilio with auth, and streams it publicly.
 *
 * URL: GET /recordings/:recordingSid.mp3
 */
recordingsRouter.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const recordingSid = String(req.params.recordingSid || "").trim();
  if (!recordingSid) return res.status(400).send("missing recordingSid");

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).send("missing TWILIO creds");
  }

  // First try local disk cache (prefetched at call end).
  try {
    const dir = path.join("/tmp", "recordings");
    const fp = path.join(dir, `${recordingSid}.mp3`);
    if (fs.existsSync(fp)) {
      const stat = fs.statSync(fp);
      const total = stat.size;
      const range = req.headers.range;

      res.setHeader("content-type", "audio/mpeg");
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("accept-ranges", "bytes");

      if (range) {
        const m = String(range).match(/bytes=(\d+)-(\d+)?/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : total - 1;
          const safeStart = Number.isFinite(start) ? Math.max(0, Math.min(start, total - 1)) : 0;
          const safeEnd = Number.isFinite(end) ? Math.max(safeStart, Math.min(end, total - 1)) : total - 1;
          const chunkSize = safeEnd - safeStart + 1;
          res.status(206);
          res.setHeader("content-range", `bytes ${safeStart}-${safeEnd}/${total}`);
          res.setHeader("content-length", String(chunkSize));
          return fs.createReadStream(fp, { start: safeStart, end: safeEnd }).pipe(res);
        }
      }

      res.status(200);
      res.setHeader("content-length", String(total));
      return fs.createReadStream(fp).pipe(res);
    }
  } catch (e) {
    logger.warn("Recording cache check failed", { recordingSid, error: e?.message || String(e) });
  }

  try {
    // If not cached yet, attempt to prefetch now (blocks once, then will be cached for future requests).
    const { ok, filepath, status } = await prefetchTwilioRecordingToDisk(recordingSid, { timeoutMs: 25000, maxWaitMs: 180000 });
    if (!ok || !filepath) {
      logger.warn("Recording prefetch failed", { recordingSid, status });
      return res.status(status === 404 ? 503 : 502).send("recording not ready");
    }

    // After prefetch, serve from disk with Range support (same as cache path).
    const stat = fs.statSync(filepath);
    const total = stat.size;
    const range = req.headers.range;

    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.setHeader("accept-ranges", "bytes");

    if (range) {
      const m = String(range).match(/bytes=(\d+)-(\d+)?/);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : total - 1;
        const safeStart = Number.isFinite(start) ? Math.max(0, Math.min(start, total - 1)) : 0;
        const safeEnd = Number.isFinite(end) ? Math.max(safeStart, Math.min(end, total - 1)) : total - 1;
        const chunkSize = safeEnd - safeStart + 1;
        res.status(206);
        res.setHeader("content-range", `bytes ${safeStart}-${safeEnd}/${total}`);
        res.setHeader("content-length", String(chunkSize));
        return fs.createReadStream(filepath, { start: safeStart, end: safeEnd }).pipe(res);
      }
    }

    res.status(200);
    res.setHeader("content-length", String(total));
    fs.createReadStream(filepath).pipe(res);
  } catch (err) {
    logger.error("Recording proxy error", { recordingSid, error: err?.message || String(err) });
    res.status(500).send("proxy error");
  }
});

// Compatibility alias: /recording/<RecordingSid>
// (GilSport-style payloads often reference this path)
// Compatibility alias: /recordings/<RecordingSid> (no extension)
// Some webhook consumers strip extensions; keep it working.
recordingsRouter.get("/recordings/:recordingSid", (req, res) => {
  const recordingSid = String(req.params.recordingSid || "").trim();
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return res.redirect(302, `/recordings/${encodeURIComponent(recordingSid)}.mp3`);
});

recordingsRouter.get("/recording/:recordingSid", (req, res) => {
  const recordingSid = String(req.params.recordingSid || "").trim();
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return res.redirect(302, `/recordings/${encodeURIComponent(recordingSid)}.mp3`);
});

// Canonical alias: /recording/<RecordingSid>.mp3
recordingsRouter.get("/recording/:recordingSid.mp3", (req, res) => {
  const recordingSid = String(req.params.recordingSid || "").trim();
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  return res.redirect(302, `/recordings/${encodeURIComponent(recordingSid)}.mp3`);
});

module.exports = { recordingsRouter };
