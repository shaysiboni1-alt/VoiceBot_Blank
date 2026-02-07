const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const env = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { getSSOT } = require("../ssot/ssotClient");
const { buildSystemPrompt } = require("../realtime/geminiLiveClient");

class TwilioMediaWS {
  constructor({ wss }) {
    this.wss = wss;

    this.wss.on("connection", (ws) => {
      logger.info("Twilio media WS connected");
      let streamSid = null;
      let callSid = null;

      let gemini = null;

      ws.on("message", async (msg) => {
        let data;
        try {
          data = JSON.parse(msg.toString("utf8"));
        } catch {
          return;
        }

        if (data.event) {
          logger.info("Twilio WS event", { event: data.event, streamSid, callSid });
        }

        if (data.event === "start") {
          streamSid = data.start?.streamSid || null;
          callSid = data.start?.customParameters?.callSid || data.start?.callSid || null;

          logger.info("Twilio stream start", {
            streamSid,
            callSid,
            customParameters: data.start?.customParameters || {},
          });

          const ssot = await getSSOT();
          const systemPromptText = buildSystemPrompt({
            ssot,
            callSid,
            streamSid,
            customParameters: data.start?.customParameters || {},
          });

          gemini = new GeminiLiveSession({
            streamSid,
            callSid,
            systemPromptText,
            onAudioUlaw8kB64: (ulaw8kB64) => {
              try {
                ws.send(
                  JSON.stringify({
                    event: "media",
                    streamSid,
                    media: {
                      payload: ulaw8kB64,
                    },
                  })
                );
              } catch (e) {
                logger.error("Failed sending audio to Twilio", { streamSid, callSid, err: String(e?.message || e) });
              }
            },
            onTranscript: ({ who, text }) => {
              const s = String(text || "");
              const short = s.length > 500 ? `${s.slice(0, 500)}…` : s;
              logger.info(`TRANSCRIPT ${who}: ${short}`, { streamSid, callSid });
            },
            onGeminiText: (t) => {
              // Keep logs readable: only when explicitly enabled + debug.
              if (!env.MB_LOG_ASSISTANT_TEXT) return;
              if (!env.MB_DEBUG) return;
              const s = String(t || "");
              const short = s.length > 400 ? `${s.slice(0, 400)}…` : s;
              logger.debug("Gemini text", { streamSid, callSid, t: short });
            },
          });

          await gemini.start();
          return;
        }

        if (data.event === "media") {
          const payload = data.media?.payload;
          if (payload && gemini) {
            gemini.sendAudioUlaw8kB64(payload);
          }
          return;
        }

        if (data.event === "stop") {
          logger.info("Twilio stream stop", { streamSid, callSid });
          try {
            gemini?.close();
          } catch {}
          gemini = null;
          return;
        }
      });

      ws.on("close", () => {
        logger.info("Twilio media WS closed", { streamSid, callSid });
        try {
          gemini?.close();
        } catch {}
      });

      ws.on("error", (err) => {
        logger.error("Twilio media WS error", { streamSid, callSid, err: String(err?.message || err) });
      });
    });
  }
}

module.exports = { TwilioMediaWS };
