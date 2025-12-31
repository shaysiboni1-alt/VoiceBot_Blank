/**
 * BluBinet Realtime – Twilio Media Streams <-> Gemini Live (WebSocket, v1beta)
 *
 * Fixes / Features:
 * - v1beta WS endpoint
 * - systemInstruction is Content (parts[]) not string (fixes 1007)
 * - Bot speaks immediately: send clientContent with turnComplete right after setupComplete
 * - "No interruption" (no barge-in): realtimeInputConfig.activityHandling = NO_INTERRUPTION
 * - Short answers + low latency generation config
 * - Optional input/output audio transcription for logs
 * - Lead webhook on call end
 *
 * ENV:
 * - PORT
 * - GEMINI_API_KEY (required)
 * - MB_BOT_NAME (default: נטע)
 * - MB_BUSINESS_NAME (default: BluBinet)
 * - MB_OPENING_TEXT (optional)  // what the bot says immediately
 * - MAKE_WEBHOOK_URL or MB_WEBHOOK_URL (optional)
 * - MB_GEMINI_MODEL (optional)  // default below
 * - MB_GEMINI_VOICE (optional)  // default: Aoede
 * - MB_LANGUAGES (optional)     // e.g. "he,en,ru"
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in environment");
  process.exit(1);
}

const BOT_NAME = process.env.MB_BOT_NAME || "נטע";
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || "BluBinet";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL || "";

const GEMINI_MODEL =
  process.env.MB_GEMINI_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_VOICE = process.env.MB_GEMINI_VOICE || "Aoede";

const MB_LANGUAGES = (process.env.MB_LANGUAGES || "he").split(",").map(s => s.trim()).filter(Boolean);

// פתיח מיידי (אפשר לשלוט ב-ENV)
const OPENING_TEXT =
  process.env.MB_OPENING_TEXT ||
  `שָׁלוֹם, הִגַּעְתֶּם לְ־${BUSINESS_NAME}. מְדַבֶּרֶת ${BOT_NAME}. אֵיךְ אֶפְשָׁר לַעֲזוֹר?`;

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
כללים:
- דברי בעברית כברירת מחדל, תשובות קצרות (1–2 משפטים).
- אל תחזרי על ברכת פתיחה שכבר נאמרה.
- אל תקטעי את הלקוח. המתיני שיסיים ואז עני.
- אם הלקוח עובר לאנגלית/רוסית, מותר לענות בשפה שלו. השפות המותרות: ${MB_LANGUAGES.join(", ")}.
- אם חסר מידע כדי לענות, שאלי שאלה אחת קצרה בלבד.
`.trim();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.send("BluBinet Status: Online"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Twilio Voice webhook (TwiML -> Media Stream)
app.post("/twilio-voice", (req, res) => {
  const host = req.headers.host;
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media-stream" />
  </Connect>
</Response>`
  );
});

const server = http.createServer(app);

// =====================
// μ-law (G.711) helpers
// =====================
function mulawDecodeSample(muLawByte) {
  let mu = (~muLawByte) & 0xff;
  let sign = (mu & 0x80) ? -1 : 1;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let magnitude = ((mantissa << 1) + 1) << (exponent + 2);
  let sample = sign * (magnitude - 33);
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

function mulawEncodeSample(pcm16) {
  const BIAS = 33;
  let sign = 0;
  let sample = pcm16;

  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
    if (sample > 32767) sample = 32767;
  }

  sample = sample + BIAS;
  if (sample > 0x7fff) sample = 0x7fff;

  let exponent = 7;
  for (let exp = 0; exp < 8; exp++) {
    if (sample <= (0x1f << (exp + 3))) {
      exponent = exp;
      break;
    }
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  let mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mu;
}

function b64ToBuf(b64) {
  return Buffer.from(b64, "base64");
}
function bufToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

// Twilio μ-law b64 (8k) -> PCM16 buffer @8k
function mulawB64ToPcm16_8k(mulawB64) {
  const muBuf = b64ToBuf(mulawB64);
  const pcmBuf = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    pcmBuf.writeInt16LE(mulawDecodeSample(muBuf[i]), i * 2);
  }
  return pcmBuf;
}

// Upsample PCM16 @8k -> PCM16 @16k (linear)
function upsamplePcm16_8k_to_16k(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  if (inSamples < 2) return pcm8kBuf;

  const outSamples = inSamples * 2;
  const outBuf = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < inSamples; i++) {
    const curr = pcm8kBuf.readInt16LE(i * 2);
    const outIndex = i * 2;

    outBuf.writeInt16LE(curr, outIndex * 2);

    if (i < inSamples - 1) {
      const next = pcm8kBuf.readInt16LE((i + 1) * 2);
      const mid = ((curr + next) / 2) | 0;
      outBuf.writeInt16LE(mid, (outIndex + 1) * 2);
    } else {
      outBuf.writeInt16LE(curr, (outIndex + 1) * 2);
    }
  }
  return outBuf;
}

// Downsample PCM16 @24k -> PCM16 @8k (factor 3 avg)
function downsamplePcm16_24k_to_8k(pcm24kBuf) {
  const inSamples = pcm24kBuf.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  if (outSamples <= 0) return Buffer.alloc(0);

  const outBuf = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const a = pcm24kBuf.readInt16LE((i * 3 + 0) * 2);
    const b = pcm24kBuf.readInt16LE((i * 3 + 1) * 2);
    const c = pcm24kBuf.readInt16LE((i * 3 + 2) * 2);
    const avg = ((a + b + c) / 3) | 0;
    outBuf.writeInt16LE(avg, i * 2);
  }
  return outBuf;
}

// PCM16 @8k -> μ-law b64 @8k
function pcm16_8k_to_mulawB64(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  const muBuf = Buffer.alloc(inSamples);
  for (let i = 0; i < inSamples; i++) {
    const s = pcm8kBuf.readInt16LE(i * 2);
    muBuf[i] = mulawEncodeSample(s);
  }
  return bufToB64(muBuf);
}

// =====================
// WebSocket Server (Twilio stream)
/// ====================
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio: Connected");

  let streamSid = null;
  let geminiWs = null;
  let callLog = [];
  let setupDone = false;
  let openingSent = false;

  function connectToGemini() {
    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    geminiWs = new WebSocket(url);

    geminiWs.on("open", () => {
      console.log("Gemini: Connection Opened");

      // IMPORTANT: systemInstruction must be Content (parts[])
      const setupMsg = {
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            // קצר, חד, בלי חפירות
            maxOutputTokens: 120,
            temperature: 0.3,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: GEMINI_VOICE,
                },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTIONS }],
          },
          // "לא קוטע" – פעילות משתמש לא תפסיק את תגובת המודל
          realtimeInputConfig: {
            activityHandling: "NO_INTERRUPTION",
          },
          // תמלול ללוגים (אופציונלי אך מועיל)
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };

      geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      // Setup complete -> send opening immediately via clientContent
      if (msg.setupComplete) {
        console.log("Gemini: Setup Complete");
        setupDone = true;

        if (!openingSent) {
          openingSent = true;

          // clientContent appends to conversation and turnComplete starts generation immediately
          const openingClientContent = {
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [{ text: OPENING_TEXT }],
                },
              ],
              turnComplete: true,
            },
          };

          geminiWs.send(JSON.stringify(openingClientContent));
        }
        return;
      }

      // Collect transcriptions (if enabled)
      if (msg?.serverContent?.inputTranscription?.text) {
        callLog.push({ user_transcript: msg.serverContent.inputTranscription.text });
      }
      if (msg?.serverContent?.outputTranscription?.text) {
        callLog.push({ bot_transcript: msg.serverContent.outputTranscription.text });
      }

      // Model output audio is in serverContent.modelTurn.parts[].inlineData
      const parts = msg?.serverContent?.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          // audio chunk
          if (p?.inlineData?.data && typeof p.inlineData.data === "string") {
            const mime = p?.inlineData?.mimeType || "";
            const pcmBuf = b64ToBuf(p.inlineData.data);

            // Most commonly audio/pcm;rate=24000 -> downsample to 8k -> μ-law -> Twilio
            let pcm8k = pcmBuf;
            if (!mime.includes("rate=8000")) {
              pcm8k = downsamplePcm16_24k_to_8k(pcmBuf);
            }

            const mulawB64 = pcm16_8k_to_mulawB64(pcm8k);

            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(
                JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: mulawB64 },
                })
              );
            }
          }

          // text (if any)
          if (typeof p?.text === "string" && p.text.trim()) {
            callLog.push({ bot_text: p.text.trim() });
          }
        }
      }

      if (msg?.error?.message) {
        console.error("Gemini Server Error:", msg.error.message);
      }
    });

    geminiWs.on("close", (code, reason) => {
      console.log("Gemini Connection Closed", code, reason?.toString?.() || "");
      try {
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      } catch {}
    });

    geminiWs.on("error", (e) => {
      console.error("Gemini Error:", e?.message || e);
    });
  }

  connectToGemini();

  // Twilio -> Gemini realtime audio stream
  twilioWs.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid || null;
      console.log("Twilio Started:", streamSid);
      return;
    }

    if (msg.event === "media") {
      if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      if (!msg?.media?.payload) return;

      // Twilio μ-law 8k -> PCM16 8k -> upsample to PCM16 16k for Gemini
      const pcm8k = mulawB64ToPcm16_8k(msg.media.payload);
      const pcm16k = upsamplePcm16_8k_to_16k(pcm8k);

      const audioMsg = {
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: bufToB64(pcm16k),
          },
        },
      };

      geminiWs.send(JSON.stringify(audioMsg));
      return;
    }

    if (msg.event === "stop") {
      try {
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio Closed");
    try {
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    } catch {}

    if (MAKE_WEBHOOK_URL) {
      fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "call_ended",
          sid: streamSid,
          log: callLog,
        }),
      }).catch(() => {});
    }
  });

  twilioWs.on("error", (e) => console.error("Twilio WS Error:", e?.message || e));
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("uncaughtException", err));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
