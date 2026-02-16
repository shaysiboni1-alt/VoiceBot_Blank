"use strict";

const express = require("express");
const fs = require("fs");
const axios = require("axios");
const { logger } = require("../utils/logger");
const {
  ensureDirSync,
  getLocalPath,
  existsSync,
  getTwilioAuth,
  downloadToFile,
} = require("../utils/recordingCache");

const router = express.Router();

// Serve cached mp3 from disk (supports Range), else stream from Twilio and tee to disk.
function serveFileWithRange(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  if (!range) {
    res.setHeader("Content-Length", fileSize);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Range: bytes=start-end
  const m = String(range).match(/bytes=(\d*)-(\d*)/);
  const start = m && m[1] ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? parseInt(m[2], 10) : fileSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    res.end();
    return;
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", end - start + 1);

  fs.createReadStream(filePath, { start, end }).pipe(res);
}

router.get("/recording/:sid.mp3", async (req, res) => {
  const sid = String(req.params.sid || "").trim();
  if (!sid) return res.status(400).send("Missing recording sid");

  ensureDirSync();
  const localPath = getLocalPath(sid);

  // 1) fast path: cached file exists
  if (localPath && existsSync(localPath)) {
    logger.info("Recording served from cache", { recordingSid: sid });
    return serveFileWithRange(req, res, localPath);
  }

  // 2) we need recording URL from registry
  const registry = req.app.get("recordingRegistry");
  const info = registry?.getRecordingInfo ? registry.getRecordingInfo(sid) : null;
  const recordingUrl = info?.recordingUrl;

  if (!recordingUrl) {
    // It might not have reached callback yet.
    logger.warn("Recording URL not found in registry", { recordingSid: sid });
    return res.status(404).send("Recording not ready yet");
  }

  // 3) try stream from Twilio and tee into local cache
  const auth = getTwilioAuth();
  if (!auth) {
    logger.error("Twilio auth missing; cannot proxy recording", { recordingSid: sid });
    return res.status(500).send("Server missing Twilio auth");
  }

  const tmpPath = localPath ? `${localPath}.tmp-${Date.now()}` : null;

  try {
    const resp = await axios.get(recordingUrl, {
      auth,
      responseType: "stream",
      timeout: Number(process.env.RECORDING_PROXY_TIMEOUT_MS || 20000),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    // tee to disk (best effort) while streaming to client
    let out = null;
    if (tmpPath) {
      try {
        out = fs.createWriteStream(tmpPath);
        resp.data.pipe(out);
        out.on("finish", () => {
          try {
            fs.renameSync(tmpPath, localPath);
            logger.info("Recording cached via proxy tee", { recordingSid: sid, path: localPath });
          } catch (e) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            logger.warn("Failed to finalize cached recording", { recordingSid: sid, error: String(e?.message || e) });
          }
        });
        out.on("error", (e) => {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          logger.warn("Recording cache tee write error", { recordingSid: sid, error: String(e?.message || e) });
        });
      } catch (e) {
        logger.warn("Recording cache tee init failed", { recordingSid: sid, error: String(e?.message || e) });
      }
    }

    resp.data.on("error", (e) => {
      logger.warn("Recording proxy stream error", { recordingSid: sid, error: String(e?.message || e) });
      try { res.end(); } catch (_) {}
    });

    // respond to client
    resp.data.pipe(res);

    // also kick a proper cache download in parallel to ensure completion (deduped)
    downloadToFile({ recordingSid: sid, recordingUrl, logger }).catch(() => {});
  } catch (err) {
    const msg = String(err?.message || err);
    logger.warn("Recording proxy failed", { recordingSid: sid, error: msg });

    // Common: Twilio returns 404 for a short window after call ends.
    return res.status(404).send("Recording not ready yet");
  }
});

module.exports = router;
