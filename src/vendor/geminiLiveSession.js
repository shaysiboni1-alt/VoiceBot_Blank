"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");
const { getSSOT } = require("../ssot/ssotClient");

function normalizeModelName(m) {
  // Google expects: "models/<model>"
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

function buildSystemInstructionFromSSOT() {
  const ssot = (typeof getSSOT === "function" ? getSSOT() : null) || {};
  const prompts = ssot.prompts || {};

  const chunks = [];
  if (prompts.SYSTEM_PROMPT) chunks.push(String(prompts.SYSTEM_PROMPT).trim());
  if (prompts.SETTINGS_CONTEXT) chunks.push(String(prompts.SETTINGS_CONTEXT).trim());
  if (prompts.RULES) chunks.push(String(prompts.RULES).trim());

  // Hard default to avoid "Arabic-first"
  chunks.push("שפה ברירת מחדל: עברית. אם המשתמש מבקש שפה אחרת - לעבור אליה.");

  return chunks.filter(Boolean).join("\n\n").trim();
}

function getGreetingFromSSOT() {
  const ssot = (typeof getSSOT === "function" ? getSSOT() : null) || {};
  const prompts = ssot.prompts || {};
  return (prompts.GREETING && String(prompts.GREETING).trim()) || "שלום! במה אוכל לעזור?";
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, meta }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.meta = meta || {};
    this.ws = null;
    this.ready = false;
    this.closed = false;

    this._greetingSent = false;
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

      const systemText = buildSystemInstructionFromSSOT();

      const setup = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),

          // systemInstruction MUST be Content (object with parts), not a raw string
          systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,

          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: env.VOICE_NAME_OVERRIDE || "Kore",
                },
              },
            },
          },

          // VAD + barge-in behavior (numeric fields only; avoid sensitivity enums)
          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: Number(env.MB_VAD_PREFIX_MS ?? 200),
              silenceDurationMs: Number(env.MB_VAD_SILENCE_MS ?? 900),
            },
          },

          // Enable transcripts (safe empty object shapes)
          ...(env.MB_LOG_TRANSCRIPTS
            ? { inputAudioTranscription: {}, outputAudioTranscription: {} }
            : {}),
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
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      // Trigger proactive greeting as soon as setup is acknowledged
      if (msg?.setupComplete && !this._greetingSent) {
        this._greetingSent = true;
        this._sendProactiveGreeting();
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
      } catch {}

      // Transcriptions (best-effort)
      try {
        const inTr = msg?.serverContent?.inputTranscription?.text;
        if (inTr) logger.info("TRANSCRIPT user", { ...this.meta, text: String(inTr) });

        const outTr = msg?.serverContent?.outputTranscription?.text;
        if (outTr) logger.info("TRANSCRIPT bot", { ...this.meta, text: String(outTr) });
      } catch {}
    });

    this.ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;
      logger.info("Gemini Live WS closed", { ...this.meta, code, reason });
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { ...this.meta, error: err.message });
    });
  }

  _sendProactiveGreeting() {
    if (!this.ws || this.closed || !this.ready) return;

    const greeting = getGreetingFromSSOT();
    const userKickoff = `התחל/י שיחה עכשיו. אמור/י את הפתיח הבא בעברית, בדיוק וברצף, ואז עצור/י להקשבה:\n${greeting}`;

    // clientContent.turns + turnComplete=true triggers an immediate model response
    const msg = {
      clientContent: {
        turns: [{ role: "user", parts: [{ text: userKickoff }] }],
        turnComplete: true,
      },
    };

    try {
      this.ws.send(JSON.stringify(msg));
      logger.info("Proactive greeting sent", this.meta);
    } catch (e) {
      logger.debug("Failed sending proactive greeting", { ...this.meta, error: e.message });
    }
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;

    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    const msg = {
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16kB64 }],
      },
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
    } catch {}
  }

  stop() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {}
  }
}

module.exports = { GeminiLiveSession };
