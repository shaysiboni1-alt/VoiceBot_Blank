// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { loadSSOT } = require("../ssot/ssotClient");
const { deliverWebhook } = require("../utils/webhooks");
const {
  startCallRecording,
  hangupCall,
  publicRecordingUrl
} = require("../utils/twilioRecording");

const { GeminiLiveSession } = require("../vendor/geminiLiveSession");

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function normalizeCallerId(raw) {
  const s = safeStr(raw);
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };

  // Twilio common placeholders / withheld indicators
  if (
    low === "anonymous" ||
    low === "restricted" ||
    low === "unavailable" ||
    low === "unknown" ||
    low === "withheld" ||
    low === "private"
  ) {
    return { value: s, withheld: true };
  }

  const digits = s.replace(/\D/g, "");
  // If it's not really a number, consider withheld
  if (digits.length < 7) return { value: s, withheld: true };

  return { value: s, withheld: false };
}

function extractNameHe(text) {
  const t = safeStr(text);
  if (!t) return "";

  // "קוראים לי X" / "השם שלי X" / "שמי X" / "אני X"
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return safeStr(m[1]);

  // If it's a short-ish phrase and no digits, treat as a name (fallback)
  if (t.length <= 25 && !/[0-9]/.test(t)) {
    return safeStr(t.replace(/^אה+[, ]*/g, ""));
  }

  return "";
}

function extractPhone(text) {
  const digits = safeStr(text).replace(/\D/g, "");
  if (!digits) return "";

  // Israel heuristics
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return `+${digits}`;
    if (digits.startsWith("0") && digits.length === 10) return `+972${digits.slice(1)}`;
    if (digits.startsWith("+") && digits.length >= 10) return digits;
    return digits;
  }

  return "";
}

function shouldTriggerHangup(botText, ssot) {
  const t = safeStr(botText);
  if (!t) return false;

  // Quick heuristic
  if (t.includes("תודה") && (t.includes("להתראות") || t.includes("יום טוב"))) return true;

  // Match closers from SETTINGS (CLOSING_*)
  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => safeStr(settings[k]))
    .filter(Boolean);

  if (!closers.length) return false;

  // Start-with match (allow slight variations)
  return closers.some((c) => {
    const head = c.slice(0, Math.min(18, c.length));
    return head && t.startsWith(head);
  });
}

function buildTranscriptText(entries) {
  return (entries || [])
    .map((e) => {
      const role = (e.role || "").toUpperCase();
      const text = safeStr(e.text);
      const norm = safeStr(e.normalized);
      if (norm && norm !== text) return `${role}: ${text}\nNORM: ${norm}`;
      return `${role}: ${text}`;
    })
    .join("\n")
    .trim();
}

function createCallState({ callSid, streamSid, caller, called, source }) {
  const callerInfo = normalizeCallerId(caller);
  return {
    callSid: callSid || "",
    streamSid: streamSid || "",
    source: source || "VoiceBot_Blank",
    caller_raw: callerInfo.value,
    caller_withheld: callerInfo.withheld,
    called: called || "",
    started_at: nowIso(),
    ended_at: null,

    // Lead fields
    name: "",
    callback_number: callerInfo.withheld ? "" : callerInfo.value,
    has_request: false,

    // Tracking
    transcript: [],
    intents: [],

    // Recording
    recordingSid: "",
    recording_url_public: "",
    recording_provider: "",

    // Safety flags
    finalized: false,
    closing_initiated: false
  };
}

async function maybeStartRecording(state) {
  if (String(env.MB_ENABLE_RECORDING) !== "true") return;
  if (!state?.callSid) return;

  try {
    const recSid = await startCallRecording(state.callSid, logger);
    if (recSid) {
      state.recordingSid = recSid;
      state.recording_provider = "twilio";
      state.recording_url_public = publicRecordingUrl(recSid);
    }
  } catch (e) {
    logger.warn("Recording start failed", { error: String(e?.message || e) });
  }
}

async function sendCallLog({ state }) {
  // CALL_LOG at stream start (per Stage4)
  try {
    await deliverWebhook(
      "CALL_LOG",
      {
        event: "CALL_LOG",
        call: {
          callSid: state.callSid,
          streamSid: state.streamSid,
          caller: state.caller_raw,
          caller_withheld: state.caller_withheld,
          called: state.called,
          source: state.source,
          started_at: state.started_at,
          recording_provider: state.recording_provider || "",
          recording_url_public: state.recording_url_public || ""
        }
      },
      logger
    );
  } catch (e) {
    logger.warn("CALL_LOG webhook failed", { error: String(e?.message || e) });
  }
}

function buildLeadParserFallback({ transcriptText }) {
  // deterministic / non-breaking fallback (no external API calls)
  const max = 4000;
  const snippet = transcriptText.length > max ? transcriptText.slice(-max) : transcriptText;

  return {
    mode: safeStr(process.env.LEAD_PARSER_MODE || ""),
    style: safeStr(process.env.LEAD_SUMMARY_STYLE || ""),
    summary: snippet
  };
}

async function finalizeCall({ state, ssot }) {
  if (!state || state.finalized) return;
  state.finalized = true;

  state.ended_at = nowIso();

  const transcriptText = buildTranscriptText(state.transcript);

  const leadComplete = Boolean(state.name && state.has_request);
  const eventType = leadComplete ? "FINAL" : "ABANDONED";

  const callMeta = {
    callSid: state.callSid,
    streamSid: state.streamSid,
    caller: state.caller_raw,
    caller_withheld: state.caller_withheld,
    called: state.called,
    source: state.source,
    started_at: state.started_at,
    ended_at: state.ended_at,
    recording_provider: state.recording_provider || "",
    recording_url_public: state.recording_url_public || ""
  };

  const payload = {
    event: eventType,
    call: callMeta,
    lead: {
      name: state.name || "",
      phone: state.callback_number || "",
      notes: transcriptText,
      lead_parser: leadComplete && String(process.env.LEAD_PARSER_ENABLED) === "true"
        ? buildLeadParserFallback({ transcriptText })
        : null
    }
  };

  try {
    await deliverWebhook(eventType, payload, logger);
  } catch (e) {
    logger.warn("FINAL/ABANDONED webhook failed", { eventType, error: String(e?.message || e) });
  }
}

// ----------------------------------------------------------------------------
// WebSocket server install
// ----------------------------------------------------------------------------

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", async (ws) => {
    // Avoid "[object Object]" logs
    logger.info({ msg: "Twilio media WS connected" });

    let ssot;
    try {
      ssot = await loadSSOT();
    } catch (e) {
      ssot = null;
      logger.warn("SSOT load failed on WS connection", { error: String(e?.message || e) });
    }

    let state = null;
    let session = null;

    function safeStopSession() {
      try {
        session?.stop();
      } catch {}
      session = null;
    }

    async function safeFinalize() {
      try {
        await finalizeCall({ state, ssot });
      } catch (e) {
        logger.warn("Finalize failed", { error: String(e?.message || e) });
      }
    }

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const ev = msg?.event;

      // ---------------- START ----------------
      if (ev === "start") {
        const streamSid = msg?.start?.streamSid || "";
        const callSid = msg?.start?.callSid || "";
        const custom = msg?.start?.customParameters || {};
        const caller = custom.caller || "";
        const called = custom.called || "";
        const source = custom.source || "VoiceBot_Blank";

        logger.info({
          msg: "Twilio stream start",
          meta: { streamSid, callSid, customParameters: custom }
        });

        state = createCallState({ callSid, streamSid, caller, called, source });

        // Recording (best effort)
        await maybeStartRecording(state);

        // CALL_LOG immediately at start (Stage4 behavior)
        await sendCallLog({ state });

        // Create Gemini session (Stage3 baseline interface)
        session = new GeminiLiveSession({
          meta: { streamSid, callSid, caller, called, source },
          ssot: ssot || {},
          onGeminiAudioUlaw8kBase64: (ulaw8kBase64) => {
            // Gemini -> Twilio (ulaw8k base64)
            try {
              ws.send(
                JSON.stringify({
                  event: "media",
                  media: { payload: ulaw8kBase64 }
                })
              );
            } catch {}
          },
          onGeminiText: (t) => {
            if (String(env.MB_LOG_ASSISTANT_TEXT) === "true") {
              logger.debug({ msg: "Gemini text", meta: { streamSid, callSid, t: safeStr(t).slice(0, 1200) } });
            }
          },
          onTranscript: (tr) => {
            // tr: { who, text, normalized, lang }
            if (!state) return;
            const role = tr?.who === "user" ? "user" : "bot";
            const text = safeStr(tr?.text);
            const normalized = safeStr(tr?.normalized);
            const lang = safeStr(tr?.lang);

            if (!text) return;

            state.transcript.push({
              role,
              text,
              normalized,
              lang,
              ts: nowIso()
            });

            // LeadGate: name capture only from USER
            if (role === "user") {
              if (!state.name) {
                const name = extractNameHe(normalized || text);
                if (name) state.name = name;
              } else {
                // Mark "has_request" when caller says something meaningful after name
                const n = safeStr(normalized || text);
                if (n.length >= 6 && !/^\s*(כן|לא|סבבה|אוקיי|בסדר)\s*$/i.test(n)) {
                  state.has_request = true;
                }

                // If caller ID is withheld, capture callback number if spoken
                if (state.caller_withheld && !state.callback_number) {
                  const phone = extractPhone(normalized || text);
                  if (phone) state.callback_number = phone;
                }
              }
            }

            // Closing => proactive hangup (Stage rule: after closing, bot hangs up)
            if (role === "bot" && !state.closing_initiated && shouldTriggerHangup(text, ssot)) {
              state.closing_initiated = true;

              // Give TTS a moment to finish, then hangup
              setTimeout(() => {
                hangupCall(state.callSid, logger).catch(() => {});
              }, 900);
            }
          }
        });

        try {
          session.start();
        } catch (e) {
          logger.error("Failed to start GeminiLiveSession", { error: String(e?.message || e) });
        }

        return;
      }

      // ---------------- MEDIA ----------------
      if (ev === "media") {
        if (!session) return;

        const payload = msg?.media?.payload;
        if (!payload) return;

        try {
          // Twilio gives ulaw8k base64
          session.sendUlaw8kFromTwilio(payload);
        } catch (e) {
          logger.debug("Failed sending audio to Gemini", { error: String(e?.message || e) });
        }
        return;
      }

      // ---------------- STOP ----------------
      if (ev === "stop") {
        const streamSid = msg?.stop?.streamSid || state?.streamSid || "";
        const callSid = msg?.stop?.callSid || state?.callSid || "";

        logger.info({ msg: "Twilio stream stop", meta: { streamSid, callSid } });

        try {
          session?.endInput();
        } catch {}
        safeStopSession();

        await safeFinalize();

        state = null;
        return;
      }
    });

    ws.on("close", async () => {
      logger.info({ msg: "Twilio media WS closed" });

      // If WS closed without STOP, finalize as ABANDONED/FINAL best-effort
      safeStopSession();
      await safeFinalize();

      state = null;
    });

    ws.on("error", (err) => {
      logger.warn("Twilio WS error", { error: String(err?.message || err) });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      if (req.url === "/twilio-media-stream") {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    } catch {
      try {
        socket.destroy();
      } catch {}
    }
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
