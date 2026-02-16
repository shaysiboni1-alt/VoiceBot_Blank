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
const { ensureCacheDir, getCachedRecordingPath, fileExists, downloadToFile } = recordingCache;
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
  // Cache-first proxy for Twilio recording MP3.
  // Goals:
  // - Fast response for repeated requests (serve from disk).
  // - Hard timeout so we never hang Render/Twilio callbacks.
  // - No third-party modules; keep baseline stable.

  const auth = getTwilioBasicAuthHeader();
  if (!auth) {
    res.status(500).json({ error: "missing_twilio_credentials" });
    return;
  }

  try {
    ensureCacheDir();
    const cachedPath = getCachedRecordingPath(recordingSid);

    const timeoutMs = (() => {
      const v = Number(process.env.RECORDING_PROXY_TIMEOUT_MS || process.env.RECORDING_DOWNLOAD_TIMEOUT_MS || 20000);
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20000;
    })();

    if (!(await fileExists(cachedPath))) {
      const url = twilioRecordingMp3Url(recordingSid);
      await downloadToFile(url, recordingSid, { timeoutMs });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const fs = require("fs");
    const stream = fs.createReadStream(cachedPath);
    stream.on("error", (err) => {
      logger.warn("Recording stream error", { recordingSid, err: String(err && err.message ? err.message : err) });
      if (!res.headersSent) res.status(500).end("recording_stream_error");
      else res.end();
    });
    stream.pipe(res);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    logger.warn("Recording proxy failed", { recordingSid, err: msg });
    res.status(502).end("recording_unavailable");
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
