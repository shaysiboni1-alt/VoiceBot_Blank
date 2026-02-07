// src/audio/pcm16ToMulaw8k.js
"use strict";

// Downsample 24k -> 8k by picking every 3rd sample (fast MVP; good enough for now)
function downsample24kTo8k(pcm16leBuf) {
  if (!pcm16leBuf || pcm16leBuf.length < 2) return Buffer.alloc(0);

  const inSamples = pcm16leBuf.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const inIndex = i * 3;
    const sample = pcm16leBuf.readInt16LE(inIndex * 2);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

// μ-law (G.711) encode 16-bit PCM sample
function linearToMulawSample(sample) {
  // Clamp
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;

  const BIAS = 0x84;
  const CLIP = 32635;

  let sign = (sample < 0) ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;

  sample = sample + BIAS;

  // Exponent
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  // Mantissa
  const mantissa = (sample >> (exponent + 3)) & 0x0F;

  let mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xFF;
}

function pcm16leToMulaw8(pcm16leBuf) {
  if (!pcm16leBuf || pcm16leBuf.length < 2) return Buffer.alloc(0);

  const samples = pcm16leBuf.length / 2;
  const out = Buffer.alloc(samples);

  for (let i = 0; i < samples; i++) {
    const s = pcm16leBuf.readInt16LE(i * 2);
    out[i] = linearToMulawSample(s);
  }
  return out;
}

function pcm16ToMulaw8kBase64(pcm16le24kBuf) {
  try {
    const pcm8k = downsample24kTo8k(pcm16le24kBuf);
    const mulaw = pcm16leToMulaw8(pcm8k);
    return mulaw.toString("base64");
  } catch {
    return "";
  }
}

module.exports = { pcm16ToMulaw8kBase64 };
