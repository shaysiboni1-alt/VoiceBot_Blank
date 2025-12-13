// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime (Whisper transcription)
// LLM: OpenAI Responses API (default) OR IVRIT (fallback via ENV)
// TTS: ElevenLabs streamed to Twilio as ulaw_8000 20ms frames
//
// Goals:
// - FAST start (cached opening)
// - FAST perceived latency (immediate ACK + chunked reply)
// - Robust logs (always)
// - Stop/clear TTS if user starts speaking (anti-cut, anti-overlap)
// - Optional IVRIT LLM integration (fallback by ENV)
//
// Requirements:
//   npm i express ws dotenv
//   Node 18+ (global fetch)

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

// LLM (OpenAI Responses)
const OPENAI_LLM_MODEL = envStr('OPENAI_LLM_MODEL', 'gpt-4o-mini');
const OPENAI_LLM_TIMEOUT_MS = envNumber('OPENAI_LLM_TIMEOUT_MS', 12000);

// IVRIT LLM (fallback)
const IVRIT_LLM_URL = envStr('IVRIT_LLM_URL', ''); // e.g. https://<your-endpoint>/chat
const IVRIT_LLM_TIMEOUT_MS = envNumber('IVRIT_LLM_TIMEOUT_MS', 12000);
const IVRIT_LLM_METHOD = envStr('IVRIT_LLM_METHOD', 'POST').toUpperCase(); // POST recommended
const IVRIT_LLM_HEADER_KEY = envStr('IVRIT_LLM_HEADER_KEY', ''); // optional
const IVRIT_LLM_HEADER_VALUE = envStr('IVRIT_LLM_HEADER_VALUE', ''); // optional

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'צהריים טובים, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);
const MB_CLOSING_SCRIPT = envStr(
  'MB_CLOSING_SCRIPT',
  'תודה שדיברתם עם BluBinet. יום נעים!'
);

const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');

const MB_LANGUAGES = envStr('MB_LANGUAGES', 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// VAD (transcription)
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.75);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 700);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 150);

// Idle / duration
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 120000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 10 * 60 * 1000);

// Barge-in
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

// Chunking + ACK behavior (NEW)
const MB_CHUNK_MAX_CHARS = envNumber('MB_CHUNK_MAX_CHARS', 60);
const MB_CHUNK_MIN_CHARS = envNumber('MB_CHUNK_MIN_CHARS', 18);
const MB_CHUNK_GAP_MS = envNumber('MB_CHUNK_GAP_MS', 140); // tiny pause between chunks
const MB_ACK_ENABLED = envBool('MB_ACK_ENABLED', true);
const MB_ACK_TEXT = envStr('MB_ACK_TEXT', 'מעולה, רגע...');
const MB_ACK_MIN_LLM_MS = envNumber('MB_ACK_MIN_LLM_MS', 350); // if LLM is instant, no ack needed

// -----------------------------
// Guardrails
// -----------------------------
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');
if (TTS_PROVIDER === 'eleven') {
  if (!ELEVEN_API_KEY) console.error('❌ Missing ELEVEN_API_KEY (or ELEVENLABS_API_KEY) in ENV.');
  if (!ELEVEN_VOICE_ID) console.error('❌ Missing VOICE_ID (or ELEVEN_VOICE_ID) in ENV.');
}

console.log(`[CONFIG] PORT=${PORT}`);
console.log(`[CONFIG] OPENAI_REALTIME_MODEL=${OPENAI_REALTIME_MODEL}`);
console.log(`[CONFIG] OPENAI_LLM_MODEL=${OPENAI_LLM_MODEL}, IVRIT_LLM_URL=${IVRIT_LLM_URL ? 'SET' : 'NOT_SET'}`);
console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}`);
console.log(`[CONFIG] VAD threshold=${MB_VAD_THRESHOLD} silence_ms=${MB_VAD_SILENCE_MS} prefix_ms=${MB_VAD_PREFIX_MS}`);
console.log(`[CONFIG] TTS_PROVIDER=${TTS_PROVIDER}`);
console.log(
  `[CONFIG] ELEVEN voice_id=${ELEVEN_VOICE_ID ? 'SET' : 'NOT_SET'} model=${ELEVEN_MODEL} lang=${ELEVEN_LANGUAGE} fmt=${ELEVEN_OUTPUT_FORMAT} optLatency=${ELEVEN_OPTIMIZE_STREAMING_LATENCY}`
);
console.log(`[CONFIG] MB_CACHE_OPENING_AUDIO=${MB_CACHE_OPENING_AUDIO}`);
console.log(`[CONFIG] CHUNK max=${MB_CHUNK_MAX_CHARS} min=${MB_CHUNK_MIN_CHARS} gapMs=${MB_CHUNK_GAP_MS} ACK=${MB_ACK_ENABLED ? 'ON' : 'OFF'}`);

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
const logInfo = (tag, msg, extra, meta) => log('info', tag, msg, extra, meta);
const logWarn = (tag, msg, extra, meta) => log('warn', tag, msg, extra, meta);
const logError = (tag, msg, extra, meta) => log('error', tag, msg, extra, meta);

// -----------------------------
// System instructions
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1) דברו בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
2) אל תתייחסי לרעש/איכות קו. אם לא הבנת: "לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?"
3) תשובות קצרות 1–3 משפטים, וסיימו בשאלה שמקדמת הבנה/איסוף צורך.
4) אל תסיימו שיחה מיוזמתכם.
5) אל תחזרו על אותה תשובה פעמיים.
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
// Audio sender (Twilio expects 20ms frames at 8k ulaw = 160 bytes)
// -----------------------------
function createAudioSender(connection, meta) {
  const state = {
    streamSid: null,
    timer: null,
    queue: [],
    clearedAt: 0,
  };

  function bindStreamSid(streamSid) {
    state.streamSid = streamSid;
    logInfo('AudioSender', 'Bound sender.streamSid', { streamSid }, meta);
    start();
  }

  function enqueue(buf) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return;
    state.queue.push(buf);
  }

  function clear() {
    state.queue = [];
    state.clearedAt = Date.now();
    if (state.streamSid && connection.readyState === WebSocket.OPEN) {
      try {
        // Twilio supports "clear" to flush audio already queued for playback
        connection.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
        logInfo('AudioSender', 'Sent Twilio clear event', undefined, meta);
      } catch (e) {
        logWarn('AudioSender', 'Failed sending clear', e, meta);
      }
    }
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (!state.streamSid) return;
      if (connection.readyState !== WebSocket.OPEN) return;
      if (state.queue.length === 0) return;

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

  return { bindStreamSid, enqueue, clear, stop };
}

// -----------------------------
// ElevenLabs URL builder (handles v3 restriction)
// -----------------------------
function buildElevenUrl() {
  // Use /stream endpoint explicitly (better first-byte behavior)
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

  if (shouldAddOpt) {
    qs.set('optimize_streaming_latency', String(ELEVEN_OPTIMIZE_STREAMING_LATENCY));
  }

  return `${baseUrl}?${qs.toString()}`;
}

// -----------------------------
// ElevenLabs streaming TTS -> push to AudioSender as chunks arrive
// Returns timing metrics for logs
// -----------------------------
async function elevenTtsStreamToSender(text, reason, sender, meta, abortSignalFn) {
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
      use_speaker_boost: ELEVEN_SPEAKER_BOOST,
    },
  };

  logInfo(
    'ElevenTTS',
    'TTS request',
    {
      reason,
      length: cleaned.length,
      model: ELEVEN_MODEL,
      lang: ELEVEN_LANGUAGE,
      fmt: ELEVEN_OUTPUT_FORMAT,
      url,
    },
    meta
  );

  const t0 = Date.now();
  let firstByteMs = null;
  let totalBytes = 0;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/*',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError('ElevenTTS', `HTTP ${res.status}`, txt, meta);
      return { ok: false, status: res.status };
    }

    if (!res.body) {
      const arr = await res.arrayBuffer();
      const buf = Buffer.from(arr);
      sender.enqueue(buf);
      totalBytes += buf.length;
      const totalMs = Date.now() - t0;
      logInfo('ElevenTTS', 'TTS done (buffered)', { firstByteMs: totalMs, totalMs, bytes: totalBytes }, meta);
      return { ok: true, firstByteMs: totalMs, totalMs, bytes: totalBytes };
    }

    const reader = res.body.getReader();

    while (true) {
      if (abortSignalFn && abortSignalFn()) {
        logWarn('ElevenTTS', 'Aborting TTS stream (user started speaking)', undefined, meta);
        try {
          reader.cancel().catch(() => {});
        } catch {}
        return { ok: false, aborted: true };
      }

      const { value, done } = await reader.read();
      if (done) break;

      if (value && value.length) {
        if (firstByteMs === null) firstByteMs = Date.now() - t0;
        const buf = Buffer.from(value);
        totalBytes += buf.length;
        sender.enqueue(buf);
      }
    }

    const totalMs = Date.now() - t0;
    logInfo('ElevenTTS', 'TTS done', { firstByteMs, totalMs, bytes: totalBytes }, meta);
    return { ok: true, firstByteMs, totalMs, bytes: totalBytes };
  } catch (e) {
    logError('ElevenTTS', 'TTS error', e, meta);
    return { ok: false, error: String(e && e.message ? e.message : e) };
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
    const text = String(MB_OPENING_SCRIPT || '').trim();
    if (!text) return;

    logInfo('Startup', 'Warming opening audio cache with ElevenLabs...', {
      model: ELEVEN_MODEL,
      lang: ELEVEN_LANGUAGE,
      fmt: ELEVEN_OUTPUT_FORMAT,
      len: text.length,
      url_has_opt_latency: url.includes('optimize_streaming_latency'),
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/*',
      },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: {
          stability: ELEVEN_STABILITY,
          similarity_boost: ELEVEN_SIMILARITY,
          style: ELEVEN_STYLE,
          use_speaker_boost: ELEVEN_SPEAKER_BOOST,
        },
      }),
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
// LLM: OpenAI Responses API
// -----------------------------
async function callOpenAiResponses({ system, userText, meta }) {
  const url = 'https://api.openai.com/v1/responses';
  const body = {
    model: OPENAI_LLM_MODEL,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: userText }] },
    ],
  };

  const t0 = Date.now();
  logInfo('LLM', 'Calling OpenAI Responses', { model: OPENAI_LLM_MODEL }, meta);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), OPENAI_LLM_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const ms = Date.now() - t0;

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logWarn('LLM', `OpenAI Responses HTTP ${res.status}`, { ms, body: txt }, meta);
      return { ok: false, ms, text: null };
    }

    const json = await res.json();
    const text = extractOpenAiText(json);

    logInfo('LLM', 'OpenAI ok', { ms, len: text ? text.length : 0 }, meta);
    return { ok: true, ms, text: text || '' };
  } catch (e) {
    const ms = Date.now() - t0;
    logWarn('LLM', 'OpenAI error', { ms, error: String(e && e.message ? e.message : e) }, meta);
    return { ok: false, ms, text: null };
  } finally {
    clearTimeout(to);
  }
}

function extractOpenAiText(respJson) {
  // Responses API can return output array with content items
  try {
    const output = respJson && respJson.output;
    if (Array.isArray(output)) {
      let acc = '';
      for (const item of output) {
        const content = item && item.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') acc += c.text;
          }
        }
      }
      return acc.trim();
    }
  } catch {}
  // Fallback
  try {
    if (respJson && typeof respJson.output_text === 'string') return respJson.output_text.trim();
  } catch {}
  return '';
}

// -----------------------------
// LLM: IVRIT (fallback by ENV)
// Expected response: { "text": "..." }  (you can adapt later)
// -----------------------------
async function callIvrit({ system, userText, meta }) {
  const t0 = Date.now();
  logInfo('LLM', 'Calling IVRIT', { url: IVRIT_LLM_URL, method: IVRIT_LLM_METHOD }, meta);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), IVRIT_LLM_TIMEOUT_MS);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (IVRIT_LLM_HEADER_KEY && IVRIT_LLM_HEADER_VALUE) {
      headers[IVRIT_LLM_HEADER_KEY] = IVRIT_LLM_HEADER_VALUE;
    }

    const res = await fetch(IVRIT_LLM_URL, {
      method: IVRIT_LLM_METHOD,
      headers,
      body: JSON.stringify({ system, text: userText }),
      signal: ctrl.signal,
    });

    const ms = Date.now() - t0;

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logWarn('LLM', `IVRIT HTTP ${res.status}`, { ms, body: txt }, meta);
      return { ok: false, ms, text: null };
    }

    const json = await res.json().catch(() => null);
    const text = (json && (json.text || json.output || json.answer)) ? String(json.text || json.output || json.answer) : '';
    logInfo('LLM', 'IVRIT ok', { ms, len: text.length }, meta);
    return { ok: true, ms, text: text.trim() };
  } catch (e) {
    const ms = Date.now() - t0;
    logWarn('LLM', 'IVRIT error', { ms, error: String(e && e.message ? e.message : e) }, meta);
    return { ok: false, ms, text: null };
  } finally {
    clearTimeout(to);
  }
}

// -----------------------------
// Reply chunking (NEW)
// -----------------------------
function splitToChunks(text, maxChars, minChars) {
  const t = String(text || '').trim();
  if (!t) return [];

  // Normalize whitespace
  const norm = t.replace(/\s+/g, ' ').trim();

  // Split by sentence-ish punctuation first
  const parts = norm
    .split(/(?<=[\.\!\?\u05F3\u05F4\u061F])\s+/) // .,!,?, Hebrew/Geresh, Arabic question mark
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let cur = '';

  function pushCur() {
    const c = cur.trim();
    if (c) chunks.push(c);
    cur = '';
  }

  for (const p of parts.length ? parts : [norm]) {
    // If part itself too large, hard-wrap by words
    if (p.length > maxChars) {
      const words = p.split(' ');
      for (const w of words) {
        if (!cur) {
          cur = w;
        } else if ((cur + ' ' + w).length <= maxChars) {
          cur += ' ' + w;
        } else {
          pushCur();
          cur = w;
        }
      }
      pushCur();
      continue;
    }

    // Accumulate parts until max
    if (!cur) {
      cur = p;
    } else if ((cur + ' ' + p).length <= maxChars) {
      cur += ' ' + p;
    } else {
      pushCur();
      cur = p;
    }
  }
  pushCur();

  // If first chunk is too tiny, merge it with next
  if (chunks.length >= 2 && chunks[0].length < minChars) {
    chunks[1] = `${chunks[0]} ${chunks[1]}`.trim();
    chunks.shift();
  }

  return chunks;
}

// -----------------------------
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${TWILIO_ACCOUNT_SID ? callSid : callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
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

  // Speaking / barge-in control
  let botSpeaking = false;
  let noListenUntilTs = 0;
  let userSpeakingRecently = false;
  let lastUserAudioAt = 0;

  // Used to cancel/stop outgoing speech when user starts speaking
  let speechGen = 0; // increments each time we start a new reply
  let lastUserTextAt = 0;

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

  function shouldAbortSpeech(myGen) {
    if (callEnded) return true;
    if (myGen !== speechGen) return true; // new speech started, cancel old
    if (userSpeakingRecently) return true;
    return false;
  }

  async function speakText(text, reason, myGen) {
    const t = String(text || '').trim();
    if (!t) return;
    if (shouldAbortSpeech(myGen)) return;

    botSpeaking = true;
    sender.clear(); // ensure no old frames are stuck
    await elevenTtsStreamToSender(
      t,
      reason,
      sender,
      meta,
      () => shouldAbortSpeech(myGen)
    );
    botSpeaking = false;
    noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
  }

  async function speakChunked(text, baseReason) {
    const reply = String(text || '').trim();
    if (!reply) return;

    const myGen = ++speechGen;
    const chunks = splitToChunks(reply, MB_CHUNK_MAX_CHARS, MB_CHUNK_MIN_CHARS);

    logInfo('Chunking', 'Split reply', { chunks: chunks.length, maxChars: MB_CHUNK_MAX_CHARS }, meta);

    for (let i = 0; i < chunks.length; i++) {
      if (shouldAbortSpeech(myGen)) {
        logWarn('Chunking', 'Stopped chunk playback (user started speaking / new gen)', { atChunk: i + 1 }, meta);
        return;
      }
      const reason = `${baseReason}:chunk_${i + 1}/${chunks.length}`;
      await speakText(chunks[i], reason, myGen);

      if (i < chunks.length - 1) {
        // tiny pause to reduce "machine gun" feel
        await new Promise((r) => setTimeout(r, MB_CHUNK_GAP_MS));
      }
    }
  }

  async function processUserText(userText, trigger) {
    const t = String(userText || '').trim();
    if (!t) return;

    lastUserTextAt = Date.now();
    conversationLog.push({ from: 'user', text: t });
    logInfo('User', t, undefined, meta);

    const system = buildSystemInstructions();

    // Fast ACK if LLM likely slow
    let didAck = false;
    let ackStart = Date.now();

    // Fire ACK immediately (perceived speed)
    if (MB_ACK_ENABLED && MB_ACK_TEXT) {
      didAck = true;
      logInfo('ACK', 'Speaking immediate ack', { text: MB_ACK_TEXT }, meta);
      conversationLog.push({ from: 'bot', text: MB_ACK_TEXT });
      await speakText(MB_ACK_TEXT, 'ack', speechGen + 1); // doesn't increment gen, but still plays now
      ackStart = Date.now();
    }

    // Choose LLM: IVRIT if set, else OpenAI
    logInfo('LLM', 'Processing user text', { trigger, textLen: t.length }, meta);

    let llmRes;
    if (IVRIT_LLM_URL) {
      llmRes = await callIvrit({ system, userText: t, meta });
      if (!llmRes.ok) {
        // fallback to OpenAI if IVRIT fails
        logWarn('LLM', 'IVRIT failed -> fallback to OpenAI', undefined, meta);
        llmRes = await callOpenAiResponses({ system, userText: t, meta });
      }
    } else {
      llmRes = await callOpenAiResponses({ system, userText: t, meta });
    }

    // If LLM is super fast, ACK might be redundant, but we already spoke it.
    // That’s okay—our chunking makes it feel natural.

    const reply = (llmRes && llmRes.ok && llmRes.text) ? String(llmRes.text).trim() : '';
    if (!reply) {
      const fallback = 'לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
      conversationLog.push({ from: 'bot', text: fallback });
      logInfo('Bot', fallback, undefined, meta);
      await speakChunked(fallback, 'fallback_no_reply');
      return;
    }

    // If we spoke ACK and user started talking during LLM, abort reply and wait.
    if (userSpeakingRecently) {
      logWarn('LLM', 'User started speaking during LLM -> skip reply playback', undefined, meta);
      return;
    }

    conversationLog.push({ from: 'bot', text: reply });
    logInfo('Bot', reply, undefined, meta);

    await speakChunked(reply, 'llm_reply');
  }

  // ---- OpenAI WS (transcription only)
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  openAiWs.on('open', () => {
    logInfo('Call', 'Connected to OpenAI Realtime API.', undefined, meta);

    const instructions = buildSystemInstructions();

    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ['text'], // transcription only
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS,
        },
        instructions,
      },
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

  // Dedup transcripts
  let lastTranscript = '';
  let lastTranscriptAt = 0;

  openAiWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'conversation.item.input_audio_transcription.completed') {
      const t = String(msg.transcript || '').trim();
      if (!t) return;

      const now = Date.now();
      if (t === lastTranscript && (now - lastTranscriptAt) < 800) return;
      lastTranscript = t;
      lastTranscriptAt = now;

      // user has spoken -> stop any current TTS and mark speaking recently
      userSpeakingRecently = true;
      lastUserAudioAt = Date.now();
      speechGen++; // cancel any in-flight chunks
      sender.clear();

      // small window: after transcript comes, allow reply once user stops
      setTimeout(() => {
        // if no new audio in the last 350ms, consider user done
        const since = Date.now() - lastUserAudioAt;
        if (since > 350) userSpeakingRecently = false;
      }, 420);

      // Process text (LLM + chunked reply)
      processUserText(t, 'transcript_completed').catch((e) => {
        logWarn('LLM', 'processUserText error', e, meta);
      });
    }

    if (msg.type === 'error') {
      logWarn('OpenAI', 'Realtime error', msg.error || msg, meta);
    }
  });

  // ---- Twilio Media Stream handlers
  connection.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      sender.bindStreamSid(streamSid);
      lastMediaTs = Date.now();

      logInfo('Call', `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}`, undefined, meta);

      // PLAY OPENING IMMEDIATELY:
      conversationLog.push({ from: 'bot', text: MB_OPENING_SCRIPT });

      if (TTS_PROVIDER === 'eleven') {
        if (OPENING_AUDIO_CACHE && OPENING_AUDIO_CACHE.length) {
          const approxSeconds = Math.round((OPENING_AUDIO_CACHE.length / 8000) * 100) / 100; // rough
          logInfo('Opening', 'Playing cached opening', { bytes: OPENING_AUDIO_CACHE.length, approxSeconds }, meta);
          sender.enqueue(Buffer.from(OPENING_AUDIO_CACHE));
        } else {
          logInfo('Opening', 'No cache; streaming opening now', undefined, meta);
          await elevenTtsStreamToSender(MB_OPENING_SCRIPT, 'opening', sender, meta);
        }
      }

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

      // Mark user audio activity (helps cancel speech fast)
      lastUserAudioAt = Date.now();

      // If bot is speaking and barge-in is disabled, we still WANT to detect speech and stop TTS.
      // So we always treat incoming audio as "user speaking".
      if (botSpeaking) {
        userSpeakingRecently = true;
        speechGen++; // cancel chunks
        sender.clear();
        logDebug('Barge', 'User audio while bot speaking -> clear & cancel', undefined, meta);

        setTimeout(() => {
          const since = Date.now() - lastUserAudioAt;
          if (since > 350) userSpeakingRecently = false;
        }, 420);
      }

      // If barge-in disabled, avoid feeding audio during bot talk tail
      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      if (openAiWs.readyState !== WebSocket.OPEN) return;

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
