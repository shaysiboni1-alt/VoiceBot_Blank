"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");
const { detectIntent } = require("../logic/intentRouter");
const { normalizeUtterance } = require("../logic/hebrewNlp");
const { finalizePipeline } = require("../stage4/finalizePipeline");

// Optional (exists in your repo). We use it if present, but do not depend on it for core flow.
let passiveCallContext = null;
try {
  // eslint-disable-next-line global-require
  passiveCallContext = require("../logic/passiveCallContext");
} catch { /* ignore */ }

// -----------------------------------------------------------------------------
// Helpers (baseline-safe)
// -----------------------------------------------------------------------------

function normalizeModelName(m) {
  if (!m) return "";
  if (m.startsWith("models/")) return m;
  return `models/${m}`;
}

function liveWsUrl() {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key
  )}`;
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function applyTemplate(tpl, vars) {
  const s = safeStr(tpl);
  if (!s) return "";
  return s.replace(/\{([A-Z0-9_]+)\}/g, (_, key) => {
    const v = vars?.[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function buildSettingsContext(settings) {
  const keys = Object.keys(settings || {}).sort();
  const lines = keys.map((k) => `${k}: ${safeStr(settings[k])}`);
  return lines.join("\n").trim();
}

function buildIntentsContext(intents) {
  const rows = Array.isArray(intents) ? intents.slice() : [];

  rows.sort((a, b) => {
    const pa = Number(a?.priority ?? 0);
    const pb = Number(b?.priority ?? 0);
    if (pb !== pa) return pb - pa;
    return String(a?.intent_id ?? "").localeCompare(String(b?.intent_id ?? ""));
  });

  const lines = rows.map((it) => {
    const id = safeStr(it.intent_id);
    const type = safeStr(it.intent_type);
    const pr = Number(it.priority ?? 0) || 0;
    const he = safeStr(it.triggers_he);
    const en = safeStr(it.triggers_en);
    const ru = safeStr(it.triggers_ru);
    return `- ${id} | type=${type} | priority=${pr} | triggers_he=${he} | triggers_en=${en} | triggers_ru=${ru}`;
  });

  return lines.join("\n").trim();
}

function buildSystemInstructionFromSSOT(ssot) {
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const intents = ssot?.intents || [];

  const defaultLang = safeStr(settings.DEFAULT_LANGUAGE) || "he";

  const sections = [];

  sections.push(
    [
      "IDENTITY (NON-NEGOTIABLE):",
      "- You are NOT a generic model and must NEVER describe yourself as an AI/LLM/model.",
      "- You are the business phone assistant defined by SETTINGS and PROMPTS.",
      "- Speak naturally and briefly.",
      "- Prefer Hebrew by default unless the caller requests otherwise."
    ].join("\n")
  );

  const master = safeStr(prompts.MASTER_PROMPT);
  const guardrails = safeStr(prompts.GUARDRAILS_PROMPT);
  const kb = safeStr(prompts.KB_PROMPT);
  const lead = safeStr(prompts.LEAD_CAPTURE_PROMPT);
  const intentRouter = safeStr(prompts.INTENT_ROUTER_PROMPT);

  if (master) sections.push(`MASTER_PROMPT:\n${master}`);
  if (guardrails) sections.push(`GUARDRAILS_PROMPT:\n${guardrails}`);
  if (kb) sections.push(`KB_PROMPT:\n${kb}`);
  if (lead) sections.push(`LEAD_CAPTURE_PROMPT:\n${lead}`);
  if (intentRouter) sections.push(`INTENT_ROUTER_PROMPT:\n${intentRouter}`);

  const settingsContext = buildSettingsContext(settings);
  if (settingsContext) sections.push(`SETTINGS_CONTEXT (SOURCE OF TRUTH):\n${settingsContext}`);

  const intentsContext = buildIntentsContext(intents);
  if (intentsContext) sections.push(`INTENTS_TABLE:\n${intentsContext}`);

  sections.push(
    [
      "LANGUAGE POLICY:",
      `- default_language=${defaultLang}`,
      "- If the caller speaks another supported language (he/en/ru), switch to it.",
      "- If the caller uses an unsupported language, apologize briefly and ask to continue in Hebrew/English/Russian."
    ].join("\n")
  );

  return sections.filter(Boolean).join("\n\n---\n\n").trim();
}

function computeGreetingHebrew(timeZone) {
  const tz = timeZone || "Asia/Jerusalem";

  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false
  }).format(new Date());

  const hour = Number(hourStr);
  if (Number.isNaN(hour)) return "שלום";

  if (hour >= 5 && hour < 11) return "בוקר טוב";
  if (hour >= 11 && hour < 17) return "צהריים טובים";
  if (hour >= 17 && hour < 22) return "ערב טוב";
  return "לילה טוב";
}

function getOpeningScriptFromSSOT(ssot, vars) {
  const settings = ssot?.settings || {};
  const tpl = safeStr(settings.OPENING_SCRIPT) || "שלום! איך נוכל לעזור?";

  const merged = {
    BUSINESS_NAME: safeStr(settings.BUSINESS_NAME),
    BOT_NAME: safeStr(settings.BOT_NAME),
    CALLER_NAME: safeStr(vars?.CALLER_NAME),
    MAIN_PHONE: safeStr(settings.MAIN_PHONE),
    BUSINESS_EMAIL: safeStr(settings.BUSINESS_EMAIL),
    BUSINESS_ADDRESS: safeStr(settings.BUSINESS_ADDRESS),
    WORKING_HOURS: safeStr(settings.WORKING_HOURS),
    BUSINESS_WEBSITE_URL: safeStr(settings.BUSINESS_WEBSITE_URL),
    VOICE_NAME: safeStr(settings.VOICE_NAME),
    GREETING: safeStr(vars?.GREETING),
    ...vars
  };

  const filled = applyTemplate(tpl, merged).trim();
  return filled || "שלום! איך נוכל לעזור?";
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (low === "anonymous" || low === "restricted" || low === "unavailable" || low === "unknown") {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function normalizeHebrewName(name) {
  const n = (name || "").trim();
  if (!n) return "";
  // Collapse repeated Hebrew letters (e.g. "שיי" -> "שי")
  if (/^[\u0590-\u05FF\s-]+$/.test(n)) {
    return n.replace(/([\u0590-\u05FF])\1+/g, "$1");
  }
  return n;
}

function extractNameHe(text) {
  const t = (text || "").trim();
  if (!t) return "";

  // Prefer explicit self-identification patterns.
  // Examples:
  //  - "קוראים לי שי" / "השם שלי שי" / "אני שי" / "מדבר שי"
  //  - "השם שלי זה שי לא שגיא"  -> we should extract "שי"
  const m = t.match(/(?:\b(?:קוראים\s*לי|השם\s*שלי(?:\s*זה)?|אני|מדבר|מדברת)\b)\s*([\u0590-\u05FF'"\-\s]{1,50})/);
  if (m && m[1]) {
    const raw = String(m[1]).trim();
    const cleaned = stripNamePhrase(raw);

    // Keep only the actual name tokens.
    // Stop at common continuation words: "לא", "ו...", etc.
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const stopwords = new Set(["לא", "ול", "ולמסור", "וב", "וביקש", "וביקשת", "אבל", "ש", "זה"]);
    const out = [];
    for (const tok of tokens) {
      if (stopwords.has(tok)) break;
      // If token starts with 'ו' (and isn't a plausible name continuation) treat as stop.
      if (tok.length > 1 && tok.startsWith("ו") && out.length > 0) break;
      out.push(tok);
      if (out.length >= 3) break;
    }
    return out.join(" ").trim();
  }

  return "";
}


function stripNamePhrases(text) {
  let t = (text || "").trim();
  if (!t) return "";
  // Remove self-identification clauses to leave the actual request/message.
  // "... קוראים לי שי" / "שמי שי" / "השם שלי שי" / "אני שי".
  t = t.replace(/(?:,|\s)*(?:קוראים לי|שמי|השם שלי(?:\s+זה)?|אני)\s+[^\n,.!?]{1,40}/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

// Backward-compatible alias (older call-site used a singular name)
function stripNamePhrase(text) {
  return stripNamePhrases(text);
}

function extractNameDeterministic(text, { allowFallbackShortToken = false } = {}) {
  const raw = (text || "").trim();
  if (!raw) return "";

  // Hebrew present -> use Hebrew extractor.
  if (/[\u0590-\u05FF]/.test(raw)) return extractNameHe(raw);

  // Common transliterations for "שי" seen from STT.
  const cleaned = raw
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/["'`.,!?;:()\[\]{}<>]/g, "")
    .trim();

  if (["shai", "sai", "sha", "shi", "shy", "şai", "şa", "šai"].includes(cleaned)) return "שי";

  if (!allowFallbackShortToken) return "";

  // Last resort: accept a short, non-numeric token/phrase.
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (/[0-9]/.test(compact)) return "";
  if (compact.length > 30) return "";
  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length > 3) return "";
  if (/^\[?noise\]?$/i.test(compact)) return "";
  return compact;
}

function extractPhone(text) {
  const digits = (text || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return `+${digits}`;
    if (digits.startsWith("0") && digits.length === 10) return `+972${digits.slice(1)}`;
    return digits;
  }
  return "";
}

function isTruthyEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Stage4 dependencies (safe, best-effort)
// -----------------------------------------------------------------------------

async function deliverWebhook(url, payload, label) {
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    logger.info("Webhook delivered", { label, status: resp.status });
  } catch (e) {
    logger.warn("Webhook delivery failed", { label, error: String(e) });
  }
}

async function twilioStartRecording(callSid) {
  if (!callSid) return "";
  if (!isTruthyEnv(env.MB_ENABLE_RECORDING)) return "";
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return "";

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      env.TWILIO_ACCOUNT_SID
    )}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

    const body = new URLSearchParams();
    body.set("RecordingStatusCallbackEvent", "completed");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization:
          "Basic " +
          Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    const j = await safeJson(resp);
    return j?.sid ? String(j.sid) : "";
  } catch (e) {
    logger.warn("Twilio startRecording failed", { callSid, error: String(e) });
    return "";
  }
}

function twilioPublicRecordingUrl(recordingSid) {
  if (!recordingSid) return "";
  const baseUrl = safeStr(env.PUBLIC_BASE_URL) || "";
  if (!baseUrl) return "";
  return `${baseUrl.replace(/\/+$/, "")}/recordings/${recordingSid}`;
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta, ssot }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript;

    this.meta = meta || {};
    this.ssot = ssot || {};

    this.ws = null;
    this.ready = false;
    this.closed = false;
    this._greetingSent = false;

    // Transcript aggregation (readability only; decision does NOT depend on it)
    this._trBuf = { user: "", bot: "" };
    this._trLastChunk = { user: "", bot: "" };
    this._trTimer = { user: null, bot: null };

    // Stage4 call state
    const callerInfo = normalizeCallerId(this.meta?.caller || "");
    const subjectMinWords = Number(this.ssot?.settings?.SUBJECT_MIN_WORDS ?? 3) || 3;

    this._call = {
      callSid: safeStr(this.meta?.callSid),
      streamSid: safeStr(this.meta?.streamSid),
      source: safeStr(this.meta?.source) || "VoiceBot_Blank",
      caller_raw: callerInfo.value,
      caller_withheld: callerInfo.withheld,
      called: safeStr(this.meta?.called),
      started_at: nowIso(),
      ended_at: null,

      // Lead fields (decision depends ONLY on these)
      lead: {
        full_name: "",
        awaiting_name: false,
        subject: "",
        callback_to_number: callerInfo.withheld ? "" : callerInfo.value,
        subject_min_words: subjectMinWords
      },

      // transcript buffer for CRM parser later (not used for decision)
      transcript: [],

      // recording
      recording_sid: "",
      recording_url_public: "",

      finalized: false
    };
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", async () => {
      logger.info("Gemini Live WS connected", this.meta);

      // Recording: start best-effort (must NOT affect voice)
      this._call.recording_sid = await twilioStartRecording(this._call.callSid);
      this._call.recording_url_public = twilioPublicRecordingUrl(this._call.recording_sid);

      const systemText = buildSystemInstructionFromSSOT(this.ssot);

      const setup = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
          systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,

          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: env.VOICE_NAME_OVERRIDE || safeStr(this.ssot?.settings?.VOICE_NAME) || "Kore"
                }
              }
            }
          },

          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: Number(env.MB_VAD_PREFIX_MS ?? 200),
              silenceDurationMs: Number(env.MB_VAD_SILENCE_MS ?? 900)
            }
          },

          ...(env.MB_LOG_TRANSCRIPTS ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {})
        }
      };

      try {
        this.ws.send(JSON.stringify(setup));
        this.ready = true;
      } catch (e) {
        logger.error("Failed to send Gemini setup", { ...this.meta, error: e.message });
      }
    });

    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      if (msg?.setupComplete && !this._greetingSent) {
        this._greetingSent = true;
        this._sendProactiveOpening();
        return;
      }

      // AUDIO from Gemini -> Twilio
      try {
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.serverContent?.turn?.parts ||
          msg?.serverContent?.parts ||
          [];

        for (const p of parts) {
          const inline = p?.inlineData;
          if (!inline || !inline?.data || !inline?.mimeType) continue;

          if (String(inline.mimeType).startsWith("audio/pcm")) {
            const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
            if (ulawB64 && this.onGeminiAudioUlaw8kBase64) {
              this.onGeminiAudioUlaw8kBase64(ulawB64);
            }
          }
        }
      } catch (e) {
        logger.debug("Gemini message parse error", { ...this.meta, error: e.message });
      }

      // Optional text parts
      try {
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.serverContent?.turn?.parts ||
          msg?.serverContent?.parts ||
          [];

        for (const p of parts) {
          const t = p?.text;
          if (t && this.onGeminiText) this.onGeminiText(String(t));
        }
      } catch { /* ignore */ }

      // Transcriptions (aggregated)
      try {
        const inTr = msg?.serverContent?.inputTranscription?.text;
        if (inTr) this._onTranscriptChunk("user", String(inTr));

        const outTr = msg?.serverContent?.outputTranscription?.text;
        if (outTr) this._onTranscriptChunk("bot", String(outTr));
      } catch { /* ignore */ }
    });

    this.ws.on("close", async (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;

      this._flushTranscript("user");
      this._flushTranscript("bot");

      logger.info("Gemini Live WS closed", { ...this.meta, code, reason });

      // Stage4 finalize: always best-effort, never throws outward
      await this._finalizeOnce("gemini_ws_close");
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { ...this.meta, error: err.message });
    });
  }

  _onTranscriptChunk(who, chunk) {
    if (!env.MB_LOG_TRANSCRIPTS) return;

    const c = chunk || "";
    if (!c) return;

    if (c === this._trLastChunk[who]) return;
    this._trLastChunk[who] = c;

    this._trBuf[who] = (this._trBuf[who] + c).slice(-800);

    if (this._trTimer[who]) clearTimeout(this._trTimer[who]);
    this._trTimer[who] = setTimeout(() => this._flushTranscript(who), 450);
  }

  _flushTranscript(who) {
    if (!env.MB_LOG_TRANSCRIPTS) return;

    if (this._trTimer[who]) {
      clearTimeout(this._trTimer[who]);
      this._trTimer[who] = null;
    }

    const text = (this._trBuf[who] || "").trim();
    this._trBuf[who] = "";
    if (!text) return;

    const nlp = normalizeUtterance(text);

    // Arm deterministic name capture only when the bot explicitly asks for the name.
    if (who === "bot") {
      const t = (nlp.normalized || nlp.raw || "").toString();
      if (/מה\s*השם/i.test(t)) {
        this._call.lead.awaiting_name = true;
      }
    }

    logger.info(`UTTERANCE ${who}`, {
      ...this.meta,
      text: nlp.raw,
      normalized: nlp.normalized,
      lang: nlp.lang
    });

    if (who === "user") {
      const intent = detectIntent({
        text: nlp.normalized || nlp.raw,
        intents: this.ssot?.intents || []
      });

      logger.info("INTENT_DETECTED", {
        ...this.meta,
        text: nlp.raw,
        normalized: nlp.normalized,
        lang: nlp.lang,
        intent
      });
    }

    // ---- Stage4: capture lead fields deterministically (decision does NOT depend on transcript existence) ----
    try {
      this._call.transcript.push({
        who,
        text: nlp.raw,
        normalized: nlp.normalized,
        lang: nlp.lang,
        ts: nowIso()
      });

      if (who === "user") {
        const userText = (nlp.normalized || nlp.raw || "").trim();

      // 1) Name capture: capture whenever we can, and allow explicit self-identification to override earlier mistakes.
      {
        const allowFallbackShortToken = !!this._call.lead.awaiting_name;
        const explicitNamePhrase = /(קוראים לי|השם שלי|שמי|אני\s+)(?=\S)/.test(userText);
        const name = extractNameDeterministic(userText, allowFallbackShortToken);
        if (name) {
          if (!this._call.lead.full_name || explicitNamePhrase) {
            this._call.lead.full_name = name;
            this._call.lead.awaiting_name = false;
          }
        }
      }

        // 2) Subject capture
        // If the user says name + request in the same utterance ("... קוראים לי שי"), extract the request part.
        if (this._call.lead.full_name && !this._call.lead.subject) {
          const stripped = stripNamePhrase(userText);
          const candidate = stripped || userText;

          const words = candidate.split(/\s+/).filter(Boolean);
          const minWords = this._call.lead.subject_min_words || 3;
          if (words.length >= minWords && candidate.length >= 6) {
            this._call.lead.subject = candidate.trim();
          } else {
            // Special-case common "call me back" requests so the lead isn't "empty".
            if (/לחזור\s+אל(י|יי)|תחזור\s+אל(י|יי)|שיחזרו\s+אל(י|יי)|תתקשר(ו)?\s+אל(י|יי)/.test(candidate)) {
              this._call.lead.subject = candidate.trim();
            }
          }
        }

        // 3) Callback number if withheld
        if (this._call.caller_withheld && !this._call.lead.callback_to_number) {
          const phone = extractPhone(userText);
          if (phone) this._call.lead.callback_to_number = phone;
        }
      }
    } catch (e) {
      logger.debug("Stage4 lead capture failed", { error: String(e) });
    }

    if (this.onTranscript) {
      this.onTranscript({ who, text: nlp.raw, normalized: nlp.normalized, lang: nlp.lang });
    }
  }

  _sendProactiveOpening() {
    if (!this.ws || this.closed || !this.ready) return;

    const tz = env.TIME_ZONE || "Asia/Jerusalem";
    const greeting = computeGreetingHebrew(tz);

    const opening = getOpeningScriptFromSSOT(this.ssot, { GREETING: greeting });

    const userKickoff =
      `התחילי שיחה עכשיו. אמרי בדיוק את טקסט הפתיחה הבא בעברית (ללא תוספות וללא שינויים), ואז עצרי להקשבה:\n` +
      opening;

    const msg = {
      clientContent: {
        turns: [{ role: "user", parts: [{ text: userKickoff }] }],
        turnComplete: true
      }
    };

    try {
      this.ws.send(JSON.stringify(msg));
      logger.info("Proactive opening sent", { ...this.meta, greeting, opening_len: opening.length });
    } catch (e) {
      logger.debug("Failed sending proactive opening", { ...this.meta, error: e.message });
    }
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;

    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    const msg = {
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16kB64 }]
      }
    };

    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.debug("Failed sending audio to Gemini", { ...this.meta, error: e.message });
    }
  }

  endInput() {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch { /* ignore */ }
  }

  async _finalizeOnce(reason) {
    if (this._call.finalized) return;
    this._call.finalized = true;

    try {
      this._call.ended_at = nowIso();
      const durationMs = Date.now() - new Date(this._call.started_at).getTime();

      const transcriptText = this._call.transcript
        .map((x) => `${String(x.who || "").toUpperCase()}: ${x.text}`)
        .join("\n");

      const callMeta = {
        callSid: this._call.callSid,
        streamSid: this._call.streamSid,
        caller: this._call.caller_raw,
        called: this._call.called,
        source: this._call.source,
        started_at: this._call.started_at,
        ended_at: this._call.ended_at,
        duration_ms: durationMs,
        caller_withheld: this._call.caller_withheld,
        finalize_reason: reason || ""
      };

      // optional passive context (non-breaking)
      if (passiveCallContext?.buildPassiveContext) {
        try {
          callMeta.passive_context = passiveCallContext.buildPassiveContext({
            meta: this.meta,
            ssot: this.ssot
          });
        } catch { /* ignore */ }
      }

      const snapshot = {
        call: callMeta,
        lead: {
          ...this._call.lead,
          // Keep notes for now (you can later swap to crm_short summary in Stage4.2)
          notes: transcriptText
        }
      };

      await finalizePipeline({
        snapshot,
        env,
        logger,
        senders: {
          sendCallLog: (payload) => deliverWebhook(env.CALL_LOG_WEBHOOK_URL, payload, "CALL_LOG"),
          sendFinal: (payload) => deliverWebhook(env.FINAL_WEBHOOK_URL, payload, "FINAL"),
          sendAbandoned: (payload) => deliverWebhook(env.ABANDONED_WEBHOOK_URL, payload, "ABANDONED"),
          resolveRecording: async () => {
            const rec = await resolveTwilioRecordingPublic({
              callSid: this._call.callSid,
              publicBaseUrl: env.PUBLIC_BASE_URL,
              twilioAccountSid: env.TWILIO_ACCOUNT_SID,
              twilioAuthToken: env.TWILIO_AUTH_TOKEN,
              enableRecording: env.MB_ENABLE_RECORDING,
              logger
            });

            // cache for later (best-effort)
            if (rec?.recording_sid) this._call.recording_sid = rec.recording_sid;
            if (rec?.recording_url_public) this._call.recording_url_public = rec.recording_url_public;

            return rec;
          }
        }
      });
    } catch (e) {
      logger.warn("Finalize failed", { error: String(e) });
    }
  }

  stop() {
    // Stage4: finalize (best-effort), then close Gemini WS.
    this._finalizeOnce("stop_called").catch(() => {});

    if (!this.ws) return;
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

module.exports = { GeminiLiveSession };
