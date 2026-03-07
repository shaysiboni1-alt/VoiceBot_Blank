"use strict";

function nowIso() {
  return new Date().toISOString();
}

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (["anonymous", "restricted", "unavailable", "unknown", "private", "withheld"].includes(low)) {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = (text || "").trim();
  if (!t) return "";
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני(?: זה)?|מדבר(?:ת)?)\s+([^\n,.!?]{2,40})/u);
  if (m && m[1]) {
    const candidate = m[1].trim().replace(/\s+/g, " ");
    if (/^[\p{Script=Hebrew}\p{Script=Latin}\s]{2,40}$/u.test(candidate)) return candidate;
  }
  return "";
}

function extractPhone(text) {
  const digits = (text || "").replace(/\D/g, "");
  if (!digits) return "";
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
    returning_caller: !!caller_profile,
    returning_name: caller_profile?.display_name || caller_profile?.full_name || "",
    returning_last_subject: caller_profile?.last_subject || "",
    returning_last_ended_at: caller_profile?.last_ended_at || null,
    language_locked: "he",
    language_observed: [],
    closing_detected: false,
    affirmed_callback_number: false,
    name: "",
    callback_number: callerInfo.withheld ? "" : callerInfo.value,
    has_request: false,
    transcript: [],
  };
}

function appendUtterance(ctx, u) {
  if (!ctx) return;
  const role = u?.role || "";
  const text = String(u?.text || "");
  const normalized = u?.normalized;
  const lang = u?.lang;
  ctx.transcript.push({ role, text, normalized, lang, ts: nowIso() });
  if (lang) ctx.language_observed.push(lang);
  if (u?.language_locked) ctx.language_locked = u.language_locked;
  if (u?.is_closing) ctx.closing_detected = true;
  if (u?.affirmed_callback_number) ctx.affirmed_callback_number = true;

  if (role !== "user") return;
  const effective = String(normalized || text).trim();
  if (!effective) return;
  const n = extractNameHe(effective);
  if (n) ctx.name = n.trim();
  if (effective.length >= 6) ctx.has_request = true;
  const p = extractPhone(effective);
  if (p) ctx.callback_number = p;
}

function finalizeCtx(ctx) {
  if (!ctx) return null;
  ctx.ended_at = nowIso();
  return ctx;
}

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
  if (callMeta.startTs) ctx.started_at = new Date(callMeta.startTs).toISOString();
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
