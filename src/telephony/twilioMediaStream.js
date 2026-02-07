// src/telephony/twilioMediaStream.js
"use strict";

const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { createGeminiLiveSession } = require("../vendor/geminiLiveSession");
const { pcm16ToMulaw8kBase64 } = require("../audio/pcm16ToMulaw8k");

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function nowIso() {
  return new Date().toISOString();
}

async function handleTwilioMediaWs(twilioWs) {
  logger.info("Twilio media WS connected");

  let streamSid = null;
  let callSid = null;
  let customParameters = {};
  let gemini = null;

  let geminiReady = false;
  let twilioClosed = false;

  function twilioSend(obj) {
    if (twilioWs.readyState === twilioWs.OPEN) {
      twilioWs.send(JSON.stringify(obj));
    }
  }

  async function cleanup(reason) {
    if (twilioClosed) return;
    twilioClosed = true;

    try {
      if (gemini) await gemini.close();
    } catch {}

    try {
      twilioWs.close();
    } catch {}

    logger.info("Session cleanup", { reason, streamSid, callSid });
  }

  twilioWs.on("message", async (data) => {
    const msg = safeJsonParse(data.toString("utf8"));
    if (!msg) return;

    if (msg.event === "start") {
      streamSid = msg.start && msg.start.streamSid ? msg.start.streamSid : null;
      callSid = msg.start && msg.start.callSid ? msg.start.callSid : null;
      customParameters = (msg.start && msg.start.customParameters) || {};

      logger.info("Twilio stream start", { streamSid, callSid, customParameters });

      // Start Gemini session on Twilio start
      try {
        gemini = createGeminiLiveSession({
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_LIVE_MODEL,
          voiceName: env.VOICE_NAME_OVERRIDE || "Kore",
          // We do output conversion anyway, but still ask for AUDIO.
          responseModalities: ["AUDIO"],
          // Optional: you can tune later from SSOT.
          systemInstruction: "You are a helpful Hebrew voice assistant.",
        });

        gemini.on("open", () => {
          geminiReady = true;
          logger.info("Gemini Live WS connected", { callSid, streamSid });
        });

        gemini.on("close", (meta) => {
          logger.info("Gemini Live WS closed", { callSid, streamSid, ...meta });
          // If Gemini closes, keep Twilio alive but there will be no audio.
        });

        gemini.on("error", (err) => {
          logger.error("Gemini Live WS error", { callSid, streamSid, error: err.message || String(err) });
        });

        gemini.on("audio_pcm16le_24000", (pcmBuf) => {
          // Convert PCM16LE 24k -> μ-law 8k (Twilio)
          const payloadB64 = pcm16ToMulaw8kBase64(pcmBuf);
          if (!payloadB64) return;

          if (streamSid) {
            twilioSend({
              event: "media",
              streamSid,
              media: { payload: payloadB64 }
            });
          }
        });

        await gemini.connect();
      } catch (e) {
        logger.error("Gemini session start failed", { callSid, streamSid, error: e.message || String(e) });
      }

      return;
    }

    if (msg.event === "media") {
      // Incoming audio from Twilio (μ-law 8k, base64)
      const payload = msg.media && msg.media.payload ? msg.media.payload : null;
      if (!payload) return;

      if (gemini && geminiReady) {
        // Send as "audio/ulaw;rate=8000" (this is what Twilio sends)
        gemini.sendAudioUlaw8k(payload);
      }
      return;
    }

    if (msg.event === "stop") {
      logger.info("Twilio stream stop", { streamSid, callSid });
      await cleanup("twilio_stop");
      return;
    }
  });

  twilioWs.on("close", () => {
    logger.info("Twilio media WS closed", { streamSid, callSid });
    cleanup("twilio_ws_closed");
  });

  twilioWs.on("error", (err) => {
    logger.error("Twilio media WS error", { streamSid, callSid, error: err.message || String(err) });
    cleanup("twilio_ws_error");
  });
}

module.exports = { handleTwilioMediaWs };
