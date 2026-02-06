// src/stage4/twilioRecordings.js
"use strict";

// Best-effort Twilio Recording resolver (by CallSid).
// Mirrors the GilSport approach: resolve recording SID + build public URL.

const { env } = require("../config/env");
const { logger } = require("../utils/logger");

function basicAuthHeader(accountSid, authToken) {
  const token = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  return `Basic ${token}`;
}

async function fetchLatestRecordingByCallSid(callSid) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing");
  }
  if (!callSid) throw new Error("callSid missing");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json?PageSize=1`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(accountSid, authToken)
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Twilio recordings HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  const rec = json?.recordings?.[0];
  if (!rec?.sid) return null;

  return {
    recording_provider: "twilio",
    recording_sid: rec.sid,
    recording_url: rec.uri ? `https://api.twilio.com${rec.uri.replace(".json", "")}` : null,
    recording_url_public: env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/recordings/${rec.sid}.mp3` : null
  };
}

async function resolveTwilioRecording(callSid) {
  if (!env.MB_ENABLE_RECORDING) return null;

  // Twilio may take a few seconds to materialize the recording resource after the call ends.
  // Retry with bounded backoff.
  const maxAttempts = 10; // ~40-50s worst-case with backoff

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const rec = await fetchLatestRecordingByCallSid(callSid);
      if (rec) {
        logger.info({ msg: "Resolved Twilio recording", meta: { callSid, sid: rec.recording_sid, attempt } });
        return rec;
      }
      logger.info({ msg: "No Twilio recordings found (yet)", meta: { callSid, attempt } });
    } catch (e) {
      logger.warn({
        msg: "Resolve Twilio recording attempt failed",
        meta: { callSid, attempt, err: e?.message || String(e) }
      });
    }

    const delayMs = Math.min(1500 * attempt, 8000);
    await new Promise((r) => setTimeout(r, delayMs));
  }

  logger.warn({ msg: "Resolve Twilio recording failed", meta: { callSid, attempts: maxAttempts } });
  return null;
}

async function startCallRecordingIfEnabled(callSid, log = logger) {
  if (!env.MB_ENABLE_RECORDING) return { started: false, reason: "disabled" };
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!callSid || !accountSid || !authToken) return { started: false, reason: "missing_credentials" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        RecordingChannels: "dual",
        RecordingTrack: "both"
      })
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      log.warn("Twilio start recording failed", { callSid, status: res.status, body: t.slice(0, 200) });
      return { started: false, reason: `http_${res.status}` };
    }

    const data = await res.json().catch(() => null);
    log.info("Twilio recording started", { callSid, recordingSid: data?.sid });
    return { started: true, recordingSid: data?.sid || "" };
  } catch (e) {
    log.warn("Twilio start recording exception", { callSid, err: e?.message || String(e) });
    return { started: false, reason: "exception" };
  }
}

module.exports = { resolveTwilioRecording, startCallRecordingIfEnabled };
