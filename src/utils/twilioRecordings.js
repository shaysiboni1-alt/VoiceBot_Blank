// src/utils/twilioRecordings.js
"use strict";

const { Readable } = require("node:stream");

function isTrue(v) {
  return String(v || "").toLowerCase() === "true";
}

function twilioAuthHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  const basic = Buffer.from(`${sid}:${token}`).toString("base64");
  return `Basic ${basic}`;
}

function twilioBase(accountSid) {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
}

async function startCallRecording(callSid, logger) {
  if (!isTrue(process.env.MB_ENABLE_RECORDING)) {
    return { ok: false, recordingSid: null, reason: "recording_disabled" };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    logger?.warn?.("startCallRecording: missing twilio creds");
    return { ok: false, recordingSid: null, reason: "twilio_creds_missing" };
  }

  const base = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    logger?.warn?.("startCallRecording: PUBLIC_BASE_URL missing");
    return { ok: false, recordingSid: null, reason: "public_base_url_missing" };
  }

  const callback = `${base}/twilio-recording-callback`;

  try {
    const url = `${twilioBase(accountSid)}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

    const body = new URLSearchParams();
    body.set("RecordingStatusCallback", callback);
    body.set("RecordingStatusCallbackMethod", "POST");
    body.set("RecordingChannels", "dual");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: twilioAuthHeader(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      logger?.warn?.("startCallRecording failed", { status: resp.status, body: text?.slice(0, 240) });
      return { ok: false, recordingSid: null, reason: `twilio_${resp.status}` };
    }

    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    const sid = data?.sid || null;

    return { ok: true, recordingSid: sid, reason: "started" };
  } catch (e) {
    logger?.warn?.("startCallRecording exception", { err: String(e) });
    return { ok: false, recordingSid: null, reason: "exception" };
  }
}

/**
 * Public proxy for Twilio recording MP3 (streaming).
 * Critical: add a hard timeout so Render won't hang and return 502.
 *
 * Optional ENV:
 *   RECORDING_PROXY_TIMEOUT_MS (default 20000)
 */
async function proxyRecordingMp3(recordingSid, res, logger) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    res.statusCode = 503;
    res.end("twilio_not_configured");
    return;
  }

  const timeoutMs = Number(process.env.RECORDING_PROXY_TIMEOUT_MS || 20000);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${twilioBase(accountSid)}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;

    const resp = await fetch(url, {
      method: "GET",
      headers: { authorization: twilioAuthHeader() },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      res.statusCode = resp.status;
      res.end(text || `twilio_${resp.status}`);
      return;
    }

    // stream to client
    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");

    const nodeStream = Readable.fromWeb(resp.body);

    nodeStream.on("error", (e) => {
      logger?.warn?.("recording mp3 stream error", { err: String(e), recordingSid });
      try { res.end(); } catch (_) {}
    });

    nodeStream.pipe(res);
  } catch (e) {
    const name = String(e?.name || "").toLowerCase();
    if (name.includes("abort")) {
      logger?.warn?.("recording mp3 fetch timeout", { recordingSid, timeoutMs });
      res.statusCode = 504;
      res.end("recording_fetch_timeout");
      return;
    }

    logger?.warn?.("recording mp3 proxy exception", { err: String(e), recordingSid });
    res.statusCode = 500;
    res.end("proxy_error");
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  startCallRecording,
  proxyRecordingMp3,
};
