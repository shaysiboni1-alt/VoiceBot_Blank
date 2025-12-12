// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (gpt-4o-realtime-preview-2024-12-17)
// כולל תמיכה ב-TTS חיצוני של ElevenLabs (ulaw_8000 לטוויליו)

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

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in ENV.');
}

const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const MB_OPENING_SCRIPT =
  process.env.MB_OPENING_SCRIPT ||
  'שלום, הגעתם ל-BluBinet – פתרונות טלפוניה חכמים בענן לעסקים. שמי נטע, איך אפשר לעזור לכם היום?';

const MB_CLOSING_SCRIPT =
  process.env.MB_CLOSING_SCRIPT ||
  'תודה שדיברתם עם BluBinet. נציג יחזור אליכם בהקדם. יום נעים!';

const MB_GENERAL_PROMPT = process.env.MB_GENERAL_PROMPT || '';
const MB_BUSINESS_PROMPT = process.env.MB_BUSINESS_PROMPT || '';

const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// מהירות דיבור כללית לבוט (לשימוש ב-ElevenLabs)
const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 0.95);

// איזה ספק TTS משתמשים: openai (ברירת מחדל) או eleven
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'openai').toLowerCase();

// OpenAI Voice (אם עובדים עם OpenAI TTS)
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

// -------- ElevenLabs config ----------
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';

// Voice ID – קודם ELEVEN_VOICE_ID, אם אין אז VOICE_ID (כמו אצלך)
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || process.env.VOICE_ID || '';

// מודל: קודם ELEVEN_TTS_MODEL, אם אין – ELEVENLABS_MODEL_ID, ואם גם זה אין – ברירת מחדל
const ELEVEN_TTS_MODEL =
  process.env.ELEVEN_TTS_MODEL ||
  process.env.ELEVENLABS_MODEL_ID ||
  'eleven_v3';

// שפה: ELEVENLABS_LANGUAGE (למשל he)
const ELEVENLABS_LANGUAGE =
  process.env.ELEVENLABS_LANGUAGE ||
  process.env.ELEVEN_LANGUAGE ||
  'he';

// פורמט שכתוב ב-ENV (לוג בלבד)
const RAW_ELEVEN_OUTPUT_FORMAT =
  process.env.ELEVEN_OUTPUT_FORMAT ||
  process.env.ELEVENLABS_OUTPUT_FORMAT ||
  'ulaw_8000';

// בפועל לטוויליו **תמיד** שולחים ulaw_8000
const ELEVEN_OUTPUT_FORMAT = 'ulaw_8000';

// ניהול נכון של MAX_OUTPUT_TOKENS – תמיד מספר או "inf"
const MAX_OUTPUT_TOKENS_ENV = process.env.MAX_OUTPUT_TOKENS;
let MAX_OUTPUT_TOKENS = 'inf';
if (MAX_OUTPUT_TOKENS_ENV) {
  const n = Number(MAX_OUTPUT_TOKENS_ENV);
  if (Number.isFinite(n) && n > 0) {
    MAX_OUTPUT_TOKENS = n;
  } else if (MAX_OUTPUT_TOKENS_ENV === 'inf') {
    MAX_OUTPUT_TOKENS = 'inf';
  }
}

// Helper – נורמליזציה לטקסט לצורך זיהוי משפט סגירה
function normalizeForClosing(text) {
  return (text || '')
    .toLowerCase()
    .replace(/["'״׳]/g, '')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const NORMALIZED_CLOSING_SCRIPT = normalizeForClosing(MB_CLOSING_SCRIPT);

// VAD – ברירות מחדל מחוזקות לרעשי רקע
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);

// מגבלת זמן שיחה – ברירת מחדל 5 דקות
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 5000);

// Barge-in
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 1600);

// לידים / וובהוק
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL || '';

// PARSING חכם ללידים
const MB_ENABLE_SMART_LEAD_PARSING = envBool(
  'MB_ENABLE_SMART_LEAD_PARSING',
  true
);
const MB_LEAD_PARSING_MODEL =
  process.env.MB_LEAD_PARSING_MODEL || 'gpt-4.1-mini';

// Debug
const MB_DEBUG = envBool('MB_DEBUG', false);

// Twilio credentials
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

console.log(`[CONFIG] MB_HANGUP_GRACE_MS=${MB_HANGUP_GRACE_MS} ms`);
console.log(
  `[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS} ms, MB_LANGUAGES=${MB_LANGUAGES.join(
    ','
  )}`
);
console.log(
  `[CONFIG] TTS_PROVIDER=${TTS_PROVIDER}, ELEVEN_VOICE_ID=${
    ELEVEN_VOICE_ID ? 'SET' : 'MISSING'
  }, ELEVEN_TTS_MODEL=${ELEVEN_TTS_MODEL}, ELEVEN_OUTPUT_FORMAT=${ELEVEN_OUTPUT_FORMAT}, ELEVENLABS_LANGUAGE=${ELEVENLABS_LANGUAGE}, RAW_OUTPUT_FORMAT=${RAW_ELEVEN_OUTPUT_FORMAT}`
);

// -----------------------------
// Dynamic KB from Google Drive
// -----------------------------
const MB_DYNAMIC_KB_URL = process.env.MB_DYNAMIC_KB_URL || '';
let dynamicBusinessPrompt = '';

let lastDynamicKbRefreshAt = 0;
const MB_DYNAMIC_KB_MIN_INTERVAL_MS = envNumber(
  'MB_DYNAMIC_KB_MIN_INTERVAL_MS',
  5 * 60 * 1000
);

async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) {
    if (MB_DEBUG) {
      console.log(`[DEBUG][${tag}] MB_DYNAMIC_KB_URL is empty – skip refresh.`);
    }
    return;
  }

  const now = Date.now();
  if (tag !== 'Startup' && now - lastDynamicKbRefreshAt < MB_DYNAMIC_KB_MIN_INTERVAL_MS) {
    console.log(
      `[INFO][${tag}] Skipping dynamic KB refresh – refreshed ${
        now - lastDynamicKbRefreshAt
      } ms ago (min interval ${MB_DYNAMIC_KB_MIN_INTERVAL_MS} ms).`
    );
    return;
  }

  try {
    const res = await fetch(MB_DYNAMIC_KB_URL);
    if (!res.ok) {
      console.error(
        `[ERROR][${tag}] Failed to fetch dynamic KB. HTTP ${res.status}`
      );
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
// Logging helpers
// -----------------------------
function logDebug(tag, msg, extra) {
  if (!MB_DEBUG) return;
  if (extra !== undefined) {
    console.log(`[DEBUG][${tag}] ${msg}`, extra);
  } else {
    console.log(`[DEBUG][${tag}] ${msg}`);
  }
}

function logInfo(tag, msg, extra) {
  if (extra !== undefined) {
    console.log(`[INFO][${tag}] ${msg}`, extra);
  } else {
    console.log(`[INFO][${tag}] ${msg}`);
  }
}

function logError(tag, msg, extra) {
  if (extra !== undefined) {
    console.error(`[ERROR][${tag}] ${msg}`, extra);
  } else {
    console.error(`[ERROR][${tag}] ${msg}`);
  }
}

// -----------------------------
// Phone normalization helper
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

    if (digits.length === 9) {
      return ['02', '03', '04', '07', '08', '09'].includes(prefix2);
    } else {
      if (prefix2 === '05' || prefix2 === '07') return true;
      if (['02', '03', '04', '07', '08', '09'].includes(prefix2)) return true;
      return false;
    }
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
5. כאשר השיחה מגיעה באופן טבעי לסיום – אל תסיימי מיד. קודם שאלי "יש עוד משהו שתרצו או שהכול ברור?", ורק אם הלקוח אומר שאין לו עוד שאלות – השתמשי במשפט הסיום המוגדר.
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
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/twilio-voice', (req, res) => {
  const host = process.env.DOMAIN || req.headers.host;
  const wsUrl =
    process.env.MB_TWILIO_STREAM_URL ||
    `wss://${host.replace(/^https?:\/\//, '')}/twilio-media-stream`;

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

  logInfo(
    'Twilio-Voice',
    `Returning TwiML with Stream URL: ${wsUrl}, From=${caller}`
  );
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);

// -----------------------------
// WebSocket server
// -----------------------------
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
תפקידך להוציא JSON אחד בלבד שתואם בדיוק לסכמה הבאה:

{
  "is_lead": boolean,
  "lead_type": "new" | "existing" | "unknown",
  "full_name": string | null,
  "business_name": string | null,
  "phone_number": string | null,
  "reason": string | null,
  "notes": string | null
}

הסברים:
- "is_lead": true אם ברור שיש כאן פנייה עסקית / התעניינות אמיתית בשירות / הזמנת שירות. אחרת false.
- "lead_type": "new" אם מדובר בלקוח חדש, "existing" אם הוא מציין שהוא לקוח קיים, אחרת "unknown".
- "full_name": אם הלקוח נותן שם (פרטי או מלא) – כתוב כפי שנשמע. אם השם נאמר בעברית, כתוב אותו באותיות עבריות ולא באנגלית. אם לא ברור – null.
- "business_name": אם הלקוח מזכיר שם עסק – כתוב כפי שנשמע. אם שם העסק נאמר בעברית, כתוב אותו באותיות עבריות ולא באנגלית. אחרת null.
- "phone_number": אם בשיחה מופיע מספר טלפון של הלקוח – החזר אותו כרצף ספרות בלבד, בלי רווחים ובלי +972 ובלי להוריד 0 בהתחלה.
  אם נשמעים כמה מספרים – בחר את המספר הרלוונטי ביותר ליצירת קשר, אחרת null.
  אל תוסף ספרות שלא נאמרו, ואל תנחש מספר אם לא ברור.
  אם המספר שנשמע אינו באורך 10 ספרות או 9 ספרות, או שאינו מתחיל בקידומת תקינה – עדיף להחזיר phone_number: null.
- "reason": תיאור קצר וקולע בעברית של סיבת הפנייה (משפט אחד קצר).
- "notes": כל דבר נוסף שיכול להיות רלוונטי לאיש מכירות / שירות (למשל: "מעוניין בדמו לבוט קולי", "פנייה דחופה", "שאל על מחירים" וכו').

חשוב:
- אם נראה שהשיחה היא רק הדגמה / סימולציה / תיאור של תסריט דוגמה לבוט קולי, ולא פנייה אמיתית של לקוח – החזר "is_lead": false ו-"phone_number": null.
- אם רוב השיחה היא בעברית – העדף עברית בכל השדות הטקסטואליים (reason, notes, שמות אם נאמרו בעברית וכו').

החזר אך ורק JSON תקין לפי הסכמה, בלי טקסט נוסף, בלי הסברים ובלי הערות.
`.trim();

    const userPrompt = `
להלן תמלול שיחה בין לקוח ובוט שירות בשם "${BOT_NAME}" עבור העסק "${BUSINESS_NAME}".

תמלול:
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
    } catch (e) {
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
// Helper – ניתוק אקטיבי בטוויליו
// -----------------------------
async function hangupTwilioCall(callSid, tag = 'Call') {
  if (!callSid) {
    logDebug(tag, 'No callSid – skipping Twilio hangup.');
    return;
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    logDebug(
      tag,
      'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing – cannot hang up via Twilio API.'
    );
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString(
            'base64'
          ),
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

// -----------------------------
// Helper – שליפה אקטיבית של המספר המזוהה מטוויליו לפי callSid
// -----------------------------
async function fetchCallerNumberFromTwilio(callSid, tag = 'Call') {
  if (!callSid) {
    logDebug(tag, 'fetchCallerNumberFromTwilio: no callSid provided.');
    return null;
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    logDebug(
      tag,
      'fetchCallerNumberFromTwilio: missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.'
    );
    return null;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString(
            'base64'
          )
      }
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(tag, `fetchCallerNumberFromTwilio HTTP ${res.status}`, txt);
      return null;
    }

    const data = await res.json();
    const fromRaw = data.from || data.caller_name || null;

    logInfo(
      tag,
      `fetchCallerNumberFromTwilio: resolved caller="${fromRaw}" from Twilio Call resource.`
    );
    return fromRaw;
  } catch (err) {
    logError(tag, 'fetchCallerNumberFromTwilio: error fetching from Twilio', err);
    return null;
  }
}

// -----------------------------
// Helper – TTS של ElevenLabs -> Twilio
// -----------------------------
async function elevenSpeakToTwilio(text, connection, streamSid) {
  const ttsTag = 'ElevenTTS';

  if (!ELEVEN_API_KEY) {
    logError(ttsTag, 'ELEVEN_API_KEY missing – cannot use ElevenLabs TTS.');
    return;
  }
  if (!ELEVEN_VOICE_ID) {
    logError(
      ttsTag,
      'ELEVEN_VOICE_ID / VOICE_ID missing – cannot use ElevenLabs TTS.'
    );
    return;
  }
  if (!streamSid) {
    logDebug(ttsTag, 'No streamSid yet – cannot send audio to Twilio.');
    return;
  }
  if (!connection || connection.readyState !== WebSocket.OPEN) {
    logDebug(ttsTag, 'Twilio WS not open – cannot send audio.');
    return;
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=${encodeURIComponent(
      ELEVEN_OUTPUT_FORMAT
    )}`;

    const body = {
      text,
      model_id: ELEVEN_TTS_MODEL,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.9,
        style: 0.3,
        use_speaker_boost: true,
        speed: MB_SPEECH_SPEED
      },
      language_code: ELEVENLABS_LANGUAGE || 'he'
    };

    logInfo(ttsTag, 'Sending text to ElevenLabs TTS.', {
      length: text.length,
      model: ELEVEN_TTS_MODEL,
      language: ELEVENLABS_LANGUAGE,
      format: ELEVEN_OUTPUT_FORMAT
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(ttsTag, `ElevenLabs TTS HTTP ${res.status}`, txt);
      return;
    }

    const arrayBuf = await res.arrayBuffer();
    const audioBuf = Buffer.from(arrayBuf);
    logInfo(
      ttsTag,
      `ElevenLabs TTS audio received. length=${audioBuf.length} bytes`
    );

    const CHUNK_SIZE = 160; // 20ms ב-8kHz μ-law

    for (let offset = 0; offset < audioBuf.length; offset += CHUNK_SIZE) {
      const chunk = audioBuf.subarray(offset, offset + CHUNK_SIZE);
      const payloadB64 = chunk.toString('base64');

      if (!connection || connection.readyState !== WebSocket.OPEN) {
        logDebug(ttsTag, 'Twilio WS closed while streaming Eleven audio.');
        break;
      }

      const twilioMsg = {
        event: 'media',
        streamSid,
        media: { payload: payloadB64 }
      };
      connection.send(JSON.stringify(twilioMsg));
    }
  } catch (err) {
    logError(ttsTag, 'Error calling ElevenLabs TTS', err);
  }
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

  let conversationLog = []; // [{ from: 'user'|'bot', text }]
  let currentBotText = '';
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

  // מצב דיבור של הבוט (לצורך barge-in)
  let botSpeaking = false;

  // האם יש response פעיל במודל
  let hasActiveResponse = false;

  // דגל: האם זה עדיין "התור של הבוט"
  let botTurnActive = false;

  // טיימסטמפ עד מתי אסור להקשיב ללקוח (זנב קצר אחרי סיום דיבור)
  let noListenUntilTs = 0;

  // האם הלקוח כבר דיבר פעם אחת
  let userHasSpoken = false;

  // האם וובהוק לידים כבר נשלח בשיחה הזו
  let leadWebhookSent = false;

  // -----------------------------
  // Helper: שליחת טקסט למודל עם הגנה על response כפול
  // -----------------------------
  function sendModelPrompt(text, purpose) {
    if (openAiWs.readyState !== WebSocket.OPEN) {
      logDebug(
        tag,
        `Cannot send model prompt (${purpose || 'no-tag'}) – WS not open.`
      );
      return;
    }
    if (hasActiveResponse) {
      logDebug(
        tag,
        `Skipping model prompt (${purpose || 'no-tag'}) – conversation already has active response.`
      );
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
    const patterns = [
      /מזוהה/,
      /למספר שממנו/,
      /למספר שממנו אני מתקשר/,
      /למספר שממנו התקשרתי/
    ];
    return conversationLog.some(
      (m) => m.from === 'user' && patterns.some((re) => re.test(m.text || ''))
    );
  }

  // -----------------------------
  // Helper: שליחת וובהוק לידים – פעם אחת בלבד, ורק אם זה ליד מלא
  // -----------------------------
  async function sendLeadWebhook(reason, closingMessage) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) {
      logDebug(
        tag,
        'Lead capture disabled or no MB_WEBHOOK_URL – skipping webhook.'
      );
      return;
    }

    if (leadWebhookSent) {
      logDebug(tag, 'Lead webhook already sent for this call – skipping.');
      return;
    }

    try {
      if (!callerNumber && callSid) {
        const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
        if (resolved) {
          callerNumber = resolved;
        }
      }

      let parsedLead = await extractLeadFromConversation(conversationLog);

      if (!parsedLead || typeof parsedLead !== 'object') {
        logInfo(tag, 'No parsed lead object – skipping webhook (לא ליד מלא).');
        return;
      }

      if (!parsedLead.phone_number && callerNumber) {
        parsedLead.phone_number = callerNumber;

        const suffixNote = conversationMentionsCallerId()
          ? 'הלקוח ביקש חזרה למספר המזוהה ממנו התקשר.'
          : 'לא נמסר מספר טלפון מפורש בשיחה – נעשה שימוש במספר המזוהה מהמערכת.';

        parsedLead.notes =
          (parsedLead.notes || '') +
          (parsedLead.notes ? ' ' : '') +
          suffixNote;
      }

      const normalizedPhone = normalizePhoneNumber(
        parsedLead.phone_number,
        callerNumber
      );
      parsedLead.phone_number = normalizedPhone;

      const callerDigits = normalizePhoneNumber(null, callerNumber);

      const callerIdRaw =
        callerDigits ||
        (callerNumber ? String(callerNumber).replace(/\D/g, '') : null);
      const callerIdNormalized = callerDigits || callerIdRaw;

      parsedLead.caller_id_raw = callerIdRaw;
      parsedLead.caller_id_normalized = callerIdNormalized;

      if (
        !parsedLead.business_name ||
        typeof parsedLead.business_name !== 'string' ||
        !parsedLead.business_name.trim()
      ) {
        parsedLead.business_name = 'לא רלוונטי';
      }

      const isFullLead =
        parsedLead.is_lead === true && !!parsedLead.phone_number;

      if (!isFullLead) {
        logInfo(
          tag,
          'Parsed lead is NOT full lead – webhook will NOT be sent.',
          {
            is_lead: parsedLead.is_lead,
            lead_type: parsedLead.lead_type,
            phone_number: parsedLead.phone_number
          }
        );
        return;
      }

      const finalPhoneNumber =
        parsedLead.phone_number || callerIdNormalized || callerIdRaw;

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
      logInfo(tag, 'Lead webhook short summary', {
        phone_number: finalPhoneNumber,
        CALLERID: finalCallerId
      });

      leadWebhookSent = true;

      const res = await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        logError(tag, `Lead webhook HTTP ${res.status}`, await res.text());
      } else {
        logInfo(
          tag,
          `Lead webhook delivered successfully. status=${res.status}`
        );
      }
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err);
    }
  }

  // -----------------------------
  // Helper: סיום שיחה מרוכז – ניתוק אחרי סגיר
  // -----------------------------
  function endCall(reason, closingMessage) {
    if (callEnded) {
      logDebug(tag, `endCall called again (${reason}) – already ended.`);
      return;
    }
    callEnded = true;

    logInfo(tag, `endCall called with reason="${reason}"`);
    logInfo(tag, 'Final conversation log:', conversationLog);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);

    if (MB_ENABLE_LEAD_CAPTURE && MB_WEBHOOK_URL) {
      sendLeadWebhook(reason, closingMessage || MB_CLOSING_SCRIPT).catch(
        (err) =>
          logError(tag, 'sendLeadWebhook fire-and-forget error', err)
      );
    }

    if (MB_DYNAMIC_KB_URL) {
      refreshDynamicBusinessPrompt('PostCall').catch((err) =>
        logError(tag, 'DynamicKB post-call refresh failed', err)
      );
    }

    if (callSid) {
      hangupTwilioCall(callSid, tag).catch(() => {});
    }

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

  // -----------------------------
  // Helper: תזמון סיום שיחה אחרי סגיר
  // -----------------------------
  function scheduleEndCall(reason, closingMessage) {
    if (callEnded) return;

    const msg = closingMessage || MB_CLOSING_SCRIPT;

    if (pendingHangup) {
      logDebug(tag, 'Hangup already scheduled, skipping duplicate.');
      return;
    }

    logInfo(
      tag,
      `scheduleEndCall invoked. reason="${reason}", closingMessage="${msg}"`
    );
    pendingHangup = { reason, closingMessage: msg };

    if (openAiWs.readyState === WebSocket.OPEN) {
      sendModelPrompt(
        `סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף שום משפט נוסף: "${msg}"`,
        'closing'
      );
      logInfo(tag, `Closing message sent to model: ${msg}`);
    } else {
      const ph = pendingHangup;
      pendingHangup = null;
      endCall(ph.reason, ph.closingMessage);
      return;
    }

    const rawGrace =
      MB_HANGUP_GRACE_MS && MB_HANGUP_GRACE_MS > 0
        ? MB_HANGUP_GRACE_MS
        : 3000;

    const graceMs = Math.max(2000, Math.min(rawGrace, 8000));

    setTimeout(() => {
      if (callEnded || !pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      logInfo(
        tag,
        `Hangup grace reached (${graceMs} ms), forcing endCall.`
      );
      endCall(ph.reason, ph.closingMessage);
    }, graceMs);

    logInfo(
      tag,
      `scheduleEndCall: hangup scheduled (with fallback in ${graceMs} ms) with reason="${reason}".`
    );
  }

  // -----------------------------
  // Helper: תזמון ניתוק כאשר הבוט כבר אמר את משפט הסיום
  // -----------------------------
  function scheduleHangupAfterBotClosing(reason) {
    if (callEnded) return;
    if (pendingHangup) {
      logDebug(tag, 'Hangup already scheduled, skipping bot-closing duplicate.');
      return;
    }

    const msg = MB_CLOSING_SCRIPT;
    pendingHangup = { reason, closingMessage: msg };
    const rawGrace =
      MB_HANGUP_GRACE_MS && MB_HANGUP_GRACE_MS > 0
        ? MB_HANGUP_GRACE_MS
        : 3000;
    const graceMs = Math.max(2000, Math.min(rawGrace, 8000));

    setTimeout(() => {
      if (callEnded || !pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      logInfo(
        tag,
        `Hangup grace (bot closing) reached (${graceMs} ms), forcing endCall.`
      );
      endCall(ph.reason, ph.closingMessage);
    }, graceMs);

    logInfo(
      tag,
      `Bot closing detected – hangup scheduled (with fallback in ${graceMs} ms) reason="${reason}".`
    );
  }

  // -----------------------------
  // Helper: בדיקת משפט סיום של הבוט
  // -----------------------------
  function checkBotClosing(botText) {
    if (!botText || !NORMALIZED_CLOSING_SCRIPT) return;
    const norm = normalizeForClosing(botText);
    if (!norm) return;

    if (
      norm.includes(NORMALIZED_CLOSING_SCRIPT) ||
      NORMALIZED_CLOSING_SCRIPT.includes(norm)
    ) {
      logInfo(
        tag,
        `Detected configured bot closing phrase in output: "${botText}"`
      );
      scheduleHangupAfterBotClosing('bot_closing_config');
    }
  }

  // -----------------------------
  // Helper: הודעת "אתם עדיין איתי?"
  // -----------------------------
  function sendIdleWarningIfNeeded() {
    if (idleWarningSent || callEnded) return;
    idleWarningSent = true;

    const text =
      'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
    sendModelPrompt(
      `תגיבי ללקוח במשפט קצר בסגנון הבא (אפשר לשנות קצת): "${text}"`,
      'idle_warning'
    );
  }

  // -----------------------------
  // OpenAI WS handlers
  // -----------------------------
  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, 'Connected to OpenAI Realtime API.');

    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;

    const session = {
      model: 'gpt-4o-realtime-preview-2024-12-17',
      modalities: TTS_PROVIDER === 'eleven' ? ['text'] : ['audio', 'text'],
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
    };

    if (TTS_PROVIDER !== 'eleven') {
      session.voice = OPENAI_VOICE;
      session.output_audio_format = 'g711_ulaw';
    }

    const sessionUpdate = {
      type: 'session.update',
      session
    };

    logDebug(tag, 'Sending session.update to OpenAI.', sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));

    const greetingText = MB_OPENING_SCRIPT;
    sendModelPrompt(
      `פתחי את השיחה עם הלקוח במשפט הבא (אפשר לשנות מעט את הניסוח אבל לא להאריך): "${greetingText}" ואז עצרי והמתיני לתשובה שלו.`,
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

      case 'response.audio_transcript.delta': {
        const delta = msg.delta || '';
        if (delta) currentBotText += delta;
        break;
      }

      case 'response.output_text.done':
      case 'response.audio_transcript.done': {
        if (!currentBotText) break;
        const text = currentBotText.trim();
        if (text) {
          conversationLog.push({ from: 'bot', text });
          logInfo('Bot', text);
          checkBotClosing(text);

          // אם עובדים עם ElevenLabs – משמיעים את הטקסט דרך TTS
          if (TTS_PROVIDER === 'eleven') {
            elevenSpeakToTwilio(text, connection, streamSid).catch((err) =>
              logError(tag, 'Error in elevenSpeakToTwilio', err)
            );
          }
        }
        currentBotText = '';
        break;
      }

      case 'response.audio.delta': {
        // אם TTS_PROVIDER=eleven – לא רוצים אודיו מ-OpenAI בכלל
        if (TTS_PROVIDER === 'eleven') break;

        const b64 = msg.delta;
        if (!b64 || !streamSid) break;
        botSpeaking = true;

        const now = Date.now();
        noListenUntilTs = now + MB_NO_BARGE_TAIL_MS;

        if (connection.readyState === WebSocket.OPEN) {
          const twilioMsg = {
            event: 'media',
            streamSid,
            media: { payload: b64 }
          };
          connection.send(JSON.stringify(twilioMsg));
        }
        break;
      }

      case 'response.audio.done': {
        botSpeaking = false;
        botTurnActive = false;
        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          logInfo(tag, 'Closing audio finished, ending call now.');
          endCall(ph.reason, ph.closingMessage);
        }
        break;
      }

      case 'response.completed': {
        botSpeaking = false;
        hasActiveResponse = false;
        botTurnActive = false;
        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          logInfo(tag, 'Response completed for closing, ending call now.');
          endCall(ph.reason, ph.closingMessage);
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcriptRaw = msg.transcript || '';
        let t = transcriptRaw.trim();
        if (t) {
          t = t
            .replace(/\s+/g, ' ')
            .replace(/\s+([,.:;!?])/g, '$1');
          conversationLog.push({ from: 'user', text: t });
          logInfo('User', t);
          userHasSpoken = true;
        }
        break;
      }

      case 'error': {
        logError(tag, 'OpenAI Realtime error event', msg);
        hasActiveResponse = false;
        botSpeaking = false;
        botTurnActive = false;
        noListenUntilTs = 0;
        break;
      }

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    logInfo(tag, 'OpenAI WS closed.');
    if (!callEnded) {
      endCall('openai_ws_closed', MB_CLOSING_SCRIPT);
    }
  });

  openAiWs.on('error', (err) => {
    logError(tag, 'OpenAI WS error', err);
    if (!openAiClosed) {
      openAiClosed = true;
      openAiWs.close();
    }
    if (!callEnded) {
      endCall('openai_ws_error', MB_CLOSING_SCRIPT);
    }
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

      logInfo(
        tag,
        `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`
      );

      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (
          !idleWarningSent &&
          sinceMedia >= MB_IDLE_WARNING_MS &&
          !callEnded
        ) {
          sendIdleWarningIfNeeded();
        }
        if (
          !idleHangupScheduled &&
          sinceMedia >= MB_IDLE_HANGUP_MS &&
          !callEnded
        ) {
          idleHangupScheduled = true;
          logInfo(tag, 'Idle timeout reached, scheduling endCall.');
          scheduleEndCall('idle_timeout', MB_CLOSING_SCRIPT);
        }
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        if (
          MB_MAX_WARN_BEFORE_MS > 0 &&
          MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS
        ) {
          maxCallWarningTimeout = setTimeout(() => {
            const t =
              'אנחנו מתקרבים לסיום הזמן לשיחה הזאת. אם תרצו להתקדם, אפשר עכשיו לסכם ולהשאיר פרטים.';
            sendModelPrompt(
              `תני ללקוח משפט קצר בסגנון הבא (אפשר לשנות קצת): "${t}"`,
              'max_call_warning'
            );
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          logInfo(tag, 'Max call duration reached, scheduling endCall.');
          scheduleEndCall('max_call_duration', MB_CLOSING_SCRIPT);
        }, MB_MAX_CALL_MS);
      }
    } else if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;

      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) {
          logDebug(
            'BargeIn',
            'Ignoring media because bot is speaking / tail (MB_ALLOW_BARGE_IN=false)',
            { botTurnActive, botSpeaking, now, noListenUntilTs }
          );
          return;
        }
      }

      const oaMsg = {
        type: 'input_audio_buffer.append',
        audio: payload
      };
      openAiWs.send(JSON.stringify(oaMsg));
    } else if (event === 'stop') {
      logInfo(tag, 'Twilio stream stopped.');
      twilioClosed = true;
      if (!callEnded) {
        endCall('twilio_stop', MB_CLOSING_SCRIPT);
      }
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logInfo(tag, 'Twilio WS closed.');
    if (!callEnded) {
      endCall('twilio_ws_closed', MB_CLOSING_SCRIPT);
    }
  });

  connection.on('error', (err) => {
    twilioClosed = true;
    logError(tag, 'Twilio WS error', err);
    if (!callEnded) {
      endCall('twilio_ws_error', MB_CLOSING_SCRIPT);
    }
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(
    `✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`
  );
  refreshDynamicBusinessPrompt('Startup').catch((err) =>
    console.error('[ERROR][DynamicKB] initial load failed', err)
  );
});
