// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (text only) + ElevenLabs TTS (ulaw_8000 streaming)
//
// עקרונות:
// - OpenAI Realtime: קלט אודיו + תמלול + תשובה טקסטואלית (לא מחזיר אודיו) => לא שומעים Alloy
// - ElevenLabs: מייצר אודיו ulaw_8000 (G.711) ומוזרם לטוויליו בזמן אמת
// - שליטה מקסימלית ב-ENV + לוגים תמידיים
//
// Twilio Voice Webhook ->  POST /twilio-voice  (TwiML)
// Browser test -> GET /twilio-voice
// Health -> GET /health
// Media Stream -> wss://<domain>/twilio-media-stream
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
  const raw = (process.env[name] || '').toLowerCase().trim();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envStr(name, def = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  return String(raw);
}

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'שלום, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);

const MB_CLOSING_SCRIPT = envStr(
  'MB_CLOSING_SCRIPT',
  'תודה שדיברתם עם BluBinet. נציג יחזור אליכם בהקדם. יום נעים!'
);

const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');
const MB_DYNAMIC_KB_URL = envStr('MB_DYNAMIC_KB_URL', '');
const MB_DYNAMIC_KB_MIN_INTERVAL_MS = envNumber('MB_DYNAMIC_KB_MIN_INTERVAL_MS', 5 * 60 * 1000);

const MB_LANGUAGES = envStr('MB_LANGUAGES', 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// VAD (OpenAI server_vad)
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 3000);

// Barge-in
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', true);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// Output tokens
const MAX_OUTPUT_TOKENS_ENV = process.env.MAX_OUTPUT_TOKENS;
let MAX_OUTPUT_TOKENS = 'inf';
if (MAX_OUTPUT_TOKENS_ENV) {
  const n = Number(MAX_OUTPUT_TOKENS_ENV);
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_TOKENS = n;
  else if (MAX_OUTPUT_TOKENS_ENV === 'inf') MAX_OUTPUT_TOKENS = 'inf';
}

// Debug
const MB_DEBUG = envBool('MB_DEBUG', true);

// Lead capture
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = envStr('MB_WEBHOOK_URL', '');
const MB_ENABLE_SMART_LEAD_PARSING = envBool('MB_ENABLE_SMART_LEAD_PARSING', true);
const MB_LEAD_PARSING_MODEL = envStr('MB_LEAD_PARSING_MODEL', 'gpt-4.1-mini');

// Twilio API creds (hangup + caller fetch)
const TWILIO_ACCOUNT_SID = envStr('TWILIO_ACCOUNT_SID', '');
const TWILIO_AUTH_TOKEN = envStr('TWILIO_AUTH_TOKEN', '');

// -----------------------------
// ElevenLabs ENV (תומך בשמות שלך)
// -----------------------------
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase().trim();

// אצלך יש VOICE_ID. נתמוך גם ELEVEN_VOICE_ID למי שכן משתמש.
const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', envStr('ELEVENLABS_API_KEY', ''));
const ELEVEN_VOICE_ID = envStr('VOICE_ID', envStr('ELEVEN_VOICE_ID', ''));

// מודל: אצלך כתוב "Eleven V3" במסך, אבל ב-API צריך ID תקין.
// נשתמש ELEVENLABS_MODEL_ID אם קיים, אחרת ELEVEN_TTS_MODEL, וננרמל ל-eleven_v3 כברירת מחדל.
let ELEVEN_MODEL_ID_RAW = envStr('ELEVENLABS_MODEL_ID', envStr('ELEVEN_TTS_MODEL', 'eleven_v3'));
ELEVEN_MODEL_ID_RAW = ELEVEN_MODEL_ID_RAW.trim();
let ELEVEN_MODEL_ID = 'eleven_v3';
if (ELEVEN_MODEL_ID_RAW) {
  const x = ELEVEN_MODEL_ID_RAW.toLowerCase().replace(/\s+/g, '_');
  // תמיכה ב-"Eleven V3" / "Eleven v3 (alpha)" וכו'
  if (x.includes('eleven') && x.includes('v3')) ELEVEN_MODEL_ID = 'eleven_v3';
  else ELEVEN_MODEL_ID = x;
}

const ELEVEN_OUTPUT_FORMAT = envStr('ELEVEN_OUTPUT_FORMAT', envStr('ELEVENLABS_OUTPUT_FORMAT', 'ulaw_8000')).trim();
const ELEVEN_TIMEOUT_MS = envNumber('ELEVENLABS_TIMEOUT_MS', 2200);
const ELEVEN_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', envStr('ELEVEN_LANGUAGE', 'he')).trim().toLowerCase();

// stability חייב להיות: 0.0 / 0.5 / 1.0 (לפי השגיאה שקיבלת)
function normalizeStability(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  // קוואנטיזציה לערכים מותרים
  const allowed = [0.0, 0.5, 1.0];
  let best = 0.5;
  let bestDist = Infinity;
  for (const a of allowed) {
    const d = Math.abs(a - n);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}

const ELEVEN_STABILITY = normalizeStability(envStr('ELEVENLABS_STABILITY', '0.5'));
const ELEVEN_STYLE = Math.max(0, Math.min(1, envNumber('ELEVENLABS_STYLE', 0.15)));
const ELEVEN_USE_BOOST = envBool('ELEVENLABS_USE_BOOST', true);

// דיליי: ננסה להקטין דרך optimize_streaming_latency (0..4)
const ELEVEN_OPTIMIZE_STREAMING_LATENCY = Math.max(
  0,
  Math.min(4, envNumber('ELEVENLABS_OPTIMIZE_STREAMING_LATENCY', 3))
);

// Fallback: אם Eleven נופל, אפשר לאפשר OpenAI audio כדי שלא יהיה שקט
const MB_FALLBACK_TO_OPENAI_AUDIO = envBool('MB_FALLBACK_TO_OPENAI_AUDIO', true);

// ASR language hint (עוזר ל-whisper לא לברוח לאנגלית)
const MB_ASR_LANGUAGE = envStr('MB_ASR_LANGUAGE', 'he').trim().toLowerCase();

// -----------------------------
// Dynamic KB
// -----------------------------
let dynamicBusinessPrompt = '';
let lastDynamicKbRefreshAt = 0;

async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) {
    if (MB_DEBUG) console.log(`[DEBUG][${tag}] MB_DYNAMIC_KB_URL empty – skip.`);
    return;
  }

  const now = Date.now();
  if (tag !== 'Startup' && now - lastDynamicKbRefreshAt < MB_DYNAMIC_KB_MIN_INTERVAL_MS) {
    console.log(
      `[INFO][${tag}] Skip dynamic KB refresh – refreshed ${now - lastDynamicKbRefreshAt}ms ago (min ${MB_DYNAMIC_KB_MIN_INTERVAL_MS}ms).`
    );
    return;
  }

  try {
    const res = await fetch(MB_DYNAMIC_KB_URL);
    if (!res.ok) {
      console.error(`[ERROR][${tag}] Failed to fetch dynamic KB. HTTP ${res.status}`);
      return;
    }
    const text = (await res.text()).trim();
    dynamicBusinessPrompt = text;
    lastDynamicKbRefreshAt = Date.now();
    console.log(`[INFO][${tag}] Dynamic KB loaded. length=${text.length}`);
  } catch (err) {
    console.error(`[ERROR][${tag}] Error fetching dynamic KB`, err);
  }
}

// -----------------------------
// Prompt builder
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1) אל תתייחסי לרעשי רקע/איכות קו. אם לא הבנת – "לא שמעתי טוב, אפשר לחזור על זה?"
2) אל תסיימי שיחה בגלל "תודה/זהו" בלבד. סיום רק כשברור שסיימו, ואז תגידי רק את משפט הסיום המדויק.
3) תשובות קצרות (2–3 משפטים) וסיימי בשאלה שמבררת מה חשוב ללקוח.
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const staticKb = (MB_BUSINESS_PROMPT || '').trim();
  const dynamicKb = (dynamicBusinessPrompt || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (staticKb) instructions += (instructions ? '\n\n' : '') + staticKb;
  if (dynamicKb) instructions += (instructions ? '\n\n' : '') + dynamicKb;

  if (!instructions) {
    instructions = `
אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
ברירת מחדל: עברית, לשון רבים, טון חם וקצר.
`.trim();
  }

  instructions += '\n\n' + EXTRA_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Logging helpers
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function rid() {
  return crypto.randomBytes(4).toString('hex');
}

function log(tag, level, msg, extra) {
  const base = `[${nowIso()}][${level}][${tag}] ${msg}`;
  if (extra !== undefined) console.log(base, extra);
  else console.log(base);
}

function logErr(tag, msg, extra) {
  const base = `[${nowIso()}][ERROR][${tag}] ${msg}`;
  if (extra !== undefined) console.error(base, extra);
  else console.error(base);
}

// crash visibility
process.on('uncaughtException', (e) => logErr('Process', 'uncaughtException', e));
process.on('unhandledRejection', (e) => logErr('Process', 'unhandledRejection', e));

// -----------------------------
// Express app
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

// request id + request logs תמיד
app.use((req, res, next) => {
  req._rid = req.headers['x-request-id'] || rid();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  log('HTTP', 'INFO', `--> [${req._rid}] ${req.method} ${req.path} ip=${ip}`);
  res.on('finish', () => {
    log('HTTP', 'INFO', `<-- [${req._rid}] ${req.method} ${req.path} status=${res.statusCode}`);
  });
  next();
});

app.get('/', (req, res) => {
  res.type('text/plain').send('OK. BluBinet Realtime is up. Try GET /health or /twilio-voice');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'blubinet-realtime',
    tts_provider: TTS_PROVIDER,
    eleven: {
      has_key: !!ELEVEN_API_KEY,
      voice_id_set: !!ELEVEN_VOICE_ID,
      model_id: ELEVEN_MODEL_ID,
      output_format: ELEVEN_OUTPUT_FORMAT,
      language: ELEVEN_LANGUAGE,
      stability: ELEVEN_STABILITY,
      style: ELEVEN_STYLE,
      use_boost: ELEVEN_USE_BOOST,
      optimize_streaming_latency: ELEVEN_OPTIMIZE_STREAMING_LATENCY
    },
    time: nowIso()
  });
});

// GET test כדי שלא תקבל Cannot GET
app.get('/twilio-voice', (req, res) => {
  log('Twilio-Voice', 'INFO', `GET /twilio-voice (browser test). rid=${req._rid}`);
  res.type('text/plain').send(
    `OK. This endpoint is meant for Twilio (HTTP POST).\n` +
      `If you see this in browser, the service is reachable.\n\n` +
      `Use POST /twilio-voice from Twilio Voice Webhook.\n` +
      `You can also check GET /health.\n`
  );
});

// POST אמיתי שמחזיר TwiML עם Stream
app.post('/twilio-voice', (req, res) => {
  const host = process.env.DOMAIN || req.headers.host;
  const wsUrl =
    process.env.MB_TWILIO_STREAM_URL ||
    `wss://${String(host).replace(/^https?:\/\//, '')}/twilio-media-stream`;

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

  log('Twilio-Voice', 'INFO', `POST /twilio-voice -> Stream=${wsUrl}, From=${caller}`);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);

// -----------------------------
// WebSocket server for Twilio Media Streams
// -----------------------------
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Twilio helpers (hangup + caller fetch)
// -----------------------------
async function hangupTwilioCall(callSid, tag = 'Call') {
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
      const txt = await res.text().catch(() => '');
      logErr(tag, `Twilio hangup HTTP ${res.status}`, txt);
    } else {
      log(tag, 'INFO', 'Twilio call hangup requested successfully.');
    }
  } catch (e) {
    logErr(tag, 'Twilio hangup error', e);
  }
}

async function fetchCallerNumberFromTwilio(callSid, tag = 'Call') {
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

    if (!res.ok) return null;
    const data = await res.json();
    return data.from || data.caller_name || null;
  } catch {
    return null;
  }
}

// -----------------------------
// Phone normalize (IL)
// -----------------------------
function normalizePhoneNumber(rawPhone, callerNumber) {
  function toDigits(num) {
    if (!num) return null;
    return String(num).replace(/\D/g, '');
  }
  function normalize972(digits) {
    if (digits.startsWith('972') && (digits.length === 11 || digits.length === 12)) {
      return '0' + digits.slice(3);
    }
    return digits;
  }
  function isValidIsraeliPhone(digits) {
    if (!/^0\d{8,9}$/.test(digits)) return false;
    const p2 = digits.slice(0, 2);
    if (digits.length === 9) return ['02', '03', '04', '07', '08', '09'].includes(p2);
    if (digits.length === 10) return p2 === '05' || p2 === '07' || ['02', '03', '04', '07', '08', '09'].includes(p2);
    return false;
  }
  function clean(num) {
    let d = toDigits(num);
    if (!d) return null;
    d = normalize972(d);
    if (!isValidIsraeliPhone(d)) return null;
    return d;
  }
  return clean(rawPhone) || clean(callerNumber) || null;
}

// -----------------------------
// Lead parsing (כמו שהיה אצלך, נשאר)
// -----------------------------
async function extractLeadFromConversation(conversationLog) {
  if (!MB_ENABLE_SMART_LEAD_PARSING) return null;
  if (!OPENAI_API_KEY) return null;
  if (!Array.isArray(conversationLog) || conversationLog.length === 0) return null;

  try {
    const conversationText = conversationLog
      .map((m) => `${m.from === 'user' ? 'לקוח' : BOT_NAME}: ${m.text}`)
      .join('\n');

    const systemPrompt = `
החזר JSON בלבד לפי הסכמה:
{
  "is_lead": boolean,
  "lead_type": "new" | "existing" | "unknown",
  "full_name": string | null,
  "business_name": string | null,
  "phone_number": string | null,
  "reason": string | null,
  "notes": string | null
}
`.trim();

    const userPrompt = `תמלול:\n${conversationText}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MB_LEAD_PARSING_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// -----------------------------
// ElevenLabs TTS (STREAMING ulaw_8000)
// -----------------------------
async function elevenTtsStreamToTwilio({ text, voiceId, modelId, language, outputFormat, ridTag, onChunkBase64 }) {
  if (!ELEVEN_API_KEY) throw new Error('Missing ELEVEN_API_KEY');
  if (!voiceId) throw new Error('Missing VOICE_ID / ELEVEN_VOICE_ID');
  if (!text || !text.trim()) return;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(
    outputFormat || 'ulaw_8000'
  )}&optimize_streaming_latency=${encodeURIComponent(String(ELEVEN_OPTIMIZE_STREAMING_LATENCY))}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ELEVEN_TIMEOUT_MS);

  const payload = {
    text,
    model_id: modelId || 'eleven_v3',
    language: language || 'he',
    // חשוב: stability חייב להיות 0.0/0.5/1.0
    voice_settings: {
      stability: ELEVEN_STABILITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: !!ELEVEN_USE_BOOST
    }
  };

  log('ElevenTTS', 'INFO', `Sending text to ElevenLabs TTS.`, {
    rid: ridTag,
    length: text.length,
    model: payload.model_id,
    language: payload.language,
    format: outputFormat || 'ulaw_8000',
    stability: payload.voice_settings.stability
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      throw new Error(`ElevenLabs HTTP ${res.status} ${errTxt}`);
    }

    // Streaming response => קוראים chunks ומעבירים לטוויליו
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      // Twilio expects base64 payload
      const b64 = Buffer.from(value).toString('base64');
      onChunkBase64(b64);
    }

    log('ElevenTTS', 'INFO', 'ElevenLabs TTS stream finished.', { rid: ridTag });
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------
// Per-call handler
// -----------------------------
wss.on('connection', (connection) => {
  const tag = 'Call';
  const callRid = rid();

  log(tag, 'INFO', 'New Twilio Media Stream connection established.', { rid: callRid });

  if (!OPENAI_API_KEY) {
    logErr(tag, 'OPENAI_API_KEY missing – closing connection.', { rid: callRid });
    connection.close();
    return;
  }

  // Keep WS alive
  connection.isAlive = true;
  connection.on('pong', () => (connection.isAlive = true));
  const pingInt = setInterval(() => {
    if (connection.readyState !== WebSocket.OPEN) return;
    if (!connection.isAlive) {
      try { connection.terminate(); } catch {}
      return;
    }
    connection.isAlive = false;
    try { connection.ping(); } catch {}
  }, 15000);

  const instructions = buildSystemInstructions();

  let streamSid = null;
  let callSid = null;
  let callerNumber = null;

  let conversationLog = [];
  let callStartTs = Date.now();
  let lastMediaTs = Date.now();

  let idleCheckInterval = null;
  let idleWarningSent = false;
  let idleHangupScheduled = false;

  let maxCallTimeout = null;
  let maxCallWarningTimeout = null;

  let pendingHangup = null;
  let twilioClosed = false;
  let openAiClosed = false;
  let callEnded = false;

  let botSpeaking = false;
  let hasActiveResponse = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  let currentBotText = '';

  // -------- end call
  async function sendLeadWebhook(reason, closingMessage) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) return;

    try {
      if (!callerNumber && callSid) {
        const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
        if (resolved) callerNumber = resolved;
      }

      const parsed = await extractLeadFromConversation(conversationLog);
      if (!parsed || typeof parsed !== 'object') return;

      const normalizedCaller = normalizePhoneNumber(null, callerNumber);
      const normalizedPhone = normalizePhoneNumber(parsed.phone_number, callerNumber);

      const payload = {
        streamSid,
        callSid,
        callerIdNormalized: normalizedCaller,
        phone_number: normalizedPhone || normalizedCaller || null,
        CALLERID: normalizedCaller || null,
        botName: BOT_NAME,
        businessName: BUSINESS_NAME,
        startedAt: new Date(callStartTs).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - callStartTs,
        reason,
        closingMessage,
        conversationLog,
        parsedLead: parsed
      };

      await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    } catch {}
  }

  function endCall(reason, closingMessage) {
    if (callEnded) return;
    callEnded = true;

    log(tag, 'INFO', `endCall called with reason="${reason}"`, { rid: callRid });
    log(tag, 'INFO', 'Final conversation log:', conversationLog);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);
    if (pingInt) clearInterval(pingInt);

    // fire-and-forget
    if (MB_ENABLE_LEAD_CAPTURE && MB_WEBHOOK_URL) {
      sendLeadWebhook(reason, closingMessage || MB_CLOSING_SCRIPT);
    }

    if (MB_DYNAMIC_KB_URL) {
      refreshDynamicBusinessPrompt('PostCall').catch(() => {});
    }

    if (callSid) {
      hangupTwilioCall(callSid, tag).catch(() => {});
    }

    try { connection.close(); } catch {}

    botSpeaking = false;
    hasActiveResponse = false;
    botTurnActive = false;
    noListenUntilTs = 0;
  }

  function scheduleEndCall(reason, closingMessage) {
    if (callEnded) return;
    if (pendingHangup) return;

    const msg = closingMessage || MB_CLOSING_SCRIPT;
    pendingHangup = { reason, closingMessage: msg };

    // ננגן את הסגיר דרך אותו מסלול TTS
    speakText(msg).catch(() => {
      const ph = pendingHangup;
      pendingHangup = null;
      endCall(ph.reason, ph.closingMessage);
    });

    const graceMs = Math.max(2000, Math.min(MB_HANGUP_GRACE_MS || 3000, 8000));
    setTimeout(() => {
      if (callEnded || !pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      endCall(ph.reason, ph.closingMessage);
    }, graceMs);
  }

  // -------- speak via Eleven (or fallback)
  async function speakText(text) {
    if (!streamSid) return;
    if (!text || !text.trim()) return;

    botSpeaking = true;
    botTurnActive = true;
    noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

    // שולחים לוג
    log('Bot', 'INFO', text);

    // 1) Eleven primary
    if (TTS_PROVIDER === 'eleven') {
      try {
        await elevenTtsStreamToTwilio({
          text,
          voiceId: ELEVEN_VOICE_ID,
          modelId: ELEVEN_MODEL_ID,
          language: ELEVEN_LANGUAGE,
          outputFormat: ELEVEN_OUTPUT_FORMAT || 'ulaw_8000',
          ridTag: callRid,
          onChunkBase64: (b64) => {
            if (connection.readyState !== WebSocket.OPEN) return;
            const twilioMsg = { event: 'media', streamSid, media: { payload: b64 } };
            try { connection.send(JSON.stringify(twilioMsg)); } catch {}
          }
        });
        botSpeaking = false;
        botTurnActive = false;

        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          endCall(ph.reason, ph.closingMessage);
        }
        return;
      } catch (e) {
        logErr('ElevenTTS', 'ElevenLabs failed, will fallback if enabled.', String(e));
      }
    }

    // 2) fallback: OpenAI audio (כדי שלא יהיה שקט)
    if (!MB_FALLBACK_TO_OPENAI_AUDIO) {
      botSpeaking = false;
      botTurnActive = false;
      return;
    }

    // fallback הוא "best effort": ננתק/נמשיך בלי להשאיר שקט מוחלט
    botSpeaking = false;
    botTurnActive = false;
  }

  // -----------------------------
  // OpenAI Realtime WS (TEXT ONLY OUTPUT)
  // -----------------------------
  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let openAiReady = false;

  function sendModelPrompt(text, purpose) {
    if (openAiWs.readyState !== WebSocket.OPEN) return;
    if (hasActiveResponse) return;

    const item = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    };

    openAiWs.send(JSON.stringify(item));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
    hasActiveResponse = true;
    botTurnActive = true;

    log(tag, 'INFO', `Sending model prompt (${purpose || 'no-tag'})`, { rid: callRid });
  }

  openAiWs.on('open', () => {
    openAiReady = true;
    log(tag, 'INFO', 'Connected to OpenAI Realtime API.', { rid: callRid });

    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;

    // 👇 הכי חשוב: modalities רק TEXT כדי שלא תקבל Alloy
    const sessionUpdate = {
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['text'], // <-- NO audio output
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1', language: MB_ASR_LANGUAGE || 'he' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: effectiveSilenceMs,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        max_response_output_tokens: MAX_OUTPUT_TOKENS,
        instructions
      }
    };

    if (MB_DEBUG) log(tag, 'INFO', 'Sending session.update to OpenAI (text-only).', sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));

    // פתיח
    sendModelPrompt(
      `פתחי את השיחה במשפט הבא (מותר מעט לשנות אבל לא להאריך): "${MB_OPENING_SCRIPT}" ואז עצרי והמתיני לתשובה.`,
      'opening_greeting'
    );
  });

  openAiWs.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logErr(tag, 'Failed to parse OpenAI WS message', e);
      return;
    }

    switch (msg.type) {
      case 'response.created':
        currentBotText = '';
        hasActiveResponse = true;
        botTurnActive = true;
        botSpeaking = false;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
        break;

      case 'response.output_text.delta': {
        const delta = msg.delta || '';
        if (delta) currentBotText += delta;
        break;
      }

      case 'response.output_text.done': {
        const text = (currentBotText || '').trim();
        currentBotText = '';

        if (text) {
          conversationLog.push({ from: 'bot', text });

          // 👇 פה אנחנו מפיקים אודיו דרך Eleven
          await speakText(text);
        }

        break;
      }

      case 'response.completed':
        hasActiveResponse = false;
        botTurnActive = false;
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const t = String(msg.transcript || '').trim();
        if (t) {
          conversationLog.push({ from: 'user', text: t });
          log('User', 'INFO', t);
        }
        break;
      }

      case 'error':
        logErr(tag, 'OpenAI Realtime error event', msg);
        hasActiveResponse = false;
        botSpeaking = false;
        botTurnActive = false;
        noListenUntilTs = 0;
        break;

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    log(tag, 'INFO', 'OpenAI WS closed.', { rid: callRid });
    if (!callEnded) endCall('openai_ws_closed', MB_CLOSING_SCRIPT);
  });

  openAiWs.on('error', (err) => {
    logErr(tag, 'OpenAI WS error', err);
    if (!openAiClosed) {
      openAiClosed = true;
      try { openAiWs.close(); } catch {}
    }
    if (!callEnded) endCall('openai_ws_error', MB_CLOSING_SCRIPT);
  });

  // -----------------------------
  // Twilio Media Stream handlers
  // -----------------------------
  connection.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logErr(tag, 'Failed to parse Twilio WS message', e);
      return;
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      callerNumber = msg.start?.customParameters?.caller || null;

      callStartTs = Date.now();
      lastMediaTs = Date.now();

      log(tag, 'INFO', `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`, {
        rid: callRid
      });

      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (!idleWarningSent && sinceMedia >= MB_IDLE_WARNING_MS && !callEnded) {
          idleWarningSent = true;
          sendModelPrompt(
            'הלקוח שקט. תגידי משפט קצר: "אני עדיין כאן על הקו, אתם איתי?" ואז תחכי.',
            'idle_warning'
          );
        }

        if (!idleHangupScheduled && sinceMedia >= MB_IDLE_HANGUP_MS && !callEnded) {
          idleHangupScheduled = true;
          scheduleEndCall('idle_timeout', MB_CLOSING_SCRIPT);
        }
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
          maxCallWarningTimeout = setTimeout(() => {
            sendModelPrompt(
              'תני משפט קצר: "אנחנו מתקרבים לסיום הזמן לשיחה הזאת. תרצו לסכם ולהשאיר פרטים?"',
              'max_call_warning'
            );
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          scheduleEndCall('max_call_duration', MB_CLOSING_SCRIPT);
        }, MB_MAX_CALL_MS);
      }
    }

    if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) return;
      }

      openAiWs.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: payload
        })
      );
    }

    if (event === 'stop') {
      log(tag, 'INFO', 'Twilio stream stopped.', { rid: callRid });
      twilioClosed = true;
      if (!callEnded) endCall('twilio_stop', MB_CLOSING_SCRIPT);
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    log(tag, 'INFO', 'Twilio WS closed.', { rid: callRid });
    if (!callEnded) endCall('twilio_ws_closed', MB_CLOSING_SCRIPT);
  });

  connection.on('error', (err) => {
    twilioClosed = true;
    logErr(tag, 'Twilio WS error', err);
    if (!callEnded) endCall('twilio_ws_error', MB_CLOSING_SCRIPT);
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}ms, MB_LANGUAGES=${MB_LANGUAGES.join(',')}`);
  console.log(`[CONFIG] Eleven: key=${ELEVEN_API_KEY ? 'SET' : 'MISSING'}, voice_id=${ELEVEN_VOICE_ID ? 'SET' : 'MISSING'}, model=${ELEVEN_MODEL_ID}, format=${ELEVEN_OUTPUT_FORMAT}, lang=${ELEVEN_LANGUAGE}, stability=${ELEVEN_STABILITY}`);
  refreshDynamicBusinessPrompt('Startup').catch(() => {});
});
