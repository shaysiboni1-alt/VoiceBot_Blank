// src/stage4/finalizePipeline.js
"use strict";

/*
  Stage 4: Finalize pipeline

  Goals (GilSport-style):
  - Send CALL_LOG (always, per env)
  - Send FINAL xor ABANDONED (deterministic)
  - Include recording_url_public/recording_sid/recording_provider when possible
  - Post-call smart parsing (LLM) to fill lead fields from transcript

  IMPORTANT: This runs after the media stream stops (post-call). It should not affect audio.
*/

const { parseLeadPostcall } = require("./postcallLeadParser");

function isTrue(v) {
  return v === true || String(v).toLowerCase() === "true";
}

function safeStr(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

function secondsFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n / 1000);
}

function formatDateTimeParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const call_date = `${map.year}-${map.month}-${map.day}`;
    const call_time = `${map.hour}:${map.minute}:${map.second}`;
    return { call_date, call_time };
  } catch {
    const iso = date.toISOString();
    return { call_date: iso.slice(0, 10), call_time: iso.slice(11, 19) };
  }
}

function deriveSubjectAndReason(parsed) {
  // We keep this simple and deterministic:
  // - subject: short headline (if model returns one)
  // - reason: slightly longer problem statement (if model returns one)
  return {
    subject: safeStr(parsed?.subject),
    reason: safeStr(parsed?.reason),
  };
}

function shouldFinalizeAsLead(lead, call) {
  // Deterministic LeadGate (GilSport-style):
  // must have: name + a callback number (caller ID) + meaningful content.
  const hasName = !!safeStr(lead?.full_name);
  const phoneExists = !!safeStr(call?.caller);
  const hasContent =
    !!safeStr(lead?.subject) ||
    !!safeStr(lead?.reason) ||
    !!safeStr(lead?.parsing_summary);
  return hasName && phoneExists && hasContent;
}

function decisionReason(lead, call) {
  if (!safeStr(lead?.full_name)) return "missing_name";
  if (!safeStr(call?.caller)) return "missing_caller";
  if (!safeStr(lead?.subject) && !safeStr(lead?.reason) && !safeStr(lead?.parsing_summary)) {
    return "missing_content";
  }
  return "ok";
}

function buildFinalPayload({ event, call, lead, recording }) {
  const tz = call?.timeZone || "UTC";
  const { call_date, call_time } = formatDateTimeParts(new Date(call?.ended_at || Date.now()), tz);

  return {
    event,
    full_name: safeStr(lead?.full_name),
    subject: safeStr(lead?.subject),
    reason: safeStr(lead?.reason),
    caller_id_e164: safeStr(call?.caller),
    phone_additional: safeStr(lead?.phone_additional),
    parsing_summary: safeStr(lead?.parsing_summary),
    recording_url_public: safeStr(recording?.recording_url_public),
    call_date,
    call_time,
    callSid: safeStr(call?.callSid),
    duration_sec: call?.duration_sec ?? null,
    // Optional (ignored by Make if not used):
    recording_provider: safeStr(recording?.recording_provider),
    recording_sid: safeStr(recording?.recording_sid),
    decision_reason: safeStr(lead?.decision_reason),
  };
}

async function finalizePipeline({ snapshot, ssot, env, logger, senders }) {
  const log = logger || console;

  // 0) Build call context
  const call = {
    callSid: snapshot?.call?.callSid || snapshot?.callSid || null,
    streamSid: snapshot?.call?.streamSid || snapshot?.streamSid || null,
    caller: snapshot?.call?.caller || snapshot?.caller || null,
    called: snapshot?.call?.called || snapshot?.called || null,
    source: snapshot?.call?.source || snapshot?.source || "VoiceBot_Blank",
    started_at: snapshot?.call?.started_at || snapshot?.started_at || null,
    ended_at: snapshot?.call?.ended_at || snapshot?.ended_at || null,
    duration_ms: snapshot?.call?.duration_ms ?? snapshot?.duration_ms ?? null,
    duration_sec: snapshot?.call?.duration_sec ?? secondsFromMs(snapshot?.call?.duration_ms ?? snapshot?.duration_ms),
    finalize_reason: snapshot?.call?.finalize_reason || snapshot?.finalize_reason || null,
    timeZone: env.TIME_ZONE || "UTC",
  };

  // 1) CALL_LOG (always, if enabled)
  try {
    if (env.CALL_LOG_AT_START === "true" && env.CALL_LOG_MODE === "start") {
      // Already sent at start by other stage; do nothing.
    }
    if (isTrue(env.CALL_LOG_AT_END)) {
      const payload = {
        event: "CALL_LOG",
        call: {
          callSid: call.callSid,
          streamSid: call.streamSid,
          caller: call.caller,
          called: call.called,
          source: call.source,
          started_at: call.started_at,
          ended_at: call.ended_at,
          duration_ms: call.duration_ms,
          duration_sec: call.duration_sec,
          finalize_reason: call.finalize_reason,
        },
      };
      if (env.CALL_LOG_WEBHOOK_URL && senders?.sendCallLog) {
        await senders.sendCallLog(payload);
      }
    }
  } catch (e) {
    log.warn?.("CALL_LOG webhook failed", e?.message || e);
  }

  // 2) Post-call smart parsing (LLM) -> lead fields
  let parsed = null;
  try {
    const transcriptText = snapshot?.lead?.transcriptText || snapshot?.transcriptText || "";
    const shouldParse = !!env.LEAD_PARSER_ENABLED;

    if (shouldParse) {
      parsed = await parseLeadPostcall({
        transcriptText,
        ssot,
          known: {
            full_name: safeStr(snapshot?.lead?.full_name) || null,
            caller_id_e164: safeStr(call?.caller || null),
          },
        env,
        logger: log,
      });
    }
  } catch (e) {
    log.warn?.("Lead postcall parsing failed", e?.message || e);
  }

  const parsedDerived = deriveSubjectAndReason(parsed || {});

  const lead = {
    // GilSport parity: prefer deterministic LeadGate values from runtime; LLM is fallback only.
    full_name: safeStr(snapshot?.lead?.full_name) || safeStr(parsed?.full_name) || null,
    subject: safeStr(snapshot?.lead?.subject) || parsedDerived.subject || null,
    reason: safeStr(snapshot?.lead?.reason) || parsedDerived.reason || null,
    phone_additional: safeStr(parsed?.phone_additional) || null,
    // GilSport parity: parsing_summary must be an LLM CRM-style summary, not raw transcript.
    parsing_summary: safeStr(parsed?.parsing_summary) || null,
  };

  // 3) Resolve recording (best-effort)
  let recording = {
    recording_provider: null,
    recording_sid: null,
    recording_url_public: null,
  };
  try {
    // env.MB_ENABLE_RECORDING is normalized to boolean in src/config/env.js
    if (env.MB_ENABLE_RECORDING && typeof senders.resolveRecording === "function") {
      recording = await senders.resolveRecording(call.callSid);
    }
  } catch (e) {
    log.warn?.("Resolve recording failed", e?.message || e);
  }

  // 4) Deterministic LeadGate -> FINAL xor ABANDONED
  // env.FINAL_ON_STOP is normalized to boolean in src/config/env.js
  const isFinal = !!shouldFinalizeAsLead(lead, call) && !!env.FINAL_ON_STOP;
  lead.decision_reason = decisionReason(lead, call);

  const finalPayload = buildFinalPayload({
    event: isFinal ? "FINAL" : "ABANDONED",
    call,
    lead,
    recording,
  });

  // 5) Deliver FINAL / ABANDONED
  if (isFinal) {
    if (env.FINAL_WEBHOOK_URL && typeof senders.sendFinal === "function") {
      await senders.sendFinal(finalPayload);
    }
  } else {
    if (env.ABANDONED_WEBHOOK_URL && typeof senders.sendAbandoned === "function") {
      await senders.sendAbandoned(finalPayload);
    }
  }

  // 6) Force hangup is handled by Twilio side; this is post-call.
  return { status: "ok", event: finalPayload.event };
}

module.exports = { finalizePipeline };
