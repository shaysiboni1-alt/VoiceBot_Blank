// src/routes/recordings.js
"use strict";

const express = require("express");
// NOTE: We intentionally avoid stream-proxying (Readable/PassThrough) here.
const fs = require("fs");
const path = require("path");
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
 * - We support HTTP Range for cached files (browser audio players / seeking).
 * - We cache to local disk (/tmp) so subsequent loads are instant.
 *
 * Compatibility aliases:
 *   /recording/<RecordingSid>
 *   /recording/<RecordingSid>.mp3
 * We normalize the recording SID defensively.
 */

const FETCH_TIMEOUT_MS = 15000; // hard timeout (ms)
const RES_SOCKET_TIMEOUT_MS = 20000; // hard timeout (ms)

const CACHE_DIR = process.env.RECORDINGS_CACHE_DIR || "/tmp/recordings";

function ensureCacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (_) {
    // best-effort
  }
}

function cachePathForSid(recordingSid) {
  return path.join(CACHE_DIR, `${recordingSid}.mp3`);
}

function normalizeRecordingSid(raw) {
  let recordingSid = String(raw || "").trim();
  // tolerate accidental suffixes
  if (recordingSid.toLowerCase().endsWith(".mp3")) {
    recordingSid = recordingSid.slice(0, -4);
  }
  return recordingSid;
}

function parseRangeHeader(rangeHeader, totalSize) {
  // Supports only single range: bytes=start-end
  // Returns { start, end } (inclusive) or null
  if (!rangeHeader) return null;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : totalSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= totalSize) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

async function serveCachedFile(req, res, recordingSid) {
  const p = cachePathForSid(recordingSid);
  let st;
  try {
    st = fs.statSync(p);
  } catch (_) {
    return false;
  }
  if (!st.isFile() || st.size <= 0) return false;

  const totalSize = st.size;
  const range = req.headers.range;
  const parsed = parseRangeHeader(range, totalSize);

  res.setHeader("content-type", "audio/mpeg");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("cache-control", "public, max-age=31536000, immutable");

  if (parsed) {
    const { start, end } = parsed;
    res.status(206);
    res.setHeader("content-range", `bytes ${start}-${end}/${totalSize}`);
    res.setHeader("content-length", String(end - start + 1));
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.status(200);
    res.setHeader("content-length", String(totalSize));
    fs.createReadStream(p).pipe(res);
  }

  logger.info("Recording served from cache", {
    recordingSid,
    bytes: totalSize,
    range: range || null
  });

  return true;
}

recordingsRouter.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const recordingSid = normalizeRecordingSid(req.params.recordingSid);
  if (!recordingSid) return res.status(400).send("missing recordingSid");

  // Access logs appear only when request finishes; log immediately.
  logger.info("Recording proxy request", {
    recordingSid,
    range: req.headers.range || null,
    ua: req.headers["user-agent"] || null
  });

  // Ensure we never hang the HTTP response forever.
  res.setTimeout(RES_SOCKET_TIMEOUT_MS);

  // Fast path: serve from local cache if present.
  ensureCacheDir();
  if (await serveCachedFile(req, res, recordingSid)) return;

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).send("missing TWILIO creds");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    accountSid
  )}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;

  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  // On cache miss we intentionally fetch the FULL mp3 (no Range) to populate cache.
  // IMPORTANT: We fetch the whole body into a Buffer (like GilSport) because
  // some environments show "infinite loading" when proxy-streaming web streams.
  const clientRange = req.headers.range;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // Prepare cache write (atomic: write to tmp, then rename)
  const finalPath = cachePathForSid(recordingSid);
  const tmpPath = `${finalPath}.part-${Date.now()}`;

  try {
    const r = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        authorization: `Basic ${basic}`,
        "user-agent": "voicebot-blank/recording-proxy"
        // no Range here on purpose
      }
    });

    clearTimeout(t);

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.warn("Recording proxy fetch failed", {
        status: r.status,
        recordingSid,
        range: clientRange || null,
        body: body?.slice(0, 240)
      });
      return res.status(502).send("twilio fetch failed");
    }

    // Read full body.
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf || buf.length === 0) {
      logger.warn("Recording proxy: empty body from Twilio", {
        recordingSid,
        status: r.status
      });
      return res.status(502).send("twilio empty body");
    }

    // Write cache (best-effort)
    try {
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, finalPath);
      logger.info("Recording cached", { recordingSid, path: finalPath, bytes: buf.length });
    } catch (e) {
      logger.warn("Recording cache write failed", {
        recordingSid,
        error: e?.message || String(e)
      });
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }

    // Serve to client (always completes, with explicit length)
    const contentType = r.headers.get("content-type") || "audio/mpeg";
    res.status(200);
    res.setHeader("content-type", contentType);
    res.setHeader("content-length", String(buf.length));
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");

    // If client requested a Range but we fetched full body, honor it here.
    const totalSize = buf.length;
    const parsed = parseRangeHeader(clientRange, totalSize);
    if (parsed) {
      const { start, end } = parsed;
      res.status(206);
      res.setHeader("content-range", `bytes ${start}-${end}/${totalSize}`);
      res.setHeader("content-length", String(end - start + 1));
      return res.end(buf.slice(start, end + 1));
    }

    return res.end(buf);
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
