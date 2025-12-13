// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime (LLM + Whisper transcription)
// TTS via ElevenLabs (streamed to Twilio as ulaw_8000 20ms frames)
//
// Fixes in this version:
// 1) ALWAYS produce audible bot replies: use output_text if available, otherwise fallback to audio_transcript.done
// 2) Response watchdog: if response "stuck" > MB_RESPONSE_TIMEOUT_MS, release lock and continue
// 3) Rich OpenAI event logs (optional via MB_LOG_LEVEL=debug)
// 4) Keep fast opening via cached Eleven audio

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

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'צהריים טובים, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);

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

// Barge-in
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// Response watchdog (prevents "stuck active response")
const MB_RESPONSE_TIMEOUT_MS = envNumber('MB_RESPONSE_TIMEOUT_MS', 9000);

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

// -----------------------------
// Guardrails
// -----------------------------
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');
if (TTS_PROVIDER === 'eleven') {
  if (!ELEVEN_API_KEY) console.error('❌ Missing ELEVEN_API_KEY (or ELEVENLABS_API_KEY) in ENV.');
  if (!ELEVEN_VOICE_ID) console.error('❌ Missing VOICE_ID (or ELEVEN_VOICE_ID) in ENV.');
}

console.log(`[CONFIG] PORT=${PORT}`);
console.log(`[CONFIG] MODEL=${OPENAI_REALTIME_MODEL}`);
console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}`);
console.log(`[CONFIG] VAD threshold=${MB_VAD_THRESHOLD} silence_ms=${MB_VAD_SILENCE_MS} prefix_ms=${MB_VAD_PREFIX_MS}`);
console.log(`[CONFIG] MB_RESPONSE_TIMEOUT_MS=${MB_RESPONSE_TIMEOUT_MS}`);
console.log(`[CONFIG] TTS_PROVIDER=${TTS_PROVIDER}`);
console.log(
  `[CONFIG] ELEVEN voice_id=${ELEVEN_VOICE_ID ? 'SET' : 'NOT_SET'} model=${ELEVEN_MODEL} lang=${ELEVEN_LANGUAGE} fmt=${ELEVEN_OUTPUT_FORMAT} optLatency=${ELEVEN_OPTIMIZE_STREAMING_LATENCY}`
);
console.log(`[CONFIG] MB_CACHE_OPENING_AUDIO=${MB_CACHE_OPENING_AUDIO}`);
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
const logInfo = (tag, msg, extra, meta) => log('info', tag, msg, extra, meta);
const logWarn = (tag, msg, extra, meta) => log('warn', tag, msg, extra, meta);
const logError = (tag, msg, extra, meta) => log('error', tag, msg, extra, meta);

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

  return { bindStreamSid, enqueue, stop };
}

// -----------------------------
// ElevenLabs URL builder (handles v3 restriction)
// -----------------------------
function buildElevenUrl() {
  const baseUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}`;
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
// -----------------------------
async function elevenTtsStreamToSender(text, reason, sender, meta) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    logError('ElevenTTS', 'Missing ELEVEN_API_KEY or VOICE_ID', undefined, meta);
    return false;
  }
  const cleaned = String(text || '').trim();
  if (!cleaned) return false;

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

  logInfo(
    'ElevenTTS',
    'Streaming text to ElevenLabs TTS.',
    {
      length: cleaned.length,
      model: ELEVEN_MODEL,
      language: ELEVEN_LANGUAGE,
      format: ELEVEN_OUTPUT_FORMAT,
      reason,
      url_has_opt_latency: url.includes('optimize_streaming_latency')
    },
    meta
  );

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
      return false;
    }

    if (!res.body) {
      const arr = await res.arrayBuffer();
      sender.enqueue(Buffer.from(arr));
      logWarn('ElevenTTS', 'No streaming body; buffered entire audio.', { bytes: Buffer.from(arr).length }, meta);
      return true;
    }

    const reader = res.body.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        const buf = Buffer.from(value);
        total += buf.length;
        sender.enqueue(buf);
      }
    }

    logInfo('ElevenTTS', `Stream done. total=${total} bytes`, undefined, meta);
    return true;
  } catch (e) {
    logError('ElevenTTS', 'Streaming error', e, meta);
    return false;
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
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => res.status(200).send('OK'));

// NOTE: If your Twilio webhook is GET, change to app.get as well.
// You said "הכול בסדר" so leaving as-is.
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

  // Realtime state
  let hasActiveResponse = false;
  let botTurnActive = false;
  let botSpeaking = false;
  let noListenUntilTs = 0;

  // response watchdog
  let activeResponseSince = 0;
  let watchdogTimer = null;

  const pendingUserTexts = [];
  let lastTranscript = '';
  let lastTranscriptAt = 0;

  const conversationLog = [];

  let idleInterval = null;
  let maxCallTimeout = null;

  function cleanupTimers() {
    if (idleInterval) clearInterval(idleInterval);
    idleInterval = null;
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    maxCallTimeout = null;
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function releaseResponseLock(reason) {
    if (!hasActiveResponse) return;
    logWarn('Call', 'Releasing stuck response lock', { reason }, meta);
    hasActiveResponse = false;
    botTurnActive = false;
    botSpeaking = false;
    activeResponseSince = 0;
    flushQueue(`released:${reason}`);
  }

  function endCall(reason) {
    if (callEnded) return;
    callEnded = true;

    cleanupTimers();

    logInfo('Call', `endCall reason="${reason}"`, undefined, meta);
    logInfo('Call', 'Final conversation log:', conversationLog, meta);

    try { sender.stop(); } catch {}
    try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
    try { if (connection.readyState === WebSocket.OPEN) connection.close(); } catch {}
  }

  // ---- OpenAI WS
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  function sendUserTextToModel(text, reason) {
    const t = String(text || '').trim();
    if (!t) return;

    if (openAiWs.readyState !== WebSocket.OPEN) {
      logWarn('OpenAI', 'WS not open; queue user text', { reason }, meta);
      pendingUserTexts.push(t);
      return;
    }

    openAiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] }
    }));

    // Ask explicitly for TEXT output (we do external TTS)
    openAiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['text']
      }
    }));

    hasActiveResponse = true;
    botTurnActive = true;
    activeResponseSince = Date.now();

    logInfo('Call', 'response.create sent', { reason }, meta);
  }

  function flushQueue(trigger) {
    if (callEnded) return;
    if (hasActiveResponse) return;
    if (!pendingUserTexts.length) return;
    const next = pendingUserTexts.shift();
    sendUserTextToModel(next, `queued:${trigger}`);
  }

  // Watchdog interval (prevents "no completed event" lock)
  watchdogTimer = setInterval(() => {
    if (callEnded) return;
    if (!hasActiveResponse) return;
    if (!activeResponseSince) return;
    const age = Date.now() - activeResponseSince;
    if (age > MB_RESPONSE_TIMEOUT_MS) {
      releaseResponseLock(`timeout_${age}ms`);
    }
  }, 250);

  openAiWs.on('open', () => {
    logInfo('Call', 'Connected to OpenAI Realtime API.', undefined, meta);

    const instructions = buildSystemInstructions();

    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ['text'], // IMPORTANT: text output only
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

    flushQueue('open');
  });

  openAiWs.on('close', () => {
    logInfo('Call', 'OpenAI WS closed.', undefined, meta);
    if (!callEnded) endCall('openai_ws_closed');
  });

  openAiWs.on('error', (err) => {
    logError('Call', 'OpenAI WS error', err, meta);
    if (!callEnded) endCall('openai_ws_error');
  });

  // We will accept bot text from either:
  // A) response.output_text.*  (preferred)
  // B) response.audio_transcript.* (fallback when output_text is not present)
  let currentBotText = '';
  let currentAudioTranscript = '';

  async function speakBotText(text, source) {
    const t = String(text || '').trim();
    if (!t) return;

    conversationLog.push({ from: 'bot', text: t });
    logInfo('Bot', t, { source }, meta);

    if (TTS_PROVIDER === 'eleven') {
      botSpeaking = true;
      await elevenTtsStreamToSender(t, `model_reply:${source}`, sender, meta);
      botSpeaking = false;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
    }
  }

  openAiWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const type = msg.type;

    // Debug event trace (optional)
    if (MB_LOG_LEVEL === 'debug') {
      if (type && !type.includes('input_audio_buffer')) {
        logDebug('OpenAI', 'evt', { type }, meta);
      }
    }

    if (type === 'response.created') {
      hasActiveResponse = true;
      botTurnActive = true;
      botSpeaking = false;
      activeResponseSince = Date.now();
      currentBotText = '';
      currentAudioTranscript = '';
      return;
    }

    // Preferred path
    if (type === 'response.output_text.delta') {
      const d = msg.delta || '';
      if (d) currentBotText += d;
      return;
    }

    // Fallback path (some runs will only provide this)
    if (type === 'response.audio_transcript.delta') {
      const d = msg.delta || '';
      if (d) currentAudioTranscript += d;
      return;
    }

    if (type === 'response.output_text.done') {
      const text = String(currentBotText || '').trim();
      currentBotText = '';
      if (text) {
        await speakBotText(text, 'output_text');
      }
      return;
    }

    if (type === 'response.audio_transcript.done') {
      // If output_text was empty, use transcript as the bot's text
      const transcript = String(msg.transcript || currentAudioTranscript || '').trim();
      currentAudioTranscript = '';

      if (!transcript) return;

      // Only speak transcript if we did NOT already speak output_text for this response
      if (!currentBotText || !String(currentBotText).trim()) {
        await speakBotText(transcript, 'audio_transcript');
      }
      return;
    }

    if (type === 'response.completed' || type === 'response.audio.done') {
      hasActiveResponse = false;
      botTurnActive = false;
      botSpeaking = false;
      activeResponseSince = 0;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
      flushQueue('response_completed');
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const t = String(msg.transcript || '').trim();
      if (!t) return;

      const now = Date.now();
      if (t === lastTranscript && (now - lastTranscriptAt) < 800) return;
      lastTranscript = t;
      lastTranscriptAt = now;

      conversationLog.push({ from: 'user', text: t });
      logInfo('User', t, undefined, meta);

      if (hasActiveResponse) {
        pendingUserTexts.push(t);
        logDebug('Call', 'Queued user text (response in flight).', { qlen: pendingUserTexts.length }, meta);
        return;
      }

      sendUserTextToModel(t, 'transcript_completed');
      return;
    }

    if (type === 'error') {
      const code = msg?.error?.code;
      logWarn('OpenAI', 'OpenAI error event', { code, message: msg?.error?.message }, meta);

      // recover: release lock and continue
      releaseResponseLock(code || 'unknown_error');
      return;
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
          logInfo('Opening', 'Playing cached opening audio.', { bytes: OPENING_AUDIO_CACHE.length }, meta);
          sender.enqueue(Buffer.from(OPENING_AUDIO_CACHE));
        } else {
          logInfo('Opening', 'No cache; streaming opening from Eleven now.', undefined, meta);
          await elevenTtsStreamToSender(MB_OPENING_SCRIPT, 'opening_greeting', sender, meta);
        }
      }

      // Idle timer
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

      // Max duration
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

      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) {
          return;
        }
      }

      // feed audio to OpenAI
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
