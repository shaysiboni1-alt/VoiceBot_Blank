require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 1000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const MB_DEBUG = String(process.env.MB_DEBUG || "").toLowerCase() === "true";

const BOT_NAME = process.env.MB_BOT_NAME || "נטע";
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || "BluBinet";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL || "";

const GEMINI_MODEL = (process.env.MB_GEMINI_MODEL || "models/gemini-2.0-flash-exp").trim();
const GEMINI_VOICE = (process.env.MB_GEMINI_VOICE || "Aoede").trim();

// Output gain (volume)
const MB_OUTPUT_GAIN = Number(process.env.MB_OUTPUT_GAIN || "1.7"); // try 1.7–2.2
const MB_OUTPUT_LIMIT = Number(process.env.MB_OUTPUT_LIMIT || "30000"); // soft-limit

const OPENING_TEXT =
  process.env.MB_OPENING_TEXT ||
  `שָׁלוֹם, הִגַּעְתֶּם לְ־${BUSINESS_NAME}. מְדַבֶּרֶת ${BOT_NAME}. אֵיךְ אֶפְשָׁר לַעֲזוֹר?`;

// IMPORTANT: Opening must be spoken verbatim
const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".

כללי שפה וסגנון:
- דברי בעברית בלבד.
- תשובות קצרות (1–2 משפטים) אחרי שהלקוח דיבר.
- אל תקטעי את הלקוח.
- אם חסר מידע: שאלי שאלה אחת קצרה בלבד.

כלל פתיח חשוב:
- אם מתקבלת הודעה שמתחילה ב-[OPENING_VERBATIM], את חייבת להקריא בדיוק מילה במילה את הטקסט שמופיע אחרי התג, בלי לקצר ובלי לשנות, ורק אחרי ההקראה תשאלי: "אֵיךְ אֶפְשָׁר לַעֲזוֹר?"
`.trim();

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.send("BluBinet Status: Online"));
app.get("/health", (req, res) => res.json({ ok: true }));

function buildWsUrl(req) {
  if (PUBLIC_BASE_URL) {
    const u = new URL(PUBLIC_BASE_URL);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}/twilio-media-stream`;
  }
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `wss://${host}/twilio-media-stream`;
}

app.post("/twilio-voice", (req, res) => {
  const wsUrl = buildWsUrl(req);
  if (MB_DEBUG) console.log("==> /twilio-voice", { from: req.body?.From, to: req.body?.To, wsUrl });

  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
  <Pause length="600"/>
</Response>`
  );
});

const server = http.createServer(app);

// =====================
// Base64 helpers
// =====================
const b64ToBuf = (b64) => Buffer.from(b64, "base64");
const bufToB64 = (buf) => Buffer.from(buf).toString("base64");

// =====================
// G.711 μ-law encode/decode (standard)
// =====================
const MU_LAW_MAX = 0x1FFF;
const MU_LAW_BIAS = 33;

function linearToMuLawSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;
  sample = sample + MU_LAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function muLawToLinearSample(muLawByte) {
  muLawByte = (~muLawByte) & 0xff;
  const sign = (muLawByte & 0x80);
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0f;

  let sample = ((mantissa << 1) + 1) << (exponent + 2);
  sample -= MU_LAW_BIAS;
  return sign ? -sample : sample;
}

function mulawB64ToPcm16_8k(mulawB64) {
  const muBuf = b64ToBuf(mulawB64);
  const pcmBuf = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    pcmBuf.writeInt16LE(muLawToLinearSample(muBuf[i]), i * 2);
  }
  return pcmBuf;
}

function pcm16_8k_to_mulawB64(pcm8kBuf) {
  const samples = pcm8kBuf.length / 2;
  const muBuf = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    muBuf[i] = linearToMuLawSample(pcm8kBuf.readInt16LE(i * 2));
  }
  return bufToB64(muBuf);
}

// =====================
// Resampling PCM24k -> PCM8k (FIR + decimate by 3)
// =====================
function clamp16(x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x | 0;
}

const FIR3 = [
  -0.0042,-0.0101,-0.0146,-0.0107, 0.0060, 0.0331, 0.0640, 0.0895, 0.1010,
   0.0895, 0.0640, 0.0331, 0.0060,-0.0107,-0.0146,-0.0101,-0.0042
];
const FIR3_HALF = Math.floor(FIR3.length / 2);

function lowpassFIR24k(pcm24kBuf) {
  const n = pcm24kBuf.length / 2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -FIR3_HALF; k <= FIR3_HALF; k++) {
      const idx = i + k;
      const s = idx < 0 || idx >= n ? 0 : pcm24kBuf.readInt16LE(idx * 2);
      acc += s * FIR3[k + FIR3_HALF];
    }
    out[i] = clamp16(acc);
  }
  return Buffer.from(out.buffer);
}

function pcm24kToPcm8k(pcm24kBuf) {
  if (!pcm24kBuf || pcm24kBuf.length < 6) return Buffer.alloc(0);
  const filtered = lowpassFIR24k(pcm24kBuf);
  const inSamples = filtered.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  const outBuf = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    outBuf.writeInt16LE(filtered.readInt16LE((i * 3) * 2), i * 2);
  }
  return outBuf;
}

// =====================
// Output volume: gain + soft limiter (on PCM8k)
// =====================
function applyGainAndLimitInPlace(pcm8kBuf, gain, limit) {
  const n = pcm8kBuf.length / 2;
  for (let i = 0; i < n; i++) {
    let x = pcm8kBuf.readInt16LE(i * 2) * gain;

    // soft clip
    const hard = limit;
    if (x > hard) x = hard + (x - hard) * 0.12;
    if (x < -hard) x = -hard + (x + hard) * 0.12;

    pcm8kBuf.writeInt16LE(clamp16(x), i * 2);
  }
  return pcm8kBuf;
}

// =====================
// Upsample Twilio PCM8k -> PCM16k (linear) for Gemini input
// =====================
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

// =====================
// Gemini Live WS (v1beta bidiGenerateContent)
// =====================
function geminiWsUrl() {
  return (
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`
  );
}

function makeSetupMsg() {
  return {
    setup: {
      model: GEMINI_MODEL,
      generation_config: {
        response_modalities: ["AUDIO"],
        max_output_tokens: 180,
        temperature: 0.3,
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: GEMINI_VOICE },
          },
        },
      },
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },

      // Keep bot from cutting the user
      realtime_input_config: { activity_handling: "NO_INTERRUPTION" },

      // Enable transcription
      input_audio_transcription: {},
      output_audio_transcription: {},
    },
  };
}

function getServerContent(msg) {
  return msg.serverContent || msg.server_content || null;
}

function getInlineData(part) {
  return part.inlineData || part.inline_data || null;
}

// =====================
// Transcript aggregation (fragments -> full lines)
// =====================
function makeTranscriptAggregator(label, logFn) {
  let buf = "";
  let timer = null;

  function flush() {
    if (!buf.trim()) return;
    logFn({ type: label, text: buf.trim() });
    buf = "";
  }

  return {
    add(fragment) {
      const t = String(fragment || "");
      if (!t) return;
      buf += t;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 400);
    },
    flush,
  };
}

// =====================
// Twilio outbound packetizer (20ms frames)
// =====================
const FRAME_SAMPLES_8K_20MS = 160;
const FRAME_BYTES_PCM8K_20MS = FRAME_SAMPLES_8K_20MS * 2;

function makeOutboundPacketizer(sendMulawFrameFn) {
  let pcmQueue = Buffer.alloc(0);

  return {
    pushPcm8k(pcm8kBuf) {
      if (!pcm8kBuf || !pcm8kBuf.length) return;
      pcmQueue = Buffer.concat([pcmQueue, pcm8kBuf]);

      while (pcmQueue.length >= FRAME_BYTES_PCM8K_20MS) {
        let frame = pcmQueue.subarray(0, FRAME_BYTES_PCM8K_20MS);
        pcmQueue = pcmQueue.subarray(FRAME_BYTES_PCM8K_20MS);

        // Gain + limit (fix low volume)
        const frameBuf = Buffer.from(frame); // copy so we can mutate safely
        applyGainAndLimitInPlace(frameBuf, MB_OUTPUT_GAIN, MB_OUTPUT_LIMIT);

        const payload = pcm16_8k_to_mulawB64(frameBuf);
        sendMulawFrameFn(payload);
      }
    },
    reset() {
      pcmQueue = Buffer.alloc(0);
    },
  };
}

// =====================
// WS server for Twilio stream
// =====================
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs, req) => {
  console.log("Twilio: WS Connected", { ip: req.socket?.remoteAddress, ua: req.headers["user-agent"] });

  let streamSid = null;
  let twilioReady = false;

  let geminiWs = null;
  let geminiReady = false;

  let openingSent = false;
  let closedByUs = false;

  let inboundMediaCount = 0;
  let lastInboundAt = 0;

  const callLog = [];
  const log = (obj) => {
    callLog.push({ ts: new Date().toISOString(), ...obj });
    if (MB_DEBUG) console.log("LOG+", obj);
  };

  const botAgg = makeTranscriptAggregator("bot_transcript_full", log);
  const userAgg = makeTranscriptAggregator("user_transcript_full", log);

  const packetizer = makeOutboundPacketizer((mulawB64) => {
    if (!streamSid) return;
    if (twilioWs.readyState !== WebSocket.OPEN) return;
    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: mulawB64 } }));
  });

  function maybeSendOpening() {
    if (openingSent) return;
    if (!twilioReady || !geminiReady) return;

    openingSent = true;

    // Force verbatim speech
    const verbatim = `[OPENING_VERBATIM] ${OPENING_TEXT}`;

    log({ type: "opening", text: OPENING_TEXT });

    geminiWs.send(
      JSON.stringify({
        client_content: {
          turns: [{ role: "user", parts: [{ text: verbatim }] }],
          turn_complete: true,
        },
      })
    );
  }

  function connectGemini() {
    geminiReady = false;
    geminiWs = new WebSocket(geminiWsUrl());

    geminiWs.on("open", () => {
      console.log("Gemini: Connection Opened. Model:", GEMINI_MODEL, "Voice:", GEMINI_VOICE);
      geminiWs.send(JSON.stringify(makeSetupMsg()));
    });

    geminiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.setupComplete || msg.setup_complete) {
        console.log("Gemini: Setup Complete");
        geminiReady = true;
        log({ type: "setup_complete", model: GEMINI_MODEL, voice: GEMINI_VOICE });
        maybeSendOpening();
        return;
      }

      const sc = getServerContent(msg);

      const inT = sc?.inputTranscription?.text || sc?.input_transcription?.text;
      const outT = sc?.outputTranscription?.text || sc?.output_transcription?.text;
      if (typeof inT === "string" && inT.length) userAgg.add(inT);
      if (typeof outT === "string" && outT.length) botAgg.add(outT);

      const modelTurn = sc?.modelTurn || sc?.model_turn;
      const parts = modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const inline = getInlineData(p);
          if (inline?.data) {
            const mime = inline.mimeType || inline.mime_type || "";
            const pcm24k = b64ToBuf(inline.data);

            if (MB_DEBUG) console.log("Gemini audio chunk", { mime, bytes: pcm24k.length });

            const pcm8k = pcm24kToPcm8k(pcm24k);

            // Send stable 20ms frames to Twilio
            packetizer.pushPcm8k(pcm8k);
          }
        }
      }

      const err = msg?.error?.message;
      if (err) {
        console.error("Gemini error:", err);
        log({ type: "gemini_error", message: err });
      }
    });

    geminiWs.on("close", (code, reason) => {
      const reasonStr = reason?.toString?.() || "";
      log({ type: "gemini_close", code, reason: reasonStr });
      if (MB_DEBUG) console.log("Gemini Connection Closed", code, reasonStr);
      if (closedByUs) return;

      setTimeout(() => {
        if (twilioWs.readyState === WebSocket.OPEN) connectGemini();
      }, 250);
    });

    geminiWs.on("error", (e) => {
      log({ type: "gemini_ws_error", message: e?.message || String(e) });
      console.error("Gemini WS error:", e?.message || e);
    });
  }

  connectGemini();

  // Twilio -> Gemini audio
  twilioWs.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid || null;
      twilioReady = true;
      log({ type: "twilio_start", streamSid });
      if (MB_DEBUG) console.log("Twilio Started:", streamSid);
      maybeSendOpening();
      return;
    }

    if (msg.event === "media") {
      inboundMediaCount++;
      lastInboundAt = Date.now();

      if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      if (!msg?.media?.payload) return;

      // μ-law 8k -> PCM16 8k -> upsample to 16k
      const pcm8k = mulawB64ToPcm16_8k(msg.media.payload);
      const pcm16k = upsamplePcm16_8k_to_16k(pcm8k);

      // IMPORTANT: Live API expects media_chunks blobs :contentReference[oaicite:2]{index=2}
      geminiWs.send(
        JSON.stringify({
          realtime_input: {
            media_chunks: [
              { data: bufToB64(pcm16k), mime_type: "audio/pcm;rate=16000" },
            ],
          },
        })
      );

      if (MB_DEBUG && inboundMediaCount % 50 === 0) {
        console.log("Inbound audio OK", { inboundMediaCount, ageMs: Date.now() - lastInboundAt });
      }
      return;
    }

    if (msg.event === "stop") {
      log({ type: "twilio_stop" });
      userAgg.flush();
      botAgg.flush();
      try {
        closedByUs = true;
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    log({ type: "twilio_close" });
    userAgg.flush();
    botAgg.flush();

    try {
      closedByUs = true;
      packetizer.reset();
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    } catch {}

    if (MAKE_WEBHOOK_URL) {
      fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "call_ended",
          sid: streamSid,
          inboundMediaCount,
          log: callLog,
        }),
      }).catch(() => {});
    }
  });

  twilioWs.on("error", (e) => console.error("Twilio WS error:", e?.message || e));
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("uncaughtException", err));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Model:", GEMINI_MODEL, "Voice:", GEMINI_VOICE);
  console.log("MB_OUTPUT_GAIN:", MB_OUTPUT_GAIN);
});
