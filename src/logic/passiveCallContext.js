"use strict";

// src/logic/passiveCallContext.js
// Passive, non-breaking call context aggregator.
// Goal: capture name / callback number / request readiness deterministically,
// while letting SSOT-driven LLM run the conversation.

function nowIso() {
  return new Date().toISOString();
}

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };

  // Common Twilio/telephony withheld values
  if (
    low === "anonymous" ||
    low === "restricted" ||
    low === "unavailable" ||
    low === "unknown" ||
    low === "private" ||
    low === "withheld"
  ) {
    return { value: s, withheld: true };
  }

  const digits = s.replace(/\D/g, "");
  // If it has enough digits, treat as not withheld
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = (text || "").trim();
  if (!t) return "";

  // Common patterns
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return m[1].trim();

  // Fallback: short single token, no digits
  if (t.length <= 25 && !/[0-9]/.test(t)) {
    return t.replace(/^אה+[, ]*/g, "").trim();
  }
  return "";
}

function extractPhone(text) {
  const digits = (text || "").replace(/\D/g, "");
  if (!digits) return "";

  // Israeli heuristic
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return "+" + digits;
    if (digits.startsWith("0") && digits.length === 10) return "+972" + digits.slice(1);
    return digits;
  }
  return "";
}

function createPassiveCallContext({ callSid, streamSid, caller, called, source, caller_profile }) {
  const callerInfo = normalizeCallerId(caller);

  return {
    callSid: callSid || "",
    streamSid: streamSid || "",
    source: source || "VoiceBot_Blank",
    caller_raw: callerInfo.value,
    caller_withheld: callerInfo.withheld,
    called: called || "",
    started_at: nowIso(),
    ended_at: null,

    // Optional caller recognition (DB-backed)
    returning_caller: !!caller_profile,
    returning_name: caller_profile?.full_name || "",
    returning_last_subject: caller_profile?.last_subject || "",
    returning_last_ended_at: caller_profile?.last_ended_at || null,

    // Lead fields (captured during conversation)
    name: "",
    callback_number: callerInfo.withheld ? "" : callerInfo.value,
    has_request: false,

    // Conversation tracking
    transcript: [], // {role,text,normalized,lang,ts}
  };
}

function appendUtterance(ctx, u) {
  if (!ctx) return;

  const role = u?.role || "";
  const text = String(u?.text || "");
  const normalized = u?.normalized;
  const lang = u?.lang;

  ctx.transcript.push({
    role,
    text,
    normalized,
    lang,
    ts: nowIso(),
  });

  if (role !== "user") return;

  const effective = String(normalized || text).trim();
  if (!effective) return;

  // Always attempt to extract a name from the user's utterance.
  // If the caller corrects or provides a new name later in the call, update it.
  const n = extractNameHe(effective);
  if (n) {
    ctx.name = n.trim();
  }

  // Mark that the caller has made a request once they say more than a few characters.
  if (effective.length >= 6) {
    ctx.has_request = true;
  }

  // Always attempt to extract a phone number from user utterances.
  // This allows callers to override or correct their callback number during the call,
  // even if the original caller ID was not withheld.
  const p = extractPhone(effective);
  if (p) {
    ctx.callback_number = p;
  }
}

function finalizeCtx(ctx) {
  if (!ctx) return null;
  ctx.ended_at = nowIso();
  return ctx;
}

// Backwards-compatible helper expected by geminiLiveSession.
// Produces the passive context object that is injected into prompts/webhooks.
function buildPassiveContext({ meta, ssot }) {
  const callMeta = meta || {};
  const ctx = createPassiveCallContext({
    callSid: callMeta.callSid,
    streamSid: callMeta.streamSid,
    caller: callMeta.caller,
    called: callMeta.called,
    source: callMeta.source,
    caller_profile: callMeta.caller_profile || null,
  });

  // Attach start time if available
  if (callMeta.startTs) ctx.started_at = new Date(callMeta.startTs).toISOString();

  // Also expose a small settings context (no secrets)
  if (ssot && typeof ssot.getSetting === "function") {
    ctx.time_zone = ssot.getSetting("TIME_ZONE") || null;
    ctx.supported_languages = ssot.getSetting("SUPPORTED_LANGUAGES") || null;
  }

  return ctx;
}

module.exports = {
  createPassiveCallContext,
  buildPassiveContext,
  appendUtterance,
  finalizeCtx,
};
