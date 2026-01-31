"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");

function normalizeModelName(m) {
  // Google expects "models/<model>"
  if (!m) return "";
  if (m.startsWith("models/")) return m;
  return `models/${m}`;
}

function liveWsUrl() {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  // Official WS endpoint (API key mode)
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key
  )}`;
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript;
    this.meta = meta || {};

    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

      // VAD + BARGE-IN via realtimeInputConfig:
      // - automaticActivityDetection (prefixPaddingMs, silenceDurationMs, sensitivities)
      // - activityHandling controls "barge-in" behavior
      // These fields are part of the Live WS schema. :contentReference[oaicite:5]{index=5}
      const setupMsg = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
          generationConfig: {
            responseModalities: ["AUDIO"], // request AUDIO back :contentReference[oaicite:6]{index=6}
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: env.VOICE_NAME_OVERRIDE || "Kore",
                },
              },
            },
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              // maps to your locked ENV names (do not rename)
              prefixPaddingMs: env.MB_VAD_PREFIX_MS,
              silenceDurationMs: env.MB_VAD_SILENCE_MS,
              // Bias to quicker EOS to reduce perceived latency
              startOfSpeechSensitivity: "START_SENSITIVITY_MEDIUM",
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            },
            // Default is START_OF_ACTIVITY_INTERRUPTS (barge-in). :contentReference[oaicite:7]{index=7}
            // Respect your MB_BARGEIN_ENABLED:
            activityHandling: env.MB_BARGEIN_ENABLED ? "START_OF_ACTIVITY_INTERRUPTS" : "NO_INTERRUPTION",
          },
        },
      };

      try {
        this.ws.send(JSON.stringify(setupMsg));
        this.ready = true;
      } catch (e) {
        logger.error("Failed to send Gemini setup", { ...this.meta, error: e.message });
      }
    });

    this.ws.on("message", (data) => {
      // Gemini Live WS messages are JSON (text). If something non-JSON arrives, ignore safely.
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      // 1) Audio out: serverContent.modelTurn.parts[].inlineData (audio/pcm...)
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
            // Gemini often returns PCM @ 24k. Convert to ulaw8k for Twilio.
            const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
            if (ulawB64 && this.onGeminiAudioUlaw8kBase64) {
              this.onGeminiAudioUlaw8kBase64(ulawB64);
            }
          }
        }
      } catch (e) {
        logger.debug("Gemini audio parse error", { ...this.meta, error: e.message });
      }

      // 2) Optional model text parts (debug)
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

      // 3) Transcriptions (input/output) are separate fields on serverContent :contentReference[oaicite:8]{index=8}
      try {
        const inT = msg?.serverContent?.inputTranscription?.text;
        if (inT && this.onTranscript) this.onTranscript("user", String(inT));

        const outT = msg?.serverContent?.outputTranscription?.text;
        if (outT && this.onTranscript) this.onTranscript("bot", String(outT));
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

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;
    if (!ulaw8kB64) return;

    // Twilio μ-law 8k -> PCM16k base64
    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);
    if (!pcm16kB64) return;

    // IMPORTANT: Use realtimeInput.audio (mediaChunks is deprecated). :contentReference[oaicite:9]{index=9}
    const msg = {
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: pcm16kB64,
        },
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
      // Signals audio stream ended (allowed when automatic activity detection is enabled). :contentReference[oaicite:10]{index=10}
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
