"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { startCallRecording } = require("../utils/twilioRecordings");
const { getSSOT } = require("../ssot/ssotClient");

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/twilio-media-stream")) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    let streamSid = null;
    let callSid = null;
    let customParameters = {};
    let gemini = null;

    // NEW (Stage 4 fix): ensure stop/finalize path runs exactly once
    let stopped = false;

    function sendToTwilioMedia(ulaw8kB64) {
      if (!streamSid) return;
      const payload = {
        event: "media",
        streamSid,
        media: { payload: ulaw8kB64 }
      };
      try {
        twilioWs.send(JSON.stringify(payload));
      } catch {}
    }

    twilioWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const ev = msg.event;

      if (ev === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;
        customParameters = msg?.start?.customParameters || {};
        logger.info("Twilio stream start", { streamSid, callSid, customParameters });

        // Start Twilio call recording early so a RecordingSid exists by the time we finalize.
        // This mirrors the GilSport flow and powers recording_url_public.
        if (env.MB_ENABLE_RECORDING && callSid) {
          startCallRecording(callSid, logger).catch((e) => {
            logger.warn("Failed to start call recording", { callSid, err: e?.message || String(e) });
          });
        }

        const ssot = getSSOT(); // כבר נטען בשרת; אם ריק – עדיין לא שוברים קול

        gemini = new GeminiLiveSession({
          // meta is forwarded into logs + Gemini session; keep it small and stable
          meta: {
            streamSid,
            callSid,
            caller: customParameters?.caller,
            called: customParameters?.called,
            source: customParameters?.source
          },
          ssot,
          onGeminiAudioUlaw8kBase64: (ulawB64) => sendToTwilioMedia(ulawB64),
          onGeminiText: (t) => logger.debug("Gemini text", { streamSid, callSid, t }),
          onTranscript: ({ who, text }) => {
            logger.info(`TRANSCRIPT ${who}`, { streamSid, callSid, text });
          }
        });

        gemini.start();
        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (b64 && gemini) gemini.sendUlaw8kFromTwilio(b64);
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        if (!stopped && gemini) {
          stopped = true;
          gemini.endInput();
          gemini.stop();
        }
        return;
      }

      if (ev === "connected") {
        logger.info("Twilio WS event", { event: "connected", streamSid: null, callSid: null });
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
      }
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
