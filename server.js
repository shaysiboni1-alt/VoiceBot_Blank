// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API
//
// מטרות:
// - עברית כברירת מחדל, לשון רבים, טון קצר וחם.
// - TTS דרך ElevenLabs (Streaming) בפורמט ulaw_8000 (מתאים ל-Twilio Media Streams).
// - פתיח מיידי דרך Eleven (בלי לחכות ל-OpenAI) כדי להוריד דיליי.
// - שליטה מלאה דרך ENV בכל מה שאפשר.
// - לוגים תמידיים וברורים (כולל rid לכל שיחה).
// - Fallback אוטומטי ל-OpenAI audio (Alloy) רק אם Eleven נכשל, כדי שלא יהיה "שקט".
//
// חשוב:
// - אל תנסו להחזיר MP3 ל-Twilio Media Streams בלי decode -> זה יישמע רעש.
// - eleven_v3 לא תומך ב-optimize_streaming_latency -> אסור לשלוח את הפרמטר הזה.
//
// ENV מומלצים (מינימום):
// - PORT=1000
// - OPENAI_API_KEY=...
// - OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview-2024-12-17
// - TWILIO_ACCOUNT_SID=...
// - TWILIO_AUTH_TOKEN=...
// - TTS_PROVIDER=eleven
// - ELEVEN_API_KEY=...            (או ELEVENLABS_API_KEY)
// - VOICE_ID=...                  (או ELEVEN_VOICE_ID)
// - ELEVENLABS_MODEL_ID=eleven_v3
// - ELEVENLABS_OUTPUT_FORMAT=ulaw_8000
// - ELEVENLABS_LANGUAGE=he
// - ELEVENLABS_STABILITY=0.5      (ייצמד אוטומטית ל-0/0.5/1)
// - ELEVENLABS_STYLE=0.15
// - ELEVENLABS_USE_BOOST=1
// - ELEVENLABS_TIMEOUT_MS=4000
//
// אופציונלי:
// - BUSINESS_NAME=BluBinet
// - OPENING_SUFFIX=... (אם יש)
// - TIME_ZONE=Asia/Jerusalem
// - MB_ALLOW_BARGE_IN=true
// - MB_NO_BARGE_TAIL_MS=900
// - MB_VAD_THRESHOLD=0.55
// - MB_VAD_PREFIX_MS=220
// - MB_VAD_SILENCE_MS=520
// - MB_MAX_CALL_MS=480000
// - MB_SILENCE_HANGUP_MS=20000
// - MAKE_WEBHOOK_URL=... (שליחת לידים)
// - MB_ABANDONED_WEBHOOK_URL=... (ניתוק שיחה באמצע)
//
// בדיקות:
// - GET /health
// - GET /twilio-voice (דפדפן) -> OK
// - Twilio Voice Webhook -> POST /twilio-voice
// - Media Stream -> wss://<domain>/twilio-media-stream

require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));

// =========================
// Logging helpers
// =========================
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function shouldLog(level) {
  return (LEVELS[level] || 20) >= (LEVELS[LOG_LEVEL] || 20);
}
function log(level, tag, msg, extra) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const base = `[${ts}][${level.toUpperCase()}][${tag}] ${msg}`;
  if (extra !== undefined) {
    try {
      console.log(base, extra);
    } catch {
      console.log(base);
    }
  } else {
    console.log(base);
  }
}

process.on("unhandledRejection", (err) => log("error", "Process", "unhandledRejection", err));
process.on("uncaughtException", (err) => log("error", "Process", "uncaughtException", err));

// HTTP request logging middleware
app.use((req, res, next) => {
  const rid = req.headers["x-request-id"] || crypto.randomBytes(4).toString("hex");
  req.rid = rid;
  log("info", "HTTP", `--> [${rid}] ${req.method} ${req.path} ip=${req.ip}`);
  res.on("finish", () => log("info", "HTTP", `<-- [${rid}] ${req.method} ${req.path} status=${res.statusCode}`));
  next();
});

// =========================
// Basic routes
// =========================
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

app.get("/twilio-voice", (req, res) => {
  // Browser test endpoint
  log("info", "Twilio-Voice", `GET /twilio-voice (browser test). rid=${req.rid}`);
  res
    .status(200)
    .send(
      `OK. This endpoint is meant for Twilio (HTTP POST)\n` +
        `If you see this in browser, the service is reachable.\n\n` +
        `Use POST /twilio-voice from Twilio Voice Webhook.\n` +
        `You can also check GET /health.\n`
    );
});

app.post("/twilio-voice", (req, res) => {
  // Twilio Voice Webhook -> return TwiML to start Media Stream
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const wsProto = proto === "http" ? "ws" : "wss";
  const wsUrl = `${wsProto}://${host}/twilio-media-stream`;

  log("info", "Twilio-Voice", `POST /twilio-voice -> Stream to ${wsUrl}`, { rid: req.rid });

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${wsUrl}" />` +
    `</Connect>` +
    `</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// =========================
// Config
// =========================
const PORT = Number(process.env.PORT || 1000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

const TTS_PROVIDER = (process.env.TTS_PROVIDER || "eleven").toLowerCase();

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || process.env.VOICE_ID || ""; // <-- supports your VOICE_ID
const ELEVEN_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID || process.env.ELEVEN_TTS_MODEL || "eleven_v3").trim();
const ELEVEN_OUTPUT_FORMAT =
  (process.env.ELEVENLABS_OUTPUT_FORMAT || process.env.ELEVEN_OUTPUT_FORMAT || "ulaw_8000").trim();
const ELEVEN_LANGUAGE = (process.env.ELEVENLABS_LANGUAGE || process.env.ELEVEN_LANGUAGE || "he").trim();
const ELEVEN_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS || 4000);

const ELEVEN_STYLE = clamp01(Number(process.env.ELEVENLABS_STYLE || 0.15));
const ELEVEN_USE_BOOST = String(process.env.ELEVENLABS_USE_BOOST || "1") === "1";
const ELEVEN_STABILITY_RAW = Number(process.env.ELEVENLABS_STABILITY || 0.5);
const ELEVEN_STABILITY = snapStability(ELEVEN_STABILITY_RAW); // 0 / 0.5 / 1 only
const ELEVEN_SIMILARITY = clamp01(Number(process.env.ELEVENLABS_SIMILARITY || 0.8));
const ELEVEN_SPEED = clamp(0.7, 1.2, Number(process.env.ELEVENLABS_SPEED || process.env.MB_SPEECH_SPEED || 1.0));

// VAD / conversation behavior
const MB_ALLOW_BARGE_IN = String(process.env.MB_ALLOW_BARGE_IN || "true") === "true";
const MB_NO_BARGE_TAIL_MS = Number(process.env.MB_NO_BARGE_TAIL_MS || 900);

const MB_VAD_THRESHOLD = clamp(0.1, 0.9, Number(process.env.MB_VAD_THRESHOLD || 0.55));
const MB_VAD_PREFIX_MS = Number(process.env.MB_VAD_PREFIX_MS || 220);
const MB_VAD_SILENCE_MS = Number(process.env.MB_VAD_SILENCE_MS || 520);

const MB_MAX_CALL_MS = Number(process.env.MB_MAX_CALL_MS || 8 * 60 * 1000);
const MB_SILENCE_HANGUP_MS = Number(process.env.MB_SILENCE_HANGUP_MS || 20 * 1000);
const MB_HANGUP_GRACE_MS = Number(process.env.MB_HANGUP_GRACE_MS || 3000);

const BUSINESS_NAME = process.env.BUSINESS_NAME || "BluBinet";
const OPENING_SUFFIX = process.env.OPENING_SUFFIX || "";
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Jerusalem";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const MB_ABANDONED_WEBHOOK_URL = process.env.MB_ABANDONED_WEBHOOK_URL || "";

// Basic startup config logs
log("info", "CONFIG", `MB_HANGUP_GRACE_MS=${MB_HANGUP_GRACE_MS} ms`);
log(
  "info",
  "CONFIG",
  `MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS} ms`
);
log(
  "info",
  "CONFIG",
  `TTS_PROVIDER=${TTS_PROVIDER}, ELEVEN_VOICE_ID=${ELEVEN_VOICE_ID ? "SET" : "MISSING"}, model=${ELEVEN_MODEL_ID}, format=${ELEVEN_OUTPUT_FORMAT}`
);

// =========================
// HTTP server + WebSocket server (Twilio Media Streams)
// =========================
const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (ws, req) => {
  const rid = crypto.randomBytes(4).toString("hex");
  log("info", "Call", "New Twilio Media Stream connection established.", { rid });

  const state = createCallState({ ws, rid });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      log("warn", "Twilio", "Non-JSON message from Twilio", { rid });
      return;
    }

    try {
      await handleTwilioMessage(state, msg);
    } catch (err) {
      log("error", "Call", "handleTwilioMessage failed", { rid, err: String(err) });
    }
  });

  ws.on("close", () => {
    log("info", "Call", "Twilio WS closed.", { rid });
    safeEndCall(state, "twilio_ws_closed").catch(() => {});
  });

  ws.on("error", (err) => {
    log("error", "Call", "Twilio WS error", { rid, err: String(err) });
    safeEndCall(state, "twilio_ws_error").catch(() => {});
  });

  // Hard max call timer
  state.maxCallTimer = setTimeout(() => {
    safeEndCall(state, "max_call_timeout").catch(() => {});
  }, MB_MAX_CALL_MS);
});

server.listen(PORT, () => {
  log("info", "Startup", `✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  log("info", "Startup", `Available at your primary URL ${process.env.RENDER_EXTERNAL_URL || ""}`.trim());
});

// =========================
// Call state + handlers
// =========================
function createCallState({ ws, rid }) {
  return {
    rid,
    twilioWs: ws,
    streamSid: null,
    callSid: null,
    caller: null,

    openAiWs: null,
    openAiReady: false,

    // Outgoing audio sender
    sender: createUlawSender({ twilioWs: ws, rid }),

    // Conversation
    conversationLog: [],
    lastUserText: null,
    lastActivityAt: Date.now(),
    silenceTimer: null,
    maxCallTimer: null,
    graceTimer: null,

    // TTS playback state
    isSpeaking: false,
    speakingSince: 0,

    // Whether we had any bot output
    hadAnyAudio: false,

    // for preventing double end
    ended: false,

    // fallback usage
    usedFallbackAlloy: false,
  };
}

async function handleTwilioMessage(state, msg) {
  const { rid } = state;

  if (msg.event === "start") {
    state.streamSid = msg.start.streamSid;
    state.callSid = msg.start.callSid;
    state.caller = msg.start.customParameters?.caller || null;

    log("info", "Call", `Twilio stream started. streamSid=${state.streamSid}, callSid=${state.callSid}, caller=${state.caller}`, {
      rid,
    });

    // Start silence hangup timer
    armSilenceTimer(state);

    // Connect OpenAI
    await connectOpenAiRealtime(state);

    // Play greeting immediately (via Eleven), without waiting for OpenAI response
    await speakNow(state, buildOpeningGreeting(), { reason: "opening_greeting" });

    // Also add that greeting into our log
    pushLog(state, "bot", buildOpeningGreeting());

    return;
  }

  if (msg.event === "media") {
    state.lastActivityAt = Date.now();
    armSilenceTimer(state);

    // If barge-in disabled and we're currently speaking, ignore user audio
    if (!MB_ALLOW_BARGE_IN && state.isSpeaking) return;

    // Forward to OpenAI input buffer (mulaw base64)
    if (state.openAiWs && state.openAiWs.readyState === WebSocket.OPEN) {
      state.openAiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        })
      );
    }
    return;
  }

  if (msg.event === "stop") {
    log("info", "Call", "Twilio stream stopped.", { rid });
    await safeEndCall(state, "twilio_stop");
    return;
  }

  // ignore mark/other
}

async function connectOpenAiRealtime(state) {
  const { rid } = state;

  if (!OPENAI_API_KEY) {
    log("error", "OpenAI", "OPENAI_API_KEY missing - cannot connect", { rid });
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };

  const openAiWs = new WebSocket(url, { headers });
  state.openAiWs = openAiWs;

  openAiWs.on("open", () => {
    log("info", "Call", "Connected to OpenAI Realtime API.", { rid });

    // text-only output when using Eleven (so לא נקבל Alloy)
    const modalities = TTS_PROVIDER === "eleven" ? ["text"] : ["text", "audio"];

    const instructions = buildMasterPrompt();

    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities,
          instructions,
          // Incoming audio format from Twilio Media Streams is G.711 mu-law (8k)
          input_audio_format: "g711_ulaw",
          // For fallback alloy audio (if we ever switch), keep output format aligned too
          output_audio_format: "g711_ulaw",
          // Use server-side VAD for turn detection
          turn_detection: {
            type: "server_vad",
            threshold: MB_VAD_THRESHOLD,
            prefix_padding_ms: MB_VAD_PREFIX_MS,
            silence_duration_ms: MB_VAD_SILENCE_MS,
          },
          // Built-in transcription (we keep it even if output is text-only)
          input_audio_transcription: { model: "whisper-1" },
        },
      })
    );

    state.openAiReady = true;
  });

  openAiWs.on("message", async (data) => {
    let evt;
    try {
      evt = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    // Helpful debug (enable LOG_LEVEL=debug)
    if (evt?.type && shouldLog("debug")) log("debug", "OpenAI", `event=${evt.type}`, { rid });

    // 1) Transcription events (user text)
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = (evt.transcript || "").trim();
      if (text) {
        state.lastUserText = text;
        pushLog(state, "user", text);
        log("info", "User", text, { rid });
      }
      return;
    }

    // Some models send this:
    if (evt.type === "input_audio_buffer.speech_stopped") {
      // Create response after user finished speaking
      await createModelResponse(state);
      return;
    }

    // 2) Text output deltas
    if (evt.type === "response.output_text.delta") {
      state._textBuf = (state._textBuf || "") + (evt.delta || "");
      return;
    }

    if (evt.type === "response.output_text.done") {
      const finalText = (state._textBuf || "").trim();
      state._textBuf = "";

      if (finalText) {
        log("info", "Bot", finalText, { rid });
        pushLog(state, "bot", finalText);
        await speakNow(state, finalText, { reason: "model_response" });
      }
      return;
    }

    // 3) If we ever fallback to OpenAI audio, handle audio deltas
    if (evt.type === "response.audio.delta") {
      if (!evt.delta) return;
      const audioBytes = Buffer.from(evt.delta, "base64");
      state.sender.enqueue(audioBytes);
      state.hadAnyAudio = true;
      return;
    }

    // 4) Errors
    if (evt.type === "error") {
      log("error", "OpenAI", "OpenAI error event", { rid, evt });
    }
  });

  openAiWs.on("close", () => {
    log("info", "Call", "OpenAI WS closed.", { rid });
  });

  openAiWs.on("error", (err) => {
    log("error", "OpenAI", "OpenAI WS error", { rid, err: String(err) });
  });
}

async function createModelResponse(state) {
  const { rid } = state;
  if (!state.openAiWs || state.openAiWs.readyState !== WebSocket.OPEN) return;
  if (!state.openAiReady) return;

  // If no last user text (maybe noise), ask to repeat
  if (!state.lastUserText) {
    await speakNow(state, "לֹא שָׁמַעְנוּ טוֹב, אֶפְשָׁר לַחְזֹר עַל זֶה?", { reason: "no_user_text" });
    pushLog(state, "bot", "לא שמעתי טוב, אפשר לחזור על זה?");
    return;
  }

  // Ask model to respond succinctly
  state.openAiWs.send(
    JSON.stringify({
      type: "response.create",
      response: {
        // keep short -> reduces latency
        max_output_tokens: 220,
      },
    })
  );

  log("info", "Call", "response.create sent", { rid });
}

async function speakNow(state, text, meta = {}) {
  const { rid } = state;

  // Mark speaking to support barge-in logic
  state.isSpeaking = true;
  state.speakingSince = Date.now();

  try {
    if (TTS_PROVIDER === "eleven") {
      await elevenSpeakStreamToTwilio(state, text, meta);
    } else {
      // If not eleven, rely on OpenAI audio (Alloy) – optional
      await openAiSpeakFallback(state, text);
    }
  } catch (err) {
    log("error", "TTS", "speakNow failed", { rid, err: String(err) });

    // Hard fallback: switch to OpenAI audio once, to avoid silence
    if (!state.usedFallbackAlloy) {
      state.usedFallbackAlloy = true;
      log("warn", "TTS", "Falling back to OpenAI audio (Alloy) to avoid silence", { rid });
      await enableOpenAiAudioAndSpeak(state, text);
    }
  } finally {
    // End speaking after tail
    setTimeout(() => {
      state.isSpeaking = false;
    }, MB_NO_BARGE_TAIL_MS);
  }
}

// =========================
// ElevenLabs TTS (Streaming -> ulaw_8000) -> Twilio media frames
// =========================
async function elevenSpeakStreamToTwilio(state, text, meta = {}) {
  const { rid } = state;

  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY missing");
  if (!ELEVEN_VOICE_ID) throw new Error("VOICE_ID / ELEVEN_VOICE_ID missing");
  if (!text || !text.trim()) return;

  const modelId = ELEVEN_MODEL_ID;
  const format = ELEVEN_OUTPUT_FORMAT;

  // eleven_v3 DOES NOT support optimize_streaming_latency -> never send it.
  // If in future you change model to something else, you can re-enable by ENV if you want.
  const qs = new URLSearchParams();
  qs.set("output_format", format);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream?${qs.toString()}`;

  const body = {
    text,
    model_id: modelId,
    // Language override (if supported)
    language_code: ELEVEN_LANGUAGE,
    // v3 accepts stability values: 0.0 / 0.5 / 1.0
    voice_settings: {
      stability: ELEVEN_STABILITY,
      similarity_boost: ELEVEN_SIMILARITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: ELEVEN_USE_BOOST,
      // speed is supported in some endpoints; safe to include, ignored if unsupported
      speed: ELEVEN_SPEED,
    },
  };

  log("info", "ElevenTTS", "Sending text to ElevenLabs TTS.", {
    rid,
    length: text.length,
    model: modelId,
    language: ELEVEN_LANGUAGE,
    format,
    stability: ELEVEN_STABILITY,
    ...meta,
  });

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), ELEVEN_TIMEOUT_MS);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/*",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((e) => {
    clearTimeout(to);
    throw e;
  });

  clearTimeout(to);

  if (!res.ok) {
    const txt = await safeReadText(res);
    throw new Error(`ElevenLabs HTTP ${res.status} ${txt}`);
  }

  if (!res.body) throw new Error("ElevenLabs response body empty");

  // Stream audio bytes into Twilio sender queue as they arrive
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    state.sender.enqueue(buf);
    state.hadAnyAudio = true;
  }

  log("info", "ElevenTTS", `ElevenLabs TTS audio received total=${total} bytes`, { rid });
}

// Read text safely from response
async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// =========================
// OpenAI audio fallback helpers
// =========================
async function enableOpenAiAudioAndSpeak(state, text) {
  const { rid } = state;
  if (!state.openAiWs || state.openAiWs.readyState !== WebSocket.OPEN) throw new Error("OpenAI WS not open");

  // Enable audio modalities + alloy voice
  state.openAiWs.send(
    JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw",
      },
    })
  );

  // Create a one-off response with the exact text
  state.openAiWs.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `תקריאו בדיוק את הטקסט הבא: ${text}` }],
      },
    })
  );

  state.openAiWs.send(JSON.stringify({ type: "response.create", response: { max_output_tokens: 50 } }));

  log("warn", "OpenAI", "Enabled audio fallback (Alloy) and requested spoken output", { rid });
}

async function openAiSpeakFallback(state, text) {
  // Not used in our flow (we default to Eleven), but kept for completeness
  await enableOpenAiAudioAndSpeak(state, text);
}

// =========================
// End call + lead parsing + webhooks
// =========================
async function safeEndCall(state, reason) {
  if (state.ended) return;
  state.ended = true;

  const { rid } = state;
  log("info", "Call", `endCall called with reason="${reason}"`, { rid });

  clearTimeout(state.silenceTimer);
  clearTimeout(state.maxCallTimer);

  // Close OpenAI WS
  try {
    if (state.openAiWs && state.openAiWs.readyState === WebSocket.OPEN) {
      state.openAiWs.close();
    }
  } catch {}

  // Attempt to resolve caller from Twilio REST (optional)
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && state.callSid) {
    try {
      const caller = await fetchCallerNumberFromTwilio(state.callSid);
      if (caller) state.caller = caller;
      log("info", "Call", `fetchCallerNumberFromTwilio: resolved caller="${caller}" from Twilio Call resource.`, { rid });
    } catch (err) {
      log("warn", "Call", "fetchCallerNumberFromTwilio failed", { rid, err: String(err) });
    }
  }

  // Final logs
  log("info", "Call", "Final conversation log:", state.conversationLog);

  // Abandoned webhook if ended without lead and we had user speech
  const hadUser = state.conversationLog.some((x) => x.from === "user");
  if (MB_ABANDONED_WEBHOOK_URL && hadUser && !MAKE_WEBHOOK_URL) {
    // If you want always, remove !MAKE_WEBHOOK_URL condition
  }

  // Parse lead (simple heuristics)
  const parsed = parseLeadFromConversation(state);

  // Send lead webhook only if "full lead"
  if (MAKE_WEBHOOK_URL) {
    if (parsed.is_lead) {
      await sendJsonWebhook(MAKE_WEBHOOK_URL, {
        source: "blubinet-realtime",
        rid,
        callSid: state.callSid,
        caller_id: state.caller,
        ...parsed,
        conversation: state.conversationLog,
      });
      log("info", "Lead", "Lead webhook sent ✅", { rid });
    } else {
      log("info", "Lead", "Parsed lead is NOT full lead – webhook will NOT be sent.", {
        rid,
        is_lead: false,
        lead_type: parsed.lead_type,
        phone_number: parsed.phone_number || (state.caller ? normalizeIsraeliPhone(state.caller) : null),
      });
    }
  } else {
    log("info", "Call", "No parsed lead object – skipping webhook (לא ליד מלא).", { rid });
  }

  // Grace close Twilio WS
  state.graceTimer = setTimeout(() => {
    try {
      if (state.twilioWs && state.twilioWs.readyState === WebSocket.OPEN) state.twilioWs.close();
    } catch {}
  }, MB_HANGUP_GRACE_MS);
}

function parseLeadFromConversation(state) {
  // Very lightweight parsing; you can tighten this later
  const userTexts = state.conversationLog.filter((x) => x.from === "user").map((x) => x.text).join(" | ");
  const phoneInText = extractPhone(userTexts);
  const callerPhone = state.caller ? normalizeIsraeliPhone(state.caller) : null;

  // "Lead" only if user asked for service / details (simple keywords)
  const isServiceIntent = /(קריאת שירות|תקלה|מחיר|הצעה|מספר|מרכזייה|IVR|ניתוב|הקלטות|קו|סוכן|תמיכה|רוצה|צריכים)/.test(
    userTexts
  );

  const notes = userTexts ? userTexts.slice(0, 500) : "שיחה קצרה ללא טקסט ברור";
  const leadType = isServiceIntent ? "service_inquiry" : "unknown";

  // Decide "full lead"
  const phone = phoneInText || callerPhone;
  const isLead = Boolean(isServiceIntent && phone);

  return {
    is_lead: isLead,
    lead_type: leadType,
    full_name: null,
    business_name: BUSINESS_NAME,
    phone_number: phone,
    reason: isServiceIntent ? "פנייה לשירות/מידע" : null,
    notes,
  };
}

// =========================
// Twilio outgoing audio sender (ulaw 8k)
// sends 20ms frames (320 bytes) in real-time
// =========================
function createUlawSender({ twilioWs, rid }) {
  const FRAME_BYTES = 320; // 20ms of 8kHz u-law (1 byte/sample)
  const SILENCE_BYTE = 0xff;

  const queue = [];
  let timer = null;

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;

      if (queue.length === 0) {
        stop();
        return;
      }

      // Build one frame
      let frame = Buffer.alloc(FRAME_BYTES, SILENCE_BYTE);
      let offset = 0;

      while (offset < FRAME_BYTES && queue.length > 0) {
        const head = queue[0];
        const need = FRAME_BYTES - offset;
        const take = Math.min(need, head.length);

        head.copy(frame, offset, 0, take);
        offset += take;

        if (take === head.length) {
          queue.shift();
        } else {
          queue[0] = head.slice(take);
        }
      }

      const payload = frame.toString("base64");

      // Twilio expects streamSid; we attach it at send-time from outer scope if available
      // We'll patch on enqueue by setting sender.streamSid
      if (!sender.streamSid) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid: sender.streamSid,
          media: { payload },
        })
      );
    }, 20);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const sender = {
    streamSid: null,
    enqueue(buf) {
      if (!buf || !buf.length) return;
      queue.push(buf);
      start();
    },
    stop,
  };

  return sender;
}

// =========================
// Timers
// =========================
function armSilenceTimer(state) {
  clearTimeout(state.silenceTimer);
  state.silenceTimer = setTimeout(() => {
    safeEndCall(state, "silence_timeout").catch(() => {});
  }, MB_SILENCE_HANGUP_MS);
}

// =========================
// Prompt / Greeting
// =========================
function buildOpeningGreeting() {
  const tod = getTimeOfDayGreeting(TIME_ZONE);
  const suffix = OPENING_SUFFIX ? ` ${OPENING_SUFFIX}` : "";
  // Keep it short for speed
  return `${tod} הגעתם ל־${BUSINESS_NAME}.${suffix} שמי נטע, איך אפשר לעזור לכם היום?`.replace(/\s+/g, " ").trim();
}

function buildMasterPrompt() {
  // Based on your BluBinet definition
  return (
    `אתם נטע, נציגת שירות ומכירות וירטואלית של ${BUSINESS_NAME}. ` +
    `אתם מדברים בעברית כברירת מחדל, בלשון רבים, בטון חם, קצר ומדויק. ` +
    `אם מתקשרים ושואלים "מי אתם" או "מה אתם עושים" – עונים במשפט אחד–שניים: ` +
    `"אנחנו BluBinet, חברה שמספקת מרכזיות ענן ופתרונות טלפוניה חכמה לעסקים – עם ניתוב שיחות, IVR, מספרים וירטואליים והקלטות". ` +
    `אם מבקשים עוד פרטים – מוסיפים עוד משפט קצר בלבד. ` +
    `מטרת השיחה: להבין צורך, להסביר בקצרה, ולהציע המשך טיפול/יצירת קשר. ` +
    `אם לא שמעתם טוב – מבקשים לחזור. ` +
    `שומרים על תשובות קצרות כדי להפחית דיליי.`
  );
}

// =========================
// Helpers
// =========================
function pushLog(state, from, text) {
  state.conversationLog.push({ from, text });
}

function clamp01(x) {
  return clamp(0, 1, x);
}
function clamp(min, max, x) {
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function snapStability(x) {
  // Eleven v3 wants one of 0.0 / 0.5 / 1.0
  const candidates = [0.0, 0.5, 1.0];
  let best = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - x);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function extractPhone(s) {
  if (!s) return null;
  const m = s.replace(/[^\d+]/g, " ").match(/(\+972\d{9}|\b0\d{9}\b)/);
  return m ? normalizeIsraeliPhone(m[1]) : null;
}
function normalizeIsraeliPhone(p) {
  if (!p) return null;
  p = String(p).trim();
  if (p.startsWith("+972")) {
    const rest = p.slice(4);
    if (rest.startsWith("0")) return `0${rest.slice(1)}`;
    return `0${rest}`;
  }
  return p;
}

function getTimeOfDayGreeting(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value || "12");
    if (hour >= 5 && hour < 12) return "בוקר טוב,";
    if (hour >= 12 && hour < 17) return "צהריים טובים,";
    if (hour >= 17 && hour < 22) return "ערב טוב,";
    return "שלום,";
  } catch {
    return "שלום,";
  }
}

// =========================
// Twilio REST caller lookup
// =========================
async function fetchCallerNumberFromTwilio(callSid) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(
    callSid
  )}.json`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.from || null;
}

// =========================
// Webhook
// =========================
async function sendJsonWebhook(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await safeReadText(res);
    throw new Error(`Webhook HTTP ${res.status} ${t}`);
  }
}
