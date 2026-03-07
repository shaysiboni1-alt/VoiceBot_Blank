"use strict";

const { parseLeadPostcall } = require("./postcallLeadParser");
const { upsertCallerProfile } = require("../memory/callerMemory");
const { detectIntent } = require("../logic/intentRouter");
const { downloadRecording } = require("../utils/twilioRecordings");

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
function buildTranscript(conversationLog) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  return rows.map((r) => {
    const role = String(r?.role || "").toUpperCase();
    const text = String(r?.text || "").trim();
    if (!text) return "";
    return `${role}: ${text}`;
  }).filter(Boolean).join("\n");
}
function deriveDisplayNameFromConversationLog(conversationLog) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  for (const r of rows) {
    if (String(r?.role || "").toLowerCase() !== "user") continue;
    let t = String(r?.text || "").trim();
    if (!t) continue;
    t = t.replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();
    t = t.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "").trim();
    if (!t || /[0-9]/.test(t) || t.length > 24 || t.length < 2) continue;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 3) continue;
    if (!/\p{L}/u.test(t)) continue;
    return words[0];
  }
  return null;
}
function deriveSubjectFromConversationLog(conversationLog) {
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  const userUtterances = rows.filter((r) => String(r?.role || "").toLowerCase() === "user").map((r) => String(r?.text || "").trim()).filter(Boolean);
  if (!userUtterances.length) return null;
  const last = userUtterances[userUtterances.length - 1];
  return last.length > 180 ? last.slice(0, 180) : last;
}
function appearsInConversation(num, convLog) {
  const digits = (num || "").replace(/\D/g, "");
  return convLog.some(({ text }) => text && text.replace(/\D/g, "").includes(digits));
}
function normalizeLead(parsed, call, knownFullName, knownPhone, conversationLog, ssot) {
  const out = { intent: null, full_name: null, callback_to_number: null, subject: null, notes: null, brand: null, model: null };
  if (parsed && typeof parsed === "object") {
    for (const k of Object.keys(out)) {
      const v = parsed[k];
      if (v && typeof v === "string") out[k] = v.trim() || null;
    }
  }
  if (!out.full_name) {
    let candidate = knownFullName ? safeStr(knownFullName) : null;
    if (!candidate) {
      const mem = safeStr(call?.passive_context?.returning_name);
      if (mem) candidate = mem;
    }
    if (!candidate) {
      const derived = deriveDisplayNameFromConversationLog(conversationLog);
      candidate = derived ? safeStr(derived) : null;
    }
    if (candidate && /^[\p{Script=Hebrew}\p{Script=Latin}\p{Script=Cyrillic}\s]{2,40}$/u.test(candidate)) out.full_name = candidate;
  }
  if (!out.callback_to_number) {
    if (knownPhone) out.callback_to_number = safeStr(knownPhone);
    else if (safeStr(call?.caller) && !call?.caller_withheld) out.callback_to_number = safeStr(call.caller);
  }
  if (!out.intent) {
    try {
      const transcript = buildTranscript(conversationLog);
      const fallback = detectIntent({ text: transcript, intents: ssot?.intents || [], opts: { forceLang: safeStr(call?.language_locked) || undefined } });
      out.intent = fallback?.intent_id || null;
    } catch {}
  }
  return out;
}
function decideEvent(lead) {
  const nameVal = safeStr(lead?.full_name);
  const phoneVal = safeStr(lead?.callback_to_number);
  const subjVal = safeStr(lead?.subject);
  const hasName = nameVal && nameVal.length >= 2 && /^[\p{Script=Hebrew}\p{Script=Latin}\p{Script=Cyrillic}\s]+$/u.test(nameVal);
  const hasPhone = !!phoneVal;
  const hasSubject = !!subjVal;
  if (hasName && hasPhone && hasSubject) return { event: "FINAL", decision_reason: "ok" };
  if (!hasName && hasPhone && hasSubject) return { event: "ABANDONED", decision_reason: "no_name" };
  if (!hasPhone && hasSubject) return { event: "ABANDONED", decision_reason: "no_phone" };
  if (hasPhone && !hasSubject) return { event: "ABANDONED", decision_reason: "no_subject" };
  return { event: "ABANDONED", decision_reason: "partial" };
}

async function finalizePipeline({ snapshot, ssot, env, logger, senders }) {
  const log = logger || console;
  try {
    const call = {
      callSid: snapshot?.call?.callSid || snapshot?.callSid || null,
      streamSid: snapshot?.call?.streamSid || snapshot?.streamSid || null,
      caller: snapshot?.call?.caller || snapshot?.caller || null,
      caller_withheld: !!(snapshot?.call?.caller_withheld ?? snapshot?.caller_withheld),
      called: snapshot?.call?.called || snapshot?.called || null,
      source: snapshot?.call?.source || snapshot?.source || "VoiceBot_Blank",
      started_at: snapshot?.call?.started_at || snapshot?.started_at || null,
      ended_at: snapshot?.call?.ended_at || snapshot?.ended_at || null,
      duration_ms: snapshot?.call?.duration_ms ?? snapshot?.duration_ms ?? null,
      duration_sec: snapshot?.call?.duration_sec ?? secondsFromMs(snapshot?.call?.duration_ms ?? snapshot?.duration_ms),
      finalize_reason: snapshot?.call?.finalize_reason || snapshot?.finalize_reason || null,
      passive_context: snapshot?.call?.passive_context || null,
      language_locked: snapshot?.call?.language_locked || null,
    };
    const conversationLog = Array.isArray(snapshot?.conversationLog) ? snapshot.conversationLog : (Array.isArray(snapshot?.call?.conversationLog) ? snapshot.call.conversationLog : []);

    let recording = { recording_provider: null, recording_sid: null, recording_url_public: null };
    try {
      if (env.MB_ENABLE_RECORDING && typeof senders?.resolveRecording === "function") recording = await senders.resolveRecording();
    } catch (e) {
      log.warn("Resolve recording failed", { error: e?.message || String(e) });
    }
    if (recording?.recording_sid) {
      try {
        const downloaded = await downloadRecording(recording.recording_sid, log);
        if (downloaded?.publicUrl) recording.recording_url_public = downloaded.publicUrl;
      } catch (e) {
        log.warn("Local download of recording failed", { error: e?.message || String(e) });
      }
    }

    const transcript = buildTranscript(conversationLog);
    const knownFullName = safeStr(call?.passive_context?.name) || safeStr(call?.passive_context?.returning_name);
    const knownPhone = safeStr(call?.passive_context?.callback_number);
    let parsed = null;
    if (isTrue(env.LEAD_PARSER_ENABLED) || env.LEAD_PARSER_ENABLED) {
      try {
        parsed = await parseLeadPostcall({ transcriptText: transcript, turns: conversationLog, ssot, known: { full_name: knownFullName, callback_to_number: knownPhone } });
      } catch (e) {
        log.warn("Postcall lead parsing failed", { error: e?.message || String(e) });
      }
    }

    const parsedLead = normalizeLead(parsed || {}, call, knownFullName, knownPhone, conversationLog, ssot);
    if (!parsedLead.subject) {
      const derived = deriveSubjectFromConversationLog(conversationLog);
      if (derived) parsedLead.subject = derived;
    }
    if (parsedLead.callback_to_number && parsedLead.callback_to_number !== call.caller && !appearsInConversation(parsedLead.callback_to_number, conversationLog)) {
      parsedLead.callback_to_number = call.caller;
    }

    const { event, decision_reason } = decideEvent(parsedLead);
    if (env.MB_LOG_FINALIZE_DECISIONS) {
      log.info("FINALIZE_DECISION", {
        callSid: call.callSid,
        language_locked: call.language_locked,
        known_full_name: knownFullName,
        known_phone: knownPhone,
        parsedLead,
        decision_reason,
        event,
      });
    }

    const call_status = event === "FINAL" ? "completed" : "abandoned";
    const payloadBase = {
      call,
      call_status,
      status: call_status,
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

    try {
      if (isTrue(env.CALL_LOG_AT_END) && env.CALL_LOG_WEBHOOK_URL && typeof senders?.sendCallLog === "function") {
        await senders.sendCallLog({ ...payloadBase, label: "CALL_LOG" });
      }
    } catch (e) {
      log.warn("CALL_LOG webhook failed", { error: e?.message || String(e) });
    }
    try {
      if (event === "FINAL") {
        if (env.FINAL_WEBHOOK_URL && typeof senders?.sendFinal === "function") await senders.sendFinal({ ...payloadBase });
      } else if (env.ABANDONED_WEBHOOK_URL && typeof senders?.sendAbandoned === "function") {
        await senders.sendAbandoned({ ...payloadBase });
      }
    } catch (e) {
      log.warn("Lead webhook failed", { error: e?.message || String(e) });
    }

    try {
      const displayName = safeStr(parsedLead.full_name) || deriveDisplayNameFromConversationLog(conversationLog) || null;
      await upsertCallerProfile({ caller: call?.caller, full_name: displayName, last_subject: safeStr(parsedLead.subject), last_notes: safeStr(parsedLead.notes), callSid: call?.callSid });
    } catch (e) {
      log.debug("Caller memory update failed", { message: e?.message || String(e), code: e?.code, detail: e?.detail, hint: e?.hint, where: e?.where });
    }
    return { status: "ok", event };
  } catch (e) {
    log.warn("finalizePipeline error", { error: e?.message || String(e) });
    return { status: "error", event: "ERROR" };
  }
}

module.exports = { finalizePipeline };
