"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");

/**
 * Very small μ-law decoder + RMS energy VAD
 * Twilio sends μ-law 8k audio frames even during silence.
 * We only enable barge when energy indicates actual speech.
 */

function muLawToLinearSample(uVal) {
  // Standard G.711 μ-law decode (8-bit -> 16-bit PCM)
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;

  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function ulawB64ToPcm16LEBuffer(ulawB64) {
  const ulawBuf = Buffer.from(ulawB64, "base64");
  const pcmBuf = Buffer.allocUnsafe(ulawBuf.length * 2);

  for (let i = 0; i < ulawBuf.length; i++) {
    const s = muLawToLinearSample(ulawBuf[i]);
    pcmBuf.writeInt16LE(s, i * 2);
  }
  return pcmBuf;
}

function rms01FromPcm16LE(pcmBuf) {
  // Compute RMS normalized to 0..1
  const n = pcmBuf.length / 2;
  if (n <= 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = pcmBuf.readInt16LE(i * 2);
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / n); // 0..~32768
  return Math.min(1, rms / 32768);
}

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

    // --- VAD/BARGE state ---
    const vadThreshold = env.MB_VAD_THRESHOLD; // e.g. 0.65 (we'll map it more gently below)
    const vadSilenceMs = env.MB_VAD_SILENCE_MS; // e.g. 900
    const bargeEnabled = env.MB_BARGEIN_ENABLED;

    // We use an "energy threshold" derived from MB_VAD_THRESHOLD but tuned for RMS01.
    // If MB_VAD_THRESHOLD is 0.65, energy threshold will be ~0.04-0.06 (typical telephony).
    const energyThreshold = Math.max(0.01, Math.min(0.2, vadThreshold * 0.08));

    let userSpeaking = false;
    let lastAboveAt = 0;
    let lastBelowAt = 0;

    function nowMs() {
      return Date.now();
    }

    function updateVADFromUlaw(ulawB64) {
      try {
        const pcm = ulawB64ToPcm16LEBuffer(ulawB64);
        const e = rms01FromPcm16LE(pcm);

        const t = nowMs();
        if (e >= energyThreshold) {
          lastAboveAt = t;
          if (!userSpeaking) {
            userSpeaking = true;
            logger.debug("VAD userSpeaking=TRUE", { streamSid, callSid, e, energyThreshold });
          }
        } else {
          lastBelowAt = t;
          if (userSpeaking && (t - lastAboveAt) >= vadSilenceMs) {
            userSpeaking = false;
            logger.debug("VAD userSpeaking=FALSE", { streamSid, callSid, e, energyThreshold });
          }
        }
      } catch {
        // ignore VAD failure
      }
    }

    function sendToTwilioMedia(ulaw8kB64) {
      if (!streamSid) return;

      // BARGE-IN gate: block bot audio ONLY while user is actually speaking (via VAD)
      if (bargeEnabled && userSpeaking) return;

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
            if (env.MB_LOG_ASSISTANT_TEXT) {
              logger.info("ASSISTANT_TEXT", { streamSid, callSid, text: String(t) });
            }
          },
          onTranscript: (role, text) => {
            if (!env.MB_LOG_TRANSCRIPTS) return;
            // log clean JSON (no long prefix)
            logger.info("TRANSCRIPT", { streamSid, callSid, role, text: String(text) });
          }
        });

        gemini.start();
        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (!b64) return;

        // Update VAD on incoming user audio
        if (bargeEnabled) updateVADFromUlaw(b64);

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
      logger.info("Twilio media WS closed", { streamSid, callSid });
      if (gemini) gemini.stop();
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      if (gemini) gemini.stop();
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
