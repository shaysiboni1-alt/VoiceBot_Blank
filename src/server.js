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
const { ensureCacheDir, getCachedRecordingPath, fileExists } = recordingCache;
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

async function proxyTwilioMp3(req, res, recordingSid) {
  // Cache + stream (tee) proxy for Twilio recording MP3.
  // This avoids waiting for a full download before responding, which can
  // stall for minutes when Twilio generates MP3 on-demand.

  const auth = getTwilioBasicAuthHeader();
  if (!auth) {
    res.status(500).json({ error: "missing_twilio_credentials" });
    return;
  }

  const fs = require("fs");
  const path = require("path");
  const { PassThrough } = require("stream");

  ensureCacheDir();
  const cachedPath = getCachedRecordingPath(recordingSid);
  const tmpPath = `${cachedPath}.part`;

  // Fast path: cached file exists (support Range for Chrome/players)
  try {
    if (await fileExists(cachedPath)) {
      const stat = fs.statSync(cachedPath);
      const range = req.headers.range;

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

      if (range) {
        const m = /^bytes=(\d+)-(\d+)?$/.exec(String(range));
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : stat.size - 1;
          const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
          const safeEnd = Number.isFinite(end) ? Math.min(stat.size - 1, end) : stat.size - 1;
          res.status(206);
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Range", `bytes ${safeStart}-${safeEnd}/${stat.size}`);
          res.setHeader("Content-Length", safeEnd - safeStart + 1);
          return fs.createReadStream(cachedPath, { start: safeStart, end: safeEnd }).pipe(res);
        }
      }

      res.status(200);
      res.setHeader("Content-Length", stat.size);
      return fs.createReadStream(cachedPath).pipe(res);
    }
  } catch (e) {
    logger.warn("Cached recording read failed", { recordingSid, err: String(e && e.message ? e.message : e) });
  }

  const url = twilioRecordingMp3Url(recordingSid);

  // Timeouts
  const connectTimeoutMs = (() => {
    const v = Number(process.env.RECORDING_PROXY_CONNECT_TIMEOUT_MS || 15000);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 15000;
  })();
  const overallTimeoutMs = (() => {
    const v = Number(process.env.RECORDING_PROXY_OVERALL_TIMEOUT_MS || 120000);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 120000;
  })();

  const ac = new AbortController();
  const tConnect = setTimeout(() => ac.abort(new Error("recording_connect_timeout")), connectTimeoutMs);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: auth,
        Accept: "audio/mpeg, audio/*;q=0.9, */*;q=0.8",
      },
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(tConnect);
    logger.warn("Recording fetch failed", { recordingSid, err: String(e && e.message ? e.message : e) });
    res.status(504).end("recording_fetch_timeout");
    return;
  }
  clearTimeout(tConnect);

  if (!upstream || !upstream.ok || !upstream.body) {
    let body = "";
    try { body = upstream ? await upstream.text() : ""; } catch (_) {}
    logger.warn("Recording fetch non-200", { recordingSid, status: upstream ? upstream.status : "no_response", body_sample: body.slice(0, 200) });
    if (upstream && (upstream.status === 404 || upstream.status === 410)) {
      res.status(404).end("recording_not_ready");
    } else {
      res.status(502).end("recording_unavailable");
    }
    return;
  }

  // Start sending immediately.
  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  const pass = new PassThrough();
  const fileStream = fs.createWriteStream(tmpPath);

  const tOverall = setTimeout(() => {
    try { ac.abort(new Error("recording_overall_timeout")); } catch (_) {}
    try { pass.destroy(new Error("recording_overall_timeout")); } catch (_) {}
  }, overallTimeoutMs);

  const finalize = (err) => {
    clearTimeout(tOverall);
    try { fileStream.end(); } catch (_) {}
    if (!err) {
      try {
        fs.mkdirSync(path.dirname(cachedPath), { recursive: true });
        fs.renameSync(tmpPath, cachedPath);
      } catch (_) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    } else {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  };

  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on("error", (e) => {
    logger.warn("Recording upstream stream error", { recordingSid, err: String(e && e.message ? e.message : e) });
    try { pass.destroy(e); } catch (_) {}
    finalize(e);
  });
  fileStream.on("finish", () => finalize(null));
  fileStream.on("error", (e) => finalize(e));

  nodeStream.pipe(pass);
  pass.pipe(res);
  pass.pipe(fileStream);
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
