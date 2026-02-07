"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

function createGeminiLiveSession() {
  const url = env.GEMINI_VERTEX_ENABLED
    ? `wss://${env.GEMINI_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.GEMINI_PROJECT_ID}/locations/${env.GEMINI_LOCATION}/models/${env.GEMINI_LIVE_MODEL}:streamGenerateContent`
    : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.StreamGenerateContent`;

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.GEMINI_API_KEY}`
  };

  const ws = new WebSocket(url, { headers });

  ws.on("open", () => {
    logger.info("Gemini Live WS connected");

    // 🔴 חובה: session init
    const initMessage = {
      setup: {
        model: env.GEMINI_LIVE_MODEL,
        generation_config: {
          response_modalities: ["AUDIO"],
          audio_config: {
            audio_encoding: "MULAW",
            sample_rate_hz: 8000
          }
        }
      }
    };

    ws.send(JSON.stringify(initMessage));
  });

  ws.on("close", () => {
    logger.info("Gemini Live WS closed");
  });

  ws.on("error", (err) => {
    logger.error("Gemini Live WS error", { error: err.message });
  });

  return ws;
}

module.exports = { createGeminiLiveSession };
