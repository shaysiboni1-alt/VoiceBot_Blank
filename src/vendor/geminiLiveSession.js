"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const {
  ulaw8kB64ToPcm16kB64,
  pcm24kB64ToUlaw8kB64,
} = require("./twilioGeminiAudio");

function normalizeModelName(m) {
  if (!m) return "";
  if (m.startsWith("models/")) return m;
  return `models/${m}`;
}

function liveWsUrl() {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    env.GEMINI_API_KEY
  )}`;
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, meta }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.meta = meta || {};
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  start() {
    if (this.ws) return;

    this.ws = new WebSocket(liveWsUrl());

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

      // ⚠️ גרסה יציבה – בלי systemInstruction, בלי VAD
      const setup = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
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
        },
      };

      try {
        this.ws.send(JSON.stringify(setup));
        this.ready = true;
      } catch (e) {
        logger.error("Failed to send Gemini setup", {
          ...this.meta,
          error: e.message,
        });
      }
    });

    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const parts =
        msg?.serverContent?.modelTurn?.parts ||
        msg?.serverContent?.turn?.parts ||
        msg?.serverContent?.parts ||
        [];

      // AUDIO
      for (const p of parts) {
        const inline = p?.inlineData;
        if (
          inline &&
          inline.data &&
          String(inline.mimeType).startsWith("audio/pcm")
        ) {
          const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
          if (ulawB64 && this.onGeminiAudioUlaw8kBase64) {
            this.onGeminiAudioUlaw8kBase64(ulawB64);
          }
        }

        if (p?.text && this.onGeminiText) {
          this.onGeminiText(String(p.text));
        }
      }
    });

    this.ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;
      logger.info("Gemini Live WS closed", {
        ...this.meta,
        code,
        reason,
      });
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", {
        ...this.meta,
        error: err.message,
      });
    });
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;

    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    const msg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: pcm16kB64,
          },
        ],
      },
    };

    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.debug("Failed sending audio to Gemini", {
        ...this.meta,
        error: e.message,
      });
    }
  }

  endInput() {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(
        JSON.stringify({ realtimeInput: { audioStreamEnd: true } })
      );
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
