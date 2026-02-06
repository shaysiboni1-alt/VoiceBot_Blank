// src/logic/leadParsing.js
import { normalizePhone } from "../utils/phone.js";

export function extractHebrewSpokenDigits(text = "") {
  const map = {
    "אפס": "0","אחת":"1","אחד":"1","שתיים":"2","שתים":"2","שניים":"2",
    "שלוש":"3","ארבע":"4","חמש":"5","שש":"6","שבע":"7","שמונה":"8","תשע":"9"
  };
  let out = "";
  text.split(/\s+/).forEach(w => {
    if (map[w]) out += map[w];
    else if (/\d/.test(w)) out += w.replace(/\D/g,"");
  });
  return out.length >= 7 ? out : null;
}

export function extractPhones(text) {
  const rawDigits = text.replace(/[^\d]/g, "");
  const spoken = extractHebrewSpokenDigits(text);
  const candidates = [];
  if (rawDigits.length >= 7) candidates.push(rawDigits);
  if (spoken) candidates.push(spoken);
  return [...new Set(candidates)].map(normalizePhone).filter(Boolean);
}

export function isValidSubject(subject, minWords = 3) {
  if (!subject) return false;
  return subject.trim().split(/\s+/).length >= minWords;
}

export function buildLeadSnapshot(ctx) {
  const {
    full_name,
    subject,
    caller_id_e164,
    callback_to_number,
    transcriptText
  } = ctx;

  return {
    full_name: full_name || null,
    subject: subject || null,
    caller_id_e164: caller_id_e164 || null,
    callback_to_number: callback_to_number || null,
    transcriptText: transcriptText || ""
  };
}

export function leadGate(snapshot, subjectMinWords) {
  if (!snapshot.full_name) return { ok:false, reason:"missing_name" };
  if (!isValidSubject(snapshot.subject, subjectMinWords))
    return { ok:false, reason:"missing_subject" };
  if (!snapshot.caller_id_e164)
    return { ok:false, reason:"missing_caller_id" };
  if (!snapshot.callback_to_number)
    return { ok:false, reason:"missing_callback" };
  return { ok:true };
}
