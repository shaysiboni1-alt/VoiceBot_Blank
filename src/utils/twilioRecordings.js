// src/utils/twilioRecordings.js
"use strict";

const { Readable } = require("node:stream");

function twilioAuthHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  const basic = Buffer.from(`${sid}:${token}`).toString("base64");
  return `Basic ${basic}`;
}

function twilioBase() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  return `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
}

async function startCallRecording(callSid, logger) {
  const enabled = String(process.env.MB_ENABLE_RECORDING || "").toLowerCase() === "true";
  if (!enabled) return { ok: false, recordingSid: null, reason: "recording_disabled" };

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    logger?.warn?.("TWILIO creds missing; cannot start recording");
    return { ok: false, recordingSid: null, reason: "twilio_creds_missing" };
  }

  const base = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    logger?.warn?.("PUBLIC_BASE_URL missing; cannot configure recording callback");
    return { ok: false, recordingSid: null, reason: "public_base_url_missing" };
  }

  const callback = `${base}/twilio-recording-callback`;

  try {
    const url = `${twilioBase()}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

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
 * Streaming public proxy for Twilio recording MP3.
 * IMPORTANT: Adds a hard timeout so Render edge won't 502 after ~60s.
 */
async function proxyRecordingMp3(recordingSid, res, logger) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !token) {
    res.statusCode = 503;
    res.end("twilio_not_configured");
    return;
  }

  // Hard timeout (ms) — keep below common edge/proxy timeouts
  const timeoutMs = Number(process.env.RECORDING_PROXY_TIMEOUT_MS || 25000);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${encodeURIComponent(
      recordingSid
    )}.mp3`;

    const resp = await fetch(url, {
      method: "GET",
      headers: { authorization: twilioAuthHeader() },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      // Pass through Twilio status (404/401/403 etc)
      res.statusCode = resp.status;
      res.end(t || `twilio_${resp.status}`);
      return;
    }

    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");

    const nodeStream = Readable.fromWeb(resp.body);
    nodeStream.on("error", (e) => {
      logger?.warn?.("recording proxy stream error", { err: String(e) });
      try { res.end(); } catch (_) {}
    });

    nodeStream.pipe(res);
  } catch (e) {
    // Timeout / abort
    if (String(e?.name || "").toLowerCase().includes("abort")) {
      logger?.warn?.("recording proxy timeout", { recordingSid, timeoutMs });
      res.statusCode = 504;
      res.end("recording_fetch_timeout");
      return;
    }

    logger?.warn?.("recording proxy exception", { err: String(e) });
    res.statusCode = 500;
    res.end("proxy_error");
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  startCallRecording,
  proxyRecordingMp3,
};
