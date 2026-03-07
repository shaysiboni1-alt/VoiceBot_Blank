"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");
const { detectIntent } = require("../logic/intentRouter");
const { normalizeUtterance } = require("../logic/hebrewNlp");
const { extractCallerName } = require("../logic/nameExtractor");
const { finalizePipeline } = require("../stage4/finalizePipeline");
const { updateCallerDisplayName } = require("../memory/callerMemory");
const { startCallRecording, publicRecordingUrl, hangupCall } = require("../utils/twilioRecordings");
const { setRecordingForCall, waitForRecording, getRecordingForCall } = require("../utils/recordingRegistry");

let passiveCallContext = null;
try {
  passiveCallContext = require("../logic/passiveCallContext");
} catch {}

function normalizeModelName(m) {
  if (!m) return "";
  if (m.startsWith("models/")) return m;
  return `models/${m}`;
}
function liveWsUrl() {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
}
function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}
function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
function nowIso() {
  return new Date().toISOString();
}
function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (["anonymous", "restricted", "unavailable", "unknown"].includes(low)) return { value: s, withheld: true };
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}
function isTruthyEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}
function isClosingUtterance(text) {
  const t = safeStr(text).toLowerCase();
  if (!t) return false;
  return /(תודה\s*ו?להתראות|להתראות|ביי|נתראה|thank(s)?\b.*(bye|goodbye)|\bbye\b|\bgoodbye\b|до свидания|спасибо)/i.test(t);
}
function applyTemplate(tpl, vars) {
  const s = safeStr(tpl);
  if (!s) return "";
  return s.replace(/\{([A-Za-z0-9_]+)\}/g, (_, keyRaw) => {
    const key = String(keyRaw || "");
    const direct = vars?.[key];
    if (direct !== undefined && direct !== null) return String(direct);
    const upper = vars?.[key.toUpperCase()];
    if (upper !== undefined && upper !== null) return String(upper);
    const lower = vars?.[key.toLowerCase()];
    if (lower !== undefined && lower !== null) return String(lower);
    return "";
  });
}
function buildSettingsContext(settings) {
  return Object.keys(settings || {}).sort().map((k) => `${k}: ${safeStr(settings[k])}`).join("\n").trim();
}
function buildIntentsContext(intents) {
  const rows = Array.isArray(intents) ? intents.slice() : [];
  rows.sort((a, b) => (Number(b?.priority ?? 0) - Number(a?.priority ?? 0)) || String(a?.intent_id ?? "").localeCompare(String(b?.intent_id ?? "")));
  return rows.map((it) => `- ${safeStr(it.intent_id)} | type=${safeStr(it.intent_type)} | priority=${Number(it.priority ?? 0) || 0} | triggers_he=${safeStr(it.triggers_he)} | triggers_en=${safeStr(it.triggers_en)} | triggers_ru=${safeStr(it.triggers_ru)}`).join("\n").trim();
}
function buildSystemInstructionFromSSOT(ssot, runtimeMeta) {
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const intents = ssot?.intents || [];
  const defaultLang = safeStr(env.MB_DEFAULT_LANGUAGE || settings.DEFAULT_LANGUAGE) || "he";
  const sections = [];
  sections.push([
    "IDENTITY (NON-NEGOTIABLE):",
    "- You are NOT a generic model and must NEVER describe yourself as an AI/LLM/model.",
    "- You are the business phone assistant defined by SETTINGS and PROMPTS.",
    "- Speak naturally, briefly, and service-first.",
    "- Keep answers short and usable on a live phone call.",
    "",
    "STRICT OUTPUT POLICY (CRITICAL):",
    "- NEVER output analysis, explanations, markdown, or meta-commentary.",
    "- DO NOT think out loud.",
    "- Speak only the final caller-facing sentence(s).",
    "- If told to say a specific sentence verbatim, say only that sentence and then stop.",
  ].join("\n"));

  const callerName = safeStr(runtimeMeta?.caller_name) || safeStr(runtimeMeta?.display_name) || "";
  if (callerName) {
    sections.push([
      "CALLER MEMORY POLICY:",
      `- Known caller name: \"${callerName}\"`,
      "- Treat it as correct unless the caller explicitly corrects it.",
      "- Do NOT ask for the caller name again.",
    ].join("\n"));
  }

  for (const key of ["MASTER_PROMPT", "GUARDRAILS_PROMPT", "KB_PROMPT", "LEAD_CAPTURE_PROMPT", "INTENT_ROUTER_PROMPT"]) {
    if (safeStr(prompts[key])) sections.push(`${key}:\n${safeStr(prompts[key])}`);
  }
  const settingsContext = buildSettingsContext(settings);
  if (settingsContext) sections.push(`SETTINGS_CONTEXT (SOURCE OF TRUTH):\n${settingsContext}`);
  const intentsContext = buildIntentsContext(intents);
  if (intentsContext) sections.push(`INTENTS_TABLE:\n${intentsContext}`);

  sections.push([
    "LANGUAGE POLICY (HARD RULES):",
    `- default_language=${defaultLang}`,
    `- Start in ${defaultLang === "he" ? "Hebrew" : defaultLang} and stay there by default.`,
    "- NEVER switch language because of accent, pronunciation, caller name, or guesswork.",
    "- Switch language ONLY if the caller explicitly asks to switch, or if the caller clearly speaks another supported language for at least two consecutive utterances.",
    "- If unsure, continue in Hebrew.",
    "- Keep the opening in Hebrew unless there is an explicit language switch request.",
  ].join("\n"));

  return sections.filter(Boolean).join("\n\n---\n\n").trim();
}
function computeGreetingHebrew(timeZone) {
  const tz = timeZone || "Asia/Jerusalem";
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()));
  if (Number.isNaN(hour)) return "שלום";
  if (hour >= 5 && hour < 11) return "בוקר טוב";
  if (hour >= 11 && hour < 17) return "צהריים טובים";
  if (hour >= 17 && hour < 22) return "ערב טוב";
  return "לילה טוב";
}
function getOpeningScriptFromSSOT(ssot, vars) {
  const settings = ssot?.settings || {};
  const isReturning = Boolean(vars?.RETURNING_CALLER) || Boolean(vars?.returning_caller);
  const tpl = (isReturning && safeStr(settings.OPENING_SCRIPT_RETURNING)) ? safeStr(settings.OPENING_SCRIPT_RETURNING) : (safeStr(settings.OPENING_SCRIPT) || "שלום! איך אפשר לעזור?");
  const merged = {
    BUSINESS_NAME: safeStr(settings.BUSINESS_NAME),
    BOT_NAME: safeStr(settings.BOT_NAME),
    CALLER_NAME: safeStr(vars?.CALLER_NAME),
    DISPLAY_NAME: safeStr(vars?.CALLER_NAME),
    display_name: safeStr(vars?.CALLER_NAME),
    MAIN_PHONE: safeStr(settings.MAIN_PHONE),
    BUSINESS_EMAIL: safeStr(settings.BUSINESS_EMAIL),
    BUSINESS_ADDRESS: safeStr(settings.BUSINESS_ADDRESS),
    WORKING_HOURS: safeStr(settings.WORKING_HOURS),
    BUSINESS_WEBSITE_URL: safeStr(settings.BUSINESS_WEBSITE_URL),
    VOICE_NAME: safeStr(settings.VOICE_NAME),
    GREETING: safeStr(vars?.GREETING),
    ...vars,
  };
  return applyTemplate(tpl, merged).trim() || "שלום! איך אפשר לעזור?";
}
async function deliverWebhook(url, payload, label) {
  if (!url) return;
  try {
    const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    logger.info("Webhook delivered", { label, status: resp.status });
  } catch (e) {
    logger.warn("Webhook delivery failed", { label, error: String(e) });
  }
}
function looksLikeNumericContinuation(prev, next) {
  const a = safeStr(prev);
  const b = safeStr(next);
  if (!a || !b) return false;
  const aDigits = a.replace(/\D/g, "");
  const bDigits = b.replace(/\D/g, "");
  if (aDigits && bDigits) return true;
  if (/^(ו?שנת|שנה|year|год)/i.test(b)) return true;
  if (/^\d{1,2}$/.test(b)) return true;
  return false;
}
function concatChunks(prev, next) {
  const a = safeStr(prev);
  const b = safeStr(next);
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith(a)) return b;
  if (a.endsWith(b)) return a;
  if (looksLikeNumericContinuation(a, b)) return `${a}${b}`.replace(/\s+/g, " ").trim();
  if (/^[,.;:!?]/.test(b)) return `${a}${b}`;
  return `${a} ${b}`.replace(/\s+/g, " ").trim();
}

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
    this._tr = {
      user: { bufferText: "", lastChunk: "", timer: null, lastChunkTs: 0 },
      bot: { bufferText: "", lastChunk: "", timer: null, lastChunkTs: 0 },
    };
    const callerInfo = normalizeCallerId(this.meta?.caller || "");
    this._call = {
      callSid: safeStr(this.meta?.callSid),
      streamSid: safeStr(this.meta?.streamSid),
      source: safeStr(this.meta?.source) || "VoiceBot_Blank",
      caller_raw: callerInfo.value,
      caller_withheld: callerInfo.withheld,
      called: safeStr(this.meta?.called),
      started_at: nowIso(),
      ended_at: null,
      conversationLog: [],
      recording_sid: "",
      finalized: false,
    };
    this._passiveCtx = null;
    try {
      if (passiveCallContext?.createPassiveCallContext) {
        this._passiveCtx = passiveCallContext.createPassiveCallContext({
          callSid: this._call.callSid,
          streamSid: this._call.streamSid,
          caller: this._call.caller_raw,
          called: this._call.called,
          source: this._call.source,
          caller_profile: this.meta?.caller_profile || null,
        });
      }
    } catch {}
    this._hangupScheduled = false;
    this._language = {
      default: safeStr(env.MB_DEFAULT_LANGUAGE || this.ssot?.settings?.DEFAULT_LANGUAGE) || "he",
      locked: safeStr(env.MB_DEFAULT_LANGUAGE || this.ssot?.settings?.DEFAULT_LANGUAGE) || "he",
      candidate: null,
      candidateHits: 0,
      explicitSwitchRequested: false,
    };
  }

  start() {
    if (this.ws) return;
    this.ws = new WebSocket(liveWsUrl());

    this.ws.on("open", async () => {
      logger.info("Gemini Live WS connected", this.meta);
      try {
        const r = await startCallRecording(this._call.callSid, logger);
        if (r?.ok && r.recordingSid) {
          this._call.recording_sid = String(r.recordingSid);
          setRecordingForCall(this._call.callSid, { recordingSid: this._call.recording_sid });
          logger.info("Recording started + stored in registry", { callSid: this._call.callSid, recordingSid: this._call.recording_sid });
        }
      } catch (e) {
        logger.warn("startCallRecording failed", { err: String(e) });
      }

      const callerName = safeStr(this.meta?.caller_profile?.display_name);
      const systemText = buildSystemInstructionFromSSOT(this.ssot, { caller_name: callerName, display_name: callerName });
      const vadPrefix = env.MB_LOW_LATENCY_MODE ? clampNum(env.MB_VAD_PREFIX_MS ?? 40, 20, 200, 40) : clampNum(env.MB_VAD_PREFIX_MS ?? 120, 40, 600, 120);
      const vadSilence = env.MB_LOW_LATENCY_MODE ? clampNum(env.MB_VAD_SILENCE_MS ?? 120, 80, 400, 120) : clampNum(env.MB_VAD_SILENCE_MS ?? 450, 150, 1500, 450);

      const setup = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
          systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.15,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.VOICE_NAME_OVERRIDE || safeStr(this.ssot?.settings?.VOICE_NAME) || "Kore" } } },
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: vadPrefix,
              silenceDurationMs: vadSilence,
            },
          },
          ...(env.MB_LOG_TRANSCRIPTS ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
        },
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
      try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
      if ((msg?.setupComplete || msg?.serverContent) && !this._greetingSent) {
        this._greetingSent = true;
        this._sendProactiveOpening();
      }

      try {
        const parts = msg?.serverContent?.modelTurn?.parts || msg?.serverContent?.turn?.parts || msg?.serverContent?.parts || [];
        for (const p of parts) {
          const inline = p?.inlineData;
          if (inline?.data && String(inline?.mimeType || "").startsWith("audio/pcm")) {
            const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
            if (ulawB64 && this.onGeminiAudioUlaw8kBase64) this.onGeminiAudioUlaw8kBase64(ulawB64);
          }
          if (p?.text && this.onGeminiText) this.onGeminiText(String(p.text));
        }
      } catch (e) {
        logger.debug("Gemini message parse error", { ...this.meta, error: e.message });
      }

      try {
        const inTr = msg?.serverContent?.inputTranscription?.text;
        if (inTr) this._onTranscriptChunk("user", String(inTr));
        const outTr = msg?.serverContent?.outputTranscription?.text;
        if (outTr) this._onTranscriptChunk("bot", String(outTr));
      } catch {}
    });

    this.ws.on("close", async (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;
      this._flushTranscript("user");
      this._flushTranscript("bot");
      logger.info("Gemini Live WS closed", { ...this.meta, code, reason });
      await this._finalizeOnce("gemini_ws_close");
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { ...this.meta, error: err.message });
    });
  }

  _nextFlushMs(who, chunk) {
    const base = who === "user" ? env.MB_USER_UTTERANCE_FLUSH_MS : env.MB_BOT_UTTERANCE_FLUSH_MS;
    const t = safeStr(chunk);
    if (looksLikeNumericContinuation(this._tr[who].bufferText, t)) {
      return Math.max(base, Number(env.MB_NUMERIC_CONTINUATION_GRACE_MS || 900));
    }
    if (t.length <= Math.max(1, Number(env.MB_MIN_STABLE_UTTERANCE_CHARS || 4) - 1)) return Math.max(base, 900);
    return base;
  }

  _onTranscriptChunk(who, chunk) {
    if (!env.MB_LOG_TRANSCRIPTS) return;
    const c = safeStr(chunk);
    if (!c) return;
    if (c === this._tr[who].lastChunk) return;
    this._tr[who].lastChunk = c;
    this._tr[who].lastChunkTs = Date.now();
    this._tr[who].bufferText = concatChunks(this._tr[who].bufferText, c).slice(-1200);
    if (this._tr[who].timer) clearTimeout(this._tr[who].timer);
    this._tr[who].timer = setTimeout(() => this._flushTranscript(who), this._nextFlushMs(who, c));
  }

  _resolveLanguagePolicy(nlp) {
    let observed = nlp.lang;
    if (!observed || observed === "unknown" || nlp.lang_confidence < 0.75 || nlp.language_analysis?.mixed) observed = this._language.locked;
    const explicit = nlp.explicit_language_switch;
    if (explicit) {
      this._language.locked = explicit;
      this._language.candidate = null;
      this._language.candidateHits = 0;
      this._language.explicitSwitchRequested = true;
      observed = explicit;
    } else if (env.MB_LANGUAGE_LOCK_ENABLED) {
      if (observed && observed !== this._language.locked) {
        if (observed === this._language.candidate) this._language.candidateHits += 1;
        else {
          this._language.candidate = observed;
          this._language.candidateHits = 1;
        }
        if (this._language.candidateHits >= Number(env.MB_LANGUAGE_SWITCH_MIN_CONSECUTIVE_UTTERANCES || 2)) {
          this._language.locked = observed;
          this._language.candidate = null;
          this._language.candidateHits = 0;
        }
      } else {
        this._language.candidate = null;
        this._language.candidateHits = 0;
      }
    } else if (observed && observed !== "unknown") {
      this._language.locked = observed;
    }
    return this._language.locked;
  }

  _flushTranscript(who) {
    if (!env.MB_LOG_TRANSCRIPTS) return;
    if (this._tr[who].timer) {
      clearTimeout(this._tr[who].timer);
      this._tr[who].timer = null;
    }
    const text = safeStr(this._tr[who].bufferText);
    this._tr[who].bufferText = "";
    if (!text) return;

    const nlp = normalizeUtterance(text);
    const lockedLanguage = who === "user" ? this._resolveLanguagePolicy(nlp) : this._language.locked;

    try {
      const role = who === "user" ? "user" : "assistant";
      this._call.conversationLog.push({ role, text: nlp.raw, ts: nowIso(), lang: lockedLanguage });
    } catch {}

    try {
      if (this._passiveCtx && passiveCallContext?.appendUtterance) {
        passiveCallContext.appendUtterance(this._passiveCtx, {
          role: who === "user" ? "user" : "assistant",
          text: nlp.raw,
          normalized: nlp.normalized,
          lang: nlp.lang,
          language_locked: lockedLanguage,
          is_closing: nlp.is_closing,
          affirmed_callback_number: nlp.is_affirmation,
        });
      }
    } catch {}

    logger.info(`UTTERANCE ${who}`, { ...this.meta, text: nlp.raw, normalized: nlp.normalized, lang: nlp.lang, language_locked: lockedLanguage, lang_confidence: nlp.lang_confidence });
    if (who === "user" && env.MB_LOG_LANGUAGE_DECISIONS) {
      logger.info("LANGUAGE_DECISION", { ...this.meta, observed_lang: nlp.lang, observed_confidence: nlp.lang_confidence, explicit_switch: nlp.explicit_language_switch, locked_language: lockedLanguage, candidate_language: this._language.candidate, candidate_hits: this._language.candidateHits });
    }

    if (who === "user") {
      try {
        const callerId = safeStr(this.meta?.caller);
        if (callerId) {
          let lastBot = "";
          const logArr = Array.isArray(this._call?.conversationLog) ? this._call.conversationLog : [];
          for (let i = logArr.length - 2; i >= 0; i--) {
            const it = logArr[i];
            if (it && it.role === "assistant" && it.text) { lastBot = String(it.text); break; }
          }
          const found = extractCallerName({ userText: nlp.raw, lastBotUtterance: lastBot });
          if (found?.name) {
            let normalizedName = String(found.name).trim();
            if (normalizedName === "שאי") normalizedName = "שי";
            const existing = safeStr(this.meta?.caller_profile?.display_name);
            if (!existing || existing !== normalizedName) {
              updateCallerDisplayName(callerId, normalizedName).catch(() => {});
              if (!this.meta.caller_profile) this.meta.caller_profile = {};
              this.meta.caller_profile.display_name = normalizedName;
              logger.info("CALLER_NAME_CAPTURED", { ...this.meta, caller: callerId, name: normalizedName, confidence_reason: found.reason, source_utterance: nlp.raw });
            }
          }
        }
      } catch {}
    }

    if (who === "bot" && env.FORCE_HANGUP_AFTER_CLOSE && !this._hangupScheduled && (nlp.is_closing || isClosingUtterance(nlp.raw))) {
      const callSid = safeStr(this._call?.callSid) || safeStr(this.meta?.callSid);
      if (callSid) {
        this._hangupScheduled = true;
        const graceMs = Math.max(3000, Number(env.HANGUP_AFTER_CLOSE_GRACE_MS || 15000));
        setTimeout(() => { hangupCall(callSid, logger).catch(() => {}); }, graceMs);
        logger.info("Proactive hangup scheduled", { ...this.meta, callSid, delay_ms: graceMs });
      }
    }

    if (who === "user") {
      const intent = detectIntent({ text: nlp.normalized || nlp.raw, intents: this.ssot?.intents || [], opts: { forceLang: lockedLanguage } });
      logger.info("INTENT_DETECTED", { ...this.meta, text: nlp.raw, normalized: nlp.normalized, lang: nlp.lang, language_locked: lockedLanguage, intent });
    }

    if (this.onTranscript) this.onTranscript({ who, text: nlp.raw, normalized: nlp.normalized, lang: nlp.lang, language_locked: lockedLanguage });
  }

  _sendProactiveOpening() {
    if (!this.ws || this.closed || !this.ready) return;
    const greeting = computeGreetingHebrew(env.TIME_ZONE || "Asia/Jerusalem");
    let callerName = safeStr(this.meta?.caller_profile?.display_name);
    if (callerName === "שאי") callerName = "שי";
    const totalCalls = Number(this.meta?.caller_profile?.total_calls ?? 0);
    const isReturning = totalCalls > 0;
    let opening = getOpeningScriptFromSSOT(this.ssot, { GREETING: greeting, CALLER_NAME: callerName, DISPLAY_NAME: callerName, display_name: callerName, returning_caller: isReturning, RETURNING_CALLER: isReturning });
    opening = String(opening).replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").replace(/,\s+,/g, ",").trim();
    const userKickoff = `אמרי עכשיו בדיוק את המשפט הבא בלבד, בעברית, מילה במילה, בלי שום תוספת, ואז עצרי להקשבה:\n${opening}`;
    try {
      this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: userKickoff }] }], turnComplete: true } }));
      logger.info("Proactive opening sent", { ...this.meta, greeting, opening_len: opening.length, language_locked: this._language.locked });
    } catch (e) {
      logger.debug("Failed sending proactive opening", { ...this.meta, error: e.message });
    }
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: ulaw8kB64ToPcm16kB64(ulaw8kB64) }] } }));
    } catch (e) {
      logger.debug("Failed sending audio to Gemini", { ...this.meta, error: e.message });
    }
  }

  endInput() {
    if (!this.ws || this.closed) return;
    try { this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch {}
  }

  async _finalizeOnce(reason) {
    if (this._call.finalized) return;
    this._call.finalized = true;
    try {
      this._call.ended_at = nowIso();
      const durationMs = Date.now() - new Date(this._call.started_at).getTime();
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
        finalize_reason: reason || "",
        language_locked: this._language.locked,
      };
      if (this._passiveCtx && passiveCallContext?.finalizeCtx) {
        try { callMeta.passive_context = passiveCallContext.finalizeCtx(this._passiveCtx); } catch {}
      } else if (passiveCallContext?.buildPassiveContext) {
        try { callMeta.passive_context = passiveCallContext.buildPassiveContext({ meta: this.meta, ssot: this.ssot }); } catch {}
      }
      await finalizePipeline({
        snapshot: { call: callMeta, conversationLog: this._call.conversationLog || [] },
        ssot: this.ssot,
        env,
        logger,
        senders: {
          sendCallLog: (payload) => deliverWebhook(env.CALL_LOG_WEBHOOK_URL, payload, "CALL_LOG"),
          sendFinal: (payload) => deliverWebhook(env.FINAL_WEBHOOK_URL, payload, "FINAL"),
          sendAbandoned: (payload) => deliverWebhook(env.ABANDONED_WEBHOOK_URL, payload, "ABANDONED"),
          resolveRecording: async () => {
            if (!isTruthyEnv(env.MB_ENABLE_RECORDING)) return { recording_provider: null, recording_sid: null, recording_url_public: null };
            await waitForRecording(this._call.callSid, 12000);
            const rec = getRecordingForCall(this._call.callSid);
            const sid = safeStr(rec?.recordingSid || this._call.recording_sid) || null;
            if (sid) this._call.recording_sid = sid;
            return { recording_provider: sid ? "twilio" : null, recording_sid: sid, recording_url_public: sid ? publicRecordingUrl(sid) : null };
          },
        }
      });
    } catch (e) {
      logger.warn("Finalize failed", { error: String(e) });
    }
  }

  stop() {
    this._finalizeOnce("stop_called").catch(() => {});
    if (!this.ws) return;
    try { this.ws.close(); } catch {}
  }
}

module.exports = { GeminiLiveSession };
