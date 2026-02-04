"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");
const { detectIntent } = require("../logic/intentRouter");
const { normalizeUtterance } = require("../logic/hebrewNlp");
const { finalizePipeline } = require("../logic/finalizePipeline");

// Optional (exists in your repo). We use it if present, but do not depend on it for core flow.
let passiveCallContext = null;
try {
  // eslint-disable-next-line global-require
  passiveCallContext = require("../logic/passiveCallContext");
} catch { /* ignore */ }

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function truthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function nowIso() {
  return new Date().toISOString();
}

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

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (low === "anonymous" || low === "restricted" || low === "unavailable" || low === "unknown" || low === "private") {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = (text || "").trim();
  if (!t) return "";

  // If user says only the "prefix" without a name -> reject.
  const pseudo = new Set(["השם שלי", "שמי", "אני", "קוראים לי", "השם שלי זה"]);
  if (pseudo.has(t)) return "";

  // "קוראים לי X", "השם שלי (זה) X", "שמי X", "אני X"
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) {
    const cand = m[1].trim();
    if (pseudo.has(cand)) return "";
    if (cand.length >= 2 && cand.length <= 40 && !cand.match(/[0-9]/)) return cand;
  }

  // fallback: if it's short and looks like a name (Hebrew/letters, not just generic words)
  if (t.length <= 20 && !t.match(/[0-9]/)) {
    if (t.match(/^[\p{L}][\p{L}\s'’-]{1,19}$/u) && !pseudo.has(t)) return t;
  }

  return "";
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

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Webhooks (direct)
// -----------------------------------------------------------------------------

async function deliverWebhookDirect(label, url, payload) {
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

// -----------------------------------------------------------------------------
// Twilio Recording (best-effort + resolve)
// -----------------------------------------------------------------------------

function twilioAuthHeader() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return "";
  return (
    "Basic " +
    Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")
  );
}

async function twilioStartRecording(callSid) {
  if (!callSid) return "";
  if (!truthy(env.MB_ENABLE_RECORDING)) return "";
  const auth = twilioAuthHeader();
  if (!auth) return "";

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      env.TWILIO_ACCOUNT_SID
    )}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

    const body = new URLSearchParams();
    // Minimal: start recording now
    body.set("RecordingChannels", "dual");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    const j = await safeJson(resp);
    const sid = j?.sid ? String(j.sid) : "";
    logger.info("Twilio recording start", { callSid, status: resp.status, recordingSid: sid || "" });
    return sid;
  } catch (e) {
    logger.warn("Twilio startRecording failed", { callSid, error: String(e) });
    return "";
  }
}

async function twilioResolveRecordingByCallSid(callSid) {
  if (!callSid) return "";
  if (!truthy(env.MB_ENABLE_RECORDING)) return "";
  const auth = twilioAuthHeader();
  if (!auth) return "";

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      env.TWILIO_ACCOUNT_SID
    )}/Recordings.json?CallSid=${encodeURIComponent(callSid)}&PageSize=20`;

    const resp = await fetch(url, {
      method: "GET",
      headers: { authorization: auth }
    });

    const j = await safeJson(resp);
    const rec = Array.isArray(j?.recordings) ? j.recordings[0] : null;
    const sid = rec?.sid ? String(rec.sid) : "";
    logger.info("Twilio recording resolve", { callSid, status: resp.status, recordingSid: sid || "" });
    return sid;
  } catch (e) {
    logger.warn("Twilio resolveRecording failed", { callSid, error: String(e) });
    return "";
  }
}

function twilioPublicRecordingUrl(recordingSid) {
  if (!recordingSid) return "";
  const baseUrl = safeStr(env.PUBLIC_BASE_URL) || "";
  if (!baseUrl) return "";
  return `${baseUrl.replace(/\/+$/, "")}/recordings/${recordingSid}`;
}

async function twilioHangup(callSid) {
  if (!callSid) return;
  const auth = twilioAuthHeader();
  if (!auth) return;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      env.TWILIO_ACCOUNT_SID
    )}/Calls/${encodeURIComponent(callSid)}.json`;

    const body = new URLSearchParams();
    body.set("Status", "completed");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    logger.info("Twilio hangup requested", { callSid, status: resp.status });
  } catch (e) {
    logger.warn("Twilio hangup failed", { callSid, error: String(e) });
  }
}

function shouldTriggerHangup(botText, ssot) {
  const t = (botText || "").trim();
  if (!t) return false;

  // quick heuristic
  if (t.includes("תודה") && t.includes("להתראות")) return true;

  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => String(settings[k] || "").trim())
    .filter(Boolean);

  return closers.some((c) => t.startsWith(c.slice(0, Math.min(18, c.length))));
}

// -----------------------------------------------------------------------------
// Lead Parser LLM (postcall) -> returns JSON per SSOT prompt
// -----------------------------------------------------------------------------

async function runLeadParserLLM({ ssot, transcriptText, callMeta }) {
  if (!truthy(env.LEAD_PARSER_ENABLED)) return null;

  const prompt = safeStr(ssot?.prompts?.LEAD_PARSER_PROMPT);
  if (!prompt) return null;

  const key = env.GEMINI_API_KEY;
  if (!key) return null;

  const model = safeStr(env.LEAD_PARSER_MODEL) || "gemini-1.5-flash";

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `${prompt}\n\n` +
                `CALL_META:\n${JSON.stringify(callMeta)}\n\n` +
                `TRANSCRIPT:\n${transcriptText}`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512
      }
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const j = await safeJson(resp);
    const txt = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const trimmed = String(txt || "").trim();

    // direct JSON
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);

    // fenced JSON
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m && m[1]) {
      const inner = m[1].trim();
      if (inner.startsWith("{") || inner.startsWith("[")) return JSON.parse(inner);
    }
  } catch (e) {
    logger.warn("LeadParser LLM failed", { error: String(e) });
  }

  return null;
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

    // transcript aggregation
    this._trBuf = { user: "", bot: "" };
    this._trLastChunk = { user: "", bot: "" };
    this._trTimer = { user: null, bot: null };

    // Stage4 state
    const callerInfo = normalizeCallerId(this.meta?.caller || "");
    const subjectMinWords = Number(this.ssot?.settings?.SUBJECT_MIN_WORDS || 3);

    this._state = {
      callLogSentStart: false,
      callLogSentEnd: false
    };

    this._call = {
      callSid: safeStr(this.meta?.callSid),
      streamSid: safeStr(this.meta?.streamSid),
      source: safeStr(this.meta?.source) || "VoiceBot_Blank",
      caller_raw: callerInfo.value,
      caller_withheld: callerInfo.withheld,
      called: safeStr(this.meta?.called),
      started_at: nowIso(),
      ended_at: null,
      duration_ms: 0,
      recordingSid: "",
      recording_url_public: "",
      closing_initiated: false,
      finalized: false,

      // Lead fields (NOT transcript-dependent for FINAL decision)
      lead: {
        full_name: "",
        subject: "",
        callback_to_number: callerInfo.withheld ? "" : callerInfo.value,
        subject_min_words: subjectMinWords,
        // notes will be filled from LLM in FINAL (not transcript)
        notes: ""
      },

      // transcript stored for LLM parsing & debugging only
      transcript: []
    };
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", async () => {
      logger.info("Gemini Live WS connected", this.meta);

      // Stage4: recording start (best-effort, never blocks)
      this._call.recordingSid = await twilioStartRecording(this._call.callSid);
      this._call.recording_url_public = twilioPublicRecordingUrl(this._call.recordingSid);

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
          ...(truthy(env.MB_LOG_TRANSCRIPTS) ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {})
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

      // Optional text parts (debug only)
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

      await this._finalizeOnce("ws_close");
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { ...this.meta, error: err.message });
    });
  }

  _onTranscriptChunk(who, chunk) {
    if (!truthy(env.MB_LOG_TRANSCRIPTS)) return;

    const c = chunk || "";
    if (!c) return;

    if (c === this._trLastChunk[who]) return;
    this._trLastChunk[who] = c;

    this._trBuf[who] = (this._trBuf[who] + c).slice(-800);

    if (this._trTimer[who]) clearTimeout(this._trTimer[who]);
    this._trTimer[who] = setTimeout(() => this._flushTranscript(who), 450);
  }

  _flushTranscript(who) {
    if (!truthy(env.MB_LOG_TRANSCRIPTS)) return;

    if (this._trTimer[who]) {
      clearTimeout(this._trTimer[who]);
      this._trTimer[who] = null;
    }

    const text = (this._trBuf[who] || "").trim();
    this._trBuf[who] = "";
    if (!text) return;

    const nlp = normalizeUtterance(text);

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

    // Stage4 accumulation
    try {
      this._call.transcript.push({
        who,
        text: nlp.raw,
        normalized: nlp.normalized,
        lang: nlp.lang,
        ts: nowIso()
      });

      if (who === "user") {
        // LeadGate: name
        if (!this._call.lead.full_name) {
          const name = extractNameHe(nlp.normalized || nlp.raw);
          if (name) this._call.lead.full_name = name;
        } else {
          // subject: first meaningful request after name (deterministic)
          if (!this._call.lead.subject) {
            const body = (nlp.normalized || nlp.raw || "").trim();
            if (body.length >= 6) this._call.lead.subject = body;
          }
          // callback number if withheld
          if (this._call.caller_withheld && !this._call.lead.callback_to_number) {
            const phone = extractPhone(nlp.normalized || nlp.raw);
            if (phone) this._call.lead.callback_to_number = phone;
          }
        }
      }

      if (who === "bot") {
        if (!this._call.closing_initiated && shouldTriggerHangup(nlp.raw, this.ssot)) {
          this._call.closing_initiated = true;
          setTimeout(() => {
            twilioHangup(this._call.callSid).catch(() => {});
          }, 900);
        }
      }
    } catch (e) {
      logger.debug("Stage4 accumulation failed", { error: String(e) });
    }

    if (this.onTranscript) this.onTranscript({ who, text: nlp.raw, normalized: nlp.normalized, lang: nlp.lang });
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
      this._call.duration_ms = Date.now() - new Date(this._call.started_at).getTime();

      // If we don't have recordingSid yet - resolve now (best effort)
      if (!this._call.recordingSid) {
        // small delay helps Twilio create the resource
        await new Promise((r) => setTimeout(r, 700));
        this._call.recordingSid = await twilioResolveRecordingByCallSid(this._call.callSid);
        this._call.recording_url_public = twilioPublicRecordingUrl(this._call.recordingSid);
      }

      const callMeta = {
        callSid: this._call.callSid,
        streamSid: this._call.streamSid,
        caller: this._call.caller_raw,
        called: this._call.called,
        source: this._call.source,
        started_at: this._call.started_at,
        ended_at: this._call.ended_at,
        duration_ms: this._call.duration_ms,
        caller_withheld: this._call.caller_withheld,
        finalize_reason: reason || "",
        recording_provider: this._call.recordingSid ? "twilio" : "",
        recording_sid: this._call.recordingSid || "",
        recording_url_public: this._call.recording_url_public || ""
      };

      if (passiveCallContext?.buildPassiveContext) {
        try {
          callMeta.passive_context = passiveCallContext.buildPassiveContext({
            meta: this.meta,
            ssot: this.ssot
          });
        } catch { /* ignore */ }
      }

      // Transcript text for LLM parsing ONLY
      const transcriptText = this._call.transcript
        .map((x) => `${String(x.who || "").toUpperCase()}: ${x.text}`)
        .join("\n");

      // If FINAL: run Lead Parser and map to notes/subject (no logs in notes)
      let parsed = null;
      const wantParser =
        truthy(env.LEAD_PARSER_ENABLED) &&
        String(env.LEAD_PARSER_MODE || "postcall").trim().toLowerCase() === "postcall";

      if (wantParser) {
        parsed = await runLeadParserLLM({ ssot: this.ssot, transcriptText, callMeta });
        if (parsed && typeof parsed === "object") {
          // subject = topic if exists; else keep deterministic subject
          if (safeStr(parsed.topic)) this._call.lead.subject = safeStr(parsed.topic);

          // notes = short CRM text (summary + bullets)
          const summary = safeStr(parsed.summary);
          const details = Array.isArray(parsed.details) ? parsed.details.map((x) => safeStr(x)).filter(Boolean) : [];
          const next = safeStr(parsed.next_step);

          const lines = [];
          if (summary) lines.push(summary);
          if (details.length) lines.push(`פרטים: ${details.join(" | ")}`);
          if (next) lines.push(`Next: ${next}`);
          this._call.lead.notes = lines.join("\n").trim();
        }
      }

      // fallback: never send raw transcript inside notes
      if (!this._call.lead.notes) {
        this._call.lead.notes = safeStr(parsed?.summary) || "";
      }

      // Webhook senders (direct URLs from ENV)
      const senders = {
        sendCallLog: async (snapWithPhase) =>
          deliverWebhookDirect(
            "CALL_LOG",
            env.CALL_LOG_WEBHOOK_URL,
            { event: "CALL_LOG", phase: snapWithPhase?.phase || "end", call: callMeta }
          ),
        sendFinal: async (payload) =>
          deliverWebhookDirect("FINAL", env.FINAL_WEBHOOK_URL, { ...payload, call: callMeta, lead: this._call.lead }),
        sendAbandoned: async (payload) =>
          deliverWebhookDirect("ABANDONED", env.ABANDONED_WEBHOOK_URL, { ...payload, call: callMeta, lead: this._call.lead }),
        resolveRecording: async () => ({
          recording_provider: callMeta.recording_provider,
          recording_sid: callMeta.recording_sid,
          recording_url_public: callMeta.recording_url_public
        })
      };

      // Build snapshot
      const snapshot = {
        call: callMeta,
        lead: this._call.lead,
        // keep transcript separately, not inside lead.notes
        transcript: this._call.transcript
      };

      await finalizePipeline({
        snapshot,
        env,
        senders,
        logger,
        state: this._state
      });
    } catch (e) {
      logger.warn("Finalize failed", { error: String(e) });
    }
  }

  stop() {
    this._finalizeOnce("stop_called").catch(() => {});

    if (!this.ws) return;
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

module.exports = { GeminiLiveSession };
