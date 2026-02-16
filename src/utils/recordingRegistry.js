"use strict";

// In-memory registry:
// - CallSid -> { recordingSid, recordingUrl, updatedAt }
// - RecordingSid -> { callSid, recordingUrl, updatedAt }
// Best-effort only. If the process restarts, data may be lost.

const RECORDINGS_BY_CALL = new Map();
const RECORDINGS_BY_SID = new Map();

function setRecordingForCall(call_id, { recordingSid, recordingUrl } = {}) {
  const callSid = String(call_id || "").trim();
  if (!callSid) return;

  const prev = RECORDINGS_BY_CALL.get(callSid) || {};
  const next = {
    recordingSid: recordingSid ?? prev.recordingSid ?? null,
    recordingUrl: recordingUrl ?? prev.recordingUrl ?? null,
    updatedAt: Date.now(),
  };
  RECORDINGS_BY_CALL.set(callSid, next);

  const sid = String(next.recordingSid || "").trim();
  if (sid) {
    const prevSid = RECORDINGS_BY_SID.get(sid) || {};
    RECORDINGS_BY_SID.set(sid, {
      callSid,
      recordingUrl: next.recordingUrl ?? prevSid.recordingUrl ?? null,
      updatedAt: Date.now(),
    });
  }
}

function getRecordingForCall(call_id) {
  const callSid = String(call_id || "").trim();
  if (!callSid) return { recordingSid: null, recordingUrl: null };
  const rec = RECORDINGS_BY_CALL.get(callSid) || {};
  return {
    recordingSid: rec.recordingSid ?? null,
    recordingUrl: rec.recordingUrl ?? null,
  };
}

function getRecordingInfo(recordingSid) {
  const sid = String(recordingSid || "").trim();
  if (!sid) return { callSid: null, recordingUrl: null };
  const rec = RECORDINGS_BY_SID.get(sid) || {};
  return {
    callSid: rec.callSid ?? null,
    recordingUrl: rec.recordingUrl ?? null,
  };
}

async function waitForRecording(call_id, timeoutMs = 12000) {
  const callSid = String(call_id || "").trim();
  if (!callSid) return { recordingSid: null, recordingUrl: null };

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rec = getRecordingForCall(callSid);
    // Twilio may return RecordingSid immediately, but MP3 may not be ready.
    // We rely on RecordingUrl arriving via RecordingStatusCallback.
    if (rec.recordingUrl) return rec;
    await new Promise((r) => setTimeout(r, 250));
  }
  return getRecordingForCall(callSid);
}

module.exports = {
  setRecordingForCall,
  getRecordingForCall,
  getRecordingInfo,
  waitForRecording,
};
