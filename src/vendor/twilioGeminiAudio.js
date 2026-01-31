// src/vendor/twilioGeminiAudio.js
"use strict";

// Twilio: ulaw8k (G.711 μ-law) base64
// Gemini Live: expects PCM16 LE @ 16k input, and returns PCM16 LE often @ 24k output.
// MVP resampling is linear / decimate. Good enough to validate end-to-end audio.

function b64ToBuf(b64) {
  return Buffer.from(b64, "base64");
}
function bufToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

// ---------- G.711 μ-law codec (8-bit) ----------
function ulawDecodeSample(uVal) {
  uVal = (~uVal) & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function ulawEncodeSample(pcm) {
  // pcm is 16-bit signed
  const BIAS = 0x84;
  const CLIP = 32635;

  let sign = (pcm < 0) ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;

  pcm = pcm + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  let ulaw = ~(sign | (exponent << 4) | mantissa);
  return ulaw & 0xff;
}

// ---------- Resampling helpers ----------
function upsampleBy2(pcm16leBuf) {
  // 8k -> 16k (linear interpolation)
  const inSamples = pcm16leBuf.length / 2;
  const out = Buffer.alloc(inSamples * 2 * 2);

  for (let i = 0; i < inSamples - 1; i++) {
    const s0 = pcm16leBuf.readInt16LE(i * 2);
    const s1 = pcm16leBuf.readInt16LE((i + 1) * 2);

    // output index in samples
    const o = i * 2;
    out.writeInt16LE(s0, o * 2);
    out.writeInt16LE(((s0 + s1) / 2) | 0, (o + 1) * 2);
  }

  // last sample
  const last = pcm16leBuf.readInt16LE((inSamples - 1) * 2);
  out.writeInt16LE(last, (inSamples * 2 - 2) * 2);
  out.writeInt16LE(last, (inSamples * 2 - 1) * 2);

  return out;
}

function downsample24kTo8k(pcm16leBuf24k) {
  // 24k -> 8k (decimate by 3, simple average)
  const inSamples = pcm16leBuf24k.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const s0 = pcm16leBuf24k.readInt16LE((i * 3 + 0) * 2);
    const s1 = pcm16leBuf24k.readInt16LE((i * 3 + 1) * 2);
    const s2 = pcm16leBuf24k.readInt16LE((i * 3 + 2) * 2);
    const avg = ((s0 + s1 + s2) / 3) | 0;
    out.writeInt16LE(avg, i * 2);
  }
  return out;
}

// ---------- Conversions ----------

function ulaw8kB64ToPcm16kB64(ulawB64) {
  const ulaw = b64ToBuf(ulawB64);
  if (!ulaw.length) return null;

  // decode ulaw8k -> PCM16LE @ 8k
  const pcm8k = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) {
    const s = ulawDecodeSample(ulaw[i]);
    // decoded range is roughly 14-bit; clamp to int16
    const clamped = Math.max(-32768, Math.min(32767, s));
    pcm8k.writeInt16LE(clamped, i * 2);
  }

  // upsample to 16k
  const pcm16k = upsampleBy2(pcm8k);
  return bufToB64(pcm16k);
}

function pcm24kB64ToUlaw8kB64(pcmB64) {
  const pcm24k = b64ToBuf(pcmB64);
  if (!pcm24k.length) return null;

  // downsample to 8k PCM16
  const pcm8k = downsample24kTo8k(pcm24k);

  // encode to ulaw
  const ulaw = Buffer.alloc(pcm8k.length / 2);
  for (let i = 0; i < ulaw.length; i++) {
    const s = pcm8k.readInt16LE(i * 2);
    ulaw[i] = ulawEncodeSample(s);
  }

  return bufToB64(ulaw);
}

module.exports = { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 };
