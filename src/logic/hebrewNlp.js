"use strict";

const HEBREW_DIACRITICS_RE = /[\u0591-\u05C7]/g;
const HEBREW_CHAR_RE = /[\u0590-\u05FF]/;

const PUNCT_NORMALIZE_MAP = new Map([
  ["׳", "'"],
  ["״", '"'],
  ["–", "-"],
  ["—", "-"],
  ["−", "-"],
  ["…", "..."],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
]);

const HE_DIGIT_WORDS = new Map([
  ["אפס", "0"],
  ["אחת", "1"],
  ["אחד", "1"],
  ["שתיים", "2"],
  ["שתים", "2"],
  ["שניים", "2"],
  ["שנים", "2"],
  ["שלוש", "3"],
  ["ארבע", "4"],
  ["חמש", "5"],
  ["שש", "6"],
  ["שבע", "7"],
  ["שמונה", "8"],
  ["תשע", "9"],
]);

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x);
}

function normalizePunctuation(s) {
  let out = s;
  for (const [from, to] of PUNCT_NORMALIZE_MAP.entries()) {
    out = out.split(from).join(to);
  }
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
  out = out.replace(/\s+([,.!?;:])/g, "$1");
  out = collapseWhitespace(out);
  return out;
}

function getScriptCounts(text) {
  const s = safeStr(text);
  const counts = { he: 0, en: 0, ru: 0, digit: 0, other: 0 };

  for (const ch of s) {
    if (/[\u0590-\u05FF]/.test(ch)) counts.he += 1;
    else if (/[A-Za-z]/.test(ch)) counts.en += 1;
    else if (/[\u0400-\u04FF]/.test(ch)) counts.ru += 1;
    else if (/\d/.test(ch)) counts.digit += 1;
    else if (!/\s/.test(ch)) counts.other += 1;
  }

  return counts;
}

function detectLanguageDetailed(s) {
  const t = safeStr(s).trim();
  if (!t) {
    return {
      lang: "unknown",
      confidence: 0,
      script_counts: getScriptCounts(t),
      mixed: false,
    };
  }

  const counts = getScriptCounts(t);
  const pairs = [
    ["he", counts.he],
    ["en", counts.en],
    ["ru", counts.ru],
  ].sort((a, b) => b[1] - a[1]);

  const top = pairs[0];
  const second = pairs[1];
  const total = counts.he + counts.en + counts.ru;

  if (!total) {
    return {
      lang: "unknown",
      confidence: 0,
      script_counts: counts,
      mixed: false,
    };
  }

  return {
    lang: top[0],
    confidence: top[1] / total,
    script_counts: counts,
    mixed: second[1] > 0 && second[1] / total >= 0.2,
  };
}

function detectLanguageRough(s) {
  return detectLanguageDetailed(s).lang;
}

function applyPhraseMap(text, replacements) {
  let s = text;
  for (const [from, to] of replacements) {
    const pattern = from
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    s = s.replace(new RegExp(pattern, "giu"), to);
  }
  return s;
}

const PHRASE_FIXES = [
  ["של ום", "שלום"],
  ["א פשר", "אפשר"],
  ["ב בקשה", "בבקשה"],
  ["שה יא", "שהיא"],
  ["ש נייה", "שנייה"],
  ["שא לות", "שאלות"],
  ["ב בת", "בבת"],
  ["שוא לת", "שואלת"],
  ["ד ו חות", "דוחות"],
  ["דו חות", "דוחות"],
  ["ל דו חות", "לדוחות"],
  ["ד ו ח", 'דו"ח'],
  ["דו ח", 'דו"ח'],
  ["ר ווח", "רווח"],
  ["הפ סד", "הפסד"],
  ["ה פסד", "הפסד"],
  ["ו הפ סד", "והפסד"],
  ["ו הפסד", "והפסד"],
  ["ע בור", "עבור"],
  ["ע בורי", "עבורי"],
  ["תש לח", "תשלח"],
  ["ל ש נת", "לשנת "],
  ["ש נת", "שנת "],
  ["ל שנ ת", "לשנת "],
  ["שנשנת", "לשנת"],
  ["לאיזושנה", "לאיזו שנה"],
  ["ש תח ז ור", "שתחזור"],
  ["ש תח זור", "שתחזור"],
  ["תח זור", "תחזור"],
  ["ל ק בל", "לקבל"],
  ["ל דבר", "לדבר"],
  ["רוצ ה", "רוצה"],
  ["ב בק שה", "בבקשה"],
];

function joinSplitDigits(text) {
  let s = safeStr(text);
  s = s.replace(/(?<!\d)(\d)\s+(\d)\s+(\d)\s+(\d)(?!\d)/g, "$1$2$3$4");
  s = s.replace(/(?<!\d)(\d)\s+(\d)\s+(\d)(?!\d)/g, "$1$2$3");
  s = s.replace(/(?<!\d)(\d)\s+(\d)(?!\d)/g, "$1$2");
  return s;
}

function joinCommonHebrewFragments(text) {
  let s = safeStr(text);
  if (!s || !HEBREW_CHAR_RE.test(s)) return s;

  s = applyPhraseMap(s, PHRASE_FIXES);
  s = s.replace(/\bש\s+נייה\b/gu, "שנייה");
  s = s.replace(/\bא\s+פשר\b/gu, "אפשר");
  s = s.replace(/\bב\s+בקשה\b/gu, "בבקשה");
  s = s.replace(/\bד\s+וחות\b/gu, "דוחות");
  s = s.replace(/\bר\s+ווח\b/gu, "רווח");
  s = s.replace(/\bהפ\s+סד\b/gu, "הפסד");
  s = s.replace(/\bו\s+הפסד\b/gu, "והפסד");
  s = s.replace(/\bע\s+בור\b/gu, "עבור");
  s = s.replace(/\bשה\s+יא\b/gu, "שהיא");
  s = s.replace(/\bשוא\s+לת\b/gu, "שואלת");
  s = s.replace(/\bשא\s+לות\b/gu, "שאלות");
  s = s.replace(/\bב\s+בת\b/gu, "בבת");
  s = s.replace(/\bתש\s+לח\b/gu, "תשלח");
  s = s.replace(/\bתח\s+זור\b/gu, "תחזור");
  s = s.replace(/\bל\s+קבל\b/gu, "לקבל");
  s = s.replace(/\bל\s+דבר\b/gu, "לדבר");
  s = s.replace(/\bרוצ\s+ה\b/gu, "רוצה");
  s = s.replace(/\bב\s+בק\s+שה\b/gu, "בבקשה");
  s = s.replace(/\bדו"?חות?\b/gu, "דוחות");
  s = s.replace(/\bדו"?ח\b/gu, 'דו"ח');

  s = s.replace(/\b([א-ת])\s+([א-ת]{2,})\b/gu, "$1$2");
  s = s.replace(/\b([א-ת]{2,})\s+([א-ת])\b/gu, "$1$2");

  s = joinSplitDigits(s);
  s = s.replace(/\b2\s*0\s*2\s*5\b/gu, "2025");
  s = s.replace(/\b2\s*0\s*2\s*4\b/gu, "2024");
  s = s.replace(/\b2\s*0\s*2\s*3\b/gu, "2023");
  s = s.replace(/\b2\s*0\s*2\s*2\b/gu, "2022");
  s = s.replace(/\b20\s+25\b/gu, "2025");
  s = s.replace(/\b20\s+24\b/gu, "2024");
  s = s.replace(/\b20\s+23\b/gu, "2023");
  s = s.replace(/\b20\s+22\b/gu, "2022");
  s = s.replace(/\bלשנת\s*(\d{4})\b/gu, "לשנת $1");
  s = s.replace(/\bשנת\s*(\d{4})\b/gu, "שנת $1");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function normalizeHebrewBusinessTerms(text) {
  let s = safeStr(text);
  s = s.replace(/רווח\s+ו\s*הפסד/gu, "רווח והפסד");
  s = s.replace(/דו"?חות?/gu, "דוחות");
  s = s.replace(/דו"?ח/gu, 'דו"ח');
  s = s.replace(/לשנת(\d{4})/gu, "לשנת $1");
  s = s.replace(/שנת(\d{4})/gu, "שנת $1");
  return s;
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

function normalizeUtterance(text) {
  const raw = safeStr(text);
  let normalized = basicNormalize(raw);
  normalized = joinCommonHebrewFragments(normalized);
  normalized = normalizeHebrewBusinessTerms(normalized);
  normalized = collapseWhitespace(normalized);

  const langInfo = detectLanguageDetailed(normalized);
  const normalized_for_numbers = langInfo.lang === "he"
    ? hebrewDigitWordsToDigits(normalized)
    : normalized;

  return {
    raw,
    normalized,
    normalized_for_numbers,
    lang: langInfo.lang,
    lang_confidence: langInfo.confidence,
    script_counts: langInfo.script_counts,
    mixed_language: langInfo.mixed,
  };
}

function detectExplicitLanguageSwitch(text) {
  const t = basicNormalize(text).toLowerCase();
  if (!t) return null;

  if (/(אפשר|תעבור|תדבר|דבר)\s+באנגלית|english please|speak english/.test(t)) {
    return "en";
  }
  if (/(אפשר|תעבור|תדבר|דבר)\s+ברוסית|русский|говори по-русски/.test(t)) {
    return "ru";
  }
  if (/(אפשר|תעבור|תדבר|דבר)\s+בעברית|speak hebrew/.test(t)) {
    return "he";
  }
  return null;
}

function isAffirmativeHebrew(text) {
  const t = basicNormalize(text);
  return /^(כן|כן כן|בטח|ברור|בוודאי|ודאי|סבבה|אוקיי|אוקי|נכון|יאללה כן)([.!?, ]|$)/u.test(t);
}

function isNegativeHebrew(text) {
  const t = basicNormalize(text);
  return /^(לא|ממש לא|לא צריך|אין צורך|לא לא)([.!?, ]|$)/u.test(t);
}

function isShortAffirmationAny(text) {
  const t = basicNormalize(text).toLowerCase();
  if (!t) return false;
  if (isAffirmativeHebrew(t)) return true;
  return /^(yes|yep|yeah|ok|okay|bien|si|sí|oui|gen|geen|lo)([.!?, ]|$)/i.test(t);
}

function isShortNegationAny(text) {
  const t = basicNormalize(text).toLowerCase();
  if (!t) return false;
  if (isNegativeHebrew(t)) return true;
  return /^(no|nope|nah|non|geen|gen|lo)([.!?, ]|$)/i.test(t);
}

function isShortSpeechToken(text) {
  const t = basicNormalize(text);
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 3 && t.length <= 18;
}

function isLikelyNoiseLanguageFlip(text) {
  const t = basicNormalize(text);
  if (!t) return false;
  if (HEBREW_CHAR_RE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 2) return false;
  return /^.{1,20}$/u.test(t);
}

function isClosingPhrase(text) {
  const t = basicNormalize(text);
  return /(תודה\s*ו?להתראות|להתראות|ביי|יום טוב|ערב טוב|לילה טוב)/u.test(t);
}

module.exports = {
  normalizeUtterance,
  detectLanguageRough,
  detectLanguageDetailed,
  detectExplicitLanguageSwitch,
  isAffirmativeHebrew,
  isNegativeHebrew,
  isShortAffirmationAny,
  isShortNegationAny,
  isShortSpeechToken,
  isLikelyNoiseLanguageFlip,
  isClosingPhrase,
  basicNormalize,
  joinCommonHebrewFragments,
  normalizeHebrewBusinessTerms,
  hebrewDigitWordsToDigits,
};
