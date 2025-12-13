// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API
//
// תיקונים (2025-12-13):
// 1) מניעת response.create כפול (conversation_already_has_active_response)
// 2) לא להגיד "לא שמעתי טוב" מוקדם מדי — מחכים לתמלול שיגיע
// 3) cancel לתשובה פעילה אם המשתמש מתחיל לדבר באמצע
// 4) שיפור דיליי ע"י debounce תזמון תגובה אחרי תמלול/סוף דיבור
//
// Twilio Voice Webhook ->  POST /twilio-voice  (TwiML)
// Twilio Media Streams -> wss://<domain>/twilio-media-stream

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
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || process.env.VOICE_ID || "";
const ELEVEN_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID || process.env.ELEVEN_TTS_MODEL || "eleven_v3").trim();
const ELEVEN_OUTPUT_FORMAT =
  (process.env.ELEVENLABS_OUTPUT_FORMAT || process.env.ELEVEN_OUTPUT_FORMAT || "ulaw_8000").trim();
const ELEVEN_LANGUAGE = (process.env.ELEVENLABS_LANGUAGE || process.env.ELEVEN_LANGUAGE || "he").trim();
const ELEVEN_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS || 4500);

const ELEVEN_STYLE = clamp01(Number(process.env.ELEVENLABS_STYLE || 0.15));
const ELEVEN_USE_BOOST = String(process.env.ELEVENLABS_USE_BOOST || "1") === "1";
const ELEVEN_STABILITY = snapStability(Number(process.env.ELEVENLABS_STABILITY || 0.5));
const ELEVEN_SIMILARITY = clamp01(Number(process.env.ELEVENLABS_SIMILARITY || 0.8));
const ELEVEN_SPEED = clamp(0.8, 1.1, Number(process.env.ELEVENLABS_SPEED || process.env.MB_SPEECH_SPEED || 1.0));

const MB_ALLOW_BARGE_IN = String(process.env.MB_ALLOW_BARGE_IN || "true") === "true";
const MB_NO_BARGE_TAIL_MS = Number(process.env.MB_NO_BARGE_TAIL_MS || 700);

// כדי להוריד latency — דיפולטים יותר אגרסיביים (עדיין אפשר לשלוט ב-ENV)
const MB_VAD_THRESHOLD = clamp(0.1, 0.9, Number(process.env.MB_VAD_THRESHOLD || 0.55));
const MB_VAD_PREFIX_MS = Number(process.env.MB_VAD_PREFIX_MS || 180);
const MB_VAD_SILENCE_MS = Number(process.env.MB_VAD_SILENCE_MS || 360);

const MB_MAX_CALL_MS = Number(process.env.MB_MAX_CALL_MS || 8 * 60 * 1000);
const MB_SILENCE_HANGUP_MS = Number(process.env.MB_SILENCE_HANGUP_MS || 20 * 1000);
const MB_HANGUP_GRACE_MS = Number(process.env.MB_HANGUP_GRACE_MS || 3000);

// תזמוני “אל תמהר להגיד לא שמעתי טוב”
const MB_TRANSCRIPT_GRACE_MS = Number(process.env.MB_TRANSCRIPT_GRACE_MS || 900); // לחכות לתמלול
const MB_RESPONSE_DEBOUNCE_MS = Number(process.env.MB_RESPONSE_DEBOUNCE_MS || 220); // תגובה מהירה אחרי תמלול

const BUSINESS_NAME = process.env.BUSINESS_NAME || "BluBinet";
const OPENING_SUFFIX = process.env.OPENING_SUFFIX || "";
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Jerusalem";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";

log("info", "CONFIG", `MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS} ms`);
log("info", "CONFIG", `VAD threshold=${MB_VAD_THRESHOLD}, prefix=${MB_VAD_PREFIX_MS}, silence=${MB_VAD_SILENCE_MS}`);
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

wss.on("connection", (ws) => {
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

  state.maxCallTimer = setTimeout(() => {
    safeEndCall(state, "max_call_timeout").catch(() => {});
  }, MB_MAX_CALL_MS);
});

server.listen(PORT, () => {
  log("info", "Startup", `✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
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

    sender: createUlawSender({ twilioWs: ws, rid }),

    conversationLog: [],
    lastUserText: null,
    lastTranscriptAt: 0,

    responseInFlight: false,
    pendingResponseTimer: null,
    pendingNoUserTimer: null,

    silenceTimer: null,
    maxCallTimer: null,
    graceTimer: null,

    isSpeaking: false,
    hadAnyAudio: false,
    ended: false,
    usedFallbackAlloy: false,

    _textBuf: "",
  };
}

async function handleTwilioMessage(state, msg) {
  const { rid } = state;

  if (msg.event === "start") {
    state.streamSid = msg.start.streamSid;
    state.callSid = msg.start.callSid;
    state.caller = msg.start.customParameters?.caller || null;

    // קריטי: להצמיד streamSid ל-sender כדי שייצא קול
    state.sender.streamSid = state.streamSid;
    log("info", "AudioSender", "Bound sender.streamSid", { rid, streamSid: state.streamSid });

    log(
      "info",
      "Call",
      `Twilio stream started. streamSid=${state.streamSid}, callSid=${state.callSid}, caller=${state.caller}`,
      { rid }
    );

    armSilenceTimer(state);

    // Connect OpenAI (במקביל)
    connectOpenAiRealtime(state).catch((e) => {
      log("error", "OpenAI", "connectOpenAiRealtime failed", { rid, err: String(e) });
    });

    // Greeting מיידי דרך Eleven
    const opening = buildOpeningGreeting();
    await speakNow(state, opening, { reason: "opening_greeting" });
    pushLog(state, "bot", opening);

    return;
  }

  if (msg.event === "media") {
    armSilenceTimer(state);

    // barge-in: אם המשתמש מתחיל לדבר בזמן שהבוט דיבר — נבטל תשובה פעילה
    if (state.openAiWs && state.openAiWs.readyState === WebSocket.OPEN) {
      state.openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
    return;
  }

  if (msg.event === "stop") {
    log("info", "Call", "Twilio stream stopped.", { rid });
    await safeEndCall(state, "twilio_stop");
    return;
  }
}

async function connectOpenAiRealtime(state) {
  const { rid } = state;

  if (!OPENAI_API_KEY) {
    log("error", "OpenAI", "OPENAI_API_KEY missing - cannot connect", { rid });
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" };

  const openAiWs = new WebSocket(url, { headers });
  state.openAiWs = openAiWs;

  openAiWs.on("open", () => {
    log("info", "Call", "Connected to OpenAI Realtime API.", { rid });

    // אנחנו עושים TTS חיצוני (Eleven) => text-only
    const modalities = ["text"];
    const instructions = buildMasterPrompt();

    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities,
          instructions,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
            threshold: MB_VAD_THRESHOLD,
            prefix_padding_ms: MB_VAD_PREFIX_MS,
            silence_duration_ms: MB_VAD_SILENCE_MS,
          },
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

    if (evt?.type && shouldLog("debug")) log("debug", "OpenAI", `event=${evt.type}`, { rid });

    // המשתמש התחיל לדבר — אם יש תשובה פעילה, נבטל כדי לא להיתקע
    if (evt.type === "input_audio_buffer.speech_started") {
      if (state.responseInFlight) {
        log("warn", "OpenAI", "User started speaking while response in flight -> response.cancel", { rid });
        try {
          state.openAiWs.send(JSON.stringify({ type: "response.cancel" }));
        } catch {}
      }
      return;
    }

    // תמלול הושלם
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = (evt.transcript || "").trim();
      if (text) {
        state.lastUserText = text;
        state.lastTranscriptAt = Date.now();
        pushLog(state, "user", text);
        log("info", "User", text, { rid });

        // אם היה טיימר של "אין תמלול" — מבטלים אותו
        if (state.pendingNoUserTimer) {
          clearTimeout(state.pendingNoUserTimer);
          state.pendingNoUserTimer = null;
        }

        // מתזמנים תגובה מהר (debounce)
        scheduleResponse(state, "transcript_completed");
      }
      return;
    }

    // סוף דיבור לפי VAD
    if (evt.type === "input_audio_buffer.speech_stopped") {
      // מחכים טיפה לתמלול שיגיע לפני “לא שמעתי טוב”
      if (state.pendingNoUserTimer) clearTimeout(state.pendingNoUserTimer);

      state.pendingNoUserTimer = setTimeout(async () => {
        state.pendingNoUserTimer = null;

        const recentlyTranscribed = Date.now() - (state.lastTranscriptAt || 0) < MB_TRANSCRIPT_GRACE_MS;
        if (recentlyTranscribed) {
          scheduleResponse(state, "speech_stopped_recent_transcript");
          return;
        }

        // אם באמת אין תמלול — רק אז "לא שמעתי טוב"
        const t = "לֹא שָׁמַעְנוּ טוֹב, אֶפְשָׁר לַחְזֹר עַל זֶה?";
        await speakNow(state, t, { reason: "no_user_text" });
        pushLog(state, "bot", "לא שמעתי טוב, אפשר לחזור על זה?");
      }, MB_TRANSCRIPT_GRACE_MS);

      // בנוסף — אם כבר יש lastUserText טרי, נשלח תגובה מהר
      const isFresh = Date.now() - (state.lastTranscriptAt || 0) < 1500;
      if (isFresh) scheduleResponse(state, "speech_stopped_fresh");
      return;
    }

    // ניהול מצב "יש תשובה פעילה"
    if (evt.type === "response.created") {
      state.responseInFlight = true;
      return;
    }
    if (evt.type === "response.done") {
      state.responseInFlight = false;
      return;
    }

    // טקסט תשובה
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

    if (evt.type === "error") {
      log("error", "OpenAI", "OpenAI error event", { rid, evt });
      // אם זה השגיאה שראית — פשוט נוריד דגל כדי שהמערכת תוכל להתאושש
      if (evt?.error?.code === "conversation_already_has_active_response") {
        state.responseInFlight = true; // נשאיר true עד response.done / או עד reset
      }
    }
  });

  openAiWs.on("close", () => log("info", "Call", "OpenAI WS closed.", { rid }));
  openAiWs.on("error", (err) => log("error", "OpenAI", "OpenAI WS error", { rid, err: String(err) }));
}

function scheduleResponse(state, reason) {
  if (!state.openAiWs || state.openAiWs.readyState !== WebSocket.OPEN) return;
  if (!state.openAiReady) return;

  if (state.pendingResponseTimer) clearTimeout(state.pendingResponseTimer);

  state.pendingResponseTimer = setTimeout(() => {
    state.pendingResponseTimer = null;
    createModelResponse(state, reason).catch(() => {});
  }, MB_RESPONSE_DEBOUNCE_MS);
}

async function createModelResponse(state, reason) {
  const { rid } = state;

  if (!state.openAiWs || state.openAiWs.readyState !== WebSocket.OPEN) return;
  if (!state.openAiReady) return;

  // ✅ Gate: לא שולחים response.create אם כבר יש תשובה פעילה
  if (state.responseInFlight) {
    log("warn", "Call", "Skip response.create (response already in flight)", { rid, reason });
    return;
  }

  // חייב להיות לנו טקסט משתמש
  if (!state.lastUserText) {
    log("warn", "Call", "No lastUserText at createModelResponse — skipping", { rid, reason });
    return;
  }

  state.openAiWs.send(JSON.stringify({ type: "response.create", response: { max_output_tokens: 220 } }));
  state.responseInFlight = true;
  log("info", "Call", "response.create sent", { rid, reason });
}

async function speakNow(state, text, meta = {}) {
  const { rid } = state;
  state.isSpeaking = true;

  try {
    if (TTS_PROVIDER === "eleven") {
      await elevenSpeakStreamToTwilio(state, text, meta);
    } else {
      await openAiFallbackSpeak(state, text);
    }
  } catch (err) {
    log("error", "TTS", "speakNow failed", { rid, err: String(err) });

    if (!state.usedFallbackAlloy) {
      state.usedFallbackAlloy = true;
      log("warn", "TTS", "Falling back to OpenAI audio (Alloy) to avoid silence", { rid });
      await openAiFallbackSpeak(state, text);
    }
  } finally {
    setTimeout(() => {
      state.isSpeaking = false;
    }, MB_NO_BARGE_TAIL_MS);
  }
}

async function elevenSpeakStreamToTwilio(state, text, meta = {}) {
  const { rid } = state;

  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY missing");
  if (!ELEVEN_VOICE_ID) throw new Error("VOICE_ID / ELEVEN_VOICE_ID missing");
  if (!text || !text.trim()) return;

  const modelId = ELEVEN_MODEL_ID;
  const format = ELEVEN_OUTPUT_FORMAT;

  const qs = new URLSearchParams();
  qs.set("output_format", format);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    ELEVEN_VOICE_ID
  )}/stream?${qs.toString()}`;

  const body = {
    text,
    model_id: modelId,
    language_code: ELEVEN_LANGUAGE,
    voice_settings: {
      stability: ELEVEN_STABILITY,
      similarity_boost: ELEVEN_SIMILARITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: ELEVEN_USE_BOOST,
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
  }).finally(() => clearTimeout(to));

  if (!res.ok) {
    const txt = await safeReadText(res);
    throw new Error(`ElevenLabs HTTP ${res.status} ${txt}`);
  }
  if (!res.body) throw new Error("ElevenLabs response body empty");

  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    state.sender.enqueue(buf);
    state.hadAnyAudio = true;
  }

  log("info", "ElevenTTS", `ElevenLabs TTS audio received total=${total} bytes`, { rid });
}

// fallback אמיתי בלבד (אם Eleven נכשל)
async function openAiFallbackSpeak(state, text) {
  const { rid } = state;
  if (!state.openAiWs || state.openAiWs.readyState !== WebSocket.OPEN) throw new Error("OpenAI WS not open");

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

  state.openAiWs.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `תקריאו בדיוק את הטקסט הבא: ${text}` }] },
    })
  );

  state.openAiWs.send(JSON.stringify({ type: "response.create", response: { max_output_tokens: 80 } }));
  log("warn", "OpenAI", "Fallback audio requested (Alloy)", { rid });
}

async function safeEndCall(state, reason) {
  if (state.ended) return;
  state.ended = true;

  const { rid } = state;
  log("info", "Call", `endCall called with reason="${reason}"`, { rid });

  clearTimeout(state.silenceTimer);
  clearTimeout(state.maxCallTimer);
  if (state.pendingResponseTimer) clearTimeout(state.pendingResponseTimer);
  if (state.pendingNoUserTimer) clearTimeout(state.pendingNoUserTimer);

  try {
    if (state.openAiWs && state.openAiWs.readyState === WebSocket.OPEN) state.openAiWs.close();
  } catch {}

  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && state.callSid) {
    try {
      const caller = await fetchCallerNumberFromTwilio(state.callSid);
      if (caller) state.caller = caller;
      log("info", "Call", `fetchCallerNumberFromTwilio: resolved caller="${caller}" from Twilio Call resource.`, { rid });
    } catch (err) {
      log("warn", "Call", "fetchCallerNumberFromTwilio failed", { rid, err: String(err) });
    }
  }

  log("info", "Call", "Final conversation log:", state.conversationLog);

  if (!MAKE_WEBHOOK_URL) {
    log("info", "Call", "No parsed lead object – skipping webhook (לא ליד מלא).", { rid });
  }

  state.graceTimer = setTimeout(() => {
    try {
      if (state.twilioWs && state.twilioWs.readyState === WebSocket.OPEN) state.twilioWs.close();
    } catch {}
  }, MB_HANGUP_GRACE_MS);
}

// =========================
// Twilio outgoing audio sender (ulaw 8k) 20ms frames
// =========================
function createUlawSender({ twilioWs, rid }) {
  const FRAME_BYTES = 320; // 20ms
  const SILENCE_BYTE = 0xff;

  const queue = [];
  let timer = null;

  const sender = {
    streamSid: null,
    enqueue(buf) {
      if (!buf || !buf.length) return;
      queue.push(buf);
      start();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;

      if (!sender.streamSid) {
        log("warn", "AudioSender", "Cannot send audio: sender.streamSid is not set yet", { rid });
        return;
      }

      if (queue.length === 0) {
        sender.stop();
        return;
      }

      let frame = Buffer.alloc(FRAME_BYTES, SILENCE_BYTE);
      let offset = 0;

      while (offset < FRAME_BYTES && queue.length > 0) {
        const head = queue[0];
        const need = FRAME_BYTES - offset;
        const take = Math.min(need, head.length);

        head.copy(frame, offset, 0, take);
        offset += take;

        if (take === head.length) queue.shift();
        else queue[0] = head.slice(take);
      }

      const payload = frame.toString("base64");

      try {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: sender.streamSid,
            media: { payload },
          })
        );
        if (shouldLog("debug")) log("debug", "AudioSender", "Sent media frame (20ms)", { rid, bytes: FRAME_BYTES });
      } catch (e) {
        log("error", "AudioSender", "Failed sending media frame", { rid, err: String(e) });
      }
    }, 20);
  }

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
  return `${tod} הגעתם ל־${BUSINESS_NAME}.${suffix} שמי נטע, איך אפשר לעזור לכם היום?`.replace(/\s+/g, " ").trim();
}

function buildMasterPrompt() {
  return (
    `אתם נטע, נציגת שירות ומכירות וירטואלית של ${BUSINESS_NAME}. ` +
    `אתם מדברים בעברית כברירת מחדל, בלשון רבים, בטון חם, קצר ומדויק. ` +
    `אם מתקשרים ושואלים "מי אתם" או "מה אתם עושים" – עונים במשפט אחד–שניים: ` +
    `"אנחנו BluBinet, חברה שמספקת מרכזיות ענן ופתרונות טלפוניה חכמה לעסקים – עם ניתוב שיחות, IVR, מספרים וירטואליים והקלטות". ` +
    `אם מבקשים עוד פרטים – מוסיפים עוד משפט קצר בלבד. ` +
    `מטרת השיחה: להבין צורך, להסביר בקצרה, ולהציע המשך טיפול/יצירת קשר. ` +
    `אם לא שמעתם טוב – מבקשים לחזור, אבל לא למהר לפני שהתמלול מגיע. ` +
    `שומרים על תשובות קצרות כדי להפחית דיליי.`
  );
}

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

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
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

  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.from || null;
}
