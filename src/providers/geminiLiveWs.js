const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const env = require("../config/env");

function buildWsUrl() {
  const url = new URL("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent");
  url.searchParams.set("key", env.GEMINI_API_KEY);
  return url.toString();
}

function createGeminiLiveClient({ callSid, streamSid, systemPromptText }) {
  const ws = new WebSocket(buildWsUrl(), {
    headers: {
      "Content-Type": "application/json",
    },
  });

  let isReady = false;

  ws.on("open", () => {
    logger.info("Gemini Live WS connected", { callSid, streamSid });

    // Hard guardrails (we want only spoken output; no meta / no markdown / no analysis).
    // Gemini Live may still emit text parts; we instruct strongly to avoid that.
    const hardRules = [
      "ענה בעברית בלבד, טבעי וקצר.",
      "אל תסביר מה אתה עושה. אל תציג מחשבות/ניתוח/תהליך.",
      "אל תכתוב כותרות, בולטים, Markdown או טקסט באנגלית.",
      "הפק רק את מה שצריך לומר למתקשר בקול.",
    ].join("\n");

    const setup = {
      setup: {
        model: env.GEMINI_LIVE_MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          // Helps keep the model terse; audio models still may vary.
          temperature: 0.4,
        },
        systemInstruction: {
          parts: [
            {
              text: `${hardRules}\n\n${systemPromptText || ""}`.trim(),
            },
          ],
        },
      },
    };

    ws.send(JSON.stringify(setup));
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    // Setup completion / readiness
    if (msg?.setupComplete) {
      isReady = true;
      logger.info("Gemini setupComplete", { callSid, streamSid });
      return;
    }

    // Let callers consume raw events if they want
    if (ws.onGeminiEvent) ws.onGeminiEvent(msg);
  });

  ws.on("close", (code, reason) => {
    logger.info("Gemini Live WS closed", { callSid, streamSid, code, reason: String(reason || "") });
  });

  ws.on("error", (err) => {
    logger.error("Gemini Live WS error", { callSid, streamSid, err: String(err?.message || err) });
  });

  function sendAudioUlaw8kB64(ulaw8kB64) {
    if (!isReady) return;
    const input = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/ulaw",
            data: ulaw8kB64,
          },
        ],
      },
    };
    ws.send(JSON.stringify(input));
  }

  function close() {
    try {
      ws.close();
    } catch {}
  }

  return {
    ws,
    sendAudioUlaw8kB64,
    close,
  };
}

module.exports = { createGeminiLiveClient };
