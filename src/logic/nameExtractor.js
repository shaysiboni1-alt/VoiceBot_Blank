// src/logic/nameExtractor.js

function containsHebrew(str) {
  return /[\u0590-\u05FF]/.test(str);
}

function containsLatin(str) {
  return /[A-Za-z]/.test(str);
}

function containsCyrillic(str) {
  return /[\u0400-\u04FF]/.test(str);
}

function cleanName(text) {
  if (!text) return null;

  let t = text.trim();

  // remove punctuation
  t = t.replace(/[.,!?]/g, "").trim();

  // reject if digits
  if (/\d/.test(t)) return null;

  // max 2 words
  const parts = t.split(/\s+/);
  if (parts.length > 2) return null;

  if (t.length < 2 || t.length > 20) return null;

  return t;
}

function extractNameFromUtterance({ text, lastBotQuestion }) {
  if (!text) return null;

  const cleaned = cleanName(text);
  if (!cleaned) return null;

  // explicit patterns
  const patterns = [
    /אני\s+(.+)/,
    /קוראים לי\s+(.+)/,
    /שמי\s+(.+)/,
    /זה\s+(.+)/
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const candidate = cleanName(m[1]);
      if (candidate) {
        return {
          name: candidate,
          confidence_reason: "explicit_pattern"
        };
      }
    }
  }

  // single token answer after name question
  if (
    lastBotQuestion &&
    /שם|מי מדבר|איך קוראים/.test(lastBotQuestion)
  ) {
    if (
      containsHebrew(cleaned) ||
      containsLatin(cleaned) ||
      containsCyrillic(cleaned)
    ) {
      return {
        name: cleaned,
        confidence_reason: "direct_answer"
      };
    }
  }

  return null;
}

module.exports = {
  extractNameFromUtterance
};
