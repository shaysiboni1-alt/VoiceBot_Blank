"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { createGeminiVertexLive } = require("../realtime/geminiVertexLive");

function attachTwilioMediaBridge(server) {
  const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

  wss.on("connection", async (twilioWs) => {
    logger.info("Twilio media WS connected");

    let streamSid = null;
    let callSid = null;

    const geminiWs = await createGeminiVertexLive((audioB64) => {
      if (!streamSid) return;
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: audioB64 }
      }));
    });

    twilioWs.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        logger.info("Twilio stream start", { streamSid, callSid });
        return;
      }

      if (msg.event === "media") {
        if (geminiWs.readyState !== WebSocket.OPEN) return;
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
        try { geminiWs.close(); } catch {}
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      try { geminiWs.close(); } catch {}
    });

    twilioWs.on("error", (e) => {
      logger.error("Twilio WS error", { error: e.message });
      try { geminiWs.close(); } catch {}
    });
  });
}

module.exports = { attachTwilioMediaBridge };
