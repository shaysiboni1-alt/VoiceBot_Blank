"use strict";

const { logger } = require("../utils/logger");
const { env } = require("../config/env");

/**
 * Minimal Gemini text completion helper (Google AI Studio Generative Language API).
 * Used for post-call lead parsing only (subject + summary).
 */
async function callGeminiTextModel({
  model,
  systemInstruction,
  userText,
  temperature = 0.2,
  maxOutputTokens = 512,
  timeoutMs = 20000
}) {
  const apiKey = env.GEMINI_API_KEY;
  const m = model || env.LEAD_PARSER_MODEL || "gemini-1.5-flash";

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          ...(systemInstruction ? [{ text: `SYSTEM:\n${systemInstruction}` }] : []),
          { text: userText || "" }
        ]
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens
    }
  };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Gemini text request failed: ${res.status} ${txt}`);
    }

    const json = await res.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join("\n") ||
      "";

    return { text };
  } catch (e) {
    logger.warn("Gemini text call failed", { err: e?.message || String(e), model: m });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { callGeminiTextModel };
