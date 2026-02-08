// Post-call Lead Parser
// Aligns strictly with SSOT PROMPTS.LEAD_PARSER_PROMPT (Index VoiceBot – Betty baseline)

const { logger } = require("../utils/logger");
const env = require("../config/env");

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

async function geminiGenerateContent({ model, contents, systemInstruction }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 512,
      topP: 0.1,
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
    throw new Error(`Gemini lead parser HTTP ${res.status}: ${text}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini lead parser: non-JSON response: ${safeStr(text).slice(0, 200)}`);
  }
  const parts = envelope?.candidates?.[0]?.content?.parts || [];
  const out = parts.map((p) => safeStr(p?.text)).join("").trim();
  if (!out) throw new Error("Gemini lead parser: empty content");
  return out;
}

function extractJsonObject(text) {
  const s = safeStr(text);
  // Fast path
  try {
    return JSON.parse(s);
  } catch (_) {
    // continue
  }

  // Heuristic: extract the first {...} block
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Lead parser returned no JSON object: ${s.slice(0, 200)}`);
  }
  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new Error(`Lead parser returned malformed JSON: ${candidate.slice(0, 200)}`);
  }
}

function parseJsonStrict(text) {
  return extractJsonObject(text);
}

function isMostlyHebrew(s) {
  const t = safeStr(s).trim();
  if (!t) return false;
  const heb = (t.match(/[֐-׿]/g) || []).length;
  const letters = (t.match(/[A-Za-z֐-׿]/g) || []).length;
  if (letters == 0) return false;
  return heb / letters >= 0.6;
}

function guessHebrewNameFromConversation(conversationText) {
  const t = safeStr(conversationText);
  // Try to pull the name the bot used when addressing the caller.
  const patterns = [
    /\bהיי\s+([\u0590-\u05FF]{1,30})\b/u,
    /\bשלום\s+([\u0590-\u05FF]{1,30})\b/u,
    /\bהבנתי,?\s+([\u0590-\u05FF]{1,30})\b/u,
    /\bרשמתי,?\s+([\u0590-\u05FF]{1,30})\b/u,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}


async function geminiText({ model, system, user }) {
  // Some deployments might pin an invalid/unsupported model name.
  // We try the configured model first, then fall back to a short list.
  const candidates = [
    safeStr(model),
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-latest",
  ].filter(Boolean);

  let lastErr = null;
  for (const m of candidates) {
    try {
      const raw = await geminiGenerateContent({
        model: m,
        systemInstruction: system
          ? {
              role: "system",
              parts: [{ text: system }],
            }
          : undefined,
        contents: [
          {
            role: "user",
            parts: [{ text: safeStr(user) }],
          },
        ],
      });

      // geminiGenerateContent() already returns the final concatenated text.
      const text = safeStr(raw).trim();
      if (!text) throw new Error("Empty Gemini response");
      return text;
    } catch (e) {
      lastErr = e;
      const msg = safeStr(e?.message);
      // Retry only on model NOT_FOUND / unsupported
      if (!/models\//i.test(msg) && !/NOT_FOUND/i.test(msg) && !/is not found/i.test(msg)) {
        break;
      }
    }
  }

  throw lastErr || new Error("Gemini lead parser failed");
}

const ALLOWED_KEYS = new Set([
  "is_lead",
  "intent",
  "full_name",
  "phone_number",
  "prefers_caller_id",
  "brand",
  "model",
  "message_for",
  "reason",
  "notes",
]);

function pickAllowed(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (ALLOWED_KEYS.has(k)) out[k] = obj[k];
  }
  return out;
}

function normalizeNullableStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizeParsedLead(raw) {
  const obj = pickAllowed(raw);

  // Coerce types & normalize
  const is_lead = typeof obj.is_lead === "boolean" ? obj.is_lead : null;
  const intent = normalizeNullableStr(obj.intent);
  const full_name = normalizeNullableStr(obj.full_name);
  const phone_number = normalizeNullableStr(obj.phone_number);
  const prefers_caller_id =
    typeof obj.prefers_caller_id === "boolean" ? obj.prefers_caller_id : null;
  const brand = normalizeNullableStr(obj.brand);
  const model = normalizeNullableStr(obj.model);
  const message_for = normalizeNullableStr(obj.message_for);
  const reason = normalizeNullableStr(obj.reason);
  const notes = normalizeNullableStr(obj.notes);

  return {
    is_lead,
    intent,
    full_name,
    phone_number,
    prefers_caller_id,
    brand,
    model,
    message_for,
    reason,
    notes,
  };
}

function deriveSubject(lead, transcriptText) {
  // Prefer explicit reason (professional short Hebrew) then notes then a trimmed fallback.
  const r = safeStr(lead?.reason);
  if (r) return r;
  const n = safeStr(lead?.notes);
  if (n) return n;
  const t = safeStr(transcriptText).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 80) : null;
}

function deriveParsingSummary(lead) {
  const intent = safeStr(lead?.intent) || "unknown";
  const reason = safeStr(lead?.reason) || safeStr(lead?.notes) || "";
  const s = (intent + (reason ? ": " + reason : "")).trim();
  return s || null;
}

async function runPostcallLeadParser({ ssot, transcriptText, known }) {
  // Primary key (locked): PROMPTS.LEAD_PARSER_PROMPT
  // In production, a sheet key can be accidentally renamed/typed. We therefore:
  // 1) Try the primary key
  // 2) Try a small set of backwards-compatible aliases
  // 3) Fall back to a safe built-in prompt (so FINAL/ABANDONED logic keeps working)
  const prompt = (() => {
    const p = safeStr(ssot?.prompts?.LEAD_PARSER_PROMPT);
    if (p) return p;
    const aliases = [
      "LEAD_PARSER",
      "LEAD_PARSER_INSTRUCTIONS",
      "LEAD_PARSER_PROMPT_V1",
      "POSTCALL_LEAD_PARSER_PROMPT",
    ];
    for (const k of aliases) {
      const v = safeStr(ssot?.prompts?.[k]);
      if (v) return v;
    }
    return safeStr(
      `You are a strict information extraction engine.
Return ONLY valid JSON (no markdown, no commentary).

TASK: From the call transcript, extract a lead object.

OUTPUT JSON SCHEMA:
{
  "full_name": string | null,
  "phone_number": string | null,
  "topic": string | null,
  "intent": string | null,
  "urgency": "low"|"normal"|"high"|null,
  "notes": string | null
}

RULES:
- Prefer Hebrew spelling when a Hebrew name is implied.
- If phone number is not explicitly provided, keep null.
- Put the most important request summary into notes.`
    );
  })();

  const model = safeStr(env.LEAD_PARSER_MODEL) || "gemini-2.0-flash";

  const context = {
    caller_id_e164: safeStr(known?.caller_id_e164) || null,
    called_e164: safeStr(known?.called_e164) || null,
    callSid: safeStr(known?.callSid) || null,
  };

  // We pass a single text blob to keep parsing deterministic.
  const input =
    `KNOWN_CONTEXT (do not invent beyond this):\n${JSON.stringify(context)}\n\n` +
    `CALL_TRANSCRIPT (may include noise; extract only explicit facts):\n${safeStr(transcriptText)}`;

  // Strengthen the parser to include fields we need for the FINAL payload
  // even if the SSOT prompt is older.
  const augmentedSystem =
    prompt +
    "\n\nADDITIONAL REQUIREMENTS (do not mention these rules):\n" +
    "- Return JSON only.\n" +
    "- Also include optional keys: subject, parsing_summary.\n" +
    "- subject: a very short title of the request (Hebrew).\n" +
    "- parsing_summary: one concise Hebrew sentence summarizing the request.\n";

  const raw = await geminiText({ model, system: augmentedSystem, user: input });

  const parsed = parseJsonStrict(raw);

  const lead = normalizeParsedLead(parsed);

  // STT occasionally emits the caller name in non-Hebrew scripts (e.g. Devanagari).
  // We prefer a Hebrew name if it can be inferred from the bot's Hebrew turns.
  if (lead.full_name && !isMostlyHebrew(lead.full_name)) {
    const guessed = guessHebrewNameFromConversation(transcriptText);
    if (guessed) lead.full_name = guessed;
  }

  // If model returned these extra keys, keep them.
  lead.subject = normalizeNullableStr(parsed?.subject) || null;
  lead.parsing_summary = normalizeNullableStr(parsed?.parsing_summary) || null;
  // Derived helper fields used by webhook payloads (kept outside the strict parser schema)
  if (!lead.subject) lead.subject = deriveSubject(lead, transcriptText);
  if (!lead.parsing_summary) lead.parsing_summary = deriveParsingSummary(lead);

  return lead;
}

module.exports = {
  runPostcallLeadParser,
};
