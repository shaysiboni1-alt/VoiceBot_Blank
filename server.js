// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (gpt-4o-realtime-preview-2024-12-17)
//
// חוקים עיקריים לפי ה-MASTER PROMPT:
// - שיחה בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
// - שליטה מלאה דרך ENV (פתיח, סגיר, פרומפט כללי, KB עסקי, טיימרים, לידים, VAD).
// - טיימר שקט + ניתוק אוטומטי + מגבלת זמן שיחה.
// - לוג שיחה + וובהוק לידים (אם מופעל) + PARSING חכם ללידים.
//
// דרישות:
//   npm install express ws dotenv
//   (מומלץ Node 18+ כדי ש-fetch יהיה זמין גלובלית)
//
// Twilio Voice Webhook ->  POST /twilio-voice  (TwiML)
// Twilio Media Streams -> wss://<domain>/twilio-media-stream
//
// גרסה זו:
// - OpenAI: LLM + STT (text modality בלבד) לשיפור latency.
// - ElevenLabs: TTS STREAMING ulaw_8000 (מתאים ל-Twilio Media Streams) + abort + cache + queue.
// - Barge-in אמיתי: speech_started עוצר TTS ומבטל response ב-OpenAI.
//
// ------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
function envStr(name, def = '') {
  const v = process.env[name];
  return v !== undefined && v !== null && String(v).trim() ? String(v).trim() : def;
}

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'שלום, הגעתם ל-BluBinet – פתרונות טלפוניה חכמים בענן לעסקים. שמי נטע, איך אפשר לעזור לכם היום?'
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

// דיבור (משפיע על Eleven: אנחנו משתמשים בזה על "length_scale" / "speed hint" בצורה עדינה)
const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 0.95);

// MAX_OUTPUT_TOKENS – תמיד מספר או "inf"
const MAX_OUTPUT_TOKENS_ENV = process.env.MAX_OUTPUT_TOKENS;
let MAX_OUTPUT_TOKENS = 'inf';
if (MAX_OUTPUT_TOKENS_ENV) {
  const n = Number(MAX_OUTPUT_TOKENS_ENV);
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_TOKENS = n;
  else if (MAX_OUTPUT_TOKENS_ENV === 'inf') MAX_OUTPUT_TOKENS = 'inf';
}

// Debug
const MB_DEBUG = envBool('MB_DEBUG', false);

// VAD – ברירות מחדל מחוזקות לרעשי רקע
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000); // 40 שניות
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);  // 90 שניות
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 5000);

// barge-in
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', true);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// לידים / וובהוק
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = envStr('MB_WEBHOOK_URL', '');

// PARSING חכם ללידים
const MB_ENABLE_SMART_LEAD_PARSING = envBool('MB_ENABLE_SMART_LEAD_PARSING', true);
const MB_LEAD_PARSING_MODEL = envStr('MB_LEAD_PARSING_MODEL', 'gpt-4.1-mini');

// Twilio credentials לניתוק אקטיבי + שליפת פרטי שיחה
const TWILIO_ACCOUNT_SID = envStr('TWILIO_ACCOUNT_SID', '');
const TWILIO_AUTH_TOKEN = envStr('TWILIO_AUTH_TOKEN', '');

// -----------------------------
// ElevenLabs ENV (תואם למה שיש לך)
// -----------------------------
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase(); // "eleven"
const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', '');
const ELEVEN_VOICE_ID = envStr('ELEVEN_VOICE_ID', '') || envStr('VOICE_ID', '');
const ELEVENLABS_MODEL_ID = envStr('ELEVENLABS_MODEL_ID', '') || envStr('ELEVEN_TTS_MODEL', '') || 'eleven_v3';
const ELEVENLABS_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', '') || envStr('ELEVEN_LANGUAGE', '') || 'he';

// stability חייב להיות אחד מ: 0.0 / 0.5 / 1.0
function normalizeStability(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  if (n <= 0.25) return 0.0;
  if (n <= 0.75) return 0.5;
  return 1.0;
}
const ELEVENLABS_STABILITY = normalizeStability(envStr('ELEVENLABS_STABILITY', '0.5'));
const ELEVENLABS_STYLE = envNumber('ELEVENLABS_STYLE', 0.15);
const ELEVENLABS_USE_BOOST = envBool('ELEVENLABS_USE_BOOST', true);
const ELEVENLABS_TIMEOUT_MS = envNumber('ELEVENLABS_TIMEOUT_MS', 2200);

// קריטי לטוויליו: ulaw_8000 בלבד
const ELEVEN_OUTPUT_FORMAT = 'ulaw_8000';

console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS} ms, MB_LANGUAGES=${MB_LANGUAGES.join(',')}`);
console.log(`[CONFIG] TTS_PROVIDER=${TTS_PROVIDER}, ELEVEN_VOICE_ID=${ELEVEN_VOICE_ID ? 'SET' : 'MISSING'}, ELEVENLABS_MODEL_ID=${ELEVENLABS_MODEL_ID}, ELEVENLABS_LANGUAGE=${ELEVENLABS_LANGUAGE}, ELEVEN_OUTPUT_FORMAT=${ELEVEN_OUTPUT_FORMAT}, ELEVENLABS_STABILITY=${ELEVENLABS_STABILITY}`);

// -----------------------------
// Dynamic KB from URL
// -----------------------------
const MB_DYNAMIC_KB_URL = envStr('MB_DYNAMIC_KB_URL', '');
let dynamicBusinessPrompt = '';
let lastDynamicKbRefreshAt = 0;
const MB_DYNAMIC_KB_MIN_INTERVAL_MS = envNumber('MB_DYNAMIC_KB_MIN_INTERVAL_MS', 5 * 60 * 1000);

async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) {
    if (MB_DEBUG) console.log(`[DEBUG][${tag}] MB_DYNAMIC_KB_URL is empty – skip refresh.`);
    return;
  }
  const now = Date.now();
  if (tag !== 'Startup' && now - lastDynamicKbRefreshAt < MB_DYNAMIC_KB_MIN_INTERVAL_MS) {
    console.log(`[INFO][${tag}] Skipping dynamic KB refresh – refreshed ${now - lastDynamicKbRefreshAt} ms ago (min interval ${MB_DYNAMIC_KB_MIN_INTERVAL_MS} ms).`);
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
// Helpers – logging
// -----------------------------
function logDebug(tag, msg, extra) {
  if (!MB_DEBUG) return;
  if (extra !== undefined) console.log(`[DEBUG][${tag}] ${msg}`, extra);
  else console.log(`[DEBUG][${tag}] ${msg}`);
}
function logInfo(tag, msg, extra) {
  if (extra !== undefined) console.log(`[INFO][${tag}] ${msg}`, extra);
  else console.log(`[INFO][${tag}] ${msg}`);
}
function logError(tag, msg, extra) {
  if (extra !== undefined) console.error(`[ERROR][${tag}] ${msg}`, extra);
  else console.error(`[ERROR][${tag}] ${msg}`);
}

// -----------------------------
// Helper – נורמליזציה למספר טלפון ישראלי
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
    const prefix2 = digits.slice(0, 2);
    if (digits.length === 9) return ['02', '03', '04', '07', '08', '09'].includes(prefix2);
    if (digits.length === 10) {
      if (prefix2 === '05' || prefix2 === '07') return true;
      if (['02', '03', '04', '07', '08', '09'].includes(prefix2)) return true;
      return false;
    }
    return false;
  }
  function clean(num) {
    let digits = toDigits(num);
    if (!digits) return null;
    digits = normalize972(digits);
    if (!isValidIsraeliPhone(digits)) return null;
    return digits;
  }
  const fromLead = clean(rawPhone);
  if (fromLead) return fromLead;
  const fromCaller = clean(callerNumber);
  if (fromCaller) return fromCaller;
  return null;
}

// -----------------------------
// System instructions builder
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים (גבוהים מהפרומפט העסקי):
1. אל תתייחסי למוזיקה, רעשים או איכות הקו, גם אם את מזהה אותם. התייחסי רק לתוכן מילולי שנשמע כמו דיבור מכוון אלייך. אם לא הבנת משפט – אמרי בקצרה משהו כמו: "לא שמעתי טוב, אפשר לחזור על זה?" בלי לתאר את הרעש.
2. לעולם אל תחליטי לסיים שיחה רק בגלל מילים שהלקוח אמר (כמו "תודה", "זהו", "לא צריך" וכדומה). המשיכי לענות באופן רגיל עד שמערכת הטלפון מסיימת את השיחה או עד שמבקשים ממך במפורש מתוך ההנחיות הטכניות לומר את משפט הסיום המלא.
3. כאשר את מתבקשת לסיים שיחה, אמרי את משפט הסיום המדויק שהוגדר במערכת בלבד, בלי להוסיף ובלי לשנות.
4. שמרי על תשובות קצרות, ברורות וממוקדות (בדרך-כלל עד 2–3 משפטים), אלא אם הלקוח ביקש הסבר מפורט.
5. כאשר השיחה מגיעה באופן טבעי לסיום – אל תסיימי מיד. קודם שאלי: "לפני שאני מסיימת, יש עוד משהו שתרצו או שהכול ברור?" ואם הלקוח אומר שלא – אז אמרי רק את משפט הסיום המדויק.
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
אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור שירות "${BUSINESS_NAME}".
דברו בטון נעים, מקצועי וקצר, ברירת המחדל היא עברית, ותמיד התאימו את עצמכם ללקוח.
`.trim();
  }

  instructions += '\n\n' + EXTRA_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Closing normalize
// -----------------------------
function normalizeForClosing(text) {
  return (text || '')
    .toLowerCase()
    .replace(/["'״׳]/g, '')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const NORMALIZED_CLOSING_SCRIPT = normalizeForClosing(MB_CLOSING_SCRIPT);

// -----------------------------
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio Voice webhook – מחזיר TwiML שמחבר את השיחה ל־Media Streams
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

  logInfo('Twilio-Voice', `Returning TwiML with Stream URL: ${wsUrl}, From=${caller}`);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Smart lead parsing helper
// -----------------------------
async function extractLeadFromConversation(conversationLog) {
  const tag = 'LeadParse';

  if (!MB_ENABLE_SMART_LEAD_PARSING) {
    logDebug(tag, 'Smart lead parsing disabled via ENV.');
    return null;
  }
  if (!OPENAI_API_KEY) {
    logError(tag, 'Missing OPENAI_API_KEY for lead parsing.');
    return null;
  }
  if (!Array.isArray(conversationLog) || conversationLog.length === 0) {
    logDebug(tag, 'Empty conversationLog – skipping lead parsing.');
    return null;
  }

  try {
    const conversationText = conversationLog
      .map((m) => `${m.from === 'user' ? 'לקוח' : BOT_NAME}: ${m.text}`)
      .join('\n');

    const systemPrompt = `
אתה מנתח שיחות טלפון בעברית (ולעתים גם בשפות אחרות) בין לקוח לבין בוט שירות.
תפקידך להוציא JSON אחד בלבד לפי הסכמה:

{
  "is_lead": boolean,
  "lead_type": "new" | "existing" | "unknown",
  "full_name": string | null,
  "business_name": string | null,
  "phone_number": string | null,
  "reason": string | null,
  "notes": string | null
}

כללים:
- "phone_number": רק אם נאמר/נכתב בשיחה. בלי +972. בלי רווחים.
- אל תנחש מספר.
- אם זו בדיקה/סימולציה – is_lead=false.
החזר אך ורק JSON תקין, בלי טקסט נוסף.
`.trim();

    const userPrompt = `
תמלול שיחה בין לקוח ובוט בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}":

${conversationText}
`.trim();

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

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logError(tag, `OpenAI lead parsing HTTP ${response.status}`, text);
      return null;
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) {
      logError(tag, 'No content in lead parsing response.');
      return null;
    }

    let parsed = null;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      parsed = raw;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      logError(tag, 'Parsed lead is not an object.', parsed);
      return null;
    }

    logInfo(tag, 'Lead parsed successfully.', parsed);
    return parsed;
  } catch (err) {
    logError(tag, 'Error in extractLeadFromConversation', err);
    return null;
  }
}

// -----------------------------
// Twilio helpers
// -----------------------------
async function hangupTwilioCall(callSid, tag = 'Call') {
  if (!callSid) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    logDebug(tag, 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing – cannot hang up via Twilio API.');
    return;
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(tag, `Twilio hangup HTTP ${res.status}`, txt);
    } else {
      logInfo(tag, 'Twilio call hangup requested successfully.');
    }
  } catch (err) {
    logError(tag, 'Error calling Twilio hangup API', err);
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
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
      }
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(tag, `fetchCallerNumberFromTwilio HTTP ${res.status}`, txt);
      return null;
    }

    const data = await res.json();
    const fromRaw = data.from || data.caller_name || null;
    logInfo(tag, `fetchCallerNumberFromTwilio: resolved caller="${fromRaw}" from Twilio Call resource.`);
    return fromRaw;
  } catch (err) {
    logError(tag, 'fetchCallerNumberFromTwilio: error', err);
    return null;
  }
}

// -----------------------------
// ElevenLabs TTS: streaming + cache + queue
// -----------------------------
const TTS_CACHE_MAX = envNumber('TTS_CACHE_MAX', 50);
const ttsCache = new Map(); // key -> Buffer (ulaw)
function cacheGet(key) {
  const v = ttsCache.get(key);
  if (!v) return null;
  // refresh LRU
  ttsCache.delete(key);
  ttsCache.set(key, v);
  return v;
}
function cacheSet(key, buf) {
  ttsCache.set(key, buf);
  while (ttsCache.size > TTS_CACHE_MAX) {
    const firstKey = ttsCache.keys().next().value;
    ttsCache.delete(firstKey);
  }
}
function ttsCacheKey(text) {
  const base = `${ELEVEN_VOICE_ID}|${ELEVENLABS_MODEL_ID}|${ELEVENLABS_LANGUAGE}|${ELEVEN_OUTPUT_FORMAT}|${ELEVENLABS_STABILITY}|${ELEVENLABS_STYLE}|${ELEVENLABS_USE_BOOST}|${MB_SPEECH_SPEED}|${text}`;
  // hash קצר
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = ((hash << 5) - hash) + base.charCodeAt(i), hash |= 0;
  return String(hash);
}

async function elevenTtsStreamToTwilio({
  text,
  onAudioChunk,          // (b64) => void
  signal,                // AbortSignal
  tag = 'ElevenTTS'
}) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    throw new Error('Missing ELEVEN_API_KEY or VOICE_ID (ELEVEN_VOICE_ID)');
  }

  // cache
  const key = ttsCacheKey(text);
  const cached = cacheGet(key);
  if (cached) {
    logInfo(tag, `Cache hit. bytes=${cached.length}`);
    // שולחים בבאפרים קטנים כדי לא לחנוק WS
    const chunkSize = 3200; // ~200ms ulaw
    for (let i = 0; i < cached.length; i += chunkSize) {
      if (signal?.aborted) return;
      const slice = cached.subarray(i, Math.min(i + chunkSize, cached.length));
      onAudioChunk(slice.toString('base64'));
      await new Promise((r) => setTimeout(r, 0));
    }
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream?output_format=${encodeURIComponent(ELEVEN_OUTPUT_FORMAT)}`;

  const body = {
    text,
    model_id: ELEVENLABS_MODEL_ID,
    voice_settings: {
      stability: ELEVENLABS_STABILITY,
      similarity_boost: 0.85,
      style: ELEVENLABS_STYLE,
      use_speaker_boost: !!ELEVENLABS_USE_BOOST
    }
  };

  // language override (אם קיים)
  if (ELEVENLABS_LANGUAGE) {
    body.language = ELEVENLABS_LANGUAGE;
  }

  // timeout + abort
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
  const combinedSignal = signal
    ? new AbortController()
    : null;

  // אם יש signal חיצוני + פנימי: מחברים
  if (signal && combinedSignal) {
    const onAbort = () => combinedSignal.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    controller.signal.addEventListener('abort', onAbort, { once: true });
  }

  const finalSignal = combinedSignal ? combinedSignal.signal : controller.signal;

  logInfo(tag, 'Sending text to ElevenLabs TTS.', {
    length: text.length,
    model: ELEVENLABS_MODEL_ID,
    language: ELEVENLABS_LANGUAGE,
    format: ELEVEN_OUTPUT_FORMAT,
    stability: ELEVENLABS_STABILITY
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/octet-stream'
    },
    body: JSON.stringify(body),
    signal: finalSignal
  }).finally(() => clearTimeout(t));

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS HTTP ${res.status} ${txt}`);
  }

  const chunks = [];
  const reader = res.body.getReader();
  while (true) {
    if (finalSignal.aborted) return;
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      const buf = Buffer.from(value);
      chunks.push(buf);
      onAudioChunk(buf.toString('base64'));
    }
  }

  const full = Buffer.concat(chunks);
  logInfo(tag, `ElevenLabs TTS audio received. length=${full.length} bytes`);
  cacheSet(key, full);
}

// -----------------------------
// Per-call handler
// -----------------------------
wss.on('connection', (connection, req) => {
  const tag = 'Call';
  logInfo(tag, 'New Twilio Media Stream connection established.');

  if (!OPENAI_API_KEY) {
    logError(tag, 'OPENAI_API_KEY missing – closing connection.');
    connection.close();
    return;
  }

  const instructions = buildSystemInstructions();

  let streamSid = null;
  let callSid = null;
  let callerNumber = null;

  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let conversationLog = [];
  let callStartTs = Date.now();
  let lastMediaTs = Date.now();
  let idleCheckInterval = null;
  let idleWarningSent = false;
  let idleHangupScheduled = false;
  let maxCallTimeout = null;
  let maxCallWarningTimeout = null;
  let pendingHangup = null;

  let openAiReady = false;
  let twilioClosed = false;
  let openAiClosed = false;
  let callEnded = false;

  // bot state
  let botSpeaking = false;
  let hasActiveResponse = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  let userHasSpoken = false;
  let leadWebhookSent = false;

  // -----------------------------
  // TTS queue + abort
  // -----------------------------
  let ttsAbortController = null;
  let ttsQueue = [];
  let ttsRunning = false;
  let currentBotFullText = '';
  let currentSpokenCursor = 0;

  function abortTts(tag2 = 'ElevenTTS') {
    if (ttsAbortController) {
      try { ttsAbortController.abort(); } catch {}
      ttsAbortController = null;
      logDebug(tag2, 'TTS aborted.');
    }
    ttsQueue = [];
    ttsRunning = false;
    botSpeaking = false;
  }

  function sendTwilioAudioB64(b64) {
    if (!b64 || !streamSid) return;
    if (connection.readyState !== WebSocket.OPEN) return;
    const twilioMsg = {
      event: 'media',
      streamSid,
      media: { payload: b64 }
    };
    connection.send(JSON.stringify(twilioMsg));
  }

  async function runTtsQueue() {
    if (ttsRunning) return;
    ttsRunning = true;

    while (ttsQueue.length && !callEnded && connection.readyState === WebSocket.OPEN) {
      const text = ttsQueue.shift();
      if (!text) continue;

      botSpeaking = true;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      // Abort controller per item
      ttsAbortController = new AbortController();
      const signal = ttsAbortController.signal;

      try {
        await elevenTtsStreamToTwilio({
          text,
          signal,
          onAudioChunk: (b64) => {
            if (callEnded || signal.aborted) return;
            sendTwilioAudioB64(b64);
          },
          tag: 'ElevenTTS'
        });
      } catch (err) {
        if (signal.aborted) {
          // cancelled by barge-in
          break;
        }
        logError('ElevenTTS', 'TTS error', String(err?.message || err));
        break;
      } finally {
        ttsAbortController = null;
      }

      botSpeaking = false;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      if (pendingHangup && !callEnded && ttsQueue.length === 0) {
        // אם זו הסגירה – ניתוק אחרי grace קצר
        const ph = pendingHangup;
        pendingHangup = null;
        setTimeout(() => {
          if (!callEnded) endCall(ph.reason, ph.closingMessage);
        }, Math.max(800, Math.min(MB_HANGUP_GRACE_MS, 5000)));
      }
    }

    ttsRunning = false;
  }

  function enqueueTts(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    ttsQueue.push(clean);
    runTtsQueue().catch(() => {});
  }

  // chunking: מחלקים טקסט תוך כדי deltas, כדי להתחיל לדבר מהר
  function maybeEnqueueNewSpokenChunks() {
    const text = currentBotFullText;
    if (!text || text.length <= currentSpokenCursor) return;

    const remaining = text.slice(currentSpokenCursor);

    // מחפשים גבול טוב: סוף משפט/פסיק/נקודה/שאלה/סימן קריאה
    const boundaryMatch = remaining.match(/^([\s\S]{1,220}?)([\.!\?]|…|\n|,|:|;)\s/);
    let chunk = '';

    if (boundaryMatch) {
      chunk = (boundaryMatch[1] + boundaryMatch[2]).trim();
    } else {
      // אם אין סימן פיסוק – אחרי מינימום תווים
      if (remaining.length >= 80) {
        chunk = remaining.slice(0, 120).trim();
      }
    }

    if (!chunk) return;

    currentSpokenCursor += chunk.length;
    enqueueTts(chunk);
  }

  // -----------------------------
  // Helper: שליחת טקסט למודל + response.create (מונע כפילויות)
  // -----------------------------
  function sendModelPrompt(text, purpose) {
    if (openAiWs.readyState !== WebSocket.OPEN) {
      logDebug(tag, `Cannot send model prompt (${purpose || 'no-tag'}) – WS not open.`);
      return;
    }
    if (hasActiveResponse) {
      logDebug(tag, `Skipping model prompt (${purpose || 'no-tag'}) – active response exists.`);
      return;
    }
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
    logInfo(tag, `Sending model prompt (${purpose || 'no-tag'})`);
  }

  // -----------------------------
  // Helper: האם הלקוח הזכיר מזוהה
  // -----------------------------
  function conversationMentionsCallerId() {
    const patterns = [/מזוהה/, /למספר שממנו/, /למספר שממנו אני מתקשר/, /למספר שממנו התקשרתי/];
    return conversationLog.some(
      (m) => m.from === 'user' && patterns.some((re) => re.test(m.text || ''))
    );
  }

  // -----------------------------
  // Helper: שליחת webhook – פעם אחת בלבד ורק אם ליד מלא
  // -----------------------------
  async function sendLeadWebhook(reason, closingMessage) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) {
      logDebug(tag, 'Lead capture disabled or no MB_WEBHOOK_URL – skipping webhook.');
      return;
    }
    if (leadWebhookSent) {
      logDebug(tag, 'Lead webhook already sent for this call – skipping.');
      return;
    }

    try {
      if (!callerNumber && callSid) {
        const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
        if (resolved) callerNumber = resolved;
      }

      const parsedLead = await extractLeadFromConversation(conversationLog);

      if (!parsedLead || typeof parsedLead !== 'object') {
        logInfo(tag, 'No parsed lead object – skipping webhook (לא ליד מלא).');
        return;
      }

      if (!parsedLead.phone_number && callerNumber) {
        parsedLead.phone_number = callerNumber;
        const suffixNote = conversationMentionsCallerId()
          ? 'הלקוח ביקש חזרה למספר המזוהה ממנו התקשר.'
          : 'לא נמסר מספר טלפון מפורש בשיחה – נעשה שימוש במספר המזוהה מהמערכת.';
        parsedLead.notes = (parsedLead.notes || '') + (parsedLead.notes ? ' ' : '') + suffixNote;
      }

      const normalizedPhone = normalizePhoneNumber(parsedLead.phone_number, callerNumber);
      parsedLead.phone_number = normalizedPhone;

      const callerDigits = normalizePhoneNumber(null, callerNumber);
      const callerIdRaw = callerDigits || (callerNumber ? String(callerNumber).replace(/\D/g, '') : null);
      const callerIdNormalized = callerDigits || callerIdRaw;

      parsedLead.caller_id_raw = callerIdRaw;
      parsedLead.caller_id_normalized = callerIdNormalized;

      if (!parsedLead.business_name || typeof parsedLead.business_name !== 'string' || !parsedLead.business_name.trim()) {
        parsedLead.business_name = 'לא רלוונטי';
      }

      const isFullLead = parsedLead.is_lead === true && !!parsedLead.phone_number;

      if (!isFullLead) {
        logInfo(tag, 'Parsed lead is NOT full lead – webhook will NOT be sent.', {
          is_lead: parsedLead.is_lead,
          lead_type: parsedLead.lead_type,
          phone_number: parsedLead.phone_number
        });
        return;
      }

      const finalPhoneNumber = parsedLead.phone_number || callerIdNormalized || callerIdRaw;
      const finalCallerId = callerIdNormalized || callerIdRaw || null;

      const payload = {
        streamSid,
        callSid,
        callerNumber: callerIdRaw,
        callerIdRaw,
        callerIdNormalized,
        phone_number: finalPhoneNumber,
        CALLERID: finalCallerId,
        botName: BOT_NAME,
        businessName: BUSINESS_NAME,
        startedAt: new Date(callStartTs).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - callStartTs,
        reason,
        closingMessage,
        conversationLog,
        parsedLead,
        isFullLead
      };

      logInfo(tag, `Sending lead webhook to ${MB_WEBHOOK_URL}`);
      logInfo(tag, 'Lead webhook short summary', { phone_number: finalPhoneNumber, CALLERID: finalCallerId });

      leadWebhookSent = true;

      const res = await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) logError(tag, `Lead webhook HTTP ${res.status}`, await res.text());
      else logInfo(tag, `Lead webhook delivered successfully. status=${res.status}`);
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err);
    }
  }

  // -----------------------------
  // End call
  // -----------------------------
  function endCall(reason, closingMessage) {
    if (callEnded) {
      logDebug(tag, `endCall called again (${reason}) – already ended.`);
      return;
    }
    callEnded = true;

    logInfo(tag, `endCall called with reason="${reason}"`);
    logInfo(tag, 'Final conversation log:', conversationLog);

    abortTts();

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);

    if (MB_ENABLE_LEAD_CAPTURE && MB_WEBHOOK_URL) {
      sendLeadWebhook(reason, closingMessage || MB_CLOSING_SCRIPT).catch((err) =>
        logError(tag, 'sendLeadWebhook fire-and-forget error', err)
      );
    }

    if (MB_DYNAMIC_KB_URL) {
      refreshDynamicBusinessPrompt('PostCall').catch((err) =>
        logError(tag, 'DynamicKB post-call refresh failed', err)
      );
    }

    if (callSid) hangupTwilioCall(callSid, tag).catch(() => {});

    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiClosed = true;
      openAiWs.close();
    }
    if (!twilioClosed && connection.readyState === WebSocket.OPEN) {
      twilioClosed = true;
      connection.close();
    }

    botSpeaking = false;
    hasActiveResponse = false;
    botTurnActive = false;
    noListenUntilTs = 0;
  }

  function scheduleEndCall(reason, closingMessage) {
    if (callEnded) return;

    const msg = closingMessage || MB_CLOSING_SCRIPT;
    if (pendingHangup) {
      logDebug(tag, 'Hangup already scheduled, skipping duplicate.');
      return;
    }

    pendingHangup = { reason, closingMessage: msg };

    // אומרים את משפט הסגירה דרך המודל (כדי לשמור על אותו flow)
    sendModelPrompt(`סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף שום משפט נוסף: "${msg}"`, 'closing');

    // fallback: אם לא נקבל טקסט/דיבור בזמן סביר
    setTimeout(() => {
      if (callEnded || !pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      logInfo(tag, 'Closing fallback reached, forcing endCall.');
      endCall(ph.reason, ph.closingMessage);
    }, Math.max(2500, Math.min(MB_HANGUP_GRACE_MS + 2500, 9000)));
  }

  function checkBotClosing(fullText) {
    if (!fullText) return;
    const norm = normalizeForClosing(fullText);
    if (!norm || !NORMALIZED_CLOSING_SCRIPT) return;

    if (norm.includes(NORMALIZED_CLOSING_SCRIPT) || NORMALIZED_CLOSING_SCRIPT.includes(norm)) {
      logInfo(tag, `Detected configured bot closing phrase in output: "${fullText}"`);
      if (pendingHangup) {
        // כבר מתוזמן – רק נוודא שיסיים אחרי ה-TTS
        return;
      }
      pendingHangup = { reason: 'bot_closing_config', closingMessage: MB_CLOSING_SCRIPT };
      // אם אין TTS בתור – ננתק אחרי grace קצר
      if (!ttsRunning && ttsQueue.length === 0) {
        setTimeout(() => {
          if (!callEnded) endCall('bot_closing_config', MB_CLOSING_SCRIPT);
        }, Math.max(1200, Math.min(MB_HANGUP_GRACE_MS, 5000)));
      }
    }
  }

  function sendIdleWarningIfNeeded() {
    if (idleWarningSent || callEnded) return;
    idleWarningSent = true;
    const text = 'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
    sendModelPrompt(`תגיבי ללקוח במשפט קצר בסגנון הבא (אפשר לשנות קצת): "${text}"`, 'idle_warning');
  }

  // -----------------------------
  // OpenAI WS handlers
  // -----------------------------
  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, 'Connected to OpenAI Realtime API.');

    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;

    const sessionUpdate = {
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['text'], // 🔥 טקסט בלבד – אנחנו עושים TTS דרך Eleven
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
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

    logDebug(tag, 'Sending session.update to OpenAI.', sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));

    // פתיח: עדיין דרך המודל (כמו שביקשת), אבל עכשיו TTS יתחיל לדבר מהר כי אנחנו chunking
    sendModelPrompt(
      `פתחי את השיחה עם הלקוח במשפט הבא (אפשר לשנות מעט את הניסוח אבל לא להאריך): "${MB_OPENING_SCRIPT}" ואז עצרי והמתיני לתשובה שלו.`,
      'opening_greeting'
    );
  });

  openAiWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logError(tag, 'Failed to parse OpenAI WS message', err);
      return;
    }

    const type = msg.type;

    switch (type) {
      case 'response.created': {
        currentBotFullText = '';
        currentSpokenCursor = 0;
        hasActiveResponse = true;
        botTurnActive = true;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
        break;
      }

      case 'response.output_text.delta': {
        const delta = msg.delta || '';
        if (delta) {
          currentBotFullText += delta;
          // ננסה להתחיל לדבר מהר
          if (TTS_PROVIDER === 'eleven') maybeEnqueueNewSpokenChunks();
        }
        break;
      }

      case 'response.output_text.done': {
        const text = (currentBotFullText || '').trim();
        if (text) {
          conversationLog.push({ from: 'bot', text });
          logInfo('Bot', text);

          // דוחפים שאריות ל-TTS אם נשארו
          if (TTS_PROVIDER === 'eleven') {
            const remaining = text.slice(currentSpokenCursor).trim();
            if (remaining) enqueueTts(remaining);
          }

          checkBotClosing(text);
        }
        break;
      }

      case 'response.completed': {
        hasActiveResponse = false;
        botTurnActive = false;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
        break;
      }

      // אם המודל מזהה שהלקוח התחיל לדבר – barge-in
      case 'input_audio_buffer.speech_started': {
        userHasSpoken = true;

        if (MB_ALLOW_BARGE_IN) {
          // אם הבוט באמצע דיבור (TTS) – עוצרים מיד
          if (botSpeaking || ttsRunning || ttsQueue.length) {
            logInfo('BargeIn', 'User started speaking – aborting TTS + cancelling OpenAI response.');
            abortTts('ElevenTTS');

            // מבטלים את התגובה הנוכחית במודל (כדי שלא ימשיך לכתוב/לייצר)
            try {
              openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            } catch {}
            hasActiveResponse = false;
            botTurnActive = false;
          }
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcriptRaw = msg.transcript || '';
        let t = transcriptRaw.trim();
        if (t) {
          t = t.replace(/\s+/g, ' ').replace(/\s+([,.:;!?])/g, '$1');
          conversationLog.push({ from: 'user', text: t });
          logInfo('User', t);
          userHasSpoken = true;
        }
        break;
      }

      case 'error': {
        logError(tag, 'OpenAI Realtime error event', msg);
        hasActiveResponse = false;
        botTurnActive = false;
        break;
      }

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    logInfo(tag, 'OpenAI WS closed.');
    if (!callEnded) endCall('openai_ws_closed', MB_CLOSING_SCRIPT);
  });

  openAiWs.on('error', (err) => {
    logError(tag, 'OpenAI WS error', err);
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
    } catch (err) {
      logError(tag, 'Failed to parse Twilio WS message', err);
      return;
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      callerNumber = msg.start?.customParameters?.caller || null;

      callStartTs = Date.now();
      lastMediaTs = Date.now();

      logInfo(tag, `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`);

      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (!idleWarningSent && sinceMedia >= MB_IDLE_WARNING_MS && !callEnded) {
          sendIdleWarningIfNeeded();
        }
        if (!idleHangupScheduled && sinceMedia >= MB_IDLE_HANGUP_MS && !callEnded) {
          idleHangupScheduled = true;
          logInfo(tag, 'Idle timeout reached, scheduling endCall.');
          scheduleEndCall('idle_timeout', MB_CLOSING_SCRIPT);
        }
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
          maxCallWarningTimeout = setTimeout(() => {
            const t = 'אנחנו מתקרבים לסיום הזמן לשיחה הזאת. אם תרצו להתקדם, אפשר עכשיו לסכם ולהשאיר פרטים.';
            sendModelPrompt(`תני ללקוח משפט קצר בסגנון הבא (אפשר לשנות קצת): "${t}"`, 'max_call_warning');
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          logInfo(tag, 'Max call duration reached, scheduling endCall.');
          scheduleEndCall('max_call_duration', MB_CLOSING_SCRIPT);
        }, MB_MAX_CALL_MS);
      }
    }

    else if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      // אם לא מאפשרים barge-in: לא שומעים לקוח בזמן דיבור/זנב
      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) {
          logDebug('BargeIn', 'Ignoring media because bot speaking/tail', { botTurnActive, botSpeaking, now, noListenUntilTs });
          return;
        }
      }

      // מעבירים audio ל-OpenAI
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
    }

    else if (event === 'stop') {
      logInfo(tag, 'Twilio stream stopped.');
      twilioClosed = true;
      if (!callEnded) endCall('twilio_stop', MB_CLOSING_SCRIPT);
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logInfo(tag, 'Twilio WS closed.');
    if (!callEnded) endCall('twilio_ws_closed', MB_CLOSING_SCRIPT);
  });

  connection.on('error', (err) => {
    twilioClosed = true;
    logError(tag, 'Twilio WS error', err);
    if (!callEnded) endCall('twilio_ws_error', MB_CLOSING_SCRIPT);
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  refreshDynamicBusinessPrompt('Startup').catch((err) =>
    console.error('[ERROR][DynamicKB] initial load failed', err)
  );
});
