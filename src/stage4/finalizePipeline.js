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

// Remove empty/nullish values at the top-level only (keep 0/false), to keep webhook payloads clean.
function compactTopLevel(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

function isWithheldCallerId(v) {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase();
  if (!s) return true;
  // Common withheld markers coming from telcos/integrations
  if (s.includes("withheld")) return true;
  if (s.includes("restricted")) return true;
  if (s.includes("anonymous")) return true;
  if (s.includes("unknown")) return true;
  if (s.includes("private")) return true;
  // Some providers pass literal strings like "blocked"
  if (s.includes("blocked")) return true;
  // E.164 numbers should start with + and contain digits
  if (s.startsWith("+") && /\d{8,}/.test(s)) return false;
  return false;
}

function normalizePhone(v) {
  const s = safeStr(v);
  if (!s) return null;
  if (isWithheldCallerId(s)) return null;
  // Keep only digits and leading +
  const cleaned = s.replace(/(?!^)\+/g, "").replace(/[^\d+]/g, "");
  // Minimal sanity: +<country><number> with at least 9 digits total
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 9) return null;
  // If no +, return as-is digits (legacy payloads); otherwise E.164-ish
  return cleaned.startsWith("+") ? cleaned : digits;
}

function resolvePhone({ modelPhone, speechPhone, callerId }) {
  return normalizePhone(modelPhone) || normalizePhone(speechPhone) || normalizePhone(callerId) || null;
}

// Deterministic FINAL vs ABANDONED decision.
// Keep this minimal and explicit: FINAL only when required fields exist.
function shouldFinalizeAsLead(leadParsed) {
  if (!leadParsed || typeof leadParsed !== "object") return false;
  const fullName = typeof leadParsed.full_name === "string" ? leadParsed.full_name.trim() : "";
  const subject = typeof leadParsed.subject === "string" ? leadParsed.subject.trim() : "";
  // `notes` may be null, but we prefer having it.
  return fullName.length > 0 && subject.length > 0;
}

// Deterministic reason string for observability/CRM (stable contract).
function decisionReason({ leadParsed, leadMode, hasCallerId, callerIdWithheld, hadAnyUserSpeech }) {
  const hasName = !!safeStr(leadParsed?.full_name);
  const hasSubject = !!safeStr(leadParsed?.subject) || !!safeStr(leadParsed?.reason);
  const hasPhone = !!safeStr(leadParsed?.phone_number) || !!safeStr(leadParsed?.callback_phone);

  if (!hadAnyUserSpeech) return "no_user_speech";
  if (leadMode && String(leadMode).toLowerCase() !== "full") {
    // In reduced lead modes we still want deterministic reasons.
    return hasName ? `lead_mode_${String(leadMode).toLowerCase()}_ok` : `lead_mode_${String(leadMode).toLowerCase()}_missing_name`;
  }

  if (!hasName) return "missing_name";
  if (!hasSubject) return "missing_subject";

  // Phone policy: if caller-id is available and not withheld, we accept it as callback.
  if (callerIdWithheld) {
    if (!hasPhone) return "missing_callback_phone_withheld";
    return "lead_complete_withheld_callback_collected";
  }
  if (hasCallerId) return "lead_complete_using_caller_id";
  if (hasPhone) return "lead_complete_phone_collected";
  return "missing_callback_phone";
}

function extractNameDeterministicFromTranscript(transcriptText) {
  const t = (typeof transcriptText === "string" ? transcriptText : "").trim();
  if (!t) return null;
  // Expect lines like "USER: ..." / "BOT: ..." from our transcript builder
  const userLines = t
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.toUpperCase().startsWith("USER:"))
    .map((x) => x.slice(5).trim())
    .filter(Boolean);

  if (!userLines.length) return null;

  // 1) Hebrew "השם שלי <name>" patterns
  for (const line of userLines.slice(0, 3)) {
    const m = line.match(/\bהשם\s+שלי\s+([^,.!?]+)[,.!?]?/);
    if (m && m[1]) {
      const cand = m[1].trim();
      if (cand.length >= 2 && cand.length <= 40 && !/\d/.test(cand)) return cand;
    }
  }

  // 2) First user answer after the name question is usually just the name.
  const cand = userLines[0].replace(/["'“”]/g, "").trim();
  if (cand.length >= 2 && cand.length <= 40 && !/\d/.test(cand)) return cand;
  return null;
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

function deriveSubjectAndReason(parsed, transcriptText) {
  const p = parsed || {};

  let subject = safeStr(p.subject) || null;
  let reason = safeStr(p.reason) || null;
  let notes = safeStr(p.notes) || null;

  const t = safeStr(transcriptText);
  if (t && (!subject || !reason || !notes)) {
    const hasReports = /דוח|דוחות/.test(t);
    const hasMasHachnasa = /מס הכנסה/.test(t);
    const hasVat = /מע"?מ|מעמ/.test(t);
    const years = Array.from(t.matchAll(/20\d{2}/g)).map((m) => m[0]);
    const year = years.length ? years[years.length - 1] : null;
    const urgent = /דחוף|בהקדם/.test(t);

    if (!subject && hasReports) {
      if (hasVat && hasMasHachnasa) subject = 'בקשת דוחות מע"מ ומס הכנסה';
      else if (hasMasHachnasa) subject = 'בקשת דוחות מס הכנסה';
      else if (hasVat) subject = 'בקשת דוחות מע"מ';
      else subject = 'בקשת דוחות';
      if (year) subject += ` ${year}`;
    }

    if (!reason && hasReports) {
      reason = 'המתקשר ביקש דוחות';
      if (hasVat && hasMasHachnasa) reason += ' מע"מ ומס הכנסה';
      else if (hasMasHachnasa) reason += ' מס הכנסה';
      else if (hasVat) reason += ' מע"מ';
      if (year) reason += ` לשנת ${year}`;
      if (urgent) reason += ' (דחוף)';
    }

    if (!notes && urgent) {
      notes = 'המתקשר ציין שהבקשה דחופה.';
    }
  }

  return { subject, reason, notes };
}
function buildFinalPayload({ event, call, lead, recording }) {
  const tz = call?.timeZone || "UTC";
  const { call_date, call_time } = formatDateTimeParts(new Date(call?.ended_at || Date.now()), tz);

  const payload = {
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
    recording_provider: safeStr(recording?.recording_provider),
    recording_sid: safeStr(recording?.recording_sid),
    decision_reason: safeStr(lead?.decision_reason),
  };

  return compactTopLevel(payload);
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

  // Keep transcriptText in outer scope (used in both success + error paths)
  let transcriptText = "";

  // 1) CALL_LOG (always, if enabled)
  try {
    if (isTrue(env.CALL_LOG_AT_START) && env.CALL_LOG_MODE === "start") {
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
    // In this runtime, we store the full transcript in snapshot.lead.notes
    // (see vendor/geminiLiveSession.js). Keep backwards-compatible fallbacks.
    transcriptText =
      snapshot?.lead?.transcriptText ||
      snapshot?.lead?.notes ||
      snapshot?.transcriptText ||
      snapshot?.notes ||
      "";

    const shouldParse = !!env.LEAD_PARSER_ENABLED;

    if (shouldParse) {
      log.info?.("Postcall lead parser start", { callSid: call.callSid, chars: transcriptText.length });
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
      log.info?.("Postcall lead parser done", { callSid: call.callSid, has_full_name: !!safeStr(parsed?.full_name) });
    }
  } catch (e) {
    log.warn?.("Lead postcall parsing failed", {
      callSid: call.callSid,
      error: e?.message || String(e),
      stack: e?.stack || null,
    });
  }

  const parsedDerived = deriveSubjectAndReason(parsed || {});

  const lead = {
    // GilSport parity: prefer deterministic LeadGate values from runtime; LLM is fallback only.
    full_name:
      safeStr(snapshot?.lead?.full_name) ||
      safeStr(parsed?.full_name) ||
      // Deterministic fallback (no LLM dependency for lead status):
      extractNameDeterministicFromTranscript(
        snapshot?.lead?.notes || snapshot?.lead?.transcriptText || snapshot?.transcriptText || ""
      ) ||
      null,
    subject: safeStr(snapshot?.lead?.subject) || parsedDerived.subject || null,
    reason: safeStr(snapshot?.lead?.reason) || parsedDerived.reason || null,
    phone_number: safeStr(parsed?.phone_number) || null,
    prefers_caller_id: typeof parsed?.prefers_caller_id === "boolean" ? parsed.prefers_caller_id : null,
    // SSOT LEAD_PARSER_PROMPT returns callback_to_number + notes. We keep legacy field names for CRM.
    phone_additional: safeStr(parsed?.callback_to_number) || safeStr(parsed?.phone_additional) || null,
    // GilSport parity: parsing_summary must be an LLM CRM-style summary, not raw transcript.
    parsing_summary: safeStr(parsed?.notes) || safeStr(parsed?.parsing_summary) || null,
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
