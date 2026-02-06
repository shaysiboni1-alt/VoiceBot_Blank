"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { startCallRecording } = require("../utils/twilioRecordings");
const { getSSOT } = require("../ssot/ssotClient");
const { finalizePipeline } = require("../stage4/finalizePipeline");

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

    // --- Stage 4 guards ---
    let stopped = false;
    let finalized = false;
    const callStartedAt = Date.now();

    function sendToTwilioMedia(ulaw8kB64) {
      if (!streamSid) return;
      try {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: ulaw8kB64 }
        }));
      } catch {}
    }

    async function safeFinalize(reason) {
      if (finalized) return;
      finalized = true;

      try {
        await finalizePipeline({
          snapshot: {
            call: {
              callSid,
              streamSid,
              caller: customParameters?.caller || null,
              called: customParameters?.called || null,
              source: customParameters?.source || "VoiceBot_Blank",
              started_at: new Date(callStartedAt).toISOString(),
              ended_at: new Date().toISOString(),
              duration_ms: Date.now() - callStartedAt,
              finalize_reason: reason
            },
            lead: gemini?.getLeadSnapshot?.() || {},
            transcriptText: gemini?.getTranscriptText?.() || ""
          },
          ssot: getSSOT(),
          env,
          logger,
          senders: gemini?.getWebhookSenders?.()
        });
      } catch (e) {
        logger.error("Finalize pipeline failed", { callSid, err: e?.message || e });
      }
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

        if (env.MB_ENABLE_RECORDING && callSid) {
          startCallRecording(callSid, logger).catch((e) => {
            logger.warn("Failed to start call recording", { callSid, err: e?.message || String(e) });
          });
        }

        const ssot = getSSOT();

        gemini = new GeminiLiveSession({
          meta: {
            streamSid,
            callSid,
            caller: customParameters?.caller,
            called: customParameters?.called,
            source: customParameters?.source
          },
          ssot,
          onGeminiAudioUlaw8kBase64: sendToTwilioMedia,
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
          safeFinalize("twilio_stop");
        }
        return;
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
        safeFinalize("ws_close");
      }
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      if (!stopped && gemini) {
        stopped = true;
        gemini.stop();
        safeFinalize("ws_error");
      }
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };

