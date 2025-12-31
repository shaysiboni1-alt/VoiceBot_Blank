require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;

// חובה כדי שלא ניפול על host header
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim(); // e.g. https://blubinet-realtime.onrender.com

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in environment");
  process.exit(1);
}

const BOT_NAME = process.env.MB_BOT_NAME || "נטע";
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || "BluBinet";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL || "";

const GEMINI_MODEL = process.env.MB_GEMINI_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_VOICE = process.env.MB_GEMINI_VOICE || "Aoede";

const OPENING_TEXT =
  process.env.MB_OPENING_TEXT ||
  `שָׁלוֹם, הִגַּעְתֶּם לְ־${BUSINESS_NAME}. מְדַבֶּרֶת ${BOT_NAME}. אֵיךְ אֶפְשָׁר לַעֲזוֹר?`;

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
כללים:
- תשובות קצרות (1–2 משפטים), ענייניות.
- לא לקטוע את הלקוח: המתיני שיסיים ואז עני.
- לא לברך שוב אחרי פתיח.
- אם חסר מידע: שאלי שאלה אחת קצרה בלבד.
`.trim();

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.send("BluBinet Status: Online"));
app.get("/health", (req, res) => res.json({ ok: true }));

function buildWsUrl(req) {
  // אם יש PUBLIC_BASE_URL – זו האמת האבסולוטית
  if (PUBLIC_BASE_URL) {
    const u = new URL(PUBLIC_BASE_URL);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}/twilio-media-stream`;
  }

  // fallback: נסה forwarded host ואז host
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `wss://${host}/twilio-media-stream`;
}

// Twilio Voice Webhook -> TwiML
app.post("/twilio-voice", (req, res) => {
  const wsUrl = buildWsUrl(req);

  console.log("==> /twilio-voice HIT", {
    from: req.body?.From,
    to: req.body?.To,
    host: req.headers.host,
    xfh: req.headers["x-forwarded-host"],
    wsUrl,
  });

  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
  <Pause length="60"/>
</Response>`
  );
});

const server = http.createServer(app);

// =====================
// μ-law helpers
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

const b64ToBuf = (b64) => Buffer.from(b64, "base64");
const bufToB64 = (buf) => Buffer.from(buf).toString("base64");

// Twilio mulaw 8k -> PCM16 8k
function mulawB64ToPcm16_8k(mulawB64) {
  const muBuf = b64ToBuf(mulawB64);
  const pcmBuf = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    pcmBuf.writeInt16LE(mulawDecodeSample(muBuf[i]), i * 2);
  }
  return pcmBuf;
}

// Upsample 8k -> 16k
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

// Downsample 24k -> 8k
function downsamplePcm16_24k_to_8k(pcm24kBuf) {
  const inSamples = pcm24kBuf.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  if (outSamples <= 0) return Buffer.alloc(0);

  const outBuf = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const a = pcm24kBuf.readInt16LE((i * 3 + 0) * 2);
    const b = pcm24kBuf.readInt16LE((i * 3 + 1) * 2);
    const c = pcm24kBuf.readInt16LE((i * 3 + 2) * 2);
    outBuf.writeInt16LE(((a + b + c) / 3) | 0, i * 2);
  }
  return outBuf;
}

// PCM16 8k -> mulaw b64
function pcm16_8k_to_mulawB64(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  const muBuf = Buffer.alloc(inSamples);
  for (let i = 0; i < inSamples; i++) {
    muBuf[i] = mulawEncodeSample(pcm8kBuf.readInt16LE(i * 2));
  }
  return bufToB64(muBuf);
}

// =====================
// WS Server for Twilio Media Stream
// =====================
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs, req) => {
  console.log("Twilio: WS Connected", {
    ip: req.socket?.remoteAddress,
    ua: req.headers["user-agent"],
  });

  let streamSid = null;
  let geminiWs = null;
  let callLog = [];
  let openingSent = false;

  function connectToGemini() {
    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    geminiWs = new WebSocket(url);

    geminiWs.on("open", () => {
      console.log("Gemini: Connection Opened");

      const setupMsg = {
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            maxOutputTokens: 120,
            temperature: 0.3,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: GEMINI_VOICE },
              },
            },
          },
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },
          realtimeInputConfig: {
            activityHandling: "NO_INTERRUPTION",
          },
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

      if (msg.setupComplete) {
        console.log("Gemini: Setup Complete");

        // פתיח מיידי בלי להמתין לדיבור משתמש
        if (!openingSent) {
          openingSent = true;
          geminiWs.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: OPENING_TEXT }] }],
                turnComplete: true,
              },
            })
          );
        }
        return;
      }

      if (msg?.serverContent?.inputTranscription?.text) {
        callLog.push({ user_transcript: msg.serverContent.inputTranscription.text });
      }
      if (msg?.serverContent?.outputTranscription?.text) {
        callLog.push({ bot_transcript: msg.serverContent.outputTranscription.text });
      }

      const parts = msg?.serverContent?.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p?.inlineData?.data) {
            const mime = p.inlineData.mimeType || "";
            const pcmBuf = b64ToBuf(p.inlineData.data);

            // לרוב: PCM16 24k -> 8k -> mulaw
            let pcm8k = pcmBuf;
            if (!mime.includes("rate=8000")) {
              pcm8k = downsamplePcm16_24k_to_8k(pcmBuf);
            }
            const mulawB64 = pcm16_8k_to_mulawB64(pcm8k);

            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: mulawB64 } }));
            }
          }

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

    geminiWs.on("error", (e) => console.error("Gemini Error:", e?.message || e));
  }

  connectToGemini();

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

      const pcm8k = mulawB64ToPcm16_8k(msg.media.payload);
      const pcm16k = upsamplePcm16_8k_to_16k(pcm8k);

      geminiWs.send(
        JSON.stringify({
          realtimeInput: {
            audio: { mimeType: "audio/pcm;rate=16000", data: bufToB64(pcm16k) },
          },
        })
      );
      return;
    }

    if (msg.event === "stop") {
      try {
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
      } catch {}
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
        body: JSON.stringify({ event: "call_ended", sid: streamSid, log: callLog }),
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
