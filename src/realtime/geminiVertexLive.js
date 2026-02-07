"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { getVertexAccessToken } = require("../utils/gcpAuth");

async function createGeminiVertexLive(onAudioChunk) {
  const token = await getVertexAccessToken();

  const url =
    `wss://${env.GEMINI_LOCATION}-aiplatform.googleapis.com/v1/` +
    `projects/${env.GEMINI_PROJECT_ID}/locations/${env.GEMINI_LOCATION}/` +
    `publishers/google/models/${env.GEMINI_LIVE_MODEL}:bidiGenerateContent`;

  const ws = new WebSocket(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  ws.on("open", () => {
    logger.info("Gemini Vertex Live WS connected");

    // חובה: הודעת setup ראשונה
    ws.send(JSON.stringify({
      setup: {
        generationConfig: {
          responseModalities: ["AUDIO"],
          temperature: 0.4,
          audioConfig: {
            audioEncoding: "MULAW",
            sampleRateHertz: 8000
          }
        },
        systemInstruction: {
          parts: [{ text: "אתה בוט קולי בעברית. דבר קצר, ברור וטבעי." }]
        }
      }
    }));
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const parts = msg?.serverContent?.modelTurn?.parts;
    if (!Array.isArray(parts)) return;

    for (const p of parts) {
      if (p.inlineData?.data) {
        onAudioChunk(p.inlineData.data); // base64 μ-law
      }
    }
  });

  ws.on("close", () => logger.info("Gemini Vertex Live WS closed"));
  ws.on("error", (e) => logger.error("Gemini Vertex Live WS error", { error: e.message }));

  return ws;
}

module.exports = { createGeminiVertexLive };
