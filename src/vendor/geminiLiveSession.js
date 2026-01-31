// src/vendor/geminiLiveSession.js
"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

// Gemini Live WS endpoint (Google AI for Developers - Live API)
function buildGeminiLiveWsUrl() {
  // Live API endpoint (key-based)
  // NOTE: we keep this minimal; you already have a working connection.
  const model = env.GEMINI_LIVE_MODEL;
  if (!model) throw new Error("Missing GEMINI_LIVE_MODEL");
  if (!env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  // This is the Live API websocket endpoint pattern (you already reached "connected").
  // Keep as-is if your repo already uses a different URL builder that works.
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    env.GEMINI_API_KEY
  )}`;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

class GeminiLiveSession {
  constructor({
    callSid,
    streamSid,
    systemInstructionText,
    onGeminiAudioUlaw8kBase64,
    onGeminiInputTranscript,
    onGeminiOutputTranscript,
    onGeminiText
  }) {
    this.callSid = callSid || "";
    this.streamSid = streamSid || "";
    this.systemInstructionText = systemInstructionText || "";

    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiInputTranscript = onGeminiInputTranscript;
    this.onGeminiOutputTranscript = onGeminiOutputTranscript;
    this.onGeminiText = onGeminiText;

    this.ws = null;
    this.setupComplete = false;
    this.closed = false;
  }

  async start() {
    if (this.ws) return;

    const url = buildGeminiLiveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", {
        callSid: this.callSid,
        streamSid: this.streamSid
      });

      // IMPORTANT:
      // setup.systemInstruction MUST be Content (not string).
      // Also enable inputTranscription/outputTranscription so we get full transcripts.
      const setupMsg = {
        setup: {
          model: `models/${env.GEMINI_LIVE_MODEL}`,

          // System instruction must be Content with parts[].text
          systemInstruction: this.systemInstructionText
            ? { parts: [{ text: this.systemInstructionText }] }
            : undefined,

          // Realtime config: keep minimal.
          realtimeInputConfig: {
            // Turn on transcripts for both sides
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          },

          // Optional: ask for audio+text (depends on model; audio is what we need)
          generationConfig: {
            // Keep defaults; do not force language here.
          }
        }
      };

      // Remove undefined fields (clean JSON)
      if (!setupMsg.setup.systemInstruction) delete setupMsg.setup.systemInstruction;

      this.ws.send(JSON.stringify(setupMsg));
    });

    this.ws.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const msg = safeJsonParse(text);
      if (!msg) {
        logger.warn("Gemini WS non-JSON message", {
          callSid: this.callSid,
          streamSid: this.streamSid,
          sample: text.slice(0, 200)
        });
        return;
      }

      // setupComplete
      if (msg.setupComplete) {
        this.setupComplete = true;
        logger.info("Gemini Live setupComplete", {
          callSid: this.callSid,
          streamSid: this.streamSid
        });
        return;
      }

      // serverContent: may contain modelTurn (text/audio parts)
      if (msg.serverContent) {
        const sc = msg.serverContent;

        // modelTurn content (text parts)
        if (sc.modelTurn && sc.modelTurn.parts && Array.isArray(sc.modelTurn.parts)) {
          const texts = [];
          for (const p of sc.modelTurn.parts) {
            if (p && typeof p.text === "string" && p.text.trim()) texts.push(p.text.trim());
            // Some responses may include inlineData for audio etc. We handle audio below.
            if (p && p.inlineData && p.inlineData.data && p.inlineData.mimeType) {
              // If Gemini returns audio as inlineData base64, we forward it.
              // We assume it's already ulaw8k base64 per your working setup; if you convert elsewhere keep it there.
              if (typeof this.onGeminiAudioUlaw8kBase64 === "function") {
                this.onGeminiAudioUlaw8kBase64(p.inlineData.data, {
                  mimeType: p.inlineData.mimeType
                });
              }
            }
          }
          if (texts.length && typeof this.onGeminiText === "function") {
            this.onGeminiText(texts.join("\n"));
          }
        }

        return;
      }

      // inputTranscription: caller transcript
      if (msg.inputTranscription) {
        const t = msg.inputTranscription;
        const transcriptText =
          (t.text && String(t.text)) ||
          (t.transcript && String(t.transcript)) ||
          "";

        if (transcriptText.trim()) {
          if (env.MB_LOG_TRANSCRIPTS) {
            logger.info("Transcript IN", {
              callSid: this.callSid,
              streamSid: this.streamSid,
              text: transcriptText
            });
          }
          if (typeof this.onGeminiInputTranscript === "function") {
            this.onGeminiInputTranscript(transcriptText);
          }
        }
        return;
      }

      // outputTranscription: bot transcript
      if (msg.outputTranscription) {
        const t = msg.outputTranscription;
        const transcriptText =
          (t.text && String(t.text)) ||
          (t.transcript && String(t.transcript)) ||
          "";

        if (transcriptText.trim()) {
          if (env.MB_LOG_TRANSCRIPTS) {
            logger.info("Transcript OUT", {
              callSid: this.callSid,
              streamSid: this.streamSid,
              text: transcriptText
            });
          }
          if (typeof this.onGeminiOutputTranscript === "function") {
            this.onGeminiOutputTranscript(transcriptText);
          }
        }
        return;
      }

      // usageMetadata etc – ignore for now
    });

    this.ws.on("close", (code, reason) => {
      this.closed = true;
      logger.info("Gemini Live WS closed", {
        callSid: this.callSid,
        streamSid: this.streamSid,
        code,
        reason: reason ? reason.toString() : ""
      });
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", {
        callSid: this.callSid,
        streamSid: this.streamSid,
        error: err && err.message ? err.message : String(err)
      });
    });
  }

  sendAudioUlaw8kBase64(ulaw8kBase64) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.setupComplete) return;

    // Realtime audio input message
    // This is the standard pattern: realtimeInput.mediaChunks[]
    const msg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=8000", // keep if your working code uses something else
            data: ulaw8kBase64
          }
        ]
      }
    };

    // NOTE:
    // If your current working bridge expects ulaw8k directly with a different mimeType,
    // keep the mimeType exactly as in your working branch.
    this.ws.send(JSON.stringify(msg));
  }

  stop() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "client_stop");
    } catch (_) {}
  }
}

module.exports = { GeminiLiveSession };
