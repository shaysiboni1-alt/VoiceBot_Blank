"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");

function safeCall(obj, fnName, ...args) {
  try {
    if (!obj) return;
    const fn = obj[fnName];
    if (typeof fn !== "function") return;
    fn.apply(obj, args);
  } catch (e) {
    logger.debug("safeCall failed", { fnName, error: e?.message });
  }
}

function createTwilioMediaWsServer({ path = "/twilio-media-stream" } = {}) {
  const wss = new WebSocket.Server({ noServer: true });
  wss._path = path;

  wss.on("connection", (ws) => {
    logger.info("Twilio media WS connected");

    let streamSid = null;
    let callSid = null;

    // בונים session מול Gemini
    const gemini = new GeminiLiveSession({
      meta: () => ({ streamSid, callSid }),
      onGeminiAudioUlaw8kBase64: (ulawB64) => {
        // שולחים חזרה לטוויליו
        try {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: ulawB64 },
            })
          );
        } catch (e) {
          logger.debug("Failed sending audio to Twilio", { streamSid, callSid, error: e.message });
        }
      },

      // אל תדליק את זה אם אתה לא חייב – זה יוצר המון טקסט
      onGeminiText: env.MB_LOG_ASSISTANT_TEXT
        ? (t) => logger.debug("Gemini text", { streamSid, callSid, t })
        : null,
    });

    // התחלת WS לג׳מיני
    safeCall(gemini, "start");

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      const event = msg?.event;

      if (event === "connected") {
        logger.info("Twilio WS event", { event, streamSid: msg?.streamSid ?? null, callSid: msg?.start?.callSid ?? null });
        return;
      }

      if (event === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;
        logger.info("Twilio stream start", {
          streamSid,
          callSid,
          customParameters: msg?.start?.customParameters || {},
        });
        return;
      }

      if (event === "media") {
        const b64 = msg?.media?.payload;
        if (b64) {
          // זה המקום שממנו הגיע לך הקרש – עכשיו זה מוגן
          safeCall(gemini, "sendUlaw8kFromTwilio", b64);
        }
        return;
      }

      if (event === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        safeCall(gemini, "close");
        try { ws.close(); } catch {}
        return;
      }
    });

    ws.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      safeCall(gemini, "close");
    });

    ws.on("error", (err) => {
      logger.info("Twilio media WS error", { streamSid, callSid, error: err.message });
      safeCall(gemini, "close");
    });
  });

  return wss;
}

module.exports = { createTwilioMediaWsServer };
