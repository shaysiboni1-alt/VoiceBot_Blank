// src/vendor/geminiLiveSession.js
"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

// קיים אצלך בקוד: המרות Twilio (ulaw8k) <-> Gemini (pcm16/pcm24)
const {
  ulaw8kB64ToPcm16kB64, // ulaw8k -> pcm16 (בדרך כלל 16k)
  pcm24kB64ToUlaw8kB64, // pcm 24k -> ulaw8k
} = require("./twilioGeminiAudio");

function buildSystemInstructionContent(text) {
  // לפי הסכמה: systemInstruction הוא Content (עם parts)
  return {
    role: "user",
    parts: [{ text: String(text || "") }],
  };
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;

    this.streamSid = null;
    this.callSid = null;
    this.customParameters = {};

    this._geminiWs = null;
    this._started = false;
    this._setupAck = false;
    this._stopping = false;

    this._pendingAudio = [];
  }

  _endpointUrl() {
    // Live API websocket endpoint (API key mode)
    // wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=...
    // (זה ה-endpoint של Live API WebSockets reference)
    const key = env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
      key
    )}`;
  }

  _voiceName() {
    // אם לא הוגדר override – נשאיר ריק (Gemini יבחר default)
    return env.VOICE_NAME_OVERRIDE && String(env.VOICE_NAME_OVERRIDE).trim()
      ? String(env.VOICE_NAME_OVERRIDE).trim()
      : null;
  }

  _buildSetupMessage() {
    // IMPORTANT:
    // 1) inputAudioTranscription/outputAudioTranscription הם שדות בתוך setup (ולא בתוך realtimeInputConfig)
    // 2) systemInstruction הוא Content (ולא string)
    // 3) realtimeInputConfig הוא camelCase

    const voiceName = this._voiceName();

    const setup = {
      model: env.GEMINI_LIVE_MODEL,
      // System instruction: Content
      systemInstruction: buildSystemInstructionContent(
        // כרגע מינימלי כדי לא “להפיל” את הסשן; את הפרומפט המלא נמשוך מה-SSOT בהמשך
        "דבר/י בעברית כברירת מחדל. היה/י עוזר/ת טלפוני/ת קצר/ה וברור/ה."
      ),

      // מאפשר תמלול גם לקלט וגם לפלט (כמו שביקשת)
      inputAudioTranscription: {},
      outputAudioTranscription: {},

      // Realtime input behavior (VAD)
      realtimeInputConfig: {
        automaticActivityDetection: {
          // ברירת מחדל enabled. אפשר גם להגדיר מפורש:
          // אם תרצה לשלוט בסף/זמנים מתקדם – נוסיף אח"כ לפי הסכמה המלאה.
        },
      },

      generationConfig: {
        responseModalities: ["AUDIO"],
        // Voice config (אם יש override)
        ...(voiceName
          ? {
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName,
                  },
                },
              },
            }
          : {}),
      },
    };

    return { setup };
  }

  async start({ streamSid, callSid, customParameters }) {
    if (this._started) return;
    this._started = true;

    this.streamSid = streamSid || null;
    this.callSid = callSid || null;
    this.customParameters = customParameters || {};

    const url = this._endpointUrl();
    const ws = new WebSocket(url);
    this._geminiWs = ws;

    ws.on("open", () => {
      logger.info("Gemini Live WS connected", { callSid: this.callSid, streamSid: this.streamSid });

      // Send setup FIRST
      const setupMsg = this._buildSetupMessage();
      ws.send(JSON.stringify(setupMsg));

      // Flush any audio queued before setup ack (אם קיים)
      if (this._pendingAudio.length) {
        for (const msg of this._pendingAudio) ws.send(msg);
        this._pendingAudio = [];
      }
    });

    ws.on("message", (raw) => {
      try {
        const txt = raw.toString("utf8");
        const msg = JSON.parse(txt);

        // Setup complete ack
        if (msg && msg.setupComplete) {
          this._setupAck = true;
          return;
        }

        // Transcription (input/output)
        // לפי reference: BidiGenerateContentTranscription עם text
        if (msg && msg.transcription && typeof msg.transcription.text === "string") {
          const t = msg.transcription.text.trim();
          if (t) this.onGeminiText && this.onGeminiText(t);
          return;
        }

        // Server content: model audio
        // בפועל מגיעים כמה wrappers אפשריים; נטפל בצורה "סלחנית":
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.modelTurn?.parts ||
          msg?.content?.parts ||
          [];

        if (Array.isArray(parts) && parts.length) {
          for (const p of parts) {
            const inline = p.inlineData || p.inline_data;
            if (!inline || !inline.data) continue;

            const mime = String(inline.mimeType || inline.mime_type || "");
            const b64 = String(inline.data || "");

            // אנחנו מצפים לאודיו PCM מהמודל, לרוב 24k
            if (mime.startsWith("audio/")) {
              // Convert PCM24k base64 -> ulaw8k base64 for Twilio
              const ulaw8 = pcm24kB64ToUlaw8kB64(b64);
              if (ulaw8) this.onGeminiAudioUlaw8kBase64 && this.onGeminiAudioUlaw8kBase64(ulaw8);
            }
          }
        }
      } catch (e) {
        logger.warn("Gemini Live WS message parse failed", {
          error: e.message,
          callSid: this.callSid,
          streamSid: this.streamSid,
        });
      }
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : "";
      logger.info("Gemini Live WS closed", {
        callSid: this.callSid,
        streamSid: this.streamSid,
        code,
        reason,
      });
    });

    ws.on("error", (err) => {
      logger.error("Gemini Live WS error", {
        error: err.message,
        callSid: this.callSid,
        streamSid: this.streamSid,
      });
    });
  }

  /**
   * Twilio sends ulaw8k base64 frames.
   * We convert to PCM16 base64 and stream to Gemini as realtime input audio.
   */
  sendTwilioUlaw8kBase64(ulaw8kB64) {
    if (this._stopping) return;
    if (!this._geminiWs) return;

    // Convert ulaw8k -> pcm16 (base64)
    const pcm16b64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    // Live API expects: { realtimeInput: { mediaChunks:[{mimeType, data}] } }
    // (ב-WS reference זה נקרא realtimeInput) – שמות camelCase
    const msgObj = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: pcm16b64,
          },
        ],
      },
    };

    const payload = JSON.stringify(msgObj);

    // אם ה-setup עוד לא "התייצב" – נאגור רגע (לא חובה, אבל מונע race)
    if (!this._setupAck) {
      this._pendingAudio.push(payload);
      return;
    }

    this._geminiWs.send(payload);
  }

  stop() {
    if (this._stopping) return;
    this._stopping = true;

    try {
      if (this._geminiWs) this._geminiWs.close();
    } catch (_) {}

    this._geminiWs = null;
  }
}

module.exports = { GeminiLiveSession };
