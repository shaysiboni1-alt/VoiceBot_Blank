"use strict";

const HEBREW_DIACRITICS_RE = /[\u0591-\u05C7]/g;
const PUNCT_NORMALIZE_MAP = new Map([
  ["׳", "'"], ["״", '"'], ["–", "-"], ["—", "-"], ["−", "-"], ["…", "..."], ["“", '"'], ["”", '"'], ["‘", "'"], ["’", "'"],
]);
const HE_DIGIT_WORDS = new Map([
  ["אפס", "0"], ["אפסים", "0"], ["אחת", "1"], ["אחד", "1"], ["שתיים", "2"], ["שתים", "2"], ["שניים", "2"], ["שנים", "2"],
  ["שלוש", "3"], ["ארבע", "4"], ["חמש", "5"], ["שש", "6"], ["שבע", "7"], ["שמונה", "8"], ["תשע", "9"],
]);
const HESITATION_RE = /\b(אה+|אמ+|המ+|אהמ+|אהה+|כאילו|טוב|אוקיי|אוקי|רגע|שניה)\b/gi;

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x);
}
function normalizePunctuation(s) {
  let out = s;
  for (const [from, to] of PUNCT_NORMALIZE_MAP.entries()) out = out.split(from).join(to);
  return out;
}
function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}
function stripDiacriticsHebrew(s) {
  return s.replace(HEBREW_DIACRITICS_RE, "");
}
function basicNormalize(s) {
  let out = safeStr(s);
  out = out.replace(/\u200f|\u200e|\ufeff/g, "");
  out = stripDiacriticsHebrew(out);
  out = normalizePunctuation(out);
  out = collapseWhitespace(out);
  return out;
}
function analyzeLanguage(text) {
  const t = safeStr(text);
  let he = 0, en = 0, ru = 0, digits = 0;
  for (const ch of t) {
    if (/[\u0590-\u05FF]/.test(ch)) he += 1;
    else if (/[\u0400-\u04FF]/.test(ch)) ru += 1;
    else if (/[A-Za-z]/.test(ch)) en += 1;
    else if (/\d/.test(ch)) digits += 1;
  }
  const totalAlpha = he + en + ru;
  let lang = "unknown";
  let confidence = 0;
  if (totalAlpha > 0) {
    const max = Math.max(he, en, ru);
    confidence = max / totalAlpha;
    if (max === he) lang = "he";
    else if (max === ru) lang = "ru";
    else lang = "en";
  }
  return { lang, confidence, script_counts: { he, en, ru, digits }, mixed: totalAlpha > 0 && confidence < 0.85 };
}
function detectLanguageRough(s) {
  return analyzeLanguage(s).lang;
}
function hebrewDigitWordsToDigits(text) {
  const s = safeStr(text);
  if (!s) return "";
  const tokens = s.split(/\s+/g);
  const out = [];
  for (const tok of tokens) {
    const clean = tok.replace(/[^\u0590-\u05FFA-Za-z0-9]/g, "");
    if (HE_DIGIT_WORDS.has(clean)) out.push(HE_DIGIT_WORDS.get(clean));
    else if (/^\d+$/.test(clean)) out.push(clean);
    else out.push(tok);
  }
  return out.join(" ").replace(/(\d)\s+(?=\d)/g, "$1");
}
function normalizeHebrewContent(s) {
  let out = basicNormalize(s);
  out = out.replace(HESITATION_RE, " ");
  out = out.replace(/\b(כן כן|לא לא)\b/g, (_, m) => m.split(" ")[0]);
  out = out.replace(/\bרווח\s+והפסד\b/g, 'רווח והפסד');
  out = collapseWhitespace(out);
  out = hebrewDigitWordsToDigits(out);
  return out;
}
function detectExplicitLanguageSwitch(text) {
  const t = basicNormalize(text).toLowerCase();
  if (!t) return null;
  if (/(אפשר|תדבר|תדברי|נעבור|תעברו).{0,8}(עברית|hebrew)/i.test(t) || /עברית/.test(t)) return "he";
  if (/(english please|speak english|in english|אנגלית)/i.test(t)) return "en";
  if (/(русский|по русски|говори по русски|רוסית)/i.test(t)) return "ru";
  return null;
}
function detectAffirmation(text) {
  const t = basicNormalize(text).toLowerCase();
  if (!t) return false;
  return /^(כן|כן בטח|כן ברור|ברור|בטח|סבבה|אוקיי|אוקי|בוודאי|כמובן|sure|yes|okay|ok|да|конечно)/i.test(t);
}
function detectClosing(text) {
  const t = basicNormalize(text).toLowerCase();
  if (!t) return false;
  return /(להתראות|ביי|תודה ו(להתראות|יום טוב)|יום טוב|כל טוב|goodbye|bye|thanks bye|до свидания|спасибо)/i.test(t);
}
function normalizeUtterance(text) {
  const raw = safeStr(text);
  const normalized = normalizeHebrewContent(raw);
  const analysis = analyzeLanguage(normalized);
  const normalized_for_numbers = analysis.lang === "he" ? hebrewDigitWordsToDigits(normalized) : normalized;
  return {
    raw,
    normalized,
    normalized_for_numbers,
    lang: analysis.lang,
    lang_confidence: analysis.confidence,
    language_analysis: analysis,
    explicit_language_switch: detectExplicitLanguageSwitch(raw),
    is_affirmation: detectAffirmation(raw),
    is_closing: detectClosing(raw),
  };
}

module.exports = {
  normalizeUtterance,
  detectLanguageRough,
  analyzeLanguage,
  basicNormalize,
  hebrewDigitWordsToDigits,
  detectExplicitLanguageSwitch,
  detectAffirmation,
  detectClosing,
};
