"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { createGeminiLiveSession } = require("../realtime/geminiLiveClient");

function attachTwilioMediaServer(server) {
  const wss = new WebSocket.Server({
    server,
    path: "/twilio-media-stream"
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    const geminiWs = createGeminiLiveSession();

    let streamSid = null;
    let callSid = null;

    // Gemini → Twilio (AUDIO OUT)
    geminiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const audio =
        msg?.serverContent?.modelTurn?.parts?.find(p => p.inlineData)?.inlineData;

      if (audio && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: audio.data }
        }));
      }
    });

    // Twilio → Gemini (AUDIO IN)
    twilioWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        logger.info("Twilio stream start", { streamSid, callSid });
        return;
      }

      if (msg.event === "media" && geminiWs.readyState === WebSocket.OPEN) {
        const audioIn = {
          clientContent: {
            turns: [{
              role: "user",
              parts: [{
                inlineData: {
                  mimeType: "audio/mulaw",
                  data: msg.media.payload
                }
              }]
            }]
          }
        };

        geminiWs.send(JSON.stringify(audioIn));
      }

      if (msg.event === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        try { geminiWs.close(); } catch {}
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      try { geminiWs.close(); } catch {}
    });
  });
}

module.exports = { attachTwilioMediaServer };
