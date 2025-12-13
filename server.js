// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime (transcription only)
// LLM: IVRIT (optional via IVRIT_LLM_URL) -> fallback OpenAI Responses API
// TTS: ElevenLabs -> streamed to Twilio as ulaw_8000, 20ms frames
//
// Key fixes:
// ✅ Twilio "clear" BEFORE EVERY TTS segment (opening/ack/reply/chunks) to prevent static/noise
// ✅ Clear sender queue BEFORE EVERY TTS segment (avoid overlap / stale frames)
// ✅ Optional prebuffer to reduce jitter
// ✅ Chunking support (optional) to reduce long TTS wait
// ✅ Strong logging, request-id per call
// ✅ Proper cleanup of intervals/timeouts (no logs running after call ends)
//
// Requirements:
//   npm install express ws dotenv
//   Node 18+ (global fetch)
//
// Twilio Voice Webhook -> POST /twilio-voice (TwiML)
// Twilio Media Streams -> wss://<domain>/twilio-media-stream

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const raw = String(process.env[name] || '').toLowerCase().trim();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
function envStr(name, def = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null || raw === '' ? def : String(raw);
}
function rid() {
  return crypto.randomBytes(4).toString('hex');
}

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const DOMAIN = envStr('DOMAIN', '');
const MB_TWILIO_STREAM_URL = envStr('MB_TWILIO_STREAM_URL', '');

const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
const OPENAI_REALTIME_MODEL = envStr('OPENAI_REALTIME_MODEL', 'gpt-4o-realtime-preview-2024-12-17');

// LLM (fallback chain)
const IVRIT_LLM_URL = envStr('IVRIT_LLM_URL', ''); // expects JSON -> {text:"..."}
const OPENAI_LLM_MODEL = envStr('OPENAI_LLM_MODEL', 'gpt-4o-mini');

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'צהריים טובים, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);

const MB_CLOSING_SCRIPT = envStr(
  'MB_CLOSING_SCRIPT',
  'תודה שדיברתם עם BluBinet. נציג יחזור אליכם בהקדם. יום נעים!'
);

const MB_ACK_ENABLED = envBool('MB_ACK_ENABLED', true);
const MB_ACK_TEXT = envStr('MB_ACK_TEXT', 'מעולה, רגע...');

const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');

const MB_LANGUAGES = envStr('MB_LANGUAGES', 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// VAD
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.75);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 700);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 150);

// Idle / duration
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 120000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 10 * 60 * 1000);

// Barge-in control (for INPUT audio to transcription)
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// Twilio credentials (optional hangup)
const TWILIO_ACCOUNT_SID = envStr('TWILIO_ACCOUNT_SID', '');
const TWILIO_AUTH_TOKEN = envStr('TWILIO_AUTH_TOKEN', '');

// Logging
const MB_LOG_LEVEL = envStr('MB_LOG_LEVEL', 'info').toLowerCase(); // debug|info|warn|error

// -----------------------------
// ElevenLabs TTS config
// -----------------------------
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase();

const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', envStr('ELEVENLABS_API_KEY', ''));
const ELEVEN_VOICE_ID = envStr('ELEVEN_VOICE_ID', envStr('VOICE_ID', '')); // you have VOICE_ID
const ELEVEN_MODEL = envStr('ELEVEN_TTS_MODEL', 'eleven_v3');
const ELEVEN_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', envStr('ELEVEN_LANGUAGE', 'he'));
const ELEVEN_OUTPUT_FORMAT = envStr('ELEVEN_OUTPUT_FORMAT', 'ulaw_8000');

// IMPORTANT: Eleven v3 does NOT support optimize_streaming_latency.
const ELEVEN_OPTIMIZE_STREAMING_LATENCY = envNumber('ELEVEN_OPTIMIZE_STREAMING_LATENCY', 3);
const ELEVEN_ENABLE_OPT_LATENCY = envBool('ELEVEN_ENABLE_OPT_LATENCY', true);

// voice settings
const ELEVEN_STABILITY = envNumber('ELEVEN_STABILITY', 0.5);
const ELEVEN_SIMILARITY = envNumber('ELEVEN_SIMILARITY', 0.75);
const ELEVEN_STYLE = envNumber('ELEVEN_STYLE', 0.0);
const ELEVEN_SPEAKER_BOOST = envBool('ELEVEN_SPEAKER_BOOST', true);

// Cached opening
const MB_CACHE_OPENING_AUDIO = envBool('MB_CACHE_OPENING_AUDIO', true);

// Chunking
const MB_ENABLE_CHUNKING = envBool('MB_ENABLE_CHUNKING', true);
const MB_CHUNK_MAX_CHARS = envNumber('MB_CHUNK_MAX_CHARS', 60);

// Audio pacing/jitter
const MB_PREBUFFER_MS = envNumber('MB_PREBUFFER_MS', 200); // 0 to disable (recommended 200ms)
const MB_SEND_SILENCE_TAIL_MS = envNumber('MB_SEND_SILENCE_TAIL_MS', 120); // add short silence tail after each TTS

// -----------------------------
// Guardrails
// -----------------------------
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');
if (TTS_PROVIDER === 'eleven') {
  if (!ELEVEN_API_KEY) console.error('❌ Missing ELEVEN_API_KEY (or ELEVENLABS_API_KEY) in ENV.');
  if (!ELEVEN_VOICE_ID) console.error('❌ Missing VOICE_ID (or ELEVEN_VOICE_ID) in ENV.');
}

console.log(`[CONFIG] PORT=${PORT}`);
console.log(`[CONFIG] REALTIME_MODEL=${OPENAI_REALTIME_MODEL}`);
console.log(`[CONFIG] LLM: IVRIT_LLM_URL=${IVRIT_LLM_URL ? 'SET' : 'NOT_SET'} fallback OpenAI=${OPENAI_LLM_MODEL}`);
console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}`);
console.log(`[CONFIG] VAD threshold=${MB_VAD_THRESHOLD} silence_ms=${MB_VAD_SILENCE_MS} prefix_ms=${MB_VAD_PREFIX_MS}`);
console.log(`[CONFIG] TTS_PROVIDER=${TTS_PROVIDER}`);
console.log(`[CONFIG] ELEVEN voice_id=${ELEVEN_VOICE_ID ? 'SET' : 'NOT_SET'} model=${ELEVEN_MODEL} lang=${ELEVEN_LANGUAGE} fmt=${ELEVEN_OUTPUT_FORMAT} optLatency=${ELEVEN_OPTIMIZE_STREAMING_LATENCY}`);
console.log(`[CONFIG] MB_CACHE_OPENING_AUDIO=${MB_CACHE_OPENING_AUDIO}`);
console.log(`[CONFIG] Chunking=${MB_ENABLE_CHUNKING} maxChars=${MB_CHUNK_MAX_CHARS}`);
console.log(`[CONFIG] PrebufferMs=${MB_PREBUFFER_MS}, SilenceTailMs=${MB_SEND_SILENCE_TAIL_MS}`);
console.log(`[CONFIG] MB_LANGUAGES=${MB_LANGUAGES.join(',')}`);

// -----------------------------
// Logging helpers
// -----------------------------
function rank(lvl) {
  if (lvl === 'debug') return 10;
  if (lvl === 'info') return 20;
  if (lvl === 'warn') return 30;
  if (lvl === 'error') return 40;
  return 20;
}
const CUR = rank(MB_LOG_LEVEL);

function log(lvl, tag, msg, extra, meta = {}) {
  if (rank(lvl) < CUR) return;
  const ts = new Date().toISOString();
  const ridPart = meta && meta.rid ? ` { rid: '${meta.rid}' }` : '';
  if (extra !== undefined) console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`, extra);
  else console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`);
}
const logDebug = (tag, msg, extra, meta) => log('debug', tag, msg, extra, meta);
const logInfo  = (tag, msg, extra, meta) => log('info',  tag, msg, extra, meta);
const logWarn  = (tag, msg, extra, meta) => log('warn',  tag, msg, extra, meta);
const logError = (tag, msg, extra, meta) => log('error', tag, msg, extra, meta);

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection', err);
});

// -----------------------------
// System instructions
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1) דברו בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
2) אל תתייחסי לרעש/איכות קו. אם לא הבנת: "לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?"
3) תשובות קצרות 1–3 משפטים, וסיימי בשאלה שמקדמת הבנה/איסוף צורך.
4) אל תסיימי שיחה מיוזמתך.
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const kb = (MB_BUSINESS_PROMPT || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (kb) instructions += (instructions ? '\n\n' : '') + kb;

  if (!instructions) {
    instructions = `
אתם עוזר קולי בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
דברו בעברית כברירת מחדל, תשובות קצרות ומקצועיות.
`.trim();
  }

  return instructions + '\n\n' + EXTRA_BEHAVIOR_RULES;
}

// -----------------------------
// Twilio CLEAR helper (CRITICAL)
// -----------------------------
function sendTwilioClear(connection, streamSid, meta) {
  if (!streamSid) return;
  try {
    connection.send(JSON.stringify({ event: 'clear', streamSid }));
    logInfo('AudioSender', 'Sent Twilio clear event', undefined, meta);
  } catch (e) {
    logWarn('AudioSender', 'Failed to send Twilio clear', e, meta);
  }
}

// -----------------------------
// Audio sender: Twilio expects 20ms frames at 8k ulaw = 160 bytes
// Optional prebuffer to reduce jitter
// -----------------------------
function createAudioSender(connection, meta) {
  const state = {
    streamSid: null,
    timer: null,
    queue: [],
    started: false,
    prebufferBytes: Math.max(0, Math.floor((MB_PREBUFFER_MS / 20) * 160)),
  };

  function bindStreamSid(streamSid) {
    state.streamSid = streamSid;
    logInfo('AudioSender', 'Bound sender.streamSid', { streamSid }, meta);
    start();
  }

  function enqueue(buf) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return;
    state.queue.push(buf);

    if (!state.started && state.prebufferBytes > 0) {
      const queuedBytes = state.queue.reduce((s, b) => s + b.length, 0);
      if (queuedBytes >= state.prebufferBytes) {
        state.started = true;
        logInfo('AudioSender', 'Prebuffer satisfied -> start sending', { prebufferBytes: state.prebufferBytes }, meta);
      }
    } else if (state.prebufferBytes === 0) {
      state.started = true;
    }
  }

  function clearQueue() {
    state.queue = [];
    state.started = (state.prebufferBytes === 0);
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (!state.streamSid) return;
      if (connection.readyState !== WebSocket.OPEN) return;
      if (state.queue.length === 0) return;
      if (!state.started) return;

      const frameSize = 160; // 20ms @ 8k ulaw
      let cur = state.queue[0];

      if (cur.length <= frameSize) {
        state.queue.shift();
        sendFrame(cur);
      } else {
        const frame = cur.subarray(0, frameSize);
        state.queue[0] = cur.subarray(frameSize);
        sendFrame(frame);
      }
    }, 20);
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.queue = [];
    state.started = false;
  }

  function sendFrame(frameBuf) {
    try {
      const payloadB64 = frameBuf.toString('base64');
      const msg = { event: 'media', streamSid: state.streamSid, media: { payload: payloadB64 } };
      connection.send(JSON.stringify(msg));
    } catch (e) {
      logError('AudioSender', 'Failed sending frame', e, meta);
    }
  }

  function sendSilenceTail(ms) {
    const m = Math.max(0, ms | 0);
    if (m <= 0) return;
    // ulaw "silence" is 0xFF commonly; Twilio tolerates it.
    const frames = Math.ceil(m / 20);
    const buf = Buffer.alloc(frames * 160, 0xFF);
    enqueue(buf);
  }

  return {
    bindStreamSid,
    enqueue,
    stop,
    clearQueue,
    sendSilenceTail,
    get streamSid() { return state.streamSid; },
  };
}

// -----------------------------
// ElevenLabs URL builder (handles v3 restriction)
// -----------------------------
function buildElevenUrl() {
  // Use /stream endpoint (works well for low-latency)
  const baseUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream`;
  const qs = new URLSearchParams({
    output_format: ELEVEN_OUTPUT_FORMAT,
    language: ELEVEN_LANGUAGE,
  });

  const isV3 = String(ELEVEN_MODEL).toLowerCase() === 'eleven_v3';
  const shouldAddOpt =
    ELEVEN_ENABLE_OPT_LATENCY &&
    !isV3 &&
    Number.isFinite(ELEVEN_OPTIMIZE_STREAMING_LATENCY) &&
    ELEVEN_OPTIMIZE_STREAMING_LATENCY > 0;

  if (shouldAddOpt) qs.set('optimize_streaming_latency', String(ELEVEN_OPTIMIZE_STREAMING_LATENCY));

  return `${baseUrl}?${qs.toString()}`;
}

// -----------------------------
// ElevenLabs streaming TTS -> push to AudioSender as chunks arrive
// NOTE: caller must do Twilio CLEAR + sender.clearQueue BEFORE calling this
// -----------------------------
async function elevenTtsStreamToSender(text, reason, sender, meta) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    logError('ElevenTTS', 'Missing ELEVEN_API_KEY or VOICE_ID', undefined, meta);
    return { ok: false };
  }
  const cleaned = String(text || '').trim();
  if (!cleaned) return { ok: false };

  const url = buildElevenUrl();

  const body = {
    text: cleaned,
    model_id: ELEVEN_MODEL,
    voice_settings: {
      stability: ELEVEN_STABILITY,
      similarity_boost: ELEVEN_SIMILARITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: ELEVEN_SPEAKER_BOOST
    }
  };

  const t0 = Date.now();
  let firstByteMs = null;
  let total = 0;

  logInfo('ElevenTTS', 'TTS request', {
    reason,
    length: cleaned.length,
    model: ELEVEN_MODEL,
    lang: ELEVEN_LANGUAGE,
    fmt: ELEVEN_OUTPUT_FORMAT,
    url_has_opt_latency: url.includes('optimize_streaming_latency'),
  }, meta);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/*',
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError('ElevenTTS', `HTTP ${res.status}`, txt, meta);
      return { ok: false };
    }

    const ct = res.headers.get('content-type') || '';
    logInfo('ElevenTTS', 'Response headers', { contentType: ct }, meta);

    if (!res.body) {
      const arr = await res.arrayBuffer();
      const buf = Buffer.from(arr);
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      total += buf.length;
      sender.enqueue(buf);
      const totalMs = Date.now() - t0;
      logInfo('ElevenTTS', 'TTS done (buffered)', { firstByteMs, totalMs, bytes: total }, meta);
      return { ok: true, firstByteMs, totalMs, bytes: total };
    }

    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        if (firstByteMs === null) firstByteMs = Date.now() - t0;
        const buf = Buffer.from(value);
        total += buf.length;
        sender.enqueue(buf);
      }
    }

    const totalMs = Date.now() - t0;
    logInfo('ElevenTTS', 'TTS done', { firstByteMs, totalMs, bytes: total }, meta);
    return { ok: true, firstByteMs, totalMs, bytes: total };
  } catch (e) {
    logError('ElevenTTS', 'Streaming error', e, meta);
    return { ok: false };
  }
}

// -----------------------------
// Cached opening audio (generated once at startup)
// -----------------------------
let OPENING_AUDIO_CACHE = null; // Buffer in ulaw_8000
async function warmupOpeningCache() {
  if (!MB_CACHE_OPENING_AUDIO) return;
  if (TTS_PROVIDER !== 'eleven') return;
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) return;

  try {
    const url = buildElevenUrl();
    const body = {
      text: String(MB_OPENING_SCRIPT || '').trim(),
      model_id: ELEVEN_MODEL,
      voice_settings: {
        stability: ELEVEN_STABILITY,
        similarity_boost: ELEVEN_SIMILARITY,
        style: ELEVEN_STYLE,
        use_speaker_boost: ELEVEN_SPEAKER_BOOST
      }
    };

    logInfo('Startup', 'Warming opening audio cache with ElevenLabs...', {
      model: ELEVEN_MODEL,
      lang: ELEVEN_LANGUAGE,
      fmt: ELEVEN_OUTPUT_FORMAT,
      len: (MB_OPENING_SCRIPT || '').length,
      url_has_opt_latency: url.includes('optimize_streaming_latency')
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/*'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logWarn('Startup', `Opening cache warmup failed HTTP ${res.status}`, txt);
      return;
    }

    const arr = await res.arrayBuffer();
    OPENING_AUDIO_CACHE = Buffer.from(arr);
    logInfo('Startup', `Opening audio cached. bytes=${OPENING_AUDIO_CACHE.length}`);
  } catch (e) {
    logWarn('Startup', 'Opening cache warmup error', e);
  }
}

// -----------------------------
// LLM calls
// -----------------------------
async function callIvritLLM(userText, meta) {
  if (!IVRIT_LLM_URL) return { ok: false };
  try {
    logInfo('LLM', 'Calling IVRIT LLM', { url: 'SET', textLen: userText.length }, meta);
    const res = await fetch(IVRIT_LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: userText,
        system: buildSystemInstructions(),
        business: BUSINESS_NAME,
        languages: MB_LANGUAGES,
      }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logWarn('LLM', `IVRIT HTTP ${res.status}`, t, meta);
      return { ok: false };
    }

    const json = await res.json().catch(() => null);
    const text = String(json?.text || '').trim();
    if (!text) return { ok: false };
    return { ok: true, text };
  } catch (e) {
    logWarn('LLM', 'IVRIT error', e, meta);
    return { ok: false };
  }
}

async function callOpenAiResponses(userText, meta) {
  const instructions = buildSystemInstructions();
  const t0 = Date.now();

  const payload = {
    model: OPENAI_LLM_MODEL,
    input: [
      { role: 'system', content: instructions },
      { role: 'user', content: String(userText || '') }
    ],
  };

  logInfo('LLM', 'Calling OpenAI Responses', { model: OPENAI_LLM_MODEL }, meta);

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const ms = Date.now() - t0;

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    logWarn('LLM', `OpenAI HTTP ${res.status} ms=${ms}`, t, meta);
    return { ok: false };
  }

  const json = await res.json().catch(() => null);

  // Extract output_text
  let out = '';
  try {
    // responses API shape: output[] with content[]; easiest: json.output_text if present
    out = String(json?.output_text || '').trim();
    if (!out && Array.isArray(json?.output)) {
      for (const item of json.output) {
        if (!item?.content) continue;
        for (const c of item.content) {
          if (c?.type === 'output_text' && c?.text) out += c.text;
        }
      }
      out = out.trim();
    }
  } catch {}

  logInfo('LLM', 'OpenAI ok', { ms, len: out.length }, meta);

  if (!out) return { ok: false };
  return { ok: true, text: out };
}

async function getLLMReply(userText, meta) {
  // 1) Try IVRIT if configured
  const iv = await callIvritLLM(userText, meta);
  if (iv.ok) return iv;

  // 2) Fallback to OpenAI Responses
  return await callOpenAiResponses(userText, meta);
}

// -----------------------------
// Chunking
// -----------------------------
function splitToChunks(text, maxChars) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (!MB_ENABLE_CHUNKING) return [t];

  const m = Math.max(30, maxChars | 0);
  const parts = [];
  let cur = '';

  const tokens = t.split(/(\s+)/); // keep spaces
  for (const tok of tokens) {
    if ((cur + tok).length <= m) {
      cur += tok;
      continue;
    }
    if (cur.trim()) parts.push(cur.trim());
    cur = tok.trimStart();
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [t];
}

// -----------------------------
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// simple request logging (optional)
app.use((req, res, next) => {
  const id = crypto.randomBytes(4).toString('hex');
  logInfo('HTTP', `--> [${id}] ${req.method} ${req.path} ip=${req.ip}`, undefined, {});
  res.on('finish', () => {
    logInfo('HTTP', `<-- [${id}] ${req.method} ${req.path} status=${res.statusCode}`, undefined, {});
  });
  next();
});

app.get('/', (req, res) => res.status(200).send('OK'));

app.post('/twilio-voice', (req, res) => {
  const host = (DOMAIN || req.headers.host || '').replace(/^https?:\/\//, '');
  const wsUrl = MB_TWILIO_STREAM_URL || `wss://${host}/twilio-media-stream`;
  const caller = req.body.From || '';

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Twilio hangup (optional)
// -----------------------------
async function hangupTwilioCall(callSid, meta) {
  if (!callSid) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!res.ok) {
      logWarn('Call', `Twilio hangup HTTP ${res.status}`, await res.text().catch(() => ''), meta);
    } else {
      logInfo('Call', 'Twilio call hangup requested successfully.', undefined, meta);
    }
  } catch (e) {
    logWarn('Call', 'Twilio hangup error', e, meta);
  }
}

// -----------------------------
// Per-call handler
// -----------------------------
wss.on('connection', (connection) => {
  const meta = { rid: rid() };
  logInfo('Call', 'New Twilio Media Stream connection established.', undefined, meta);

  if (!OPENAI_API_KEY) {
    logError('Call', 'OPENAI_API_KEY missing – closing.', undefined, meta);
    try { connection.close(); } catch {}
    return;
  }

  const sender = createAudioSender(connection, meta);

  let streamSid = null;
  let callSid = null;

  let callEnded = false;
  let lastMediaTs = Date.now();

  // prevent user audio being sent while bot speaking (if configured)
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

    logInfo('Call', `endCall reason="${reason}"`, undefined, meta);
    logInfo('Call', 'Final conversation log:', conversationLog, meta);

    try { sender.stop(); } catch {}

    if (callSid) hangupTwilioCall(callSid, meta).catch(() => {});
    try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
    try { if (connection.readyState === WebSocket.OPEN) connection.close(); } catch {}
  }

  // -----------------------------
  // Play helpers (CRITICAL: clear + queue reset)
  // -----------------------------
  async function playTtsText(text, reason) {
    if (callEnded) return false;
    const t = String(text || '').trim();
    if (!t) return false;

    // ✅ CRITICAL: clear Twilio buffer + clear internal queue BEFORE each TTS
    sendTwilioClear(connection, sender.streamSid, meta);
    sender.clearQueue();

    botSpeaking = true;
    const r = await elevenTtsStreamToSender(t, reason, sender, meta);
    if (MB_SEND_SILENCE_TAIL_MS > 0) sender.sendSilenceTail(MB_SEND_SILENCE_TAIL_MS);
    botSpeaking = false;

    noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
    return !!r.ok;
  }

  async function playOpening() {
    if (callEnded) return;

    conversationLog.push({ from: 'bot', text: MB_OPENING_SCRIPT });

    // ✅ CRITICAL: clear before opening too
    sendTwilioClear(connection, sender.streamSid, meta);
    sender.clearQueue();

    if (TTS_PROVIDER === 'eleven') {
      if (OPENING_AUDIO_CACHE && OPENING_AUDIO_CACHE.length) {
        logInfo('Opening', 'Playing cached opening', {
          bytes: OPENING_AUDIO_CACHE.length,
          approxSeconds: (OPENING_AUDIO_CACHE.length / 8000).toFixed(2) // ulaw_8000 ~ 8000 bytes/sec
        }, meta);
        sender.enqueue(Buffer.from(OPENING_AUDIO_CACHE));
        if (MB_SEND_SILENCE_TAIL_MS > 0) sender.sendSilenceTail(MB_SEND_SILENCE_TAIL_MS);
      } else {
        logInfo('Opening', 'No cache; TTS opening now', undefined, meta);
        await playTtsText(MB_OPENING_SCRIPT, 'opening');
      }
    }
  }

  // -----------------------------
  // OpenAI Realtime WS (transcription only)
  // -----------------------------
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openAiWs.on('open', () => {
    logInfo('Call', 'Connected to OpenAI Realtime API.', undefined, meta);

    const instructions = buildSystemInstructions();

    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ['text', 'audio'],
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        instructions
      }
    }));
  });

  openAiWs.on('close', () => {
    logInfo('Call', 'OpenAI WS closed.', undefined, meta);
    if (!callEnded) endCall('openai_ws_closed');
  });

  openAiWs.on('error', (err) => {
    logError('Call', 'OpenAI WS error', err, meta);
    if (!callEnded) endCall('openai_ws_error');
  });

  // Handle transcription completed -> call LLM -> speak via Eleven
  let lastTranscript = '';
  let lastTranscriptAt = 0;
  let llmInFlight = false;
  let turnId = 0;

  async function handleUserText(text, trigger) {
    if (callEnded) return;
    const t = String(text || '').trim();
    if (!t) return;

    turnId += 1;
    const myTurn = turnId;

    conversationLog.push({ from: 'user', text: t });
    logInfo('User', t, undefined, meta);

    // optional immediate ACK (short)
    if (MB_ACK_ENABLED && MB_ACK_TEXT) {
      logInfo('ACK', 'Speaking immediate ack', { text: MB_ACK_TEXT }, meta);
      await playTtsText(MB_ACK_TEXT, 'ack');
    }

    // Avoid parallel LLM calls; if user speaks again, we supersede previous
    llmInFlight = true;
    logInfo('LLM', 'Processing user text', { trigger, textLen: t.length, turnId: myTurn }, meta);

    const reply = await getLLMReply(t, meta);
    if (callEnded) return;

    // If a newer turn exists, drop this reply
    if (myTurn !== turnId) {
      logWarn('LLM', 'Dropping stale reply (newer user turn exists)', { myTurn, turnId }, meta);
      return;
    }

    llmInFlight = false;
    if (!reply.ok || !reply.text) {
      const fallback = 'לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
      conversationLog.push({ from: 'bot', text: fallback });
      logInfo('Bot', fallback, undefined, meta);
      await playTtsText(fallback, 'fallback');
      return;
    }

    const out = String(reply.text || '').trim();
    conversationLog.push({ from: 'bot', text: out });
    logInfo('Bot', out, undefined, meta);

    // Chunking to reduce long wait & smoother playback
    const chunks = splitToChunks(out, MB_CHUNK_MAX_CHARS);
    if (chunks.length > 1) {
      logInfo('Chunking', 'Split reply', { chunks: chunks.length, maxChars: MB_CHUNK_MAX_CHARS }, meta);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // If user started speaking (barge) - optionally stop speaking further chunks
      if (MB_ALLOW_BARGE_IN && Date.now() < noListenUntilTs) {
        // already in tail, continue
      }
      await playTtsText(chunk, chunks.length > 1 ? `llm_reply:chunk_${i + 1}/${chunks.length}` : 'llm_reply');
      if (callEnded) return;
    }
  }

  openAiWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const type = msg.type;

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const t = String(msg.transcript || '').trim();
      if (!t) return;

      const now = Date.now();
      if (t === lastTranscript && (now - lastTranscriptAt) < 800) return;
      lastTranscript = t;
      lastTranscriptAt = now;

      // If barge-in is disabled, ignore while bot speaking / tail
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      // If LLM is in-flight and user speaks again, supersede (turnId increments)
      await handleUserText(t, 'transcript_completed');
      return;
    }

    if (type === 'error') {
      const code = msg?.error?.code;
      logWarn('OpenAI', 'OpenAI error event', { code, message: msg?.error?.message }, meta);
      return;
    }
  });

  // -----------------------------
  // Twilio Media Stream handlers
  // -----------------------------
  connection.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      sender.bindStreamSid(streamSid);
      lastMediaTs = Date.now();

      logInfo('Call', `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}`, undefined, meta);

      // Play opening immediately (no dependency on OpenAI)
      await playOpening();

      // Idle watchdog
      if (idleInterval) clearInterval(idleInterval);
      idleInterval = setInterval(() => {
        if (callEnded) {
          clearInterval(idleInterval);
          idleInterval = null;
          return;
        }
        const since = Date.now() - lastMediaTs;
        if (since > MB_IDLE_HANGUP_MS) {
          logInfo('Call', 'Idle hangup.', { sinceMs: since }, meta);
          endCall('idle_timeout');
        }
      }, 1000);

      // Max call duration
      if (MB_MAX_CALL_MS > 0) {
        if (maxCallTimeout) clearTimeout(maxCallTimeout);
        maxCallTimeout = setTimeout(() => {
          if (!callEnded) endCall('max_call_duration');
        }, MB_MAX_CALL_MS);
      }

      return;
    }

    if (msg.event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;

      if (openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      // If barge-in disabled, do not feed audio while bot speaking / tail
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
        if (llmInFlight) return; // optional: reduce background noise while waiting
      }

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      return;
    }

    if (msg.event === 'stop') {
      logInfo('Call', 'Twilio stream stopped.', undefined, meta);
      if (!callEnded) endCall('twilio_stop');
      return;
    }
  });

  connection.on('close', () => {
    logInfo('Call', 'Twilio WS closed.', undefined, meta);
    if (!callEnded) endCall('twilio_ws_closed');
  });

  connection.on('error', (err) => {
    logError('Call', 'Twilio WS error', err, meta);
    if (!callEnded) endCall('twilio_ws_error');
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, async () => {
  console.log(`✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  await warmupOpeningCache();
});
