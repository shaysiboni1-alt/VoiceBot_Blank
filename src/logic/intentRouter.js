"use strict";

/**
 * Deterministic Intent Router (SSOT-driven)
 * ----------------------------------------
 * - No AI
 * - No side effects
 * - Pure text matching
 *
 * Rules:
 * - Match triggers_he / triggers_en / triggers_ru
 * - ALSO match intent_type as trigger
 * - Score = number of matched triggers
 * - Winner by:
 *   1) score (desc)
 *   2) priority (desc)
 * - Fallback: intent_id === "other"
 */

function normalizeText(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTriggers(raw) {
  if (!raw) return [];
  return String(raw)
    .split("|")
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

function detectIntent({ text, intents }) {
  const cleanText = normalizeText(text);
  if (!cleanText) return null;

  let best = null;

  for (const it of intents || []) {
    const intentId = it.intent_id;
    const intentType = it.intent_type;
    const priority = Number(it.priority || 0);

    const triggers = [
      ...splitTriggers(it.triggers_he),
      ...splitTriggers(it.triggers_en),
      ...splitTriggers(it.triggers_ru),
      intentType ? intentType.toLowerCase() : null
    ].filter(Boolean);

    let score = 0;
    const matched = [];

    for (const trig of triggers) {
      if (cleanText.includes(trig)) {
        score += 1;
        matched.push(trig);
      }
    }

    if (score === 0) continue;

    const candidate = {
      intent_id: intentId,
      intent_type: intentType,
      score,
      priority,
      matched_triggers: matched
    };

    if (!best) {
      best = candidate;
      continue;
    }

    if (
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.priority > best.priority)
    ) {
      best = candidate;
    }
  }

  if (best) return best;

  // Fallback to "other"
  const other = (intents || []).find(i => i.intent_id === "other");
  return {
    intent_id: other?.intent_id || "other",
    intent_type: other?.intent_type || "other",
    score: 0,
    priority: Number(other?.priority || 0),
    matched_triggers: []
  };
}

module.exports = {
  detectIntent
};
