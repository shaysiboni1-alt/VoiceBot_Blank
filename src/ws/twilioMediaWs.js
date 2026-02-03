"use strict";

const WebSocket = require("ws");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { logger } = require("../utils/logger");
const { loadSSOT } = require("../ssot/ssotClient");
const { deliverWebhook } = require("../utils/webhooks");
const {
  startCallRecording,
  hangupCall,
  publicRecordingUrl
} = require("../utils/twilioRecording");

function nowIso() {
  return new Date().toISOString();
}

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (["anonymous", "restricted", "unavailable", "unknown"].includes(low)) {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = (text || "").trim();
  const m = t.match(/(?:קוראים לי|השם שלי|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m) return m[1].trim();
  if (t.length <= 25 && !t.match(/\d/)) return t;
  return "";
}

function extractPhone(text) {
  const d = (text || "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) return "+972" + d.slice(1);
  if (d.startsWith("972") && d.length === 12) return "+" + d;
  return "";
}

function createCallState(meta) {
  const caller = normalizeCallerId(meta.caller);
  return {
    ...meta,
    caller_raw: caller.value,
    caller_withheld: caller.withheld,
    started_at: nowIso(),
    ended_at: null,
    name: "",
    callback_number: caller.withheld ? "" : caller.value,
    has_request: false,
    transcript: [],
    recordingSid: "",
    recording_url_public: "",
    closing_initiated: false
  };
}

async function finalizeCall(state, ssot) {
  state.ended_at = nowIso();

  const transcriptText = state.transcript
    .map(x => `${x.role.toUpperCase()}: ${x.text}`)
    .join("\n");

  const isFinal = Boolean(state.name && state.has_request);
  const eventType = isFinal ? "FINAL" : "ABANDONED";

  await deliverWebhook(eventType, {
    event: eventType,
    call: {
      callSid: state.callSid,
      streamSid: state.streamSid,
      caller: state.caller_raw,
      called: state.called,
      started_at: state.started_at,
      ended_at: state.ended_at,
      recording_url_public: state.recording_url_public,
      recording_provider: state.recordingSid ? "twilio" : ""
    },
    lead: {
      name: state.name,
      phone: state.callback_number,
      notes: transcriptText
    }
  }, logger);
}

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", async (ws) => {
    const ssot = await loadSSOT();
    let state = null;
    let session = null;

    ws.on("message", async (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      if (msg.event === "start") {
        const { streamSid, callSid, customParameters = {} } = msg.start;

        state = createCallState({
          streamSid,
          callSid,
          caller: customParameters.caller,
          called: customParameters.called,
          source: customParameters.source || "VoiceBot_Blank"
        });

        await deliverWebhook("CALL_LOG", {
          event: "CALL_LOG",
          call: {
            callSid,
            streamSid,
            caller: state.caller_raw,
            called: state.called,
            started_at: state.started_at
          }
        }, logger);

        if (process.env.MB_ENABLE_RECORDING === "true") {
          const sid = await startCallRecording(callSid, logger);
          if (sid) {
            state.recordingSid = sid;
            state.recording_url_public = publicRecordingUrl(sid);
          }
        }

        session = new GeminiLiveSession({
          ssot,
          meta: { streamSid, callSid },
          onGeminiAudioUlaw8kBase64: (b64) => {
            ws.send(JSON.stringify({
              event: "media",
              media: { payload: b64 }
            }));
          },
          onTranscript: ({ who, text, normalized, lang }) => {
            state.transcript.push({ role: who, text, normalized, lang });

            if (who === "user") {
              if (!state.name) {
                const n = extractNameHe(normalized || text);
                if (n) state.name = n;
              } else {
                state.has_request = true;
                if (state.caller_withheld && !state.callback_number) {
                  const p = extractPhone(normalized || text);
                  if (p) state.callback_number = p;
                }
              }
            }

            if (who === "bot" && text.includes("להתראות") && !state.closing_initiated) {
              state.closing_initiated = true;
              setTimeout(() => hangupCall(state.callSid, logger), 900);
            }
          }
        });

        session.start();
      }

      if (msg.event === "media" && session) {
        session.sendUlaw8kFromTwilio(msg.media.payload);
      }

      if (msg.event === "stop") {
        session?.stop();
        await finalizeCall(state, ssot);
        session = null;
        state = null;
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/twilio-media-stream") {
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
    } else {
      socket.destroy();
    }
  });
}

module.exports = { installTwilioMediaWs };
