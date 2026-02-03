"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { loadSSOT } = require("../ssot/ssotClient");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { deliverWebhook } = require("../utils/webhooks");
const {
  startCallRecording,
  hangupCall,
  publicRecordingUrl
} = require("../utils/twilioRecording");
const { getCallContext } = require("../logic/passiveCallContext");

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function normalizeCallerId(raw) {
  const s = (raw || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (["anonymous", "restricted", "unknown", "unavailable"].includes(low)) {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  if (!text) return "";
  const t = text.trim();
  const m = t.match(/(?:קוראים לי|שמי|השם שלי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return m[1].trim();
  if (t.length <= 25 && !/[0-9]/.test(t)) return t;
  return "";
}

function shouldHangup(botText, ssot) {
  if (!botText) return false;
  const t = botText.trim();
  if (t.includes("תודה") && t.includes("להתראות")) return true;

  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => String(settings[k] || "").trim())
    .filter(Boolean);

  return closers.some((c) => t.startsWith(c.slice(0, Math.min(18, c.length))));
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

function createState({ callSid, streamSid, caller, called, source }) {
  const c = normalizeCallerId(caller);
  return {
    callSid,
    streamSid,
    source,
    caller_raw: c.value,
    caller_withheld: c.withheld,
    called,
    started_at: nowIso(),
    ended_at: null,

    name: "",
    has_request: false,
    callback_number: c.withheld ? "" : c.value,

    transcript: [],
    closing: false,

    recordingSid: "",
    recording_url_public: ""
  };
}

// -----------------------------------------------------------------------------
// Finalize
// -----------------------------------------------------------------------------

async function finalizeCall({ state, ssot }) {
  if (!state) return;

  state.ended_at = nowIso();

  const transcriptText = state.transcript
    .map((u) => `${u.role.toUpperCase()}: ${u.text}`)
    .join("\n");

  const isLead = Boolean(state.name && state.has_request);
  const eventType = isLead ? "FINAL" : "ABANDONED";

  const payload = {
    event: eventType,
    call: {
      callSid: state.callSid,
      streamSid: state.streamSid,
      caller: state.caller_raw,
      called: state.called,
      source: state.source,
      started_at: state.started_at,
      ended_at: state.ended_at,
      caller_withheld: state.caller_withheld,
      recording_provider: state.recordingSid ? "twilio" : "",
      recording_url_public: state.recording_url_public || ""
    },
    lead: {
      name: state.name || "",
      phone: state.callback_number || "",
      notes: transcriptText
    }
  };

  await deliverWebhook(eventType, payload, logger);
}

// -----------------------------------------------------------------------------
// WS Server
// -----------------------------------------------------------------------------

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", async (ws) => {
    const ssot = await loadSSOT();
    let session = null;
    let state = null;

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // ---- START ------------------------------------------------------------
      if (msg.event === "start") {
        const { streamSid, callSid, customParameters = {} } = msg.start;
        const caller = customParameters.caller || "";
        const called = customParameters.called || "";
        const source = customParameters.source || "VoiceBot_Blank";

        state = createState({ callSid, streamSid, caller, called, source });

        await deliverWebhook(
          "CALL_LOG",
          {
            event: "CALL_LOG",
            call: {
              callSid,
              streamSid,
              caller: state.caller_raw,
              called,
              source,
              started_at: state.started_at
            }
          },
          logger
        );

        if (process.env.MB_ENABLE_RECORDING === "true") {
          const recSid = await startCallRecording(callSid, logger);
          if (recSid) {
            state.recordingSid = recSid;
            state.recording_url_public = publicRecordingUrl(recSid);
          }
        }

        session = new GeminiLiveSession({
          ssot,
          meta: { callSid, streamSid },
          onGeminiAudioUlaw8kBase64: (b64) => {
            ws.send(JSON.stringify({ event: "media", media: { payload: b64 } }));
          },
          onTranscript: (u) => {
            state.transcript.push({
              role: u.who,
              text: u.normalized || u.text,
              ts: nowIso()
            });

            if (u.who === "user") {
              if (!state.name) {
                const n = extractNameHe(u.normalized || u.text);
                if (n) state.name = n;
              } else {
                if ((u.normalized || u.text).length > 6) {
                  state.has_request = true;
                }
              }
            }

            if (u.who === "bot" && !state.closing && shouldHangup(u.text, ssot)) {
              state.closing = true;
              setTimeout(() => {
                hangupCall(callSid, logger).catch(() => {});
              }, 900);
            }
          }
        });

        session.start();
        return;
      }

      // ---- MEDIA ------------------------------------------------------------
      if (msg.event === "media" && session) {
        session.sendUlaw8kFromTwilio(msg.media.payload);
        return;
      }

      // ---- STOP -------------------------------------------------------------
      if (msg.event === "stop") {
        try {
          session?.endInput();
          session?.stop();
        } catch {}

        await finalizeCall({ state, ssot });
        state = null;
        session = null;
        return;
      }
    });

    ws.on("close", async () => {
      try {
        session?.stop();
      } catch {}
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/twilio-media-stream") {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });
}

module.exports = { installTwilioMediaWs };
