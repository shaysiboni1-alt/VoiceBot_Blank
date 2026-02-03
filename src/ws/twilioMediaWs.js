"use strict";

const WebSocket = require("ws");

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("../vendor/twilioGeminiAudio");
const { normalizeUtterance } = require("../logic/hebrewNlp");
const { detectIntent } = require("../logic/intentRouter");
const { loadSSOT } = require("../ssot/ssotClient");
const { startCallRecording, publicRecordingUrl } = require("../utils/twilioRecording");

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function isTruthy(x) {
  const s = String(x ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}

function normalizePhoneE164(p) {
  const s = safeStr(p);
  if (!s) return "";
  const cleaned = s.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("0")) return `+972${cleaned.slice(1)}`;
  if (cleaned.startsWith("972")) return `+${cleaned}`;
  if (cleaned.startsWith("5")) return `+972${cleaned}`;
  return cleaned;
}

function extractNameHe(raw) {
  const text = safeStr(raw);
  if (!text) return "";
  const cleaned = text.replace(/[^\p{L}\s\-'.]/gu, " ").replace(/\s+/g, " ").trim();

  // Prefer Hebrew letters
  const he = cleaned.match(/[א-ת][א-ת\s\-']{1,40}/);
  if (he && he[0]) return he[0].trim();

  // Fallback: short "name-like" (letters only), no digits
  if (cleaned.length <= 25 && !/[0-9]/.test(cleaned) && /\p{L}/u.test(cleaned)) {
    return cleaned;
  }
  return "";
}

function extractPhoneAny(text) {
  const s = safeStr(text);
  if (!s) return "";

  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return "";

  if (digits.length >= 9 && digits.length <= 12) {
    // try to normalize Israel-ish patterns
    if (digits.startsWith("972") && digits.length >= 11) return `+${digits}`;
    if (digits.startsWith("0") && digits.length >= 9) return `+972${digits.slice(1)}`;
    if (digits.startsWith("5") && digits.length === 9) return `+972${digits}`;
  }

  if (digits.length >= 10 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function buildLeadParserPrompt(style) {
  const mode = safeStr(style) || "crm_short";

  return [
    "You are a strict JSON generator.",
    "You will receive a phone call transcript (Hebrew/English/Russian mix possible).",
    "Return JSON ONLY (no markdown, no prose).",
    "",
    "Output schema:",
    "{",
    '  "summary": string,',
    '  "topic": string,',
    '  "requested_action": string,',
    '  "important_details": string[],',
    '  "urgency": "low" | "medium" | "high",',
    '  "next_step": string',
    "}",
    "",
    `Style=${mode}. Keep summary SHORT and CRM-friendly.`,
  ].join("\n");
}

function extractFirstJsonObject(text) {
  const s = String(text || "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return "";
  return s.slice(first, last + 1);
}

async function deliverWebhook(url, payload, eventType) {
  const target = safeStr(url);
  if (!target) return;

  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    logger.info("Webhook delivered", {
      eventType,
      status: res.status,
      attempt: 1,
    });
  } catch (e) {
    logger.info("Webhook failed", { eventType, error: e.message });
  }
}

async function runLeadParser({ meta, ssot, lead, transcriptText }) {
  if (!isTruthy(env.LEAD_PARSER_ENABLED)) return null;
  if (safeStr(env.LEAD_PARSER_MODE).toLowerCase() !== "postcall") return null;

  const model = safeStr(env.LEAD_PARSER_MODEL);
  if (!model) {
    logger.info("Lead parser skipped (missing LEAD_PARSER_MODEL)", meta);
    return null;
  }

  // require basic lead data before parsing
  if (!safeStr(lead?.name) || !safeStr(lead?.phone)) return null;

  const prompt = buildLeadParserPrompt(env.LEAD_SUMMARY_STYLE);

  const body = {
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { text: "\n---\nLEAD:\n" + JSON.stringify(lead) },
          { text: "\n---\nTRANSCRIPT:\n" + (transcriptText || "") },
        ],
      },
    ],
  };

  try {
    const key = env.GEMINI_API_KEY;
    if (!key) {
      logger.info("Lead parser skipped (missing GEMINI_API_KEY)", meta);
      return null;
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const json = await res.json();
    const txt =
      json?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join("\n") || "";

    const jsonText = extractFirstJsonObject(txt);
    if (!jsonText) return null;

    try {
      return JSON.parse(jsonText);
    } catch (e) {
      logger.info("Lead parser JSON parse failed", { ...meta, error: e.message });
      return null;
    }
  } catch (e) {
    logger.info("Lead parser failed", { ...meta, error: e.message });
    return null;
  }
}

// -----------------------------------------------------------------------------
// Main WS installer
// -----------------------------------------------------------------------------

function installTwilioMediaWs(app) {
  app.ws("/twilio-media-stream", async (ws, req) => {
    logger.info("Twilio media WS connected");

    // per-call state
    let streamSid = null;
    let callSid = null;
    let finalized = false;

    const ssot = await loadSSOT();

    const lead = {
      name: "",
      phone: "",
      notes: "",
    };

    const callerInfo = {
      caller: "",
      called: "",
      source: "VoiceBot_Blank",
      caller_withheld: false,
    };

    const transcript = {
      bot: [],
      user: [],
    };

    const recording = {
      recording_provider: "",
      recording_sid: "",
      recording_url_public: "",
    };

    function metaBase() {
      return {
        streamSid,
        callSid,
        caller: callerInfo.caller,
        called: callerInfo.called,
        source: callerInfo.source,
      };
    }

    function pushTranscript(who, text) {
      const t = safeStr(text);
      if (!t) return;
      transcript[who].push(`${who.toUpperCase()}: ${t}`);
      // keep bounded
      if (transcript[who].length > 120) transcript[who] = transcript[who].slice(-120);
    }

    function fullTranscriptText() {
      // interleave approximately: keep it simple (append by time order isn't available reliably)
      // For parsing, concatenating both arrays is usually sufficient.
      return [...transcript.bot, ...transcript.user].join("\n").trim();
    }

    const gemini = new GeminiLiveSession({
      ssot,
      meta: metaBase(),
      onGeminiAudioUlaw8kBase64: (ulawB64) => {
        try {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: ulawB64 },
            })
          );
        } catch {}
      },
      onGeminiText: (t) => {
        logger.debug("Gemini text", { ...metaBase(), t });
      },
      onTranscript: ({ who, text, normalized, lang }) => {
        // deterministic logs already handled in vendor; here we build transcript for parsing/webhook
        if (who === "bot") pushTranscript("bot", text);
        if (who === "user") pushTranscript("user", text);

        // lead capture (deterministic + minimal)
        if (who === "user") {
          const nlp = normalizeUtterance(text || "");
          const candidateName = extractNameHe(nlp.normalized || nlp.raw || "");
          const candidatePhone = extractPhoneAny(nlp.normalized || nlp.raw || "");

          if (!lead.name && candidateName) lead.name = candidateName;
          if (!lead.phone && candidatePhone) lead.phone = normalizePhoneE164(candidatePhone);

          // keep last user request short for fallback notes
          if (nlp.normalized || nlp.raw) lead.notes = safeStr(nlp.normalized || nlp.raw);

          // keep intent log deterministically (Stage2 behavior)
          try {
            const intent = detectIntent({
              text: nlp.normalized || nlp.raw,
              intents: ssot?.intents || [],
            });
            logger.info("INTENT_DETECTED", { ...metaBase(), text: nlp.raw, normalized: nlp.normalized, lang: nlp.lang, intent });
          } catch {}
        }
      },
    });

    async function finalizeCall(reason) {
      if (finalized) return;
      finalized = true;

      const ended_at = nowIso();

      const callPayloadBase = {
        callSid,
        streamSid,
        caller: callerInfo.caller,
        called: callerInfo.called,
        source: callerInfo.source,
        started_at: callerInfo.started_at || "",
        ended_at,
        duration_ms: callerInfo.started_at_ms ? Date.now() - callerInfo.started_at_ms : 0,
        caller_withheld: callerInfo.caller_withheld,
        recording_provider: recording.recording_provider,
        recording_sid: recording.recording_sid,
        recording_url_public: recording.recording_url_public,
        finalize_reason: reason || "",
      };

      // Decide FINAL vs ABANDONED (minimal deterministic gate)
      const leadComplete = !!safeStr(lead.name) && !!safeStr(lead.phone);

      let leadParser = null;
      if (leadComplete) {
        leadParser = await runLeadParser({
          meta: metaBase(),
          ssot,
          lead,
          transcriptText: fullTranscriptText(),
        });
      }

      // Build CRM-friendly notes (SHORT)
      const notesFromParser = safeStr(leadParser?.summary);
      const topic = safeStr(leadParser?.topic);
      const requested = safeStr(leadParser?.requested_action);

      const shortNotesParts = [];
      if (topic) shortNotesParts.push(`נושא: ${topic}`);
      if (requested) shortNotesParts.push(`בקשה: ${requested}`);
      if (notesFromParser) shortNotesParts.push(`סיכום: ${notesFromParser}`);

      const notesFallback = safeStr(lead.notes);
      const notesFinal = shortNotesParts.length ? shortNotesParts.join(" | ") : notesFallback;

      const payload = {
        call: callPayloadBase,
        lead: {
          name: safeStr(lead.name),
          phone: safeStr(lead.phone) || normalizePhoneE164(callerInfo.caller),
          notes: notesFinal,
          lead_parser: leadParser || null,
        },
      };

      // 1) CALL_LOG (end only)
      await deliverWebhook(env.CALL_LOG_WEBHOOK_URL, { event: "CALL_LOG", phase: "end", ...payload }, "CALL_LOG");

      // 2) FINAL/ABANDONED
      if (leadComplete) {
        await deliverWebhook(env.FINAL_WEBHOOK_URL, { event: "FINAL", ...payload }, "FINAL");
      } else {
        // ABANDONED should still include caller phone if known
        if (!payload.lead.phone) payload.lead.phone = normalizePhoneE164(callerInfo.caller);
        await deliverWebhook(env.ABANDONED_URL, { event: "ABANDONED", ...payload }, "ABANDONED");
      }
    }

    ws.on("message", async (msgBuf) => {
      let msg;
      try {
        msg = JSON.parse(msgBuf.toString("utf8"));
      } catch {
        return;
      }

      const event = msg?.event;

      if (event === "connected") {
        logger.info("Twilio WS event", { meta: { event, streamSid: msg?.streamSid ?? null, callSid: msg?.start?.callSid ?? null } });
        return;
      }

      if (event === "start") {
        streamSid = msg?.start?.streamSid || msg?.streamSid || null;
        callSid = msg?.start?.callSid || null;

        const cp = msg?.start?.customParameters || {};
        callerInfo.caller = safeStr(cp.caller || "");
        callerInfo.called = safeStr(cp.called || "");
        callerInfo.source = safeStr(cp.source || "VoiceBot_Blank");
        callerInfo.started_at = nowIso();
        callerInfo.started_at_ms = Date.now();

        callerInfo.caller_withheld = !callerInfo.caller || /anonymous|restricted|withheld/i.test(callerInfo.caller);

        logger.info("Twilio stream start", { meta: { streamSid, callSid, customParameters: cp } });

        // Start recording (server-side); public URL = our proxy route
        if (isTruthy(env.MB_ENABLE_RECORDING) && callSid) {
          const recSid = await startCallRecording(callSid, logger);
          if (recSid) {
            recording.recording_provider = "twilio";
            recording.recording_sid = recSid;
            recording.recording_url_public = publicRecordingUrl(recSid);
          }
        }

        // Start Gemini
        try {
          gemini.meta = metaBase();
          gemini.start();
        } catch (e) {
          logger.info("Gemini session start failed", { ...metaBase(), error: e.message });
        }

        return;
      }

      if (event === "media") {
        const payload = msg?.media?.payload;
        if (payload) {
          try {
            gemini.sendUlaw8kFromTwilio(payload);
          } catch {}
        }
        return;
      }

      if (event === "stop") {
        logger.info("Twilio stream stop", { meta: { streamSid, callSid } });

        try {
          gemini.endInput();
          gemini.stop();
        } catch {}

        await finalizeCall("stop_called");
        try {
          ws.close();
        } catch {}
        return;
      }
    });

    ws.on("close", async () => {
      logger.info("Twilio media WS closed", { meta: { streamSid, callSid } });
      try {
        gemini.endInput();
        gemini.stop();
      } catch {}

      await finalizeCall("ws_closed");
    });

    ws.on("error", async (err) => {
      logger.info("Twilio media WS error", { meta: { streamSid, callSid }, error: err.message });
      await finalizeCall("ws_error");
    });
  });
}

module.exports = { installTwilioMediaWs };
