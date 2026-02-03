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
  if (!t) return "";
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return m[1].trim();
  if (t.length <= 25 && !t.match(/\d/)) return t.replace(/^אה+[, ]*/g, "").trim();
  return "";
}

function extractPhone(text) {
  const d = (text || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10 && d.startsWith("0")) return "+972" + d.slice(1);
  if (d.startsWith("972") && d.length === 12) return "+" + d;
  return "";
}

function createCallState(meta) {
  const caller = normalizeCallerId(meta.caller);
  return {
    streamSid: meta.streamSid || "",
    callSid: meta.callSid || "",
    caller_raw: caller.value,
    caller_withheld: caller.withheld,
    called: meta.called || "",
    source: meta.source || "VoiceBot_Blank",
    started_at: nowIso(),
    ended_at: null,
    name: "",
    callback_number: caller.withheld ? "" : caller.value,
    has_request: false,
    transcript: [],
    recordingSid: "",
    recording_url_public: "",
    closing_initiated: false,
    finalized: false
  };
}

async function safeDeliver(eventType, payload) {
  try {
    await deliverWebhook(eventType, payload, logger);
  } catch (e) {
    logger.warn({ msg: "Webhook deliver failed", meta: { eventType, error: String(e) } });
  }
}

async function finalizeCall(state, ssot) {
  // Idempotent + safe: never throw, never crash the server
  if (!state) return;
  if (state.finalized) return;
  state.finalized = true;

  state.ended_at = nowIso();

  const transcriptText = (state.transcript || [])
    .map(x => `${String(x.role || "").toUpperCase()}: ${x.text || ""}`)
    .join("\n");

  const isFinal = Boolean(state.name && state.has_request);
  const eventType = isFinal ? "FINAL" : "ABANDONED";

  await safeDeliver(eventType, {
    event: eventType,
    call: {
      callSid: state.callSid,
      streamSid: state.streamSid,
      caller: state.caller_raw,
      called: state.called,
      source: state.source,
      started_at: state.started_at,
      ended_at: state.ended_at,
      recording_url_public: state.recording_url_public || "",
      recording_provider: state.recordingSid ? "twilio" : ""
    },
    lead: {
      name: state.name || "",
      phone: state.callback_number || "",
      notes: transcriptText
    }
  });
}

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", async (ws) => {
    let ssot;
    try {
      ssot = await loadSSOT();
    } catch (e) {
      logger.error({ msg: "SSOT load failed", meta: { error: String(e) } });
      ssot = { settings: {}, prompts: {}, intents: [] };
    }

    let state = null;
    let session = null;

    function stopSessionSafe() {
      try { session?.stop(); } catch {}
      session = null;
    }

    async function finalizeSafe() {
      try {
        await finalizeCall(state, ssot);
      } catch (e) {
        logger.warn({ msg: "finalizeCall failed (suppressed)", meta: { error: String(e) } });
      }
    }

    ws.on("message", async (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      if (msg.event === "start") {
        const start = msg.start || {};
        const streamSid = start.streamSid || "";
        const callSid = start.callSid || "";
        const custom = start.customParameters || {};

        state = createCallState({
          streamSid,
          callSid,
          caller: custom.caller || "",
          called: custom.called || "",
          source: custom.source || "VoiceBot_Blank"
        });

        logger.info({ msg: "Twilio stream start", meta: { streamSid, callSid, customParameters: custom } });

        // CALL_LOG early (start-of-stream)
        await safeDeliver("CALL_LOG", {
          event: "CALL_LOG",
          call: {
            callSid,
            streamSid,
            caller: state.caller_raw,
            called: state.called,
            source: state.source,
            started_at: state.started_at
          }
        });

        // Recording (best-effort)
        if (process.env.MB_ENABLE_RECORDING === "true") {
          try {
            const sid = await startCallRecording(callSid, logger);
            if (sid) {
              state.recordingSid = sid;
              state.recording_url_public = publicRecordingUrl(sid);
            }
          } catch (e) {
            logger.warn({ msg: "startCallRecording failed", meta: { error: String(e) } });
          }
        }

        // Start Gemini session with correct callback-based API
        try {
          session = new GeminiLiveSession({
            ssot,
            meta: { streamSid, callSid, caller: state.caller_raw, called: state.called, source: state.source },

            onGeminiAudioUlaw8kBase64: (b64) => {
              // Gemini -> Twilio (uLaw 8k base64)
              try {
                ws.send(JSON.stringify({ event: "media", media: { payload: b64 } }));
              } catch {}
            },

            onTranscript: ({ who, text, normalized, lang }) => {
              if (!state) return;

              const role = who === "assistant" ? "bot" : (who || "user"); // normalize
              const t = text || "";
              const norm = normalized || "";
              state.transcript.push({
                role,
                text: t,
                normalized: norm,
                lang: lang || "",
                ts: nowIso()
              });

              if (role === "user") {
                if (!state.name) {
                  const n = extractNameHe(norm || t);
                  if (n) state.name = n;
                } else {
                  // Once name exists, any meaningful user content = request exists
                  if ((norm || t).trim().length >= 3) state.has_request = true;

                  // If caller withheld, capture callback phone if spoken
                  if (state.caller_withheld && !state.callback_number) {
                    const p = extractPhone(norm || t);
                    if (p) state.callback_number = p;
                  }
                }
              }

              if (role === "bot") {
                // Proactive hangup after closing (best-effort)
                if (!state.closing_initiated && (t.includes("להתראות") || t.includes("תודה"))) {
                  state.closing_initiated = true;
                  setTimeout(() => {
                    if (state?.callSid) hangupCall(state.callSid, logger).catch(() => {});
                  }, 900);
                }
              }
            },

            onGeminiText: (text) => {
              // optional debug; keep quiet unless needed
              if (process.env.MB_LOG_ASSISTANT_TEXT === "true") {
                logger.info({ msg: "Gemini text", meta: { t: String(text || "").slice(0, 800) } });
              }
            }
          });

          session.start();
        } catch (e) {
          logger.error({ msg: "Gemini session start failed", meta: { error: String(e) } });
          // If session cannot start, finalize as abandoned (without crashing)
          await finalizeSafe();
          stopSessionSafe();
          state = null;
        }

        return;
      }

      if (msg.event === "media") {
        if (!session) return;
        try {
          // Twilio -> Gemini : uLaw 8k base64
          session.sendUlaw8kFromTwilio(msg.media?.payload || "");
        } catch (e) {
          logger.warn({ msg: "sendUlaw8kFromTwilio failed", meta: { error: String(e) } });
        }
        return;
      }

      if (msg.event === "stop") {
        logger.info({ msg: "Twilio stream stop", meta: { streamSid: msg?.stop?.streamSid, callSid: msg?.stop?.callSid } });

        // IMPORTANT: stop can arrive even if start never completed => guard
        stopSessionSafe();
        await finalizeSafe();

        // clear AFTER finalize
        state = null;
        return;
      }
    });

    ws.on("close", async () => {
      logger.info({ msg: "Twilio media WS closed" });
      stopSessionSafe();
      await finalizeSafe();
      state = null;
    });

    ws.on("error", async (err) => {
      logger.warn({ msg: "Twilio media WS error", meta: { error: String(err) } });
      stopSessionSafe();
      await finalizeSafe();
      state = null;
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/twilio-media-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });
}

module.exports = { installTwilioMediaWs };
