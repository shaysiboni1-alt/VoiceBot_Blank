// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime (Whisper transcription via WS)
// LLM: IVRIT (optional) -> fallback OpenAI Responses API
// TTS: ElevenLabs -> Twilio as g711_ulaw 8kHz
//
// Audio quality fixes (IMPORTANT):
// - Always send EXACT 160 bytes per 20ms frame (pad with 0xFF ulaw silence)
// - Prebuffer before playback to avoid underruns (jitter protection)
// - Tail silence padding to avoid last-syllable cut
//

require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const raw = String(process.env[name] || "").toLowerCase().trim();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}
function envStr(name, def = "") {
  const raw = process.env[name];
  return raw === undefined || raw === null || raw === "" ? def : String(raw);
}
function makeRid() {
  return crypto.randomBytes(4).toString("hex");
}

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber("PORT", 3000);

const DOMAIN = envStr("DOMAIN", "");
const MB_TWILIO_STREAM_URL = envStr("MB_TWILIO_STREAM_URL", "");

const OPENAI_API_KEY = envStr("OPENAI_API_KEY", "");
const OPENAI_REALTIME_MODEL = envStr("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview-2024-12-17");
const OPENAI_LLM_MODEL = envStr("OPENAI_LLM_MODEL", "gpt-4o-mini");

const IVRIT_LLM_URL = envStr("IVRIT_LLM_URL", ""); // optional endpoint -> expects {text:"..."}

const BOT_NAME = envStr("MB_BOT_NAME", "נטע");
const BUSINESS_NAME = envStr("MB_BUSINESS_NAME", "BluBinet");

const MB_OPENING_SCRIPT = envStr(
  "MB_OPENING_SCRIPT",
  "צהריים טובים, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?"
);

const MB_GENERAL_PROMPT = envStr("MB_GENERAL_PROMPT", "");
const MB_BUSINESS_PROMPT = envStr("MB_BUSINESS_PROMPT", "");

// VAD
const MB_VAD_THRESHOLD = envNumber("MB_VAD_THRESHOLD", 0.75);
const MB_VAD_SILENCE_MS = envNumber("MB_VAD_SILENCE_MS", 700);
const MB_VAD_PREFIX_MS = envNumber("MB_VAD_PREFIX_MS", 150);

// Barge-in
const MB_ALLOW_BARGE_IN = envBool("MB_ALLOW_BARGE_IN", false);
const MB_NO_BARGE_TAIL_MS = envNumber("MB_NO_BARGE_TAIL_MS", 900);

// UX
const MB_ACK_ENABLED = envBool("MB_ACK_ENABLED", true);
const MB_ACK_TEXT = envStr("MB_ACK_TEXT", "מעולה, רגע...");
const MB_REPLY_CHUNKING = envBool("MB_REPLY_CHUNKING", true);
const MB_REPLY_CHUNK_CHARS = envNumber("MB_REPLY_CHUNK_CHARS", 70);

// Audio quality
const MB_TTS_TAIL_SILENCE_MS = envNumber("MB_TTS_TAIL_SILENCE_MS", 180);
// NEW: prebuffer (jitter protection) — 200ms default
const MB_AUDIO_PREBUFFER_MS = envNumber("MB_AUDIO_PREBUFFER_MS", 200);

// Idle / max call (optional)
const MB_IDLE_HANGUP_MS = envNumber("MB_IDLE_HANGUP_MS", 120000);
const MB_MAX_CALL_MS = envNumber("MB_MAX_CALL_MS", 10 * 60 * 1000);

// Twilio REST hangup optional
const TWILIO_ACCOUNT_SID = envStr("TWILIO_ACCOUNT_SID", "");
const TWILIO_AUTH_TOKEN = envStr("TWILIO_AUTH_TOKEN", "");

// Logging
const MB_LOG_LEVEL = envStr("MB_LOG_LEVEL", "info").toLowerCase();

// -----------------------------
// ElevenLabs TTS config
// -----------------------------
const TTS_PROVIDER = envStr("TTS_PROVIDER", "eleven").toLowerCase();

const ELEVEN_API_KEY = envStr("ELEVEN_API_KEY", envStr("ELEVENLABS_API_KEY", ""));
const ELEVEN_VOICE_ID = envStr("ELEVEN_VOICE_ID", envStr("VOICE_ID", ""));
const ELEVEN_MODEL = envStr("ELEVEN_TTS_MODEL", "eleven_v3");
const ELEVEN_LANGUAGE = envStr("ELEVENLABS_LANGUAGE", envStr("ELEVEN_LANGUAGE", "he"));
const ELEVEN_OUTPUT_FORMAT = envStr("ELEVEN_OUTPUT_FORMAT", "ulaw_8000");

// v3 limitation
const ELEVEN_OPTIMIZE_STREAMING_LATENCY = envNumber("ELEVEN_OPTIMIZE_STREAMING_LATENCY", 3);
const ELEVEN_ENABLE_OPT_LATENCY = envBool("ELEVEN_ENABLE_OPT_LATENCY", true);

// voice settings
const ELEVEN_STABILITY = envNumber("ELEVEN_STABILITY", 0.5);
const ELEVEN_SIMILARITY = envNumber("ELEVEN_SIMILARITY", 0.75);
const ELEVEN_STYLE = envNumber("ELEVEN_STYLE", 0.0);
const ELEVEN_SPEAKER_BOOST = envBool("ELEVEN_SPEAKER_BOOST", true);

const ELEVEN_FORCE_STREAM_ENDPOINT = envBool("ELEVEN_FORCE_STREAM_ENDPOINT", true);
const ELEVEN_STRIP_WAV_HEADER = envBool("ELEVEN_STRIP_WAV_HEADER", true);

// Cached opening
const MB_CACHE_OPENING_AUDIO = envBool("MB_CACHE_OPENING_AUDIO", true);

if (!OPENAI_API_KEY) console.error("❌ Missing OPENAI_API_KEY in ENV.");
if (TTS_PROVIDER === "eleven") {
  if (!ELEVEN_API_KEY) console.error("❌ Missing ELEVEN_API_KEY (or ELEVENLABS_API_KEY) in ENV.");
  if (!ELEVEN_VOICE_ID) console.error("❌ Missing VOICE_ID (or ELEVEN_VOICE_ID) in ENV.");
}

// -----------------------------
// Logging
// -----------------------------
function rank(lvl) {
  if (lvl === "debug") return 10;
  if (lvl === "info") return 20;
  if (lvl === "warn") return 30;
  if (lvl === "error") return 40;
  return 20;
}
const CUR = rank(MB_LOG_LEVEL);
function log(lvl, tag, msg, extra, meta = {}) {
  if (rank(lvl) < CUR) return;
  const ts = new Date().toISOString();
  const ridPart = meta && meta.rid ? ` { rid: '${meta.rid}' }` : "";
  if (extra !== undefined) console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`, extra);
  else console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`);
}
const logInfo = (tag, msg, extra, meta) => log("info", tag, msg, extra, meta);
const logWarn = (tag, msg, extra, meta) => log("warn", tag, msg, extra, meta);
const logError = (tag, msg, extra, meta) => log("error", tag, msg, extra, meta);

console.log(`[CONFIG] PORT=${PORT}`);
console.log(`[CONFIG] PREBUFFER_MS=${MB_AUDIO_PREBUFFER_MS} TAIL_SILENCE_MS=${MB_TTS_TAIL_SILENCE_MS}`);
console.log(`[CONFIG] CHUNKING=${MB_REPLY_CHUNKING} ACK=${MB_ACK_ENABLED} BARGE_IN=${MB_ALLOW_BARGE_IN}`);
console.log(`[CONFIG] ELEVEN fmt=${ELEVEN_OUTPUT_FORMAT} model=${ELEVEN_MODEL} stream=${ELEVEN_FORCE_STREAM_ENDPOINT} stripWav=${ELEVEN_STRIP_WAV_HEADER}`);

// -----------------------------
// System instructions
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1) דברו בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
2) אם לא הבנתם: "לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?"
3) תשובות קצרות 1–3 משפטים, וסיימו בשאלה שמקדמת הבנה/איסוף צורך.
4) אל תסיימו שיחה מיוזמתכם.
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || "").trim();
  const kb = (MB_BUSINESS_PROMPT || "").trim();
  let instructions = "";
  if (base) instructions += base;
  if (kb) instructions += (instructions ? "\n\n" : "") + kb;
  if (!instructions) {
    instructions = `אתם עוזר קולי בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}". דברו בעברית כברירת מחדל, תשובות קצרות ומקצועיות.`;
  }
  return instructions + "\n\n" + EXTRA_BEHAVIOR_RULES;
}

// -----------------------------
// ulaw silence helpers
// -----------------------------
function ulawSilenceBytes(ms) {
  const frames = Math.ceil(ms / 20);
  const bytes = frames * 160;
  return Buffer.alloc(bytes, 0xff);
}
function padTo160(buf) {
  if (buf.length === 160) return buf;
  if (buf.length > 160) return buf.subarray(0, 160);
  const out = Buffer.alloc(160, 0xff);
  buf.copy(out, 0, 0, buf.length);
  return out;
}

// -----------------------------
// Audio sender with PREBUFFER + EXACT 160 bytes frames
// -----------------------------
function createAudioSender(connection, meta) {
  const state = {
    streamSid: null,
    timer: null,
    queue: [], // Buffers
    stopped: false,
    startedSending: false,
    prebufferBytes: Math.max(0, Math.floor(MB_AUDIO_PREBUFFER_MS / 20) * 160),
    queuedBytes: 0,
  };

  function bindStreamSid(streamSid) {
    state.streamSid = streamSid;
    logInfo("AudioSender", "Bound sender.streamSid", { streamSid }, meta);
    start();
  }

  function enqueue(buf) {
    if (state.stopped) return;
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return;
    state.queue.push(buf);
    state.queuedBytes += buf.length;
  }

  function stop() {
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.queue = [];
    state.queuedBytes = 0;
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (!state.streamSid) return;
      if (state.stopped) return;
      if (connection.readyState !== WebSocket.OPEN) return;
      if (state.queue.length === 0) return;

      // PREBUFFER: wait until we have enough bytes before starting playback
      if (!state.startedSending && state.prebufferBytes > 0) {
        if (state.queuedBytes < state.prebufferBytes) return;
        state.startedSending = true;
        logInfo("AudioSender", "Prebuffer satisfied -> start sending", { prebufferBytes: state.prebufferBytes }, meta);
      } else if (!state.startedSending) {
        state.startedSending = true;
      }

      // send exactly 160 bytes
      const frameSize = 160;

      let cur = state.queue[0];
      if (cur.length === 0) {
        state.queue.shift();
        return;
      }

      let frame;
      if (cur.length >= frameSize) {
        frame = cur.subarray(0, frameSize);
        const rest = cur.subarray(frameSize);
        state.queue[0] = rest;
        state.queuedBytes -= frameSize;
      } else {
        // last partial: pad to 160 to avoid artifacts
        frame = padTo160(cur);
        state.queue.shift();
        state.queuedBytes -= cur.length;
      }

      try {
        const payloadB64 = frame.toString("base64");
        connection.send(JSON.stringify({ event: "media", streamSid: state.streamSid, media: { payload: payloadB64 } }));
      } catch (e) {
        logError("AudioSender", "Failed sending frame", e, meta);
      }
    }, 20);
  }

  return { bindStreamSid, enqueue, stop };
}

// -----------------------------
// WAV stripper (if needed)
// -----------------------------
function stripWavIfPresent(buf, meta) {
  try {
    if (!ELEVEN_STRIP_WAV_HEADER) return buf;
    if (!buf || buf.length < 16) return buf;
    const riff = buf.toString("ascii", 0, 4);
    const wave = buf.toString("ascii", 8, 12);
    if (riff !== "RIFF" || wave !== "WAVE") return buf;

    let i = 12;
    while (i + 8 <= buf.length) {
      const chunkId = buf.toString("ascii", i, i + 4);
      const chunkSize = buf.readUInt32LE(i + 4);
      i += 8;
      if (chunkId === "data") {
        const start = i;
        const end = Math.min(i + chunkSize, buf.length);
        const dataBuf = buf.subarray(start, end);
        logWarn("ElevenTTS", "Stripped WAV header from Eleven audio (RIFF/WAVE detected).", { original: buf.length, data: dataBuf.length }, meta);
        return dataBuf;
      }
      i += chunkSize;
    }
    return buf;
  } catch (e) {
    logWarn("ElevenTTS", "WAV strip error (kept original)", e, meta);
    return buf;
  }
}

// -----------------------------
// Eleven URL (always /stream) + v3 restriction
// -----------------------------
function buildElevenUrl() {
  const basePath = ELEVEN_FORCE_STREAM_ENDPOINT ? "/stream" : "";
  const baseUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}${basePath}`;
  const qs = new URLSearchParams({ output_format: ELEVEN_OUTPUT_FORMAT, language: ELEVEN_LANGUAGE });

  const isV3 = String(ELEVEN_MODEL).toLowerCase() === "eleven_v3";
  const shouldAddOpt =
    ELEVEN_ENABLE_OPT_LATENCY &&
    !isV3 &&
    Number.isFinite(ELEVEN_OPTIMIZE_STREAMING_LATENCY) &&
    ELEVEN_OPTIMIZE_STREAMING_LATENCY > 0;

  if (shouldAddOpt) qs.set("optimize_streaming_latency", String(ELEVEN_OPTIMIZE_STREAMING_LATENCY));
  return `${baseUrl}?${qs.toString()}`;
}

// -----------------------------
// Eleven streaming TTS
// -----------------------------
async function elevenTtsStreamToSender(text, reason, sender, meta) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) return false;
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;

  const url = buildElevenUrl();
  const body = {
    text: cleaned,
    model_id: ELEVEN_MODEL,
    voice_settings: {
      stability: ELEVEN_STABILITY,
      similarity_boost: ELEVEN_SIMILARITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: ELEVEN_SPEAKER_BOOST,
    },
  };

  const t0 = Date.now();
  logInfo("ElevenTTS", "TTS request", { reason, length: cleaned.length, url }, meta);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/*",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      logWarn("ElevenTTS", `HTTP ${res.status}`, await res.text().catch(() => ""), meta);
      return false;
    }

    // Log content-type (helps detect wrong format like mp3)
    const ct = res.headers.get("content-type") || "";
    logInfo("ElevenTTS", "Response headers", { contentType: ct }, meta);

    if (!res.body || !res.body.getReader) {
      const arr = await res.arrayBuffer();
      let buf = Buffer.from(arr);
      buf = stripWavIfPresent(buf, meta);
      sender.enqueue(buf);
      if (MB_TTS_TAIL_SILENCE_MS > 0) sender.enqueue(ulawSilenceBytes(MB_TTS_TAIL_SILENCE_MS));
      return true;
    }

    const reader = res.body.getReader();
    let total = 0;
    let firstByteMs = null;

    // small buffer to detect RIFF quickly
    let head = Buffer.alloc(0);
    let decided = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;

      const chunk = Buffer.from(value);
      total += chunk.length;
      if (firstByteMs === null) firstByteMs = Date.now() - t0;

      if (!decided) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 4096) {
          const stripped = stripWavIfPresent(head, meta);
          sender.enqueue(stripped);
          decided = true;
        }
        continue;
      }

      sender.enqueue(chunk);
    }

    if (!decided && head.length) {
      const stripped = stripWavIfPresent(head, meta);
      sender.enqueue(stripped);
    }

    if (MB_TTS_TAIL_SILENCE_MS > 0) sender.enqueue(ulawSilenceBytes(MB_TTS_TAIL_SILENCE_MS));

    logInfo("ElevenTTS", "TTS done", { firstByteMs: firstByteMs ?? (Date.now() - t0), totalMs: Date.now() - t0, bytes: total }, meta);
    return true;
  } catch (e) {
    logWarn("ElevenTTS", "TTS error", e, meta);
    return false;
  }
}

// -----------------------------
// Cached opening audio
// -----------------------------
let OPENING_AUDIO_CACHE = null;

async function warmupOpeningCache() {
  if (!MB_CACHE_OPENING_AUDIO) return;
  if (TTS_PROVIDER !== "eleven") return;
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) return;

  try {
    const url = buildElevenUrl();
    const body = {
      text: String(MB_OPENING_SCRIPT || "").trim(),
      model_id: ELEVEN_MODEL,
      voice_settings: {
        stability: ELEVEN_STABILITY,
        similarity_boost: ELEVEN_SIMILARITY,
        style: ELEVEN_STYLE,
        use_speaker_boost: ELEVEN_SPEAKER_BOOST,
      },
    };

    logInfo("Startup", "Warming opening audio cache with ElevenLabs...", { url });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/*",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      logWarn("Startup", `Opening cache warmup failed HTTP ${res.status}`, await res.text().catch(() => ""));
      return;
    }

    const arr = await res.arrayBuffer();
    let buf = Buffer.from(arr);
    buf = stripWavIfPresent(buf);
    if (MB_TTS_TAIL_SILENCE_MS > 0) buf = Buffer.concat([buf, ulawSilenceBytes(MB_TTS_TAIL_SILENCE_MS)]);
    OPENING_AUDIO_CACHE = buf;
    logInfo("Startup", `Opening audio cached. bytes=${OPENING_AUDIO_CACHE.length}`);
  } catch (e) {
    logWarn("Startup", "Opening cache warmup error", e);
  }
}

// -----------------------------
// LLM: IVRIT -> fallback OpenAI Responses
// -----------------------------
async function callIvritLLM(userText, meta) {
  if (!IVRIT_LLM_URL) return null;
  try {
    const res = await fetch(IVRIT_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: userText }),
    });
    if (!res.ok) {
      logWarn("IVRIT", `HTTP ${res.status}`, await res.text().catch(() => ""), meta);
      return null;
    }
    const j = await res.json().catch(() => null);
    const out = j && typeof j.text === "string" ? j.text.trim() : "";
    return out || null;
  } catch (e) {
    logWarn("IVRIT", "Call error", e, meta);
    return null;
  }
}

async function callOpenAiResponses(systemInstructions, userText, meta) {
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_LLM_MODEL,
        input: [
          { role: "system", content: systemInstructions },
          { role: "user", content: userText },
        ],
        max_output_tokens: 220,
      }),
    });

    if (!res.ok) {
      logWarn("LLM", `OpenAI HTTP ${res.status}`, await res.text().catch(() => ""), meta);
      return "לֹא הִצְלַחְתִּי לַעֲנוֹת רֶגַע. אֶפְשָׁר לְנַסּוֹת שׁוּב?";
    }

    const j = await res.json();
    let text = "";
    if (j.output && Array.isArray(j.output)) {
      for (const item of j.output) {
        if (item?.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
          }
        }
      }
    }
    text = String(text || "").trim();
    return text || "לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?";
  } catch (e) {
    logWarn("LLM", "OpenAI call error", e, meta);
    return "לֹא הִצְלַחְתִּי לַעֲנוֹת רֶגַע. אֶפְשָׁר לְנַסּוֹת שׁוּב?";
  }
}

function splitIntoChunks(text, maxChars) {
  const s = String(text || "").trim();
  if (!s) return [];
  const chunks = [];
  let cur = "";
  const tokens = s.split(/\s+/);
  for (const t of tokens) {
    if (!cur) cur = t;
    else if ((cur + " " + t).length <= maxChars) cur += " " + t;
    else { chunks.push(cur); cur = t; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// -----------------------------
// Express & HTTP server
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/twilio-voice", (req, res) => {
  const host = (DOMAIN || req.headers.host || "").replace(/^https?:\/\//, "");
  const wsUrl = MB_TWILIO_STREAM_URL || `wss://${host}/twilio-media-stream`;
  const caller = req.body.From || "";

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

// -----------------------------
// Per-call handler
// -----------------------------
wss.on("connection", (connection) => {
  const meta = { rid: makeRid() };
  logInfo("Call", "New Twilio Media Stream connection established.", undefined, meta);

  const sender = createAudioSender(connection, meta);

  let callEnded = false;
  let lastMediaTs = Date.now();
  let botSpeaking = false;
  let noListenUntilTs = 0;

  const conversationLog = [];
  let idleInterval = null;
  let maxCallTimeout = null;

  function cleanupTimers() {
    if (idleInterval) clearInterval(idleInterval);
    idleInterval = null;
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    maxCallTimeout = null;
  }

  function endCall(reason) {
    if (callEnded) return;
    callEnded = true;
    cleanupTimers();
    logInfo("Call", `endCall reason="${reason}"`, undefined, meta);
    logInfo("Call", "Final conversation log:", conversationLog, meta);
    try { sender.stop(); } catch {}
    try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
    try { if (connection.readyState === WebSocket.OPEN) connection.close(); } catch {}
  }

  // OpenAI Realtime WS (transcription only)
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  openAiWs.on("open", () => {
    logInfo("Call", "Connected to OpenAI Realtime API.", undefined, meta);
    openAiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ["text", "audio"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        instructions: buildSystemInstructions()
      }
    }));
  });

  openAiWs.on("close", () => { if (!callEnded) endCall("openai_ws_closed"); });
  openAiWs.on("error", (e) => { logError("Call", "OpenAI WS error", e, meta); if (!callEnded) endCall("openai_ws_error"); });

  let llmBusy = false;
  let lastTranscript = "";
  let lastTranscriptAt = 0;

  async function speakReply(text) {
    const reply = String(text || "").trim();
    if (!reply) return;
    conversationLog.push({ from: "bot", text: reply });

    botSpeaking = true;

    if (MB_REPLY_CHUNKING) {
      const chunks = splitIntoChunks(reply, MB_REPLY_CHUNK_CHARS);
      for (let i = 0; i < chunks.length; i++) {
        await elevenTtsStreamToSender(chunks[i], `llm_reply:chunk_${i + 1}/${chunks.length}`, sender, meta);
      }
    } else {
      await elevenTtsStreamToSender(reply, "llm_reply", sender, meta);
    }

    botSpeaking = false;
    noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
  }

  async function handleUserText(t) {
    const text = String(t || "").trim();
    if (!text) return;

    const now = Date.now();
    if (text === lastTranscript && now - lastTranscriptAt < 800) return;
    lastTranscript = text;
    lastTranscriptAt = now;

    conversationLog.push({ from: "user", text });
    logInfo("User", text, undefined, meta);

    if (!MB_ALLOW_BARGE_IN && (botSpeaking || now < noListenUntilTs)) return;
    if (llmBusy) return;

    llmBusy = true;

    if (MB_ACK_ENABLED) {
      botSpeaking = true;
      conversationLog.push({ from: "bot", text: MB_ACK_TEXT });
      await elevenTtsStreamToSender(MB_ACK_TEXT, "ack", sender, meta);
      botSpeaking = false;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
    }

    let reply = null;
    if (IVRIT_LLM_URL) reply = await callIvritLLM(text, meta);
    if (!reply) reply = await callOpenAiResponses(buildSystemInstructions(), text, meta);

    await speakReply(reply);
    llmBusy = false;
  }

  openAiWs.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      await handleUserText(msg.transcript || "");
    }
  });

  connection.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "start") {
      const streamSid = msg.start?.streamSid || null;
      sender.bindStreamSid(streamSid);
      lastMediaTs = Date.now();

      conversationLog.push({ from: "bot", text: MB_OPENING_SCRIPT });
      botSpeaking = true;

      if (OPENING_AUDIO_CACHE && OPENING_AUDIO_CACHE.length) {
        sender.enqueue(Buffer.from(OPENING_AUDIO_CACHE));
      } else {
        await elevenTtsStreamToSender(MB_OPENING_SCRIPT, "opening_greeting", sender, meta);
      }

      botSpeaking = false;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      idleInterval = setInterval(() => {
        const since = Date.now() - lastMediaTs;
        if (since > MB_IDLE_HANGUP_MS) endCall("idle_timeout");
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        maxCallTimeout = setTimeout(() => endCall("max_call_duration"), MB_MAX_CALL_MS);
      }

      return;
    }

    if (msg.event === "media") {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;
      if (openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN && (botSpeaking || now < noListenUntilTs)) return;

      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      return;
    }

    if (msg.event === "stop") {
      endCall("twilio_stop");
    }
  });

  connection.on("close", () => { if (!callEnded) endCall("twilio_ws_closed"); });
  connection.on("error", (e) => { logError("Call", "Twilio WS error", e, meta); if (!callEnded) endCall("twilio_ws_error"); });
});

// -----------------------------
// Start
// -----------------------------
process.on("uncaughtException", (e) => console.error("[FATAL] uncaughtException", e));
process.on("unhandledRejection", (e) => console.error("[FATAL] unhandledRejection", e));

server.listen(PORT, async () => {
  console.log(`✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  await warmupOpeningCache();
});
