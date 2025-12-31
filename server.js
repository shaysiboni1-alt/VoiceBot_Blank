/**
 * BluBinet Voice Bot (Stable, Hebrew, Clean Audio)
 * Twilio Voice (Gather STT he-IL) -> Gemini Text -> Google Cloud TTS -> Twilio <Play>
 *
 * Why:
 * - You do NOT have Gemini Live audio-bidi permissions (only text-out models appear).
 * - This gives: perfect Hebrew understanding, clean voice (no μ-law noise), full logs.
 *
 * ENV:
 * - PORT (Render)
 * - PUBLIC_BASE_URL (required) e.g. https://blubinet-realtime.onrender.com
 *
 * - GEMINI_API_KEY (required)  // from Google AI Studio
 * - MB_GEMINI_TEXT_MODEL (optional) default: gemini-2.0-flash-exp
 *
 * - GOOGLE_TTS_API_KEY (required for clean Hebrew voice)  // Google Cloud Text-to-Speech API key
 * - MB_TTS_VOICE (optional) default: he-IL-Wavenet-C
 * - MB_TTS_RATE (optional) default: 1.04
 *
 * - MB_BOT_NAME (default: נטע)
 * - MB_BUSINESS_NAME (default: BluBinet)
 * - MB_OPENING_TEXT (optional)
 * - MB_CLOSING_TEXT (optional)
 *
 * - MAKE_WEBHOOK_URL or MB_WEBHOOK_URL (optional) // call summary on completed calls
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT) || 3000;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();
if (!PUBLIC_BASE_URL) {
  console.error("Missing PUBLIC_BASE_URL. Example: https://blubinet-realtime.onrender.com");
  process.exit(1);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const GOOGLE_TTS_API_KEY = (process.env.GOOGLE_TTS_API_KEY || "").trim();
if (!GOOGLE_TTS_API_KEY) {
  console.error("Missing GOOGLE_TTS_API_KEY (Google Cloud Text-to-Speech API key). Required for clean Hebrew voice.");
  process.exit(1);
}

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL || "";

const BOT_NAME = process.env.MB_BOT_NAME || "נטע";
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || "BluBinet";

const GEMINI_TEXT_MODEL = (process.env.MB_GEMINI_TEXT_MODEL || "gemini-2.0-flash-exp").trim();

const TTS_VOICE = (process.env.MB_TTS_VOICE || "he-IL-Wavenet-C").trim();
const TTS_RATE = Number(process.env.MB_TTS_RATE || "1.04");

const OPENING_TEXT =
  (process.env.MB_OPENING_TEXT || "").trim() ||
  `שָׁלוֹם, הִגַּעְתֶּם לְ־${BUSINESS_NAME}. מְדַבֶּרֶת ${BOT_NAME}. אֵיךְ אֶפְשָׁר לַעֲזוֹר?`;

const CLOSING_TEXT =
  (process.env.MB_CLOSING_TEXT || "").trim() ||
  `תּוֹדָה רַבָּה. אִם תִּרְצוּ, אֲחֲזוֹר אֲלֵיכֶם עִם פְּרָטִים. יוֹם נָעִים.`;

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
כללים:
- דברי בעברית בלבד כברירת מחדל.
- תשובות קצרות מאוד (1–2 משפטים).
- לא לחזור על פתיח שכבר נאמר.
- לא לשאול הרבה שאלות: לכל היותר שאלה אחת כדי להמשיך.
- סגנון שירותי-מכירתי עדין, מקצועי וזורם.
`.trim();

// ===== In-memory storage (simple + fast). For production, you can swap to Redis.
const sessions = new Map(); // callSid -> { log: [{role,text,ts}], audio: Map<audioId,Buffer>, createdAt }
function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      log: [],
      audio: new Map(),
      createdAt: Date.now(),
    });
  }
  return sessions.get(callSid);
}

function addLog(callSid, role, text) {
  const s = getSession(callSid);
  s.log.push({ role, text, ts: new Date().toISOString() });
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function twiml(xml) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${xml}\n</Response>`;
}

// ===== Health
app.get("/", (req, res) => res.send("BluBinet Status: Online"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== Serve synthesized audio
app.get("/audio/:audioId.mp3", (req, res) => {
  const { audioId } = req.params;
  const callSid = (req.query.callSid || "").toString();
  if (!callSid) return res.status(400).send("Missing callSid");
  const s = sessions.get(callSid);
  if (!s) return res.status(404).send("Session not found");
  const buf = s.audio.get(audioId);
  if (!buf) return res.status(404).send("Audio not found");

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
});

// ===== Gemini text call
async function geminiGenerateText(userText, callSid) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_TEXT_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  // Keep it short: user + system only (you can add memory later if needed)
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },
    contents: [
      { role: "user", parts: [{ text: userText }] }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 140
    }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Gemini generateContent error", r.status, j);
    return "סליחה, הייתה תקלה רגעית. אפשר לנסות שוב?";
  }

  const text =
    j?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(" ").trim() ||
    "סליחה, לא הבנתי. אפשר לחזור בקצרה?";

  // ultra-short safety: cut overly long outputs
  return text.length > 450 ? text.slice(0, 450) : text;
}

// ===== Google Cloud TTS -> MP3
async function googleTtsMp3(text) {
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(
    GOOGLE_TTS_API_KEY
  )}`;

  const body = {
    input: { text },
    voice: {
      languageCode: "he-IL",
      name: TTS_VOICE,
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: TTS_RATE,
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Google TTS error", r.status, j);
    // fallback: return null -> Twilio <Say> (will be English voice, not ideal)
    return null;
  }

  const b64 = j.audioContent;
  if (!b64) return null;
  return Buffer.from(b64, "base64");
}

// ===== Build a Gather step (Hebrew STT)
function gatherStep(actionUrl, sayOrPlayXml) {
  // Important: speechTimeout="auto" waits for end-of-speech.
  // language="he-IL" ensures correct Hebrew STT.
  return `
${sayOrPlayXml}
<Gather input="speech" language="he-IL" speechTimeout="auto" action="${actionUrl}" method="POST">
</Gather>
<Redirect method="POST">${actionUrl.replace("/gather", "/reprompt")}</Redirect>
`.trim();
}

// ===== Entry point: play opening, start gather
app.post("/twilio-voice", async (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  console.log("==> /twilio-voice", { callSid, from, to });

  // init session
  getSession(callSid);
  addLog(callSid, "system", `CALL_START from=${from} to=${to}`);

  // synth opening
  addLog(callSid, "assistant", OPENING_TEXT);
  const mp3 = await googleTtsMp3(OPENING_TEXT);

  const audioId = makeId();
  if (mp3) getSession(callSid).audio.set(audioId, mp3);

  const playXml = mp3
    ? `<Play>${PUBLIC_BASE_URL}/audio/${audioId}.mp3?callSid=${encodeURIComponent(callSid)}</Play>`
    : `<Say>${OPENING_TEXT}</Say>`;

  const actionUrl = `${PUBLIC_BASE_URL}/gather?callSid=${encodeURIComponent(callSid)}`;

  res.type("text/xml").send(twiml(gatherStep(actionUrl, playXml)));
});

// ===== Reprompt if no speech captured
app.post("/reprompt", async (req, res) => {
  const callSid = (req.query.callSid || req.body.CallSid || "").toString();
  if (!callSid) return res.type("text/xml").send(twiml(`<Hangup/>`));

  const repromptText = "לא שמעתי תשובה. איך אפשר לעזור?";
  addLog(callSid, "assistant", repromptText);

  const mp3 = await googleTtsMp3(repromptText);
  const audioId = makeId();
  if (mp3) getSession(callSid).audio.set(audioId, mp3);

  const playXml = mp3
    ? `<Play>${PUBLIC_BASE_URL}/audio/${audioId}.mp3?callSid=${encodeURIComponent(callSid)}</Play>`
    : `<Say>${repromptText}</Say>`;

  const actionUrl = `${PUBLIC_BASE_URL}/gather?callSid=${encodeURIComponent(callSid)}`;
  res.type("text/xml").send(twiml(gatherStep(actionUrl, playXml)));
});

// ===== Handle user speech -> Gemini -> TTS -> continue gather
app.post("/gather", async (req, res) => {
  const callSid = (req.query.callSid || req.body.CallSid || "").toString();
  const speech = (req.body.SpeechResult || "").toString().trim();
  const confidence = req.body.Confidence;

  if (!callSid) return res.type("text/xml").send(twiml(`<Hangup/>`));

  if (!speech) {
    // no speech recognized -> reprompt
    return res.type("text/xml").send(
      twiml(`<Redirect method="POST">${PUBLIC_BASE_URL}/reprompt?callSid=${encodeURIComponent(callSid)}</Redirect>`)
    );
  }

  console.log("User said:", speech, "conf:", confidence);
  addLog(callSid, "user", speech);

  // Gemini text answer
  const answer = await geminiGenerateText(speech, callSid);
  addLog(callSid, "assistant", answer);

  // TTS answer (clean MP3)
  const mp3 = await googleTtsMp3(answer);
  const audioId = makeId();
  if (mp3) getSession(callSid).audio.set(audioId, mp3);

  const playXml = mp3
    ? `<Play>${PUBLIC_BASE_URL}/audio/${audioId}.mp3?callSid=${encodeURIComponent(callSid)}</Play>`
    : `<Say>${answer}</Say>`;

  const actionUrl = `${PUBLIC_BASE_URL}/gather?callSid=${encodeURIComponent(callSid)}`;
  res.type("text/xml").send(twiml(gatherStep(actionUrl, playXml)));
});

// ===== Call status callback (send full log to Make when completed)
app.post("/call-status", async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  console.log("==> /call-status", { callSid, callStatus });

  if (callSid && (callStatus === "completed" || callStatus === "canceled" || callStatus === "failed" || callStatus === "busy" || callStatus === "no-answer")) {
    const s = sessions.get(callSid);
    const log = s?.log || [];

    // clean up old audio to save memory
    if (s) {
      s.audio.clear();
      // keep log for a bit or delete immediately
      // sessions.delete(callSid);
    }

    if (MAKE_WEBHOOK_URL) {
      fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "call_ended",
          callSid,
          callStatus,
          log,
        }),
      }).catch(() => {});
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
