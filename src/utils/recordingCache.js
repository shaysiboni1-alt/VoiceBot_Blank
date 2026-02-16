"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Best-effort local cache for Twilio recordings (mp3).
// Goals:
// - Never block call flow.
// - Serve /recording/:sid.mp3 quickly from disk when possible.
// - If not cached yet, stream from Twilio and tee to disk.
// - Handle concurrent downloads safely (single in-flight per RecordingSid).

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/tmp/recordings";
const DEFAULT_TIMEOUT_MS = Number(process.env.RECORDING_DOWNLOAD_TIMEOUT_MS || 20000);

const inflight = new Map(); // recordingSid -> Promise

function ensureDirSync() {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  } catch (_) {}
}

function getLocalPath(recordingSid) {
  const sid = String(recordingSid || "").trim();
  return sid ? path.join(RECORDINGS_DIR, `${sid}.mp3`) : null;
}

function existsSync(p) {
  try {
    return p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function getTwilioAuth() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token =
    String(process.env.TWILIO_AUTH_TOKEN || "").trim() ||
    String(process.env.TWILIO_ACCOUNT_TOKEN || "").trim(); // backward compat if user set it
  return sid && token ? { username: sid, password: token } : null;
}

async function downloadToFile({ recordingSid, recordingUrl, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sid = String(recordingSid || "").trim();
  const url = String(recordingUrl || "").trim();
  if (!sid || !url) throw new Error("downloadToFile missing sid/url");

  ensureDirSync();
  const finalPath = getLocalPath(sid);
  if (!finalPath) throw new Error("downloadToFile no finalPath");

  if (existsSync(finalPath)) return { path: finalPath, cached: true };

  // dedupe concurrent downloads
  if (inflight.has(sid)) return inflight.get(sid);

  const p = (async () => {
    const auth = getTwilioAuth();
    if (!auth) throw new Error("Twilio auth missing (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN)");

    const tmpPath = `${finalPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
      const resp = await axios.get(url, {
        auth,
        responseType: "stream",
        timeout: timeoutMs,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: (s) => s >= 200 && s < 300,
      });

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath);
        resp.data.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        resp.data.pipe(out);
      });

      // atomic-ish rename
      fs.renameSync(tmpPath, finalPath);

      logger?.info?.("Recording cached to disk", { recordingSid: sid, path: finalPath });
      return { path: finalPath, cached: true };
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (_) {}

      logger?.warn?.("Recording cache download failed", {
        recordingSid: sid,
        error: String(err?.message || err),
      });
      throw err;
    } finally {
      inflight.delete(sid);
    }
  })();

  inflight.set(sid, p);
  return p;
}

function startDownloadBestEffort({ recordingSid, recordingUrl, logger } = {}) {
  // fire and forget
  downloadToFile({ recordingSid, recordingUrl, logger }).catch(() => {});
}

module.exports = {
  RECORDINGS_DIR,
  ensureDirSync,
  getLocalPath,
  existsSync,
  getTwilioAuth,
  downloadToFile,
  startDownloadBestEffort,
};
