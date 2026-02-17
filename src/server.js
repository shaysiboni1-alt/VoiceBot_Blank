// src/server.js
"use strict";

const express = require("express");
const https = require("https");
const { Readable } = require("stream");

const { env } = require("./config/env");
const { logger } = require("./utils/logger");

const { healthRouter } = require("./routes/health");
const { adminReloadRouter } = require("./routes/adminReloadSheets");
const { twilioStatusRouter } = require("./routes/twilioStatus");

const { loadSSOT } = require("./ssot/ssotClient");
const { installTwilioMediaWs } = require("./ws/twilioMediaWs");

// Optional Postgres (caller memory). Enabled automatically when DATABASE_URL is present.
const { ensureCallerMemorySchema } = require("./memory/callerMemory");

// Lead/Recording support (does not affect audio pipeline)
const recordingRegistry = require("./utils/recordingRegistry");
const recordingCache = require("./utils/recordingCache");
const { recordingPath, hasCached, getRecordingStatus, downloadToFile } = recordingCache;
const { setRecordingForCall } = recordingRegistry;

/**
 * Public Recording Proxy (SERVER-LAYER ONLY)
 * -----------------------------------------
 * Serves public URLs like:
 *   GET /recording/:recordingSid.mp3
 *   GET /recordings/:recordingSid.mp3   (alias)
 *
 * Implementation is intentionally "GilSport-style":
 * - No axios dependency (Render deploy stability)
 * - Uses Twilio Basic Auth server-side (browser gets a public URL)
 * - Supports Range requests (Chrome/WhatsApp etc)
 * - No extra router files; everything lives in server.js as requested.
 */

function getTwilioBasicAuthHeader() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!sid || !token) return null;
  const b64 = Buffer.from(`${sid}:${token}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function twilioRecordingMp3Url(recordingSid) {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  // This endpoint streams the media. We use .mp3 explicitly.
  // Works when the Recording was created by Twilio recording (default wav -> mp3 conversion served by API).
  return `https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${recordingSid}.mp3`;
}

function sendMp3File(req, res, filePath) {
  // Supports Range requests (browser audio player).
  const fs = require("fs");
  const stat = fs.statSync(filePath);
  const total = stat.size;

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", total);
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.end());
    return stream.pipe(res);
  }

  const m = /^bytes=(\d+)-(\d+)?$/.exec(String(range));
  if (!m) {
    res.status(416).setHeader("Content-Range", `bytes */${total}`);
    return res.end();
  }

  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : total - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.status(416).setHeader("Content-Range", `bytes */${total}`);
    return res.end();
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", chunkSize);
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => res.end());
  return stream.pipe(res);
}

async function proxyTwilioMp3(recordingSid, req, res) {
  // Public proxy: return Twilio recording MP3 without exposing credentials.
  // Behavior:
  // - If cached -> serve from disk with Range support (fast).
  // - Else -> stream from Twilio to client (Range passthrough), optionally tee to cache for future requests.
  if (!recordingSid || typeof recordingSid !== "string") {
    res.status(400).send("Bad request");
    return;
  }

  // 1) If we have cache + file exists, serve immediately
  const cacheEnabled = String(process.env.RECORDING_CACHE_ENABLED || "true").toLowerCase() !== "false";
  const cachePath = getRecordingCachePath(recordingSid);

  try {
    if (cacheEnabled && fs.existsSync(cachePath)) {
      await sendMp3File(req, res, cachePath);
      return;
    }
  } catch (e) {
    // Cache failures must never block serving; fall through to live proxy.
    logger.warn("Recording cache read failed; falling back to live proxy", { recordingSid, err: String(e && e.message ? e.message : e) });
  }

  // 2) Live proxy from Twilio (supports Range)
  const range = req.headers.range;
  const controller = new AbortController();

  const totalTimeoutMs = Number(process.env.RECORDING_PROXY_TOTAL_TIMEOUT_MS || 120000); // 2 min default
  const timeout = setTimeout(() => controller.abort(new Error("recording_proxy_timeout")), Math.max(5000, totalTimeoutMs));

  let tmpPath = null;
  let fileStream = null;
  let tee = null;

  // If client disconnects, abort upstream immediately
  const onClose = () => {
    try { controller.abort(new Error("client_disconnected")); } catch (_) {}
  };
  res.on("close", onClose);

  try {
    const auth = getTwilioBasicAuthHeader();
    const mp3Url = getTwilioRecordingMp3Url(recordingSid);

    const headers = { Authorization: auth };
    if (range) headers.Range = range;

    const twilioRes = await fetch(mp3Url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    });

    // Propagate status (200/206/404 etc.)
    res.status(twilioRes.status);

    // Copy relevant headers
    const passHeaders = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "etag",
      "last-modified",
    ];
    for (const h of passHeaders) {
      const v = twilioRes.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    // Always mark as inline audio
    res.setHeader("Content-Disposition", `inline; filename="${recordingSid}.mp3"`);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    if (!twilioRes.body) {
      res.end();
      return;
    }

    // Convert to Node stream
    const nodeStream = Readable.fromWeb(twilioRes.body);

    // Tee to cache only for full-file responses (no Range, 200 OK)
    const canCache = cacheEnabled && !range && twilioRes.status === 200;
    if (canCache) {
      try {
        ensureRecordingCacheDir();
        tmpPath = cachePath + ".tmp";
        fileStream = fs.createWriteStream(tmpPath);
        tee = new PassThrough();

        // nodeStream -> tee -> (res + file)
        tee.pipe(res);
        tee.pipe(fileStream);

        await Promise.all([
          pipeline(nodeStream, tee),
          new Promise((resolve, reject) => {
            fileStream.on("finish", resolve);
            fileStream.on("error", reject);
            tee.on("error", reject);
          }),
        ]);

        // Atomically move into place
        try {
          fs.renameSync(tmpPath, cachePath);
        } catch (e) {
          // If rename fails, just remove tmp
          try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        }
        return;
      } catch (e) {
        logger.warn("Recording cache tee failed; streaming without cache", { recordingSid, err: String(e && e.message ? e.message : e) });
        // fallthrough to plain streaming below
        try { if (fileStream) fileStream.destroy(); } catch (_) {}
        try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }

    // Plain streaming (Range or no cache)
    await pipeline(nodeStream, res);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    logger.warn("Recording proxy failed", { recordingSid, err: msg });
    if (!res.headersSent) {
      res.status(502).send("Recording proxy failed");
    } else {
      try { res.end(); } catch (_) {}
    }
  } finally {
    clearTimeout(timeout);
    res.off("close", onClose);
    try { if (fileStream) fileStream.destroy(); } catch (_) {}
    try { if (tee) tee.destroy(); } catch (_) {}
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

const app = express();
app.set("recordingRegistry", recordingRegistry);

// JSON payloads (webhooks/admin)
app.use(express.json({ limit: "1mb" }));

// Twilio RecordingStatusCallback sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// IMPORTANT: Render health/probe hits GET /
// Must return fast 200 so Render detects the open HTTP port.
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

// --- Routers ---
app.use(healthRouter);
app.use(adminReloadRouter);
app.use(twilioStatusRouter);

// --- Public Recording URLs (server.js layer) ---
function normalizeRecordingSid(raw) {
  const sid = String(raw || "").trim();
  // Twilio Recording SID format typically starts with "RE"
  return sid;
}

app.get(["/recording/:sid", "/recordings/:sid"], async (req, res) => {
  const sid = normalizeRecordingSid(req.params.sid);
  if (!sid) return res.status(400).json({ error: "missing_recording_sid" });

  // Friendly redirect to .mp3
  res.redirect(302, `/recording/${encodeURIComponent(sid)}.mp3`);
});

app.get(["/recording/:sid.mp3", "/recordings/:sid.mp3"], async (req, res) => {
  const sid = normalizeRecordingSid(req.params.sid);
  if (!sid) return res.status(400).json({ error: "missing_recording_sid" });
  return proxyTwilioMp3(req, res, sid);
});

// Twilio async recording callback
app.post("/twilio-recording-callback", (req, res) => {
  try {
    const callSid = String(req.body?.CallSid || "").trim();
    const recordingSid = String(req.body?.RecordingSid || "").trim();
    const recordingUrl = String(req.body?.RecordingUrl || "").trim();

    if (callSid) {
      setRecordingForCall(callSid, {
        recordingSid: recordingSid || null,
        recordingUrl: recordingUrl || null
      });
    }

    // Respond quickly (Twilio expects fast ACK)
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.warn("twilio-recording-callback error", { err: String(e) });
    res.status(200).json({ ok: true });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

async function start() {
  // Load SSOT once at boot (and via /admin/reload-sheets)
  await loadSSOT({ logger });

  // Ensure Caller Memory DB schema (best-effort)
  await ensureCallerMemorySchema({ logger });

  // Twilio Media WebSocket server (voice pipeline)
  const port = env.PORT || 10000;
  const server = app.listen(port, () => {
    logger.info("Service started", { port, provider_mode: env.PROVIDER_MODE });
  });

  // IMPORTANT: installTwilioMediaWs requires the *HTTP server* (server.on('upgrade', ...)).
  installTwilioMediaWs(server);
}

start().catch((e) => {
  logger.error("Fatal boot error", { err: String(e) });
  process.exit(1);
});
