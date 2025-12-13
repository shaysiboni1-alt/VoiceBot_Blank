// server.js
//
// BluBinet Voice Bot – "נטע" (Twilio Media Streams + OpenAI Realtime transcription + LLM + Eleven TTS)
//
// FIXES IN THIS VERSION:
// ✅ HARD Hebrew lock (never answer in EN/AR), with post-process fallback
// ✅ Prevent re-greeting after first greeting/opening (strip "שלום/בוקר טוב" etc.)
// ✅ ACK variants random
// ✅ Closing detection + play MB_CLOSING_SCRIPT + hangup
// ✅ Leads system: always include callerId, extracted name/phone, conversation log
// ✅ Abandoned call webhook: sends last user text + callerId
// ✅ Audio framing: ALWAYS 160-byte ulaw frames (20ms) to Twilio (pad with 0xFF)
// ✅ Twilio "clear": ONCE per utterance (opening/ack/reply), never between chunks
//
// Requirements:
//   npm install express ws dotenv
//   Node 18+

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
function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

// -----------------------------
// Config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const DOMAIN = envStr('DOMAIN', '');
const MB_TWILIO_STREAM_URL = envStr('MB_TWILIO_STREAM_URL', '');

const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
const OPENAI_REALTIME_MODEL = envStr('OPENAI_REALTIME_MODEL', 'gpt-4o-realtime-preview-2024-12-17');

// LLM
const IVRIT_LLM_URL = envStr('IVRIT_LLM_URL', '');
const OPENAI_LLM_MODEL = envStr('OPENAI_LLM_MODEL', 'gpt-4o-mini');

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'שלום, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);

// Behavior / language
const MB_FORCE_HEBREW = envBool('MB_FORCE_HEBREW', true);
const MB_LANGUAGES = envStr('MB_LANGUAGES', 'he')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ACK
const MB_ACK_ENABLED = envBool('MB_ACK_ENABLED', true);
const MB_ACK_TEXT = envStr('MB_ACK_TEXT', 'מעולה, רגע...');
const MB_ACK_VARIANTS = envStr('MB_ACK_VARIANTS', '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Prompts
const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');

// Closing
const MB_ENABLE_CLOSING = envBool('MB_ENABLE_CLOSING', true);
const MB_CLOSING_SCRIPT = envStr(
  'MB_CLOSING_SCRIPT',
  'תודה רבה שפניתם אלינו! אם תרצו, אפשר להשאיר שם ומספר ונחזור אליכם. להתראות.'
);
const MB_CLOSING_HANGUP_DELAY_MS = envNumber('MB_CLOSING_HANGUP_DELAY_MS', 900);

// Leads / Webhooks
const MB_LEADS_ENABLED = envBool('MB_LEADS_ENABLED', false);
const MAKE_WEBHOOK_URL = envStr('MAKE_WEBHOOK_URL', '');
const MB_ABANDON_WEBHOOK_URL = envStr('MB_ABANDON_WEBHOOK_URL', '');

// VAD / turn-taking
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.75);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 700);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 150);

const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 120000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 10 * 60 * 1000);

const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// ElevenLabs
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase();
const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', envStr('ELEVENLABS_API_KEY', ''));
const ELEVEN_VOICE_ID = envStr('ELEVEN_VOICE_ID', envStr('VOICE_ID', ''));
const ELEVEN_MODEL = envStr('ELEVEN_TTS_MODEL', 'eleven_v3');
const ELEVEN_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', envStr('ELEVEN_LANGUAGE', 'he'));
const ELEVEN_OUTPUT_FORMAT = envStr('ELEVEN_OUTPUT_FORMAT', 'ulaw_8000');
const ELEVEN_STABILITY = envNumber('ELEVEN_STABILITY', 0.5);
const ELEVEN_SIMILARITY = envNumber('ELEVEN_SIMILARITY', 0.75);
const ELEVEN_STYLE = envNumber('ELEVEN_STYLE', 0.0);
const ELEVEN_SPEAKER_BOOST = envBool('ELEVEN_SPEAKER_BOOST', true);

// Chunking
const MB_ENABLE_CHUNKING = envBool('MB_ENABLE_CHUNKING', true);
const MB_CHUNK_MAX_CHARS = envNumber('MB_CHUNK_MAX_CHARS', 80);

// Opening cache
const MB_CACHE_OPENING_AUDIO = envBool('MB_CACHE_OPENING_AUDIO', true);
let OPENING_AUDIO_CACHE = null;

// -----------------------------
// Logging
// -----------------------------
const MB_LOG_LEVEL = envStr('MB_LOG_LEVEL', 'info').toLowerCase();
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
  const ridPart = meta?.rid ? ` { rid: '${meta.rid}' }` : '';
  if (extra !== undefined) console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`, extra);
  else console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`);
}
const logDebug = (t, m, e, meta) => log('debug', t, m, e, meta);
const logInfo  = (t, m, e, meta) => log('info',  t, m, e, meta);
const logWarn  = (t, m, e, meta) => log('warn',  t, m, e, meta);
const logError = (t, m, e, meta) => log('error', t, m, e, meta);

// -----------------------------
// Guardrails
// -----------------------------
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');
if (TTS_PROVIDER === 'eleven') {
  if (!ELEVEN_API_KEY) console.error('❌ Missing ELEVEN_API_KEY (or ELEVENLABS_API_KEY) in ENV.');
  if (!ELEVEN_VOICE_ID) console.error('❌ Missing VOICE_ID (or ELEVEN_VOICE_ID) in ENV.');
}

// -----------------------------
// Prompting
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1) אתם "נטע", נציגת שירות של "${BUSINESS_NAME}".
2) תשובה בעברית בלבד. גם אם פונים באנגלית/ערבית/שפה אחרת – תשיבו בעברית, בלי לעבור שפה.
3) אל תגידו "שלום/בוקר טוב/היי" מחדש אחרי שכבר נפתח השיחה. פתחו ישר בתוכן.
4) תשובות קצרות (1–3 משפטים) ולסיים בשאלה אחת שמקדמת צורך.
5) לא מציינים ספקים מתחרים בשמות.
6) אם הלקוח אומר "תודה, זהו / סיימנו / להתראות / ביי" – עוברים לסגירה קצרה ומנתקים.
`.trim();

function buildSystemInstructions(hasGreeted) {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const kb = (MB_BUSINESS_PROMPT || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (kb) instructions += (instructions ? '\n\n' : '') + kb;

  if (!instructions) {
    instructions = `
אתם עוזר קולי בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
`.trim();
  }

  // If already greeted, force no re-greeting
  const noGreet = hasGreeted
    ? '\n\nהערה קריטית: כבר בירכתם בתחילת השיחה. אל תפתחו שוב ב"שלום/היי/בוקר טוב".'
    : '';

  return instructions + '\n\n' + EXTRA_BEHAVIOR_RULES + noGreet;
}

// -----------------------------
// Language / text utilities
// -----------------------------
function looksHebrew(text) {
  const s = String(text || '');
  if (!s.trim()) return true;

  // Count Hebrew letters vs Latin/Arabic letters
  const heb = (s.match(/[\u0590-\u05FF]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  const arb = (s.match(/[\u0600-\u06FF]/g) || []).length;

  // If strong presence of Latin/Arabic and low Hebrew -> not Hebrew
  const nonHeb = lat + arb;
  if (nonHeb >= 10 && heb < 5) return false;

  // If contains full English sentences (simple heuristic)
  if (lat > heb * 2 && lat > 12) return false;

  return true;
}

function stripReGreetingIfNeeded(text, hasGreeted) {
  let out = String(text || '').trim();
  if (!out) return out;
  if (!hasGreeted) return out;

  // Remove common re-greeting prefixes
  out = out.replace(/^(בוקר טוב|צהריים טובים|ערב טוב|לילה טוב|היי|שלום)[!,.־\s]+/i, '');
  out = out.replace(/^wa\s+alaikum.*?!\s*/i, ''); // if it tries arabic greeting
  return out.trim();
}

function sanitizeLLMText(text) {
  let out = String(text || '').trim();
  if (!out) return out;

  // Replace placeholders if any
  out = out.replaceAll('{MB_CLOSING_SCRIPT}', MB_CLOSING_SCRIPT);

  // Remove weird double spaces
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

// -----------------------------
// Closing detection (STRONG intent only)
// -----------------------------
function isClosingIntent(userText) {
  const t = String(userText || '').trim().toLowerCase();
  if (!t) return false;

  // strong goodbye signals (do NOT close on "thanks" alone)
  const patterns = [
    /\bזהו\b/,
    /\bסיימנו\b/,
    /\bסיימתי\b/,
    /\bלהתראות\b/,
    /\bביי\b/,
    /\bנתראה\b/,
    /\bאפשר לנתק\b/,
    /\bתנתקי\b/,
    /\bתסיימי\b/,
    /\bתודה\b.*\bלהתראות\b/,
    /\bתודה\b.*\bזהו\b/
  ];

  const patternsEn = [
    /\bbye\b/,
    /\bgoodbye\b/,
    /\bthat'?s all\b/,
    /\bi'?m done\b/,
    /\bend (the )?call\b/
  ];

  return patterns.some(r => r.test(t)) || patternsEn.some(r => r.test(t));
}

// -----------------------------
// Leads extraction (simple + practical)
// -----------------------------
function extractPhone(text) {
  const s = String(text || '');
  // Israeli-ish phone patterns (very forgiving)
  const m = s.match(/(\+972[\s-]?\d[\d\s-]{6,}|0\d[\d\s-]{7,})/);
  return m ? m[1].replace(/[^\d+]/g, '') : '';
}
function extractNameHe(text) {
  const s = String(text || '').trim();
  // naive: "אני X" / "קוראים לי X"
  let m = s.match(/(?:קוראים לי|שמי|אני)\s+([א-ת]{2,}(?:\s+[א-ת]{2,})?)/);
  if (m) return m[1].trim();
  return '';
}

async function postWebhook(url, payload, meta) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    logInfo('Leads', 'Webhook sent', { urlHost: (() => { try { return new URL(url).host; } catch { return 'invalid'; } })() }, meta);
  } catch (e) {
    logWarn('Leads', 'Webhook send failed', e, meta);
  }
}

// -----------------------------
// Twilio CLEAR helper
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
// Audio sender: ALWAYS 160-byte frames
// -----------------------------
function createAudioSender(connection, meta) {
  const state = { streamSid: null, timer: null, queue: [] };

  function bindStreamSid(streamSid) {
    state.streamSid = streamSid;
    logInfo('AudioSender', 'Bound sender.streamSid', { streamSid }, meta);
    start();
  }

  function enqueue(buf) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return;
    state.queue.push(buf);
  }

  function clearQueue() {
    state.queue = [];
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (!state.streamSid) return;
      if (connection.readyState !== WebSocket.OPEN) return;
      if (state.queue.length === 0) return;

      const frameSize = 160;
      let cur = state.queue[0];

      if (cur.length < frameSize) {
        let merged = Buffer.from(cur);
        state.queue.shift();

        while (merged.length < frameSize && state.queue.length) {
          const nxt = state.queue[0];
          const need = frameSize - merged.length;
          if (nxt.length <= need) {
            merged = Buffer.concat([merged, nxt]);
            state.queue.shift();
          } else {
            merged = Buffer.concat([merged, nxt.subarray(0, need)]);
            state.queue[0] = nxt.subarray(need);
          }
        }

        if (merged.length < frameSize) {
          const pad = Buffer.alloc(frameSize - merged.length, 0xFF); // ulaw silence
          merged = Buffer.concat([merged, pad]);
        }

        sendFrame160(merged);
        return;
      }

      const frame = cur.subarray(0, frameSize);
      if (cur.length === frameSize) state.queue.shift();
      else state.queue[0] = cur.subarray(frameSize);

      sendFrame160(frame);
    }, 20);
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.queue = [];
  }

  function sendFrame160(frameBuf) {
    try {
      let out = frameBuf;
      if (out.length !== 160) {
        if (out.length > 160) out = out.subarray(0, 160);
        else out = Buffer.concat([out, Buffer.alloc(160 - out.length, 0xFF)]);
      }
      const payloadB64 = out.toString('base64');
      connection.send(JSON.stringify({
        event: 'media',
        streamSid: state.streamSid,
        media: { payload: payloadB64 }
      }));
    } catch (e) {
      logError('AudioSender', 'Failed sending frame', e, meta);
    }
  }

  return {
    bindStreamSid,
    enqueue,
    stop,
    clearQueue,
    get streamSid() { return state.streamSid; },
  };
}

// -----------------------------
// Eleven URL + streaming TTS
// -----------------------------
function buildElevenUrl() {
  const baseUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream`;
  const qs = new URLSearchParams({
    output_format: ELEVEN_OUTPUT_FORMAT,
    language: ELEVEN_LANGUAGE,
  });
  return `${baseUrl}?${qs.toString()}`;
}

async function elevenTtsStreamToSender(text, reason, sender, meta) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return { ok: false };

  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    logError('ElevenTTS', 'Missing ELEVEN_API_KEY or VOICE_ID', undefined, meta);
    return { ok: false };
  }

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
    fmt: ELEVEN_OUTPUT_FORMAT
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

    if (!res.body) {
      const arr = await res.arrayBuffer();
      const buf = Buffer.from(arr);
      firstByteMs = Date.now() - t0;
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

async function warmupOpeningCache(meta) {
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

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/*'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) return;

    const arr = await res.arrayBuffer();
    OPENING_AUDIO_CACHE = Buffer.from(arr);
    logInfo('Startup', `Opening audio cached. bytes=${OPENING_AUDIO_CACHE.length}`, undefined, meta);
  } catch {}
}

// -----------------------------
// LLM calls (IVRIT -> fallback OpenAI Responses)
// -----------------------------
async function callIvritLLM(userText, hasGreeted, meta) {
  if (!IVRIT_LLM_URL) return { ok: false };
  try {
    const res = await fetch(IVRIT_LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: userText,
        system: buildSystemInstructions(hasGreeted),
        business: BUSINESS_NAME,
        languages: MB_LANGUAGES,
        forceHebrew: MB_FORCE_HEBREW
      }),
    });

    if (!res.ok) return { ok: false };
    const json = await res.json().catch(() => null);
    const text = String(json?.text || '').trim();
    if (!text) return { ok: false };
    return { ok: true, text };
  } catch (e) {
    logWarn('LLM', 'IVRIT error', e, meta);
    return { ok: false };
  }
}

async function callOpenAiResponses(userText, hasGreeted, meta) {
  const instructions = buildSystemInstructions(hasGreeted);

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_LLM_MODEL,
      input: [
        { role: 'system', content: instructions },
        { role: 'user', content: String(userText || '') }
      ],
    }),
  });

  if (!res.ok) return { ok: false };
  const json = await res.json().catch(() => null);
  let out = String(json?.output_text || '').trim();
  if (!out && Array.isArray(json?.output)) {
    let acc = '';
    for (const item of json.output) {
      for (const c of (item?.content || [])) {
        if (c?.type === 'output_text' && c?.text) acc += c.text;
      }
    }
    out = acc.trim();
  }
  if (!out) return { ok: false };
  return { ok: true, text: out };
}

async function forceHebrewRewrite(text, hasGreeted, meta) {
  // Minimal extra call only when needed
  const prompt = `
החזירו את הטקסט הבא בעברית בלבד, לשון רבים, קצר (1–3 משפטים) ולסיים בשאלה אחת.
אל תפתחו ב"שלום/היי/בוקר טוב" אם כבר בירכתם.
טקסט:
"""${String(text || '').trim()}"""
`.trim();

  const r = await callOpenAiResponses(prompt, hasGreeted, meta);
  if (!r.ok) return text;
  return r.text;
}

async function getLLMReply(userText, hasGreeted, meta) {
  const iv = await callIvritLLM(userText, hasGreeted, meta);
  if (iv.ok) return iv;
  return await callOpenAiResponses(userText, hasGreeted, meta);
}

// -----------------------------
// Chunking
// -----------------------------
function splitToChunks(text, maxChars) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (!MB_ENABLE_CHUNKING) return [t];

  const m = Math.max(40, maxChars | 0);
  const parts = [];
  let cur = '';

  const tokens = t.split(/(\s+)/);
  for (const tok of tokens) {
    if ((cur + tok).length <= m) { cur += tok; continue; }
    if (cur.trim()) parts.push(cur.trim());
    cur = tok.trimStart();
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [t];
}

// -----------------------------
// Express + Twilio TwiML
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
// Call handler
// -----------------------------
wss.on('connection', (connection) => {
  const meta = { rid: rid() };
  logInfo('Call', 'New Twilio Media Stream connection established.', undefined, meta);

  const sender = createAudioSender(connection, meta);

  let streamSid = null;
  let callSid = null;
  let callEnded = false;

  let lastMediaTs = Date.now();
  let botSpeaking = false;
  let noListenUntilTs = 0;

  let hasGreeted = false;

  // lead fields
  let callerId = '';
  let extractedName = '';
  let extractedPhone = '';
  let lastUserText = '';
  let endedReason = '';

  const conversationLog = [];

  let idleInterval = null;
  let maxCallTimeout = null;

  function cleanupTimers() {
    if (idleInterval) clearInterval(idleInterval);
    idleInterval = null;
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    maxCallTimeout = null;
  }

  async function sendLeadsEvent(eventType) {
    if (!MB_LEADS_ENABLED) return;
    if (!MAKE_WEBHOOK_URL) return;

    const payload = {
      event: eventType,
      business: BUSINESS_NAME,
      bot: BOT_NAME,
      ts: new Date().toISOString(),
      callSid,
      streamSid,
      callerId,
      extracted: { name: extractedName, phone: extractedPhone },
      lastUserText,
      endedReason,
      conversationLog
    };

    await postWebhook(MAKE_WEBHOOK_URL, payload, meta);
  }

  async function sendAbandonEvent() {
    if (!MB_ABANDON_WEBHOOK_URL) return;
    const payload = {
      event: 'call_abandoned',
      business: BUSINESS_NAME,
      bot: BOT_NAME,
      ts: new Date().toISOString(),
      callSid,
      streamSid,
      callerId,
      extracted: { name: extractedName, phone: extractedPhone },
      lastUserText,
      endedReason,
      conversationLog
    };
    await postWebhook(MB_ABANDON_WEBHOOK_URL, payload, meta);
  }

  function endCall(reason) {
    if (callEnded) return;
    callEnded = true;
    endedReason = reason;

    cleanupTimers();

    logInfo('Call', `endCall reason="${reason}"`, undefined, meta);
    logInfo('Call', 'Final conversation log:', conversationLog, meta);

    // Webhooks (best-effort, no await-block)
    sendLeadsEvent('call_ended').catch(() => {});
    if (reason === 'twilio_stop' || reason === 'twilio_ws_closed') {
      sendAbandonEvent().catch(() => {});
    }

    try { sender.stop(); } catch {}
    try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
    try { if (connection.readyState === WebSocket.OPEN) connection.close(); } catch {}
  }

  function pickAckText() {
    if (MB_ACK_VARIANTS.length) return pickRandom(MB_ACK_VARIANTS);
    return MB_ACK_TEXT;
  }

  async function playUtterance(texts, reasonPrefix) {
    if (callEnded) return;
    const list = (Array.isArray(texts) ? texts : [String(texts || '')])
      .map(s => String(s || '').trim())
      .filter(Boolean);
    if (!list.length) return;

    sendTwilioClear(connection, sender.streamSid, meta);
    sender.clearQueue();

    botSpeaking = true;
    for (let i = 0; i < list.length; i++) {
      const ok = await elevenTtsStreamToSender(
        list[i],
        `${reasonPrefix}${list.length > 1 ? `:${i+1}/${list.length}` : ''}`,
        sender,
        meta
      );
      if (!ok.ok) break;
    }
    botSpeaking = false;
    noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
  }

  async function playOpening() {
    const t = String(MB_OPENING_SCRIPT || '').trim();
    if (!t) return;

    conversationLog.push({ from: 'bot', text: t });
    hasGreeted = true;

    if (OPENING_AUDIO_CACHE && OPENING_AUDIO_CACHE.length) {
      sendTwilioClear(connection, sender.streamSid, meta);
      sender.clearQueue();
      sender.enqueue(Buffer.from(OPENING_AUDIO_CACHE));
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
      return;
    }
    await playUtterance([t], 'opening');
  }

  async function playClosingAndHangup() {
    if (!MB_ENABLE_CLOSING) return endCall('closing_disabled');
    const closing = String(MB_CLOSING_SCRIPT || '').trim();
    if (!closing) return endCall('closing_empty');

    conversationLog.push({ from: 'bot', text: closing });
    await playUtterance([closing], 'closing');

    setTimeout(() => endCall('closing'), MB_CLOSING_HANGUP_DELAY_MS);
  }

  // OpenAI Realtime (transcription)
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
        instructions: buildSystemInstructions(hasGreeted)
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

  let lastTranscript = '';
  let lastTranscriptAt = 0;
  let turnId = 0;

  async function handleUserText(text) {
    if (callEnded) return;
    const t = String(text || '').trim();
    if (!t) return;

    lastUserText = t;

    // extract leads (lightweight)
    const p = extractPhone(t);
    if (p) extractedPhone = extractedPhone || p;

    const n = extractNameHe(t);
    if (n) extractedName = extractedName || n;

    // closing intent: do not ack, do not call LLM
    if (MB_ENABLE_CLOSING && isClosingIntent(t)) {
      logInfo('Closing', 'User closing intent detected', { text: t }, meta);
      return await playClosingAndHangup();
    }

    turnId += 1;
    const myTurn = turnId;

    conversationLog.push({ from: 'user', text: t });
    logInfo('User', t, undefined, meta);

    if (MB_ACK_ENABLED) {
      const ack = pickAckText();
      if (ack) {
        conversationLog.push({ from: 'bot', text: ack });
        logInfo('ACK', 'Speaking immediate ack', { text: ack }, meta);
        await playUtterance([ack], 'ack');
        if (callEnded) return;
      }
    }

    const reply = await getLLMReply(t, hasGreeted, meta);
    if (callEnded) return;
    if (myTurn !== turnId) return;

    let out = sanitizeLLMText(reply?.text || '');

    // enforce Hebrew output
    if (MB_FORCE_HEBREW && !looksHebrew(out)) {
      logWarn('LLM', 'Non-Hebrew reply detected -> rewriting to Hebrew', { sample: out.slice(0, 80) }, meta);
      out = await forceHebrewRewrite(out, hasGreeted, meta);
      out = sanitizeLLMText(out);
    }

    // prevent re-greeting after opening
    out = stripReGreetingIfNeeded(out, hasGreeted);

    // once we replied at least once, considered greeted already
    if (!hasGreeted) hasGreeted = true;

    if (!out) return;

    conversationLog.push({ from: 'bot', text: out });
    logInfo('Bot', out, undefined, meta);

    const chunks = splitToChunks(out, MB_CHUNK_MAX_CHARS);
    await playUtterance(chunks, 'reply');

    // optionally ping leads mid-call
    if (MB_LEADS_ENABLED && MAKE_WEBHOOK_URL) {
      // only when we have something meaningful
      if (extractedName || extractedPhone) {
        await sendLeadsEvent('lead_update');
      }
    }
  }

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

      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      await handleUserText(t);
    }
  });

  // Twilio stream
  connection.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      // capture callerId from custom parameter if exists
      const params = msg.start?.customParameters || {};
      callerId = params.caller || '';

      sender.bindStreamSid(streamSid);
      lastMediaTs = Date.now();

      logInfo('Call', `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}`, undefined, meta);

      await playOpening();

      idleInterval = setInterval(() => {
        if (callEnded) return;
        const since = Date.now() - lastMediaTs;
        if (since > MB_IDLE_HANGUP_MS) endCall('idle_timeout');
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        maxCallTimeout = setTimeout(() => {
          if (!callEnded) endCall('max_call_duration');
        }, MB_MAX_CALL_MS);
      }

      // initial lead ping
      if (MB_LEADS_ENABLED && MAKE_WEBHOOK_URL) {
        await sendLeadsEvent('call_started');
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
        if (botSpeaking || now < noListenUntilTs) return;
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
// Start
// -----------------------------
server.listen(PORT, async () => {
  console.log(`✅ BluBinet Bot running on port ${PORT}`);
  await warmupOpeningCache({ rid: 'startup' });
});
