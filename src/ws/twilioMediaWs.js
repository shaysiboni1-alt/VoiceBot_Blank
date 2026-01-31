// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");

/**
 * Attaches Twilio Media Streams WebSocket endpoint:
 *  - path: /twilio-media-stream
 *  - logs start/stop + counts inbound media frames
 *  - (optional) sends a short beep test OUT but DOES NOT close the socket
 */
function attachTwilioMediaWs(httpServer) {
  const wss = new WebSocket.Server({
    server: httpServer,
    path: "/twilio-media-stream"
  });

  wss.on("connection", (ws) => {
    logger.info("Twilio media WS connected");

    const state = {
      streamSid: null,
      callSid: null,
      customParameters: {},
      mediaFrames: 0,
      mediaBytesB64: 0,
      lastMediaAt: null,
      statsTimer: null
    };

    // כל 2 שניות נדפיס סטטיסטיקה כדי לראות אם נכנס RX אודיו מהמתקשר
    state.statsTimer = setInterval(() => {
      logger.info("Twilio RX stats", {
        streamSid: state.streamSid,
        callSid: state.callSid,
        frames: state.mediaFrames,
        b64_chars: state.mediaBytesB64,
        last_media_at: state.lastMediaAt
      });
    }, 2000);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch (e) {
        logger.warn("Twilio WS non-JSON message", { len: data?.length });
        return;
      }

      const ev = msg.event;

      if (ev === "start") {
        state.streamSid = msg?.start?.streamSid || null;
        state.callSid = msg?.start?.callSid || null;
        state.customParameters = msg?.start?.customParameters || {};
        logger.info("Twilio stream start", {
          streamSid: state.streamSid,
          callSid: state.callSid,
          customParameters: state.customParameters
        });

        // NOTE: אם כבר יש אצלך פונקציית Beep קיימת – תשאיר אותה.
        // כאן אנחנו בכוונה לא סוגרים WS אחרי הביפ/כלום.
        return;
      }

      if (ev === "media") {
        const payload = msg?.media?.payload || "";
        state.mediaFrames += 1;
        state.mediaBytesB64 += payload.length;
        state.lastMediaAt = new Date().toISOString();

        // לא נלוג כל פריים (זה רועש). מספיק הסטטיסטיקה כל 2 שניות.
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", {
          streamSid: state.streamSid,
          callSid: state.callSid
        });
        return;
      }

      // events אחרים (mark וכו')
      logger.info("Twilio WS event", { event: ev, streamSid: state.streamSid, callSid: state.callSid });
    });

    ws.on("close", () => {
      if (state.statsTimer) clearInterval(state.statsTimer);
      logger.info("Twilio media WS closed", {
        streamSid: state.streamSid,
        callSid: state.callSid,
        frames: state.mediaFrames,
        b64_chars: state.mediaBytesB64
      });
    });

    ws.on("error", (err) => {
      logger.error("Twilio WS error", {
        streamSid: state.streamSid,
        callSid: state.callSid,
        error: err?.message || String(err)
      });
    });
  });
}

module.exports = { attachTwilioMediaWs };
