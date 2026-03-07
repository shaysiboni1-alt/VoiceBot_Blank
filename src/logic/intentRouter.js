"use strict";

const { logger } = require("../utils/logger");
const {
  detectLang,
  normalizeHebrew,
  normalizeLatin,
  buildHebrewTokenSet,
  splitTriggersCell
} = require("../utils/textNlp");

function normalizeArgs(arg1, arg2, arg3) {
  if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1) && Object.prototype.hasOwnProperty.call(arg1, "text")) {
    return {
      textRaw: String(arg1.text || ""),
      rows: Array.isArray(arg1.intents) ? arg1.intents : [],
      opts: arg1.opts || arg3 || {},
    };
  }
  return {
    textRaw: String(arg1 || ""),
    rows: Array.isArray(arg2) ? arg2 : [],
    opts: arg3 || {},
  };
}

function emptyIntent() {
  return {
    intent_id: "other",
    intent_type: "other",
    score: 0,
    priority: 0,
    matched_triggers: []
  };
}

function detectIntent(arg1, arg2, arg3) {
  const { textRaw, rows, opts } = normalizeArgs(arg1, arg2, arg3);
  if (!rows.length) return emptyIntent();

  const lang = opts.forceLang || detectLang(textRaw);
  const norm = lang === "he" ? normalizeHebrew(textRaw) : normalizeLatin(textRaw);
  const tokenSetHe = lang === "he" ? buildHebrewTokenSet(norm) : null;
  const normTokens = new Set(norm.split(" ").filter(Boolean));

  let best = null;
  for (const it of rows) {
    const intentId = String(it?.intent_id || "").trim();
    const intentType = String(it?.intent_type || "").trim() || "other";
    const priority = Number(it?.priority ?? 0) || 0;
    if (!intentId) continue;

    const triggersCell = lang === "he" ? it?.triggers_he : (lang === "ru" ? it?.triggers_ru : it?.triggers_en);
    const triggers = splitTriggersCell(triggersCell);
    if (!triggers.length) continue;

    let score = 0;
    const matched = [];
    for (const tr0 of triggers) {
      const tr = lang === "he" ? normalizeHebrew(tr0) : normalizeLatin(tr0);
      if (!tr) continue;
      if (tr.length >= 2 && norm.includes(tr)) {
        score += tr.length >= 6 ? 6 : 4;
        matched.push(tr0);
        continue;
      }
      if (lang === "he") {
        if (!tr.includes(" ") && tokenSetHe && tokenSetHe.has(tr)) {
          score += 3;
          matched.push(tr0);
          continue;
        }
      } else {
        const tokens = tr.split(" ").filter(Boolean);
        for (const tk of tokens) {
          if (tk.length >= 2 && normTokens.has(tk)) {
            score += 2;
            matched.push(tr0);
            break;
          }
        }
      }
    }

    if (score <= 0) continue;
    const candidate = {
      intent_id: intentId,
      intent_type: intentType,
      score,
      priority,
      matched_triggers: Array.from(new Set(matched)).slice(0, 8)
    };

    if (!best) best = candidate;
    else if (candidate.score > best.score) best = candidate;
    else if (candidate.score === best.score && candidate.priority > best.priority) best = candidate;
    else if (candidate.score === best.score && candidate.priority === best.priority && candidate.intent_id.localeCompare(best.intent_id) < 0) best = candidate;
  }

  const out = best || emptyIntent();
  if (opts.logDebug) logger.info("INTENT_DEBUG", { lang, norm, best: out });
  return out;
}

module.exports = { detectIntent };
