// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");

/**
 * Twilio Media Streams WS handler (inbound/outbound audio).
 * This stage implements a deterministic outbound-audio smoke-test:
 * after "start", send a 1s beep tone to caller (μ-law 8k).
 *
 * Goal: validate server -> Twilio -> caller audio path, BEFORE Gemini integration.
 */

function ulawEncodeSample(pcm16) {
  // G.711 μ-law encoder for a single 16-bit PCM sample
  const MU_LAW_MAX = 0x1FFF;
  const BIAS = 0x84;

  let sign = (pcm16 >> 8) & 0x80;
  if (sign !== 0) pcm16 = -pcm16;
  if (pcm16 > MU_LAW_MAX) pcm16 = MU_LAW_MAX;

  pcm16 = pcm16 + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm16 & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (pcm16 >> (exponent + 3)) & 0x0F;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulawByte;
}

function genBeepUlawFrames({
  durationMs = 1000,
  freqHz = 1000,
  sampleRate = 8000,
  frameMs = 20,
  amplitude = 0.35
} = {}) {
  const samplesPerFrame = Math.floor((sampleRate * frameMs) / 1000); // 160 at 8k/20ms
  const totalFrames = Math.floor(durationMs / frameMs);

  const framesB64 = [];
  let t = 0;

  // amplitude in PCM16 scale
  const amp = Math.floor(32767 * amplitude);

  for (let f = 0; f < totalFrames; f++) {
    const ulaw = Buffer.alloc(samplesPerFrame);
    for (let i = 0; i < samplesPerFrame; i++) {
      const sample =
        Math.sin((2 * Math.PI * freqHz * t) / sampleRate) * amp;
      // clamp + convert to int16
      let s = sample | 0;
      if (s > 32767) s = 32767;
      if (s < -32768) s = -32768;

      ulaw[i] = ulawEncodeSample(s);
      t++;
    }
    framesB64.push(ulaw.toString("base64"));
  }

  return framesB64;
}

function attachTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

  wss.on("connection", (ws) => {
    logger.info("Twilio media WS connected");

    let streamSid = null;
    let callSid = null;
    let beepSent = false;
    let beepTimer = null;

    const safeSend = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch (e) {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        callSid = msg.start?.callSid || null;

        logger.info("Twilio stream start", {
          streamSid,
          callSid,
          customParameters: msg.start?.customParameters || {}
        });

        // Outbound-audio smoke test: send beep once
        if (!beepSent && streamSid) {
          beepSent = true;

          const frames = genBeepUlawFrames({
            durationMs: 1000,
            freqHz: 1000,
            amplitude: 0.35
          });

          let idx = 0;
          beepTimer = setInterval(() => {
            if (idx >= frames.length) {
              clearInterval(beepTimer);
              beepTimer = null;
              logger.info("Beep test finished", { streamSid, callSid });
              return;
            }

            safeSend({
              event: "media",
              streamSid,
              media: {
                payload: frames[idx]
              }
            });

            idx++;
          }, 20);

          logger.info("Beep test started", { streamSid, callSid });
        }
      }

      if (msg.event === "media") {
        // inbound audio from caller is in msg.media.payload (μ-law 8k base64)
        // Not used yet in this stage.
        return;
      }

      if (msg.event === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        if (beepTimer) clearInterval(beepTimer);
        beepTimer = null;
      }
    });

    ws.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      if (beepTimer) clearInterval(beepTimer);
      beepTimer = null;
    });

    ws.on("error", (err) => {
      logger.error("Twilio media WS error", {
        streamSid,
        callSid,
        error: err?.message || String(err)
      });
      if (beepTimer) clearInterval(beepTimer);
      beepTimer = null;
    });
  });

  return wss;
}

module.exports = { attachTwilioMediaWs };
