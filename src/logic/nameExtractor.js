"use strict";

// -----------------------------------------------------------------------------
// Deterministic Caller Name Extractor (no-LLM)
// -----------------------------------------------------------------------------
// Goals:
// - Extract caller's *own* name when spoken anywhere in the call.
// - Be strict (anti-hallucination): only accept with high confidence.
// - Support he/en/ru with simple, conservative heuristics.

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function stripEdgePunct(s) {
  return safeStr(s)
    .replace(/[\u200e\u200f\u202a-\u202e\ufeff]/g, "")
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .trim();
}

function hasDigits(s) {
  return /\d/.test(s);
}

function countWords(s) {
  return stripEdgePunct(s).split(/\s+/).filter(Boolean).length;
}

function looksLikeHebrewNameToken(s) {
  const t = stripEdgePunct(s);
  if (!t) return false;
  if (hasDigits(t)) return false;
  if (!/[\u0590-\u05FF]/.test(t)) return false;
  if (t.length < 2 || t.length > 32) return false;
  const w = countWords(t);
  if (w < 1 || w > 3) return false;
  if (/[\p{P}\p{S}]/u.test(t)) return false;
  return true;
}

function looksLikeEnglishNameToken(s) {
  const t = stripEdgePunct(s);
  if (!t) return false;
  if (hasDigits(t)) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (t.length < 2 || t.length > 40) return false;
  const w = countWords(t);
  if (w < 1 || w > 3) return false;
  // allow apostrophe/hyphen inside
  if (!/^[A-Za-z][A-Za-z'\-\s]+[A-Za-z]$/.test(t)) return false;
  return true;
}

function looksLikeRussianNameToken(s) {
  const t = stripEdgePunct(s);
  if (!t) return false;
  if (hasDigits(t)) return false;
  if (!/[\u0400-\u04FFЁё]/.test(t)) return false;
  if (t.length < 2 || t.length > 40) return false;
  const w = countWords(t);
  if (w < 1 || w > 3) return false;
  if (!/^[\u0400-\u04FFЁё\-\s]+$/.test(t)) return false;
  return true;
}

const HE_REJECT = new Set([
  "כן",
  "לא",
  "בסדר",
  "אוקיי",
  "אוקי",
  "שלום",
  "היי",
  "הי",
  "רגע",
  "תודה",
  "מה",
  "מי",
  "למה",
  "איך",
]);

const EN_REJECT = new Set(["yes", "no", "ok", "okay", "hello", "hi", "thanks", "thank", "wait"]);

const RU_REJECT = new Set(["да", "нет", "ок", "привет", "спасибо", "подожди"]);

function rejectByStopwords(lang, name) {
  const t = stripEdgePunct(name);
  const tl = t.toLowerCase();
  if (!t) return true;
  if (lang === "he") return HE_REJECT.has(t);
  if (lang === "en") return EN_REJECT.has(tl);
  if (lang === "ru") return RU_REJECT.has(tl);
  return false;
}

function lastBotAskedNameHe(lastBotTextNorm) {
  const t = safeStr(lastBotTextNorm);
  if (!t) return false;
  // conservative indicators that the assistant asked for the caller's name
  return (
    t.includes("מה השם") ||
    t.includes("איך קוראים") ||
    t.includes("מי מדבר") ||
    t.includes("שם מלא") ||
    t.includes("אפשר שם") ||
    t.includes("מה שמך")
  );
}

function lastBotAskedNameEn(lastBotTextNorm) {
  const t = safeStr(lastBotTextNorm).toLowerCase();
  if (!t) return false;
  return t.includes("your name") || t.includes("who am i speaking") || t.includes("who is this") || t.includes("may i have your name");
}

function lastBotAskedNameRu(lastBotTextNorm) {
  const t = safeStr(lastBotTextNorm).toLowerCase();
  if (!t) return false;
  return t.includes("как вас зовут") || t.includes("ваше имя") || t.includes("с кем я говорю");
}

function extractBySelfIntro(lang, textNorm) {
  const t = safeStr(textNorm);
  if (!t) return null;

  if (lang === "he") {
    // Examples: "קוראים לי שי", "שמי שי", "אני שי", "זה שי"
    const m = t.match(/^(?:קוראים\s+לי|שמי|אני|זה)\s+(.+)$/);
    if (!m) return null;
    const candidate = stripEdgePunct(m[1]);
    if (!candidate) return null;
    if (!looksLikeHebrewNameToken(candidate)) return null;
    if (rejectByStopwords("he", candidate)) return null;
    return { name: candidate, reason: "self_intro_pattern_he" };
  }

  if (lang === "en") {
    const m = t.match(/^(?:my\s+name\s+is|i\s+am|this\s+is)\s+(.+)$/i);
    if (!m) return null;
    const candidate = stripEdgePunct(m[1]);
    if (!candidate) return null;
    if (!looksLikeEnglishNameToken(candidate)) return null;
    if (rejectByStopwords("en", candidate)) return null;
    return { name: candidate, reason: "self_intro_pattern_en" };
  }

  if (lang === "ru") {
    const m = t.match(/^(?:меня\s+зовут)\s+(.+)$/i);
    if (!m) return null;
    const candidate = stripEdgePunct(m[1]);
    if (!candidate) return null;
    if (!looksLikeRussianNameToken(candidate)) return null;
    if (rejectByStopwords("ru", candidate)) return null;
    return { name: candidate, reason: "self_intro_pattern_ru" };
  }

  return null;
}

function extractAsAnswerAfterNameQuestion(lang, userTextNorm, lastBotTextNorm) {
  const t = stripEdgePunct(userTextNorm);
  if (!t) return null;
  if (hasDigits(t)) return null;

  const asked =
    (lang === "he" && lastBotAskedNameHe(lastBotTextNorm)) ||
    (lang === "en" && lastBotAskedNameEn(lastBotTextNorm)) ||
    (lang === "ru" && lastBotAskedNameRu(lastBotTextNorm));

  if (!asked) return null;

  // Only accept short answers
  const w = countWords(t);
  if (w < 1 || w > 2) return null;

  if (lang === "he") {
    if (!looksLikeHebrewNameToken(t)) return null;
    if (rejectByStopwords("he", t)) return null;
    return { name: t, reason: "answer_after_name_question_he" };
  }

  if (lang === "en") {
    if (!looksLikeEnglishNameToken(t)) return null;
    if (rejectByStopwords("en", t)) return null;
    return { name: t, reason: "answer_after_name_question_en" };
  }

  if (lang === "ru") {
    if (!looksLikeRussianNameToken(t)) return null;
    if (rejectByStopwords("ru", t)) return null;
    return { name: t, reason: "answer_after_name_question_ru" };
  }

  return null;
}

/**
 * Extract caller name deterministically.
 * @param {{ raw: string, normalized: string, lang: "he"|"en"|"ru"|"unknown" }} nlp
 * @param {string} lastBotUtteranceNormalized
 * @returns {{name: string, reason: string} | null}
 */
function extractCallerName(nlp, lastBotUtteranceNormalized) {
  const lang = safeStr(nlp?.lang) || "unknown";
  const norm = safeStr(nlp?.normalized || nlp?.raw);
  if (!norm) return null;

  // 1) Strongest: explicit self-introduction
  const bySelfIntro = extractBySelfIntro(lang, norm);
  if (bySelfIntro) return bySelfIntro;

  // 2) Allowed: short answer after ANY question that semantically requests a name
  const byAnswer = extractAsAnswerAfterNameQuestion(lang, norm, lastBotUtteranceNormalized);
  if (byAnswer) return byAnswer;

  return null;
}

module.exports = { extractCallerName };
