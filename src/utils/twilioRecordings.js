const axios = require("axios");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PUBLIC_BASE_URL,
  MB_ENABLE_RECORDING
} = process.env;

// Registry בזיכרון
const RECORDINGS = new Map();

function setRecordingForCall(callSid, data) {
  if (!callSid) return;
  const prev = RECORDINGS.get(callSid) || {};
  RECORDINGS.set(callSid, {
    ...prev,
    ...data,
    updatedAt: Date.now()
  });
}

function getRecordingForCall(callSid) {
  return RECORDINGS.get(callSid) || null;
}

async function waitForRecording(callSid, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rec = getRecordingForCall(callSid);
    if (rec && rec.recordingSid) return rec;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

// התחלת הקלטה בתחילת שיחה
async function startRecording(callSid) {
  if (!MB_ENABLE_RECORDING || MB_ENABLE_RECORDING === "false") return;
  if (!PUBLIC_BASE_URL) return;
  if (!callSid) return;

  const callbackUrl = `${PUBLIC_BASE_URL}/twilio-recording-callback`;

  try {
    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`,
      new URLSearchParams({
        RecordingStatusCallback: callbackUrl,
        RecordingStatusCallbackMethod: "POST",
        RecordingChannels: "dual"
      }),
      {
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN
        }
      }
    );

    if (res.data && res.data.sid) {
      setRecordingForCall(callSid, { recordingSid: res.data.sid });
    }
  } catch (err) {
    console.error("startRecording failed", err.message);
  }
}

// Callback מ-Twilio
function recordingCallbackHandler(req, res) {
  const { CallSid, RecordingSid, RecordingUrl } = req.body || {};
  if (CallSid && RecordingSid) {
    setRecordingForCall(CallSid, {
      recordingSid: RecordingSid,
      recordingUrl: RecordingUrl
    });
  }
  res.sendStatus(200);
}

// ✅ PROXY תקין – זה התיקון הקריטי
async function proxyRecording(req, res) {
  const sid = req.params.sid;
  if (!sid) return res.sendStatus(400);

  try {
    const twilioRes = await axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`,
      {
        responseType: "stream",
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN
        }
      }
    );

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    twilioRes.data.pipe(res);
  } catch (err) {
    console.error("proxyRecording error", err.message);
    res.sendStatus(502);
  }
}

module.exports = {
  startRecording,
  waitForRecording,
  getRecordingForCall,
  recordingCallbackHandler,
  proxyRecording
};
