"use strict";

/*
  Finalize Pipeline (GilSport‑style) for VoiceBot_Blank

  This module runs after each call to build and dispatch webhook payloads. It:
    - Resolves recording metadata via senders.resolveRecording() and downloads
      the MP3 from Twilio using downloadRecording() when possible, to provide
      a stable /recordings URL.
    - Builds a transcript of the conversation and parses it through the
      post‑call lead parser (Gemini) to extract intent, full_name, phone,
      subject, notes, brand, model and a parsing summary.
    - Applies deterministic fallbacks when the LLM fails: uses the passive
      context and conversation heuristics to fill missing name/phone/subject,
      and uses intentRouter.detectIntent if no intent was returned.
    - Decides whether the call is FINAL or ABANDONED based on the presence
      of a name (>=2 chars), a subject and a callback number.
    - Builds a payload containing the call metadata, call_status (completed/
      abandoned), event (FINAL/ABANDONED), parsedLeadCollection (with
      isFullLead flag), recording information and the full conversation log.
    - Sends CALL_LOG, FINAL or ABANDONED webhooks using the senders object.
    - Updates the caller memory table with the last name/subject/notes so that
      returning callers are greeted by name.

  The function never throws outward; errors are logged and processing continues.
*/

const { parseLeadPostcall } = require("./postcallLeadParser");
const { upsertCallerProfile } = require("../memory/callerMemory");
const { detectIntent } = require("../logic/intentRouter");
const { downloadRecording } = require("../utils/twilioRecordings");

// -- Helper functions --

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

// Build a USER/BOT transcript from the conversation log for LLM parsing.
function buildTranscript(conversationLog) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  return rows
    .map((r) => {
      const role = String(r?.role || "").toUpperCase();
      const text = String(r?.text || "").trim();
      if (!text) return "";
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

// Heuristic to derive a display name from the conversation log when the LLM
// didn't return one. Looks for the first short user utterance with letters.
function deriveDisplayNameFromConversationLog(conversationLog) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  for (const r of rows) {
    if (String(r?.role || "").toLowerCase() !== "user") continue;
    let t = String(r?.text || "").trim();
    if (!t) continue;
    // Remove control chars and punctuation
    t = t.replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();
    t = t.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "").trim();
    if (!t) continue;
    if (/[0-9]/.test(t)) continue;
    if (t.length > 24) continue;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 3) continue;
    if (t.length < 2) continue;
    if (!/\p{L}/u.test(t)) continue;
    return words[0];
  }
  return null;
}

// Normalize the raw lead and fill missing fields from known values and heuristics.
function normalizeLead(parsed, call, knownFullName, knownPhone, conversationLog, ssot) {
  const out = {
    intent: null,
    full_name: null,
    callback_to_number: null,
    subject: null,
    notes: null,
    brand: null,
    model: null,
  };
  if (parsed && typeof parsed === "object") {
    for (const k of Object.keys(out)) {
      const v = parsed[k];
      if (typeof v === "string") {
        const s = v.trim();
        out[k] = s || null;
      }
    }
  }
  // Name fallback: use known full name from passive context or heuristic
  if (!out.full_name) {
    if (knownFullName) {
      out.full_name = safeStr(knownFullName);
    } else {
      const derived = deriveDisplayNameFromConversationLog(conversationLog);
      if (derived) out.full_name = safeStr(derived);
    }
  }
  // Phone fallback: use known phone from passive context or caller ID (if not withheld)
  if (!out.callback_to_number) {
    if (knownPhone) {
      out.callback_to_number = safeStr(knownPhone);
    } else {
      const caller = safeStr(call?.caller);
      const withheld = !!call?.caller_withheld;
      if (caller && !withheld) {
        out.callback_to_number = caller;
      }
    }
  }
  // Intent fallback: call detectIntent on the transcript if missing
  if (!out.intent) {
    try {
      const transcript = buildTranscript(conversationLog);
      const fallback = detectIntent({ text: transcript, intents: ssot?.intents || [] });
      out.intent = fallback?.intent_id || null;
    } catch {
      /* ignore errors in fallback intent detection */
    }
  }
  return out;
}

// When LLM didn't return a subject, derive a short subject from the last
// meaningful user utterance, truncated to 180 characters.
function deriveSubjectFromConversationLog(conversationLog) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  const userUtterances = rows
    .filter((r) => String(r?.role || "").toLowerCase() === "user")
    .map((r) => String(r?.text || "").trim())
    .filter(Boolean);
  if (!userUtterances.length) return null;
  const last = userUtterances[userUtterances.length - 1];
  return last.length > 180 ? last.slice(0, 180) : last;
}

// Decide FINAL vs ABANDONED event. A final lead requires name (>=2 chars),
// subject and phone. Missing name yields ABANDONED even if phone & subject exist.
function decideEvent(lead) {
  const nameVal = safeStr(lead?.full_name);
  const phoneVal = safeStr(lead?.callback_to_number);
  const subjVal = safeStr(lead?.subject);
  const hasName = nameVal && nameVal.length >= 2;
  const hasPhone = !!phoneVal;
  const hasSubject = !!subjVal;
  if (hasName && hasPhone && hasSubject) {
    return { event: "FINAL", decision_reason: "ok" };
  }
  if (!hasName && hasPhone && hasSubject) {
    return { event: "ABANDONED", decision_reason: "no_name" };
  }
  if (hasPhone && !hasSubject) {
    return { event: "ABANDONED", decision_reason: "no_subject" };
  }
  if (!hasPhone && hasSubject) {
    return { event: "ABANDONED", decision_reason: "no_phone" };
  }
  return { event: "ABANDONED", decision_reason: "partial" };
}

// -- Main function: finalizePipeline --

async function finalizePipeline({ snapshot, ssot, env, logger, senders }) {
  const log = logger || console;
  try {
    // 1) Assemble call metadata from the snapshot
    const call = {
      callSid: snapshot?.call?.callSid || snapshot?.callSid || null,
      streamSid: snapshot?.call?.streamSid || snapshot?.streamSid || null,
      caller: snapshot?.call?.caller || snapshot?.caller || null,
      caller_withheld: !!(snapshot?.call?.caller_withheld ?? snapshot?.caller_withheld),
      called: snapshot?.call?.called || snapshot?.called || null,
      source: snapshot?.call?.source || snapshot?.source || "VoiceBot_Blank",
      started_at: snapshot?.call?.started_at || snapshot?.started_at || null,
      ended_at: snapshot?.call?.ended_at || snapshot?.ended_at || null,
      duration_ms:
        snapshot?.call?.duration_ms ?? snapshot?.duration_ms ?? null,
      duration_sec:
        snapshot?.call?.duration_sec ??
        secondsFromMs(snapshot?.call?.duration_ms ?? snapshot?.duration_ms),
      finalize_reason: snapshot?.call?.finalize_reason || snapshot?.finalize_reason || null,
      passive_context: snapshot?.call?.passive_context || null,
    };

    // 2) Extract the full conversation log
    const conversationLog = Array.isArray(snapshot?.conversationLog)
      ? snapshot.conversationLog
      : Array.isArray(snapshot?.call?.conversationLog)
        ? snapshot.call.conversationLog
        : [];

    // 3) Resolve recording via the Twilio WS / registry. Best effort.
    let recording = {
      recording_provider: null,
      recording_sid: null,
      recording_url_public: null,
    };
    if (env.MB_ENABLE_RECORDING && typeof senders?.resolveRecording === "function") {
      try {
        recording = await senders.resolveRecording();
      } catch (e) {
        log.warn?.("Resolve recording failed", e?.message || e);
      }
    }

    // 4) Download recording from Twilio API and save locally. If successful,
    // update recording_url_public to point at /recordings/<sid>.mp3.
    if (recording?.recording_sid) {
      try {
        const downloaded = await downloadRecording(recording.recording_sid, log);
        if (downloaded?.publicUrl) {
          recording.recording_url_public = downloaded.publicUrl;
        }
      } catch (e) {
        log.warn?.("Local download of recording failed", e?.message || e);
      }
    }

    // 5) Build transcript and parse the lead via LLM
    const transcript = buildTranscript(conversationLog);
    const knownFullName = safeStr(call?.passive_context?.name);
    const knownPhone = safeStr(call?.passive_context?.callback_number);
    let parsed = null;
    if (isTrue(env.LEAD_PARSER_ENABLED) || env.LEAD_PARSER_ENABLED) {
      try {
        parsed = await parseLeadPostcall({
          transcriptText: transcript,
          turns: conversationLog,
          ssot,
          known: { full_name: knownFullName, callback_to_number: knownPhone },
        });
      } catch (e) {
        log.warn?.("Postcall lead parsing failed", e?.message || e);
      }
    }

    // 6) Normalize and fill missing fields; apply fallbacks
    const parsedLead = normalizeLead(parsed || {}, call, knownFullName, knownPhone, conversationLog, ssot);
    // Derive subject if missing
    if (!parsedLead.subject) {
      const derived = deriveSubjectFromConversationLog(conversationLog);
      if (derived) parsedLead.subject = derived;
    }

    // 7) Decide on event (FINAL/ABANDONED) and call_status
    const { event, decision_reason } = decideEvent(parsedLead);
    const call_status = event === "FINAL" ? "completed" : "abandoned";

    // 8) Build the payload that will be sent to webhooks
    const payloadBase = {
      call,
      call_status,
      status: call_status, // alias for backward compatibility
      event,
      decision_reason,
      intent: safeStr(parsedLead.intent),
      recording_provider: safeStr(recording?.recording_provider),
      recording_sid: safeStr(recording?.recording_sid),
      recording_url_public: safeStr(recording?.recording_url_public),
      conversationLog,
      parsedLeadCollection: {
        intent: safeStr(parsedLead.intent),
        full_name: safeStr(parsedLead.full_name),
        callback_to_number: safeStr(parsedLead.callback_to_number),
        subject: safeStr(parsedLead.subject),
        notes: safeStr(parsedLead.notes),
        brand: safeStr(parsedLead.brand),
        model: safeStr(parsedLead.model),
        isFullLead: event === "FINAL",
      },
    };

    // 9) Dispatch CALL_LOG webhook at end, if enabled
    try {
      if (isTrue(env.CALL_LOG_AT_END)) {
        if (env.CALL_LOG_WEBHOOK_URL && typeof senders?.sendCallLog === "function") {
          await senders.sendCallLog({ ...payloadBase, label: "CALL_LOG" });
        }
      }
    } catch (e) {
      log.warn?.("CALL_LOG webhook failed", e?.message || e);
    }

    // 10) Dispatch FINAL or ABANDONED webhook
    try {
      if (event === "FINAL") {
        if (env.FINAL_WEBHOOK_URL && typeof senders?.sendFinal === "function") {
          await senders.sendFinal({ ...payloadBase });
        }
      } else {
        if (env.ABANDONED_WEBHOOK_URL && typeof senders?.sendAbandoned === "function") {
          await senders.sendAbandoned({ ...payloadBase });
        }
      }
    } catch (e) {
      log.warn?.("Lead webhook failed", e?.message || e);
    }

    // 11) Update caller memory (best effort). Store the name, subject and notes.
    try {
      const displayName =
        safeStr(parsedLead.full_name) ||
        deriveDisplayNameFromConversationLog(conversationLog) ||
        null;
      await upsertCallerProfile({
        caller: call?.caller,
        full_name: displayName,
        last_subject: safeStr(parsedLead.subject),
        last_notes: safeStr(parsedLead.notes),
        callSid: call?.callSid,
      });
    } catch (e) {
      log.debug?.("Caller memory update failed", {
        message: e?.message || String(e),
        code: e?.code,
        detail: e?.detail,
        hint: e?.hint,
        where: e?.where,
      });
    }

    return { status: "ok", event };
  } catch (e) {
    log.warn?.("finalizePipeline error", e?.message || e);
    return { status: "error", event: "ERROR" };
  }
}

module.exports = { finalizePipeline };
