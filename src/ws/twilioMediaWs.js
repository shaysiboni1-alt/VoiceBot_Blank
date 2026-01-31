"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

/**
 * Twilio <-> Gemini Live realtime audio bridge (API KEY mode)
 * - RX: Twilio μ-law 8k -> Gemini realtimeInput.audio
 * - TX: Gemini inlineData audio -> Twilio media payload
 * - No intents, no closing, no hangup (yet)
 */

function attachTwilioMediaWs(httpServer) {
  const wss = new WebSocket.Server({
    server: httpServer,
    path: "/twilio-media-stream"
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    let callSid = null;
    let streamSid = null;

    // --- Gemini Live WS ---
    const geminiUrl =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      "?key=" + encodeURIComponent(env.GEMINI_API_KEY);

    const geminiWs = new WebSocket(geminiUrl);
    let geminiReady = false;

    geminiWs.on("open", () => {
      geminiReady = true;
      logger.info("Gemini Live WS connected");

      // Setup message (required)
      geminiWs.send(JSON.stringify({
        setup: {
          model: `models/${env.GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.4
          },
          systemInstruction:
            "אתה בוט קולי בעברית. דבר ברור, קצר וטבעי. אל תמציא מידע."
        }
      }));
    });

    geminiWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const parts = msg?.serverContent?.modelTurn?.parts;
      if (!Array.isArray(parts)) return;

      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          // Gemini returns base64 audio
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: {
              payload: p.inlineData.data
            }
          }));
        }

        if (typeof p.text === "string" && env.MB_LOG_ASSISTANT_TEXT) {
          logger.info("Assistant text", { callSid, text: p.text });
        }
      }
    });

    geminiWs.on("error", (err) => {
      logger.error("Gemini Live WS error", { error: err.message });
    });

    geminiWs.on("close", () => {
      logger.info("Gemini Live WS closed");
    });

    // --- Twilio WS ---
    twilioWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        logger.info("Twilio stream start", { streamSid, callSid });
        return;
      }

      if (msg.event === "media") {
        if (!geminiReady) return;

        // Forward μ-law audio to Gemini
        geminiWs.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/x-mulaw;rate=8000",
              data: msg.media.payload
            }
          }
        }));
        return;
      }

      if (msg.event === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        return;
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      try { geminiWs.close(); } catch {}
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio WS error", { error: err.message });
      try { geminiWs.close(); } catch {}
    });
  });
}

module.exports = { attachTwilioMediaWs };
