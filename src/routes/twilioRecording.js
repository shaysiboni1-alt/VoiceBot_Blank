// src/utils/twilioRecording.js
"use strict";

const { env } = require("../config/env");

/**
 * Start a call recording on Twilio.
 * Returns recordingSid (if Twilio returns it), otherwise "".
 */
async function startCallRecording(callSid, logger) {
  try {
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      logger?.warn?.("Recording start skipped (missing TWILIO creds)");
      return "";
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      accountSid
    )}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

    const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    // Note: Twilio defaults are OK. You can pass RecordingChannels, RecordingStatusCallback, etc.
    const body = new URLSearchParams();
    body.set("RecordingStatusCallbackEvent", "completed");
    // If you need dual channel, uncomment:
    // body.set("RecordingChannels", "dual");

    const r = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      logger?.warn?.("Twilio start recording failed", { status: r.status, body: txt?.slice(0, 240) });
      return "";
    }

    const j = await r.json().catch(() => null);
    return String(j?.sid || "");
  } catch (err) {
    logger?.warn?.("Twilio start recording error", { error: err?.message || String(err) });
    return "";
  }
}

async function hangupCall(callSid, logger) {
  try {
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) return;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      accountSid
    )}/Calls/${encodeURIComponent(callSid)}.json`;

    const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const body = new URLSearchParams();
    body.set("Status", "completed");

    await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    }).catch(() => {});
  } catch (err) {
    logger?.debug?.("hangupCall error", { error: err?.message || String(err) });
  }
}

function publicRecordingUrl(recordingSid) {
  const sid = String(recordingSid || "").trim();
  if (!sid) return "";
  const base = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return "";
  return `${base}/recordings/${sid}.mp3`;
}

module.exports = {
  startCallRecording,
  hangupCall,
  publicRecordingUrl
};
