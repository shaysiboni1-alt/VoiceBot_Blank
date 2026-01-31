"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");

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

    // --- BARGE-IN gate state ---
    let bargeActive = false;
    let lastUserMediaAt = 0;
    let lastBargeStartAt = 0;

    function nowMs() {
      return Date.now();
    }

    function setBargeActive(on) {
      if (!env.MB_BARGEIN_ENABLED) return;
      if (on === bargeActive) return;
      bargeActive = on;

      if (bargeActive) {
        lastBargeStartAt = nowMs();
        logger.debug("BARGE-IN ON", { streamSid, callSid });
      } else {
        logger.debug("BARGE-IN OFF", { streamSid, callSid });
      }
    }

    // heuristic: אם מגיע media מהמשתמש - נחשב כ"תחילת דיבור"
    // ונשאיר bargeActive עד שלא הגיע media X מילישניות.
    function onUserMediaFrame() {
      if (!env.MB_BARGEIN_ENABLED) return;

      const t = nowMs();
      lastUserMediaAt = t;

      // start gate immediately (or after MB_BARGEIN_MIN_MS via simple latch)
      if (!bargeActive) setBargeActive(true);
    }

    function maybeReleaseBarge() {
      if (!env.MB_BARGEIN_ENABLED) return;
      if (!bargeActive) return;

      const t = nowMs();
      const sinceLastUser = t - lastUserMediaAt;

      // אם המשתמש השתתק מספיק זמן — משחררים את gate
      if (sinceLastUser >= env.MB_BARGEIN_COOLDOWN_MS) {
        // optional: enforce minimum barge window
        const sinceStart = t - lastBargeStartAt;
        if (sinceStart >= env.MB_BARGEIN_MIN_MS) {
          setBargeActive(false);
        }
      }
    }

    const bargeTimer = setInterval(maybeReleaseBarge, 100);

    function sendToTwilioMedia(ulaw8kB64) {
      if (!streamSid) return;

      // אם המשתמש מדבר כרגע — לא משדרים אודיו של הבוט לטוויליו (זה ה-barge)
      if (env.MB_BARGEIN_ENABLED && bargeActive) return;

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

      if (ev === "connected") {
        logger.info("Twilio WS event", { event: "connected", streamSid: null, callSid: null });
        return;
      }

      if (ev === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;
        customParameters = msg?.start?.customParameters || {};
        logger.info("Twilio stream start", { streamSid, callSid, customParameters });

        gemini = new GeminiLiveSession({
          meta: { streamSid, callSid },
          onGeminiAudioUlaw8kBase64: (ulawB64) => sendToTwilioMedia(ulawB64),
          onGeminiText: (t) => {
            // לא משנה קול. רק לוגים.
            if (env.MB_LOG_ASSISTANT_TEXT) logger.info("ASSISTANT_TEXT", { streamSid, callSid, text: t });
          },
          onTranscript: (role, text) => {
            // תמלול מלא — נשאיר JSON נקי
            if (!env.MB_LOG_TRANSCRIPTS) return;
            logger.info("TRANSCRIPT", { streamSid, callSid, role, text });
          }
        });

        gemini.start();
        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (!b64) return;

        // BARGE signal
        onUserMediaFrame();

        if (gemini) gemini.sendUlaw8kFromTwilio(b64);
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        if (gemini) {
          gemini.endInput();
          gemini.stop();
        }
        return;
      }
    });

    twilioWs.on("close", () => {
      clearInterval(bargeTimer);
      logger.info("Twilio media WS closed", { streamSid, callSid });
      if (gemini) gemini.stop();
    });

    twilioWs.on("error", (err) => {
      clearInterval(bargeTimer);
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      if (gemini) gemini.stop();
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
