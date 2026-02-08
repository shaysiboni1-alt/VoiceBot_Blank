"use strict";

const { GEMINI_API_KEY, GEMINI_TEXT_MODEL } = require("../config/env");
const { logger } = require("../utils/logger");

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  // Strip ```json fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1] : text;

  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const jsonStr = candidate.slice(first, last + 1);
  return jsonStr;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function inferExpectedKeysFromPrompt(prompt) {
  // The prompt usually contains an example like: {"full_name":..., ...}
  const jsonStr = extractJsonObject(prompt);
  if (!jsonStr) return null;
  const obj = safeJsonParse(jsonStr);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return Object.keys(obj);
}

function normalizeLeadObject(raw, expectedKeys) {
  const out = {};
  for (const k of expectedKeys) out[k] = null;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  for (const k of expectedKeys) {
    const v = raw[k];
    if (v === undefined || v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v === "string") {
      const s = v.trim();
      out[k] = s.length ? s : null;
      continue;
    }
    // Keep only primitives/strings; everything else -> null (deterministic, no surprises)
    if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    out[k] = null;
  }

  return out;
}

async function geminiGenerateJson({ systemPrompt, transcriptText }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing; cannot parse lead post-call");
  }

  const model = GEMINI_TEXT_MODEL || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${systemPrompt}\n\nTRANSCRIPT:\n${transcriptText}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini generateContent failed (${res.status}): ${text.slice(0, 500)}`);
  }

  // Gemini returns JSON text; still guard for wrappers.
  const parsed = safeJsonParse(text);
  if (parsed && parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
    return parsed.candidates[0].content.parts[0].text;
  }

  // Sometimes responseMimeType returns the JSON directly as text.
  return text;
}

/**
 * SSOT contract:
 * - ssot.prompts.LEAD_PARSER_PROMPT (required)
 */
async function parseLeadPostcall({ ssot, transcriptText }) {
  const prompt = ssot?.prompts?.LEAD_PARSER_PROMPT;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Missing SSOT PROMPTS.LEAD_PARSER_PROMPT");
  }

  const expectedKeys =
    inferExpectedKeysFromPrompt(prompt) || ["full_name", "subject", "callback_to_number", "notes"];

  const rawText = await geminiGenerateJson({
    systemPrompt: prompt,
    transcriptText,
  });

  const jsonStr = extractJsonObject(rawText) || rawText;
  const obj = safeJsonParse(jsonStr);
  if (!obj) {
    throw new Error(`Lead parser returned non-JSON: ${String(rawText).slice(0, 200)}`);
  }

  return normalizeLeadObject(obj, expectedKeys);
}

module.exports = {
  parseLeadPostcall,
};
