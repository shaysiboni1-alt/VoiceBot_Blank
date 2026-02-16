// src/routes/recordings.js
"use strict";

const express = require("express");
const { Readable } = require("stream");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

const recordingsRouter = express.Router();

// Safety: validate Twilio Recording SID format (RE + 32 hex)
function isValidRecordingSid(s) {
  return typeof s === "string" && /^RE[a-f0-9]{32}$/i.test(s);
}

recordingsRouter.get("/:recordingSid.mp3", async (req, res) => {
  const recordingSid = String(req.params.recordingSid || "").trim();

  if (!isValidRecordingSid(recordingSid)) {
    return res.status(400).type("text/plain").send("Invalid recording SID");
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    logger.warn("Recording proxy missing Twilio credentials");
    return res.status(500).type("text/plain").send("Server not configured for recordings");
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;

  const ac = new AbortController();
  const hardTimeout = setTimeout(() => ac.abort(), 25000);

  try {
    // Fetch and stream immediately to avoid Render edge timeouts
    const r = await fetch(twilioUrl, {
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      },
      signal: ac.signal,
    });

    if (!r.ok) {
      let body = "";
      try {
        body = (await r.text()).slice(0, 400);
      } catch {}
      logger.warn("Recording proxy Twilio error", { status: r.status, body });
      return res.status(r.status).type("text/plain").send(body || "Twilio error");
    }

    const ct = r.headers.get("content-type") || "audio/mpeg";
    res.status(200);
    res.setHeader("Content-Type", ct);
    const cl = r.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Recording-Sid", recordingSid);

    if (typeof res.flushHeaders === "function") res.flushHeaders();

    if (!r.body) return res.end();

    const nodeStream = Readable.fromWeb(r.body);

    nodeStream.on("error", (e) => {
      logger.error("Recording stream error", { err: String(e) });
      try {
        res.destroy(e);
      } catch {}
    });

    // If client disconnects, abort upstream fetch
    req.on("close", () => {
      try {
        ac.abort();
      } catch {}
    });

    nodeStream.pipe(res);
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "Upstream timeout" : String(err);
    logger.error("Recording proxy failed", { err: msg });
    if (!res.headersSent) res.status(502).type("text/plain");
    try {
      res.end(msg);
    } catch {}
  } finally {
    clearTimeout(hardTimeout);
  }
});

module.exports = { recordingsRouter };
