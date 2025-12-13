// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (LLM) + ElevenLabs (TTS)
//
// מטרה:
// - שיחה יציבה בלי "לא שמעתי טוב" סתם
// - בלי שגיאת conversation_already_has_active_response
// - פתיח מהיר (Eleven ישירות) במקום לחכות ל־OpenAI
// - לוגים תמידיים וברורים עם rid לכל שיחה
// - תשתית IVRIT לתמלול (STT) דרך endpoint שתגדיר
//
// Twilio Voice Webhook ->  POST /twilio-voice  (TwiML)
// Twilio Media Streams -> wss://<domain>/twilio-media-stream
//

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

const DOMAIN = envStr('DOMAIN', ''); // מומלץ להגדיר: blubinet-realtime.onrender.com
const MB_TWILIO_STREAM_URL = envStr('MB_TWILIO_STREAM_URL', ''); // אופציונלי: wss://.../twilio-media-stream

const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
const OPENAI_REALTIME_MODEL = envStr('OPENAI_REALTIME_MODEL', 'gpt-4o-realtime-preview-2024-12-17');

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

const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');

const MB_LANGUAGES = envStr('MB_LANGUAGES', 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// VAD defaults
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 650);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 180);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 3000);

// barge-in
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', true);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// Lead capture (שומר כמו שהיה – אבל לא חוסם)
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = envStr('MB_WEBHOOK_URL', '');

// Twilio credentials (לניתוק אקטיבי / שליפה)
const TWILIO_ACCOUNT_SID = envStr('TWILIO_ACCOUNT_SID', '');
const TWILIO_AUTH_TOKEN = envStr('TWILIO_AUTH_TOKEN', '');

// Debug + always logs
const MB_DEBUG = envBool('MB_DEBUG', true);
const MB_LOG_LEVEL = envStr('MB_LOG_LEVEL', 'info').toLowerCase(); // info|debug

// -----------------------------
// TTS Provider: ElevenLabs
// -----------------------------
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase(); // eleven|openai
const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', envStr('ELEVENLABS_API_KEY', ''));
const ELEVEN_VOICE_ID = envStr('ELEVEN_VOICE_ID', envStr('VOICE_ID', '')); // אתה אמרת שיש לך VOICE_ID בלבד
const ELEVEN_MODEL = envStr('ELEVEN_TTS_MODEL', 'eleven_v3');
const ELEVEN_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', envStr('ELEVEN_LANGUAGE', 'he'));
const ELEVEN_OUTPUT_FORMAT = envStr('ELEVEN_OUTPUT_FORMAT', 'ulaw_8000'); // חשוב ל-Twilio media streams
const ELEVEN_STABILITY = envNumber('ELEVEN_STABILITY', 0.5);
const ELEVEN_SIMILARITY = envNumber('ELEVEN_SIMILARITY', 0.75);
const ELEVEN_STYLE = envNumber('ELEVEN_STYLE', 0.0);
const ELEVEN_SPEAKER_BOOST = envBool('ELEVEN_SPEAKER_BOOST', true);

// פתיח ישיר ב-TTS (מהיר יותר)
const MB_OPENING_DIRECT_TTS = envBool('MB_OPENING_DIRECT_TTS', true);

// -----------------------------
// IVRIT STT scaffolding (אופציונלי)
// -----------------------------
// אם תגדיר IVRIT_STT_URL, אפשר להעביר תמלול עברית אליו במקום OpenAI whisper.
// כרגע נשאר תשתית, לא חובה להפעלה.
const IVRIT_STT_URL = envStr('IVRIT_STT_URL', ''); // endpoint שאתה שולט עליו
const IVRIT_STT_AUTH = envStr('IVRIT_STT_AUTH', ''); // אם צריך
const IVRIT_STT_LANGUAGE = envStr('IVRIT_STT_LANGUAGE', 'he');

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in ENV.');
}
if (TTS_PROVIDER === 'eleven') {
  if (!ELEVEN_API_KEY) console.error('❌ Missing ELEVEN_API_KEY (or ELEVENLABS_API_KEY) in ENV.');
  if (!ELEVEN_VOICE_ID) console.error('❌ Missing VOICE_ID (or ELEVEN_VOICE_ID) in ENV.');
}

console.log(`[CONFIG] PORT=${PORT}`);
console.log(`[CONFIG] TTS_PROVIDER=${TTS_PROVIDER}`);
console.log(`[CONFIG] ELEVEN_MODEL=${ELEVEN_MODEL}, ELEVEN_LANGUAGE=${ELEVEN_LANGUAGE}, ELEVEN_OUTPUT_FORMAT=${ELEVEN_OUTPUT_FORMAT}`);
console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}`);
console.log(`[CONFIG] MB_OPENING_DIRECT_TTS=${MB_OPENING_DIRECT_TTS}`);
console.log(`[CONFIG] IVRIT_STT_URL=${IVRIT_STT_URL ? 'SET' : 'NOT_SET'}`);

// -----------------------------
// Logging helpers (always show logs)
// -----------------------------
function levelRank(lvl) {
  if (lvl === 'debug') return 10;
  if (lvl === 'info') return 20;
  if (lvl === 'warn') return 30;
  if (lvl === 'error') return 40;
  return 20;
}
const CURRENT_LVL = levelRank(MB_LOG_LEVEL);

function log(lvl, tag, msg, extra, meta = {}) {
  if (levelRank(lvl) < CURRENT_LVL) return;
  const ts = new Date().toISOString();
  const ridPart = meta && meta.rid ? ` { rid: '${meta.rid}' }` : '';
  if (extra !== undefined) {
    console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`, extra);
  } else {
    console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`);
  }
}
const logInfo = (tag, msg, extra, meta) => log('info', tag, msg, extra, meta);
const logWarn = (tag, msg, extra, meta) => log('warn', tag, msg, extra, meta);
const logError = (tag, msg, extra, meta) => log('error', tag, msg, extra, meta);
const logDebug = (tag, msg, extra, meta) => log('debug', tag, msg, extra, meta);

// -----------------------------
// System instructions builder
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים (גבוהים מהפרומפט העסקי):
1. אל תתייחסי למוזיקה, רעשים או איכות הקו. אם לא הבנת: "לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?"
2. אל תסיימי שיחה בעצמך. סיימי רק כשמבקשים ממך במפורש או בטיימאאוטים.
3. תשובות קצרות: 1–3 משפטים.
4. בסוף טבעי – שאלי: "רֶגַע לִפְנֵי שֶׁאֲנִי מְסַיֶּמֶת, יֵשׁ עוֹד מַשֶּׁהוּ שֶׁתִּרְצוּ?"
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const kb = (MB_BUSINESS_PROMPT || '').trim();
  let instructions = '';
  if (base) instructions += base;
  if (kb) instructions += (instructions ? '\n\n' : '') + kb;
  if (!instructions) {
    instructions = `
אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור העסק "${BUSINESS_NAME}".
דברו בטון נעים ומקצועי, תשובות קצרות, ברירת מחדל עברית.
`.trim();
  }
  instructions += '\n\n' + EXTRA_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Twilio hangup + fetch caller
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
      logError('Call', `Twilio hangup HTTP ${res.status}`, await res.text().catch(() => ''), meta);
    } else {
      logInfo('Call', 'Twilio call hangup requested successfully.', undefined, meta);
    }
  } catch (e) {
    logError('Call', 'Error calling Twilio hangup API', e, meta);
  }
}

async function fetchCallerNumberFromTwilio(callSid, meta) {
  if (!callSid) return null;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
      }
    });
    if (!res.ok) {
      logError('Call', `fetchCallerNumberFromTwilio HTTP ${res.status}`, await res.text().catch(() => ''), meta);
      return null;
    }
    const data = await res.json();
    const fromRaw = data.from || data.caller_name || null;
    logInfo('Call', `fetchCallerNumberFromTwilio: resolved caller="${fromRaw}" from Twilio Call resource.`, undefined, meta);
    return fromRaw;
  } catch (e) {
    logError('Call', 'fetchCallerNumberFromTwilio: error', e, meta);
    return null;
  }
}

// -----------------------------
// AudioSender: send ulaw_8000 in 20ms frames
// -----------------------------
function createAudioSender(connection, meta) {
  const state = {
    streamSid: null,
    timer: null,
    queue: [],
    sending: false
  };

  function bindStreamSid(streamSid) {
    state.streamSid = streamSid;
    logInfo('AudioSender', 'Bound sender.streamSid', { streamSid }, meta);
  }

  function enqueueUlawBuffer(buf) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return;
    state.queue.push(buf);
    start();
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (!state.streamSid) return;
      if (connection.readyState !== WebSocket.OPEN) return;
      if (state.queue.length === 0) return;

      // Twilio expects 20ms frames: 8kHz ulaw => 160 bytes
      const frameSize = 160;
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

  return { bindStreamSid, enqueueUlawBuffer, stop };
}

// -----------------------------
// ElevenLabs TTS
// -----------------------------
async function elevenTts(text, reason, meta) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    logError('ElevenTTS', 'Missing ELEVEN_API_KEY or VOICE_ID', undefined, meta);
    return null;
  }
  const cleaned = String(text || '').trim();
  if (!cleaned) return null;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}`;

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

  // יש מודלים שלא תומכים בפרמטרים מסוימים – לא שולחים optimize_streaming_latency בכלל
  const headers = {
    'xi-api-key': ELEVEN_API_KEY,
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg'
  };

  // פורמט: ulaw_8000 -> מתאים ישירות ל-Twilio Media Streams
  // Eleven תומכים ב-output_format דרך query string:
  // https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=ulaw_8000
  const urlWithFmt = `${url}?output_format=${encodeURIComponent(ELEVEN_OUTPUT_FORMAT)}&language=${encodeURIComponent(ELEVEN_LANGUAGE)}`;

  logInfo('ElevenTTS', 'Sending text to ElevenLabs TTS.', {
    rid: meta.rid,
    length: cleaned.length,
    model: ELEVEN_MODEL,
    language: ELEVEN_LANGUAGE,
    format: ELEVEN_OUTPUT_FORMAT,
    stability: ELEVEN_STABILITY,
    reason
  }, meta);

  try {
    const res = await fetch(urlWithFmt, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError('ElevenTTS', `ElevenLabs TTS HTTP ${res.status}`, txt, meta);
      return null;
    }
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    logInfo('ElevenTTS', `ElevenLabs TTS audio received total=${buf.length} bytes`, undefined, meta);
    return buf;
  } catch (e) {
    logError('ElevenTTS', 'ElevenLabs TTS fetch error', e, meta);
    return null;
  }
}

// -----------------------------
// IVRIT STT (placeholder) - not enabled by default
// -----------------------------
async function ivritTranscribeBase64Ulaw8k(b64, meta) {
  if (!IVRIT_STT_URL) return null;
  try {
    const res = await fetch(IVRIT_STT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(IVRIT_STT_AUTH ? { Authorization: IVRIT_STT_AUTH } : {})
      },
      body: JSON.stringify({
        audio_b64: b64,
        format: 'g711_ulaw_8000',
        language: IVRIT_STT_LANGUAGE
      })
    });
    if (!res.ok) {
      logError('IVRIT', `IVRIT_STT HTTP ${res.status}`, await res.text().catch(() => ''), meta);
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data.text !== 'string') return null;
    return data.text.trim();
  } catch (e) {
    logError('IVRIT', 'IVRIT_STT error', e, meta);
    return null;
  }
}

// -----------------------------
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// basic health
app.get('/', (req, res) => res.status(200).send('OK'));

// request logging
app.use((req, res, next) => {
  const id = crypto.randomBytes(4).toString('hex');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  logInfo('HTTP', `--> [${id}] ${req.method} ${req.path} ip=${ip}`);
  res.on('finish', () => logInfo('HTTP', `<-- [${id}] ${req.method} ${req.path} status=${res.statusCode}`));
  next();
});

// Twilio Voice webhook – TwiML that connects Media Streams
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

  logInfo('Twilio-Voice', `Returning TwiML with Stream URL: ${wsUrl}, From=${caller}`);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Per-call handler
// -----------------------------
wss.on('connection', (connection) => {
  const meta = { rid: rid() };

  logInfo('Call', 'New Twilio Media Stream connection established.', meta, meta);

  if (!OPENAI_API_KEY) {
    logError('Call', 'OPENAI_API_KEY missing – closing connection.', undefined, meta);
    try { connection.close(); } catch {}
    return;
  }

  // call state
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;

  let callStartTs = Date.now();
  let lastMediaTs = Date.now();

  let idleCheckInterval = null;
  let maxCallTimeout = null;
  let maxCallWarningTimeout = null;

  let callEnded = false;
  let twilioClosed = false;
  let openAiClosed = false;

  // response control
  let hasActiveResponse = false;
  let botSpeaking = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  // user transcript queue to avoid conversation_already_has_active_response
  const pendingUserTexts = [];
  let lastUserTextAt = 0;
  let lastBotAudioAt = 0;

  const conversationLog = [];

  // Audio sender for Twilio
  const sender = createAudioSender(connection, meta);

  // OpenAI WS (LLM + (optional) whisper transcription)
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  function safeCloseAll(reason) {
    if (callEnded) return;
    callEnded = true;

    logInfo('Call', `endCall called with reason="${reason}"`, undefined, meta);
    logInfo('Call', 'Final conversation log:', conversationLog, meta);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);

    // hangup
    if (callSid) hangupTwilioCall(callSid, meta).catch(() => {});

    // close sockets
    try {
      sender.stop();
    } catch {}
    try {
      if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
        openAiClosed = true;
        openAiWs.close();
      }
    } catch {}
    try {
      if (!twilioClosed && connection.readyState === WebSocket.OPEN) {
        twilioClosed = true;
        connection.close();
      }
    } catch {}
  }

  // ---- OpenAI helpers
  function sendUserTextToModel(text, reason) {
    const t = String(text || '').trim();
    if (!t) return;

    // always create a user item, then response.create
    if (openAiWs.readyState !== WebSocket.OPEN) {
      logWarn('Call', 'OpenAI WS not open – cannot send user text.', { reason }, meta);
      return;
    }

    const itemEvt = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: t }]
      }
    };

    openAiWs.send(JSON.stringify(itemEvt));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));

    hasActiveResponse = true;
    botTurnActive = true;
    logInfo('Call', 'response.create sent', { reason }, meta);
  }

  function maybeSendNextFromQueue(trigger) {
    if (callEnded) return;
    if (hasActiveResponse) {
      logDebug('Call', 'Skip send (response already in flight)', { trigger }, meta);
      return;
    }
    if (pendingUserTexts.length === 0) return;

    const next = pendingUserTexts.shift();
    sendUserTextToModel(next, `queued:${trigger}`);
  }

  // “לא שמעתי טוב” רק אם באמת אין כלום
  async function maybeNoUserTextNudge() {
    if (callEnded) return;

    const now = Date.now();
    const sinceUser = now - (lastUserTextAt || callStartTs);

    // אם הלקוח דיבר לאחרונה – לא לנג'ס
    if (sinceUser < 6500) return;

    // אם הבוט באמצע response/דיבור – לא לנג'ס
    if (hasActiveResponse || botSpeaking || botTurnActive) return;

    // נודג' קצר
    const nudge = 'לֹא שָׁמַעְתִּי טוֹב. אֶפְשָׁר לַחֲזוֹר עַל זֶה בְּמִשְׁפָּט קָצָר?';
    conversationLog.push({ from: 'bot', text: 'לא שמעתי טוב, אפשר לחזור על זה?' });
    const audio = await elevenTts(nudge, 'no_user_text', meta);
    if (audio) {
      sender.enqueueUlawBuffer(audio);
      lastBotAudioAt = Date.now();
    }
  }

  // ---- OpenAI WS handlers
  openAiWs.on('open', () => {
    logInfo('Call', 'Connected to OpenAI Realtime API.', undefined, meta);

    const instructions = buildSystemInstructions();

    // session.update
    const sessionUpdate = {
      type: 'session.update',
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ['text', 'audio'],
        // אנחנו עדיין מאפשרים whisper כדי לקבל transcript_completed
        // אם בעתיד נעבור ל-IVRIT: נבטל פה transcription וננהל לבד.
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
    };

    openAiWs.send(JSON.stringify(sessionUpdate));

    // פתיח: Eleven ישירות (מהיר יותר)
    if (MB_OPENING_DIRECT_TTS && TTS_PROVIDER === 'eleven') {
      (async () => {
        conversationLog.push({ from: 'bot', text: MB_OPENING_SCRIPT });
        const audio = await elevenTts(MB_OPENING_SCRIPT, 'opening_greeting', meta);
        if (audio) {
          sender.enqueueUlawBuffer(audio);
          lastBotAudioAt = Date.now();
        }
      })().catch((e) => logError('Call', 'Opening direct TTS failed', e, meta));
    } else {
      // fallback: אם רוצים פתיח מהמודל
      pendingUserTexts.push(`פתחי את השיחה במשפט הבא בלבד: "${MB_OPENING_SCRIPT}"`);
      maybeSendNextFromQueue('opening');
    }
  });

  let currentBotText = '';

  openAiWs.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logError('OpenAI', 'Failed to parse OpenAI message', e, meta);
      return;
    }

    const type = msg.type;

    if (type === 'response.created') {
      hasActiveResponse = true;
      botTurnActive = true;
      currentBotText = '';
      return;
    }

    if (type === 'response.output_text.delta' || type === 'response.audio_transcript.delta') {
      const d = msg.delta || '';
      if (d) currentBotText += d;
      return;
    }

    if (type === 'response.output_text.done' || type === 'response.audio_transcript.done') {
      const text = (currentBotText || '').trim();
      if (text) {
        conversationLog.push({ from: 'bot', text });
        logInfo('Bot', text, undefined, meta);

        // TTS: Eleven speaks the model text
        if (TTS_PROVIDER === 'eleven') {
          const audio = await elevenTts(text, 'model_reply', meta);
          if (audio) {
            sender.enqueueUlawBuffer(audio);
            lastBotAudioAt = Date.now();
          }
        } else {
          // אם אי פעם תחזור ל-openai voice: כאן היינו שולחים audio deltas
          // כרגע לא משתמשים.
        }
      }
      currentBotText = '';
      return;
    }

    if (type === 'response.completed' || type === 'response.audio.done') {
      hasActiveResponse = false;
      botSpeaking = false;
      botTurnActive = false;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      // אם יש טקסטים בתור – ממשיכים
      maybeSendNextFromQueue('response_completed');
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      // קיבלנו תמלול מהלקוח
      const tRaw = (msg.transcript || '').trim();
      if (!tRaw) return;

      const t = tRaw.replace(/\s+/g, ' ').trim();
      lastUserTextAt = Date.now();

      conversationLog.push({ from: 'user', text: t });
      logInfo('User', t, undefined, meta);

      // IMPORTANT:
      // לא שולחים response.create אם יש response פעיל — מכניסים לתור
      if (hasActiveResponse) {
        pendingUserTexts.push(t);
        logWarn('Call', 'User spoke while response in flight -> queued', undefined, meta);
        return;
      }

      // שליחה מיידית למודל (הדרך הנכונה)
      sendUserTextToModel(t, 'transcript_completed');
      return;
    }

    if (type === 'error') {
      logError('OpenAI', 'OpenAI error event', { evt: msg }, meta);

      // מקרה מוכר: conversation_already_has_active_response
      const code = msg?.error?.code;
      if (code === 'conversation_already_has_active_response') {
        // לא עושים כלום, התור שלנו יטפל.
        return;
      }
      if (code === 'response_cancel_not_active') {
        // מתעלמים – זה קורה אם ניסו cancel בלי response פעיל
        return;
      }

      // אם זו שגיאה אחרת קשה – נסגור כדי לא להיתקע שקט
      hasActiveResponse = false;
      botSpeaking = false;
      botTurnActive = false;
      return;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    logInfo('Call', 'OpenAI WS closed.', undefined, meta);
    if (!callEnded) safeCloseAll('openai_ws_closed');
  });

  openAiWs.on('error', (err) => {
    logError('Call', 'OpenAI WS error', err, meta);
    if (!openAiClosed) {
      openAiClosed = true;
      try { openAiWs.close(); } catch {}
    }
    if (!callEnded) safeCloseAll('openai_ws_error');
  });

  // ---- Twilio Media Stream handlers
  connection.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logError('Call', 'Failed to parse Twilio WS message', e, meta);
      return;
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      callerNumber = msg.start?.customParameters?.caller || null;

      callStartTs = Date.now();
      lastMediaTs = Date.now();

      sender.bindStreamSid(streamSid);

      logInfo(
        'Call',
        `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`,
        undefined,
        meta
      );

      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (sinceMedia >= MB_IDLE_WARNING_MS) {
          // "נודג'" עדין – אבל רק אם באמת אין שיחה
          maybeNoUserTextNudge().catch(() => {});
        }
        if (sinceMedia >= MB_IDLE_HANGUP_MS) {
          logInfo('Call', 'Idle timeout reached -> hanging up', undefined, meta);
          safeCloseAll('idle_timeout');
        }
      }, 1000);

      // Max call duration + warning
      if (MB_MAX_CALL_MS > 0) {
        if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
          maxCallWarningTimeout = setTimeout(async () => {
            const t = 'אנחנו מתקרבים לסיום הזמן לשיחה הזאת. אם תרצו להתקדם, אפשר עכשיו לסכם ולהשאיר פרטים.';
            conversationLog.push({ from: 'bot', text: t });
            const audio = await elevenTts(t, 'max_call_warning', meta);
            if (audio) sender.enqueueUlawBuffer(audio);
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          logInfo('Call', 'Max call duration reached -> hanging up', undefined, meta);
          safeCloseAll('max_call_duration');
        }, MB_MAX_CALL_MS);
      }

      return;
    }

    if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;

      // Barge-in handling: אם לא מאפשרים – לא מעבירים אודיו בזמן דיבור הבוט
      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) return;
      }

      // אם בעתיד תפעיל IVRIT STT, כאן אפשר לאסוף אודיו למקטעים.
      // כרגע: פשוט מעבירים ל-OpenAI Realtime כדי לקבל transcript_completed.
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      }
      return;
    }

    if (event === 'stop') {
      logInfo('Call', 'Twilio stream stopped.', undefined, meta);
      twilioClosed = true;
      if (!callEnded) safeCloseAll('twilio_stop');
      return;
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logInfo('Call', 'Twilio WS closed.', undefined, meta);
    if (!callEnded) safeCloseAll('twilio_ws_closed');
  });

  connection.on('error', (err) => {
    twilioClosed = true;
    logError('Call', 'Twilio WS error', err, meta);
    if (!callEnded) safeCloseAll('twilio_ws_error');
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
});
