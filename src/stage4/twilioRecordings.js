// src/stage4/twilioRecordings.js
"use strict";

/*
  Twilio Recording resolver (GilSport-style, adapted)
  ---------------------------------------------------
  Goal:
  - After call end, find RecordingSid for a given CallSid (if exists)
  - Return a PUBLIC proxy URL (no auth) hosted on our service:
      <PUBLIC_BASE_URL>/recordings/<RecordingSid>.mp3

  Notes:
  - Twilio may create the recording a short time after the call ends.
    We poll for a short window.
*/

const https = require("https");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStr(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

function basicAuthHeader(accountSid, authToken) {
  const raw = `${accountSid}:${authToken}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              return resolve(JSON.parse(data || "{}"));
            } catch (e) {
              return reject(new Error(`Invalid JSON from Twilio: ${e.message}`));
            }
          }
          return reject(new Error(`Twilio API ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function resolveTwilioRecordingSid({ callSid, accountSid, authToken, logger }) {
  const log = logger || console;
  const cs = safeStr(callSid);
  if (!cs) return null;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    accountSid
  )}/Recordings.json?CallSid=${encodeURIComponent(cs)}&PageSize=20`;

  const json = await httpGetJson(url, {
    authorization: basicAuthHeader(accountSid, authToken),
    "user-agent": "voicebot-blank/recording-resolver",
  });

  const recs = Array.isArray(json.recordings) ? json.recordings : [];
  if (!recs.length) {
    log.debug?.("No recordings yet", { callSid: cs });
    return null;
  }

  // Prefer the first (most recent). Twilio tends to return newest first but we don't assume ordering.
  // Pick by date_created if present.
  recs.sort((a, b) => String(b?.date_created || "").localeCompare(String(a?.date_created || "")));
  const sid = safeStr(recs[0]?.sid);
  return sid;
}

async function resolveTwilioRecordingPublic({
  callSid,
  publicBaseUrl,
  twilioAccountSid,
  twilioAuthToken,
  enableRecording,
  logger,
  waitMs = 12000,
}) {
  const log = logger || console;

  if (!enableRecording) {
    return { recording_provider: "twilio", recording_sid: null, recording_url_public: null };
  }

  const base = safeStr(publicBaseUrl);
  const accountSid = safeStr(twilioAccountSid);
  const authToken = safeStr(twilioAuthToken);
  const cs = safeStr(callSid);

  if (!base || !accountSid || !authToken || !cs) {
    return { recording_provider: "twilio", recording_sid: null, recording_url_public: null };
  }

  const started = Date.now();
  let sid = null;

  // Poll quickly at first, then back off slightly
  const delays = [0, 800, 1200, 1600, 2200, 3000, 3500];
  for (const d of delays) {
    if (d > 0) await sleep(d);
    try {
      sid = await resolveTwilioRecordingSid({ callSid: cs, accountSid, authToken, logger: log });
      if (sid) break;
    } catch (e) {
      // If Twilio is temporarily unavailable, keep trying within window
      log.debug?.("Recording sid lookup error", { callSid: cs, error: e?.message || String(e) });
    }
    if (Date.now() - started > waitMs) break;
  }

  if (!sid) {
    return { recording_provider: "twilio", recording_sid: null, recording_url_public: null };
  }

  // Canonical public URL (proxy; no Twilio auth)
  const urlPublic = `${base.replace(/\/$/, "")}/recordings/${encodeURIComponent(sid)}.mp3`;
  return { recording_provider: "twilio", recording_sid: sid, recording_url_public: urlPublic };
}

module.exports = {
  resolveTwilioRecordingPublic,
};
