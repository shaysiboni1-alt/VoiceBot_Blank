const express = require("express");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

const router = express.Router();

// Where we prefetch recordings to (see src/stage4/twilioRecordings.js)
const RECORDINGS_DIR = "/tmp/recordings";

function safeSid(raw) {
  return String(raw || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
}

function sendFileWithRange(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // Default headers
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", fileSize);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Example: "bytes=0-"
  const m = /^bytes=(\d+)-(\d*)$/i.exec(range);
  if (!m) {
    res.status(416).end();
    return;
  }

  const start = Math.min(parseInt(m[1], 10), fileSize - 1);
  const end = m[2] ? Math.min(parseInt(m[2], 10), fileSize - 1) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", end - start + 1);

  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function httpsGetFollow(url, headers, maxHops = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (resp) => {
      const { statusCode, headers: respHeaders } = resp;

      // Follow redirects (Twilio sometimes responds with a 302 to a signed media URL)
      if ([301, 302, 307, 308].includes(statusCode) && respHeaders.location && maxHops > 0) {
        resp.resume(); // drain
        resolve(httpsGetFollow(respHeaders.location, headers, maxHops - 1));
        return;
      }

      if (statusCode !== 200) {
        let body = "";
        resp.on("data", (d) => (body += d.toString("utf8")));
        resp.on("end", () => reject(new Error(`Upstream status ${statusCode}: ${body.slice(0, 500)}`)));
        return;
      }

      resolve(resp);
    });

    req.on("error", reject);
  });
}

async function streamFromTwilio(recordingSid, req, res) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    res.status(500).send("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    return;
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;

  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: "audio/mpeg",
    // Preserve range requests for smooth playback
    ...(req.headers.range ? { Range: req.headers.range } : {}),
  };

  try {
    const upstream = await httpsGetFollow(apiUrl, headers);

    // If we asked for range, Twilio should respond 206; otherwise 200.
    // We pass through relevant headers.
    if (upstream.statusCode === 206) {
      res.status(206);
      if (upstream.headers["content-range"]) res.setHeader("Content-Range", upstream.headers["content-range"]);
      if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
      res.setHeader("Accept-Ranges", "bytes");
    } else {
      res.status(200);
      if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    upstream.pipe(res);
  } catch (e) {
    logger.warn("Recording stream failed", { recordingSid, error: String(e?.message || e) });
    res.status(502).send("Failed to fetch recording");
  }
}

// Public URL pattern: /recordings/RExxxx.mp3
router.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const recordingSid = safeSid(req.params.recordingSid);

  if (!recordingSid) {
    res.status(400).send("Missing recordingSid");
    return;
  }

  // Prefer the prefetched local file (fast + stable + supports Range)
  try {
    const localPath = path.join(RECORDINGS_DIR, `${recordingSid}.mp3`);
    if (fs.existsSync(localPath)) {
      sendFileWithRange(req, res, localPath);
      return;
    }
  } catch (e) {
    logger.warn("Local recording serve failed", { recordingSid, error: String(e?.message || e) });
  }

  // Fallback: stream directly from Twilio
  await streamFromTwilio(recordingSid, req, res);
});

module.exports = router;
