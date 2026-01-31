"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");

function attachTwilioMediaWs(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    // Twilio connects EXACTLY to /twilio-media-stream
    if (req.url !== "/twilio-media-stream") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    logger.info("Twilio media WS connected");

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch (e) {
        logger.warn("Twilio WS non-json message", { error: e.message });
        return;
      }

      const ev = msg.event;

      if (ev === "start") {
        logger.info("Twilio stream start", {
          streamSid: msg?.start?.streamSid,
          callSid: msg?.start?.callSid,
          customParameters: msg?.start?.customParameters || null
        });
      } else if (ev === "media") {
        // NOTE: פה יגיע audio payload base64 (ulaw)
        // כרגע לא עושים כלום כדי רק להחזיק את החיבור ולא להתנתק.
      } else if (ev === "stop") {
        logger.info("Twilio stream stop", {
          streamSid: msg?.stop?.streamSid
        });
      }
    });

    ws.on("close", () => logger.info("Twilio media WS closed"));
    ws.on("error", (err) => logger.error("Twilio media WS error", { error: err.message }));
  });
}

module.exports = { attachTwilioMediaWs };
