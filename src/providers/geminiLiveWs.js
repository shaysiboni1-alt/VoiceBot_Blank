"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

function buildLiveUrlDeveloper() {
  // Live API WS endpoint (Developer API)
  // Source: Google AI Live API docs
  return "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
}

function createGeminiLiveClient({ callSid, streamSid, systemPromptText }) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }
  if (!env.GEMINI_LIVE_MODEL) {
    throw new Error("Missing GEMINI_LIVE_MODEL");
  }

  const url = buildLiveUrlDeveloper();

  const ws = new WebSocket(url, {
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY
    }
  });

  let isReady = false;

  ws.on("open", () => {
    logger.info("Gemini Live WS connected", { callSid, streamSid });

    // Setup message (best-effort schema; robust on receive)
    const setup = {
      setup: {
        model: `models/${env.GEMINI_LIVE_MODEL}`,
        generation_config: {
          // אנחנו רוצים אודיו חזרה
          response_modalities: ["AUDIO"]
        },
        // נתחיל בעברית; בהמשך ניישר לפי SSOT שפות.
        system_instruction: {
          parts: [{ text: systemPromptText || "דבר בעברית בצורה טבעית וקצרה." }]
        }
      }
    };

    ws.send(JSON.stringify(setup));
    isReady = true;
  });

  ws.on("error", (err) => {
    logger.error("Gemini Live WS error", { error: err.message || String(err), callSid, streamSid });
  });

  ws.on("close", () => {
    logger.info("Gemini Live WS closed", { callSid, streamSid });
  });

  function sendAudioBase64Pcmu(b64) {
    if (!isReady || ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      realtime_input: {
        media_chunks: [
          {
            mime_type: "audio/pcmu",
            data: b64
          }
        ]
      }
    };

    ws.send(JSON.stringify(msg));
  }

  return { ws, sendAudioBase64Pcmu };
}

module.exports = { createGeminiLiveClient };
