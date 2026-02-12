// src/stage4/finalizePipeline.js
"use strict";

/*
  FINALIZE PIPELINE (GilSport-style, adapted to VoiceBot_Blank)

  Non-negotiables:
  - Must not affect audio (runs post-call)
  - Always send CALL_LOG (if enabled via ENV)
  - Send FINAL xor ABANDONED
  - Lead parsing is post-call via SSOT LEAD_PARSER_PROMPT (JSON-only)
  - Attach recording_url_public/recording_sid/recording_provider when available (best-effort)

  Decision rule (locked):
  - FINAL: full_name + subject + callback_to_number
  - ABANDONED: callback_to_number only
*/

const { parseLeadPostcall } = require("./postcallLeadParser");
const { upsertCallerProfile } = require("../memory/callerMemory");

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

function buildTranscriptFromConversationLog(conversationLog) {
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

function deriveDisplayNameFromConversationLog(conversationLog) {
  // Deterministic heuristic: the first user utterance after the opening question is usually the name.
  // We only accept short, non-numeric strings (<= 3 words, <= 24 chars) and avoid punctuation-only.
  const rows = Array.isArray(conversationLog) ? conversationLog : [];

  for (const r of rows) {
    if (String(r?.role || '').toLowerCase() !== 'user') continue;
    let t = String(r?.text || '').trim();
    if (!t) continue;

    // Strip common punctuation
    t = t.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    t = t.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '').trim();
    if (!t) continue;

    // Reject obvious non-names
    if (/[0-9]/.test(t)) continue;
    if (t.length > 24) continue;

    const words = t.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 3) continue;

    // Require some letters (Hebrew/Latin); avoid single-character noise.
    if (t.length < 2) continue;
    if (!/\p{L}/u.test(t)) continue;

    return words.join(' ');
  }

  return null;
}



function deriveSubjectFromConversationLog(conversationLog, displayNameMaybe) {
  // Deterministic fallback: pick the first meaningful user utterance that is not just a name/yes/no.
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  const dn = (displayNameMaybe || "").trim();

  for (const r of rows) {
    if (String(r?.role || '').toLowerCase() !== 'user') continue;
    let t = String(r?.text || '').trim();
    if (!t) continue;

    // Strip punctuation edges
    t = t.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '').trim();
    if (!t) continue;

    const tl = t.toLowerCase();
    if (tl === "כן" || tl === "לא" || tl === "ok" || tl === "okay" || tl === "yes" || tl === "no") continue;

    // If it's exactly the name (or contains only the name), skip
    if (dn && (t === dn || t === `אני ${dn}` || t === `שמי ${dn}` || t === `קוראים לי ${dn}`)) continue;

    // Must have at least 2 words or be a sentence-like utterance
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 2 && t.length < 6) continue;

    return t.slice(0, 180);
  }

  return null;
}
function normalizeParsedLead(parsed, call) {
  const lead = {
    full_name: safeStr(parsed?.full_name),
    subject: safeStr(parsed?.subject),
    callback_to_number: safeStr(parsed?.callback_to_number),
    notes: safeStr(parsed?.notes),
  };

  // GilSport parity: if caller ID exists and is not withheld, allow it to be the callback number.
  if (!lead.callback_to_number) {
    const caller = safeStr(call?.caller);
    const withheld = !!call?.caller_withheld;
    if (caller && !withheld) lead.callback_to_number = caller;
  }

  return lead;
}

function decideEvent(lead) {
  const hasPhone = !!safeStr(lead?.callback_to_number);
  const hasName = !!safeStr(lead?.full_name);
  const hasSubject = !!safeStr(lead?.subject);

  if (hasPhone && hasName && hasSubject) return { event: "FINAL", decision_reason: "ok" };
  if (hasPhone) return { event: "ABANDONED", decision_reason: "phone_only" };
  return { event: "ABANDONED", decision_reason: "missing_phone" };
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function enhanceSubjectDeterministic({ subject, conversationLog }) {
  const base = safeStr(subject);
  const rows = Array.isArray(conversationLog) ? conversationLog : [];
  const userText = rows
    .filter((r) => String(r?.role || "") === "user")
    .map((r) => String(r?.text || "").trim())
    .filter(Boolean)
    .join(" \n");

  if (!userText) return base;

  const t = userText.replace(/\s+/g, " ").trim();
  const tl = t.toLowerCase();

  const flags = {
    reports: /(\bדוח|\bדוחות|דו"?חות)/.test(t),
    vat: /(מע"?מ|מעמ)/.test(t),
    incomeTax: /(מס\s*הכנסה)/.test(t),
    urgent: /(דחוף|בהקדם)/.test(t),
  };

  // Years like 2024
  const years = uniq((t.match(/\b(19|20)\d{2}\b/g) || []));

  // Period fragments / ranges (keep as-is; do NOT guess)
  const periodFragments = uniq((t.match(/\b\d{1,2}\s*-\s*\d{1,2}\b/g) || []).map((s) => s.replace(/\s+/g, "")));
  const weirdFragments = uniq((t.match(/\b\d{2}\s*-\s*\d\b/g) || []).map((s) => s.replace(/\s+/g, "")));
  const singleDigits = uniq((t.match(/\b\d\b/g) || []));

  const parts = [];

  // Build a richer subject (still concise) from what was actually said.
  if (flags.reports) {
    const taxParts = [];
    if (flags.vat) taxParts.push('מע"מ');
    if (flags.incomeTax) taxParts.push("מס הכנסה");
    const taxStr = taxParts.length ? ` (${taxParts.join(" + ")})` : "";
    parts.push(`דוחות${taxStr}`);
  }

  if (years.length) parts.push(`שנה/ים: ${years.join(", ")}`);

  // If we have explicit ranges, prefer those. If we only have fragments like 20-2 + 5, keep them verbatim.
  const allPeriods = uniq([...periodFragments, ...weirdFragments]);
  if (allPeriods.length) {
    parts.push(`תקופות: ${allPeriods.join(", ")}`);
  } else {
    // Only add single digits if there's context around "תקופות" to avoid noise.
    if (tl.includes("תקופ") && singleDigits.length) {
      parts.push(`תקופות (כפי שנאמר): ${singleDigits.join(", ")}`);
    }
  }

  if (flags.urgent) parts.push("דחוף");

  // If we built nothing new, keep as-is.
  if (!parts.length) return base;

  const enriched = parts.join(" – ");

  // Merge with existing subject if it contains additional useful info.
  if (base) {
    const baseNorm = base.toLowerCase();
    // If base already includes most of what we built, keep base.
    const overlap = parts.every((p) => baseNorm.includes(p.toLowerCase().split(" ")[0]));
    if (overlap && base.length >= enriched.length) return base;
    // Otherwise: combine without duplicating.
    if (baseNorm.includes("דוח") || baseNorm.includes("דוחות")) {
      return `${base} – ${enriched}`.slice(0, 180);
    }
    return `${enriched} – ${base}`.slice(0, 180);
  }

  return enriched.slice(0, 180);
}

async function finalizePipeline({ snapshot, ssot, env, logger, senders }) {
  const log = logger || console;

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
    duration_sec:
      snapshot?.call?.duration_sec ??
      secondsFromMs(snapshot?.call?.duration_ms ?? snapshot?.duration_ms),
    finalize_reason: snapshot?.call?.finalize_reason || snapshot?.finalize_reason || null,
    passive_context: snapshot?.call?.passive_context || null,
  };

  const conversationLog = Array.isArray(snapshot?.conversationLog)
    ? snapshot.conversationLog
    : Array.isArray(snapshot?.call?.conversationLog)
      ? snapshot.call.conversationLog
      : [];

  // 1) Resolve recording (best-effort) BEFORE webhooks so all events can include it.
  let recording = {
    recording_provider: null,
    recording_sid: null,
    recording_url_public: null,
  };
  try {
    if (env.MB_ENABLE_RECORDING && typeof senders?.resolveRecording === "function") {
      recording = await senders.resolveRecording(call.callSid);
    }
  } catch (e) {
    log.warn?.("Resolve recording failed", e?.message || e);
  }

  // 2) Post-call lead parsing (SSOT prompt inside parseLeadPostcall)
  let parsedRaw = null;
  try {
    const transcriptText = buildTranscriptFromConversationLog(conversationLog);
    const shouldParse = isTrue(env.LEAD_PARSER_ENABLED) || !!env.LEAD_PARSER_ENABLED;

    if (shouldParse) {
      parsedRaw = await parseLeadPostcall({
        transcriptText,
        ssot,
        known: {
          caller_id_e164: safeStr(call?.caller) || null,
        },
        env,
        logger: log,
      });
    }
  } catch (e) {
    log.warn?.("Lead postcall parsing failed", e?.message || e);
  }

  const parsedLead = normalizeParsedLead(parsedRaw || {}, call);

// Deterministic fallbacks (do NOT change payload structure):
// - If postcall parser missed the caller's name but we captured it in-call, use it.
const capturedCallerName = safeStr(snapshot?.call?.caller_name) || safeStr(snapshot?.call?.callerName) || null;
if (!parsedLead.full_name && capturedCallerName) {
  parsedLead.full_name = capturedCallerName;
}

// - If subject is missing, derive from conversation log (first meaningful user utterance).
if (!parsedLead.subject) {
  const derived = deriveSubjectFromConversationLog(conversationLog, parsedLead.full_name);
  if (derived) parsedLead.subject = derived;
}


  // Deterministic enrichment: make subject include key details actually said (without guessing).
  parsedLead.subject = enhanceSubjectDeterministic({
    subject: parsedLead.subject,
    conversationLog,
  });

  // 3) Payload base (shared by all webhooks)
  const payloadBase = {
    call,
    parsedLead,
    conversationLog,
    recording_provider: safeStr(recording?.recording_provider),
    recording_sid: safeStr(recording?.recording_sid),
    recording_url_public: safeStr(recording?.recording_url_public),
  };

  // 4) CALL_LOG (always if enabled)
  try {
    if (env.CALL_LOG_AT_START === "true" && env.CALL_LOG_MODE === "start") {
      // already sent elsewhere
    }
    if (isTrue(env.CALL_LOG_AT_END)) {
      if (env.CALL_LOG_WEBHOOK_URL && typeof senders?.sendCallLog === "function") {
        await senders.sendCallLog({ event: "CALL_LOG", ...payloadBase });
      }
    }
  } catch (e) {
    log.warn?.("CALL_LOG webhook failed", e?.message || e);
  }

  // 5) FINAL xor ABANDONED (deterministic)
  const { event, decision_reason } = decideEvent(parsedLead);
try {
  const hasPhone = !!safeStr(parsedLead?.callback_to_number);
  const hasName = !!safeStr(parsedLead?.full_name);
  const hasSubject = !!safeStr(parsedLead?.subject);
  log.info?.("FINAL_DECISION", {
    callSid: call.callSid,
    event,
    decision_reason,
    hasPhone,
    hasName,
    hasSubject,
    intent_id: safeStr(snapshot?.call?.intent_id) || "other",
  });
} catch { /* ignore */ }

  const finalPayload = {
    event,
    decision_reason,
    ...payloadBase,
  };

  // Propagate the detected intent_id into FINAL payload (required by spec).
  // Keep ABANDONED unchanged unless explicitly requested.
  const snapshotIntentId =
    safeStr(snapshot?.call?.intent_id) ||
    safeStr(snapshot?.intent_id) ||
    null;
  if (event === "FINAL") {
    finalPayload.intent_id = snapshotIntentId || "other";
  }

  const derivedDisplayName =
    finalPayload?.parsedLead?.full_name || deriveDisplayNameFromConversationLog(conversationLog) || null;

  if (event === "FINAL") {
    if (env.FINAL_WEBHOOK_URL && typeof senders?.sendFinal === "function") {
      await senders.sendFinal(finalPayload);
    }

    // Best-effort caller memory update (does not affect leads/webhooks)
    try {
      await upsertCallerProfile({
        caller: finalPayload?.call?.caller,
        display_name: derivedDisplayName,
        meta_patch: {
          last_subject: finalPayload?.parsedLead?.subject || null,
          last_notes: finalPayload?.parsedLead?.notes || null,
          last_callSid: finalPayload?.call?.callSid || null,
        },
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
  } else {
    if (env.ABANDONED_WEBHOOK_URL && typeof senders?.sendAbandoned === "function") {
      await senders.sendAbandoned(finalPayload);
    }

    // Also remember abandoned calls (optional)
    try {
      await upsertCallerProfile({
        caller: finalPayload?.call?.caller,
        display_name: derivedDisplayName,
        meta_patch: {
          last_subject: finalPayload?.parsedLead?.subject || null,
          last_notes: finalPayload?.parsedLead?.notes || null,
          last_callSid: finalPayload?.call?.callSid || null,
        },
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
  }

  return { status: "ok", event };
}

module.exports = { finalizePipeline };
