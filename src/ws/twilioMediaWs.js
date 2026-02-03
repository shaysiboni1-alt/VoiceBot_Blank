// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { loadSSOT } = require("../ssot/ssotClient");
const { deliverWebhook } = require("../utils/webhooks");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const {
  startCallRecording,
  publicRecordingUrl,
  stopCallRecording,
} = require("../utils/twilioRecording");

// Optional existing helper (requested to reuse if present) – non-breaking fallback.
let passiveCallContextFactory = null;
try {
  // eslint-disable-next-line global-require
  passiveCallContextFactory = require("../logic/passiveCallContext");
} catch (_) {
  passiveCallContextFactory = null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function normalizeCallerId(callerRaw) {
  const s = String(callerRaw || "").trim();
  const low = s.toLowerCase();

  if (!s) return { value: "", withheld: true };
  if (["anonymous", "restricted", "unavailable", "unknown", "private"].includes(low)) {
    return { value: s, withheld: true };
  }

  const digits = s.replace(/\D/g, "");
  // Twilio usually sends E.164; treat any decent digit length as not withheld.
  return { value: s, withheld: digits.length < 7 };
}

function cleanName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.replace(/[.,;:!?]+$/g, "").replace(/^[-–—\s]+/g, "").trim();
}

function extractNameHe(text) {
  const t = String(text || "").trim();
  if (!t) return "";

  // "קוראים לי X", "השם שלי X", "השם שלי זה X", "שמי X", "אני X"
  const m = t.match(/(?:קוראים לי|השם שלי(?:\s+זה)?|שמי|אני)\s+([^\n,.!?]{2,60})/);
  if (m && m[1]) return cleanName(m[1]);

  // Fallback: if it's short and contains Hebrew letters, assume it's a name.
  if (t.length <= 28 && /[\u0590-\u05FF]/.test(t) && !/[0-9]/.test(t)) {
    return cleanName(t);
  }

  return "";
}

function extractPhone(text) {
  const digits = String(text || "").replace(/\D/g, "");
  if (!digits) return "";

  // Israel: 10 digits starting 0, or 972XXXXXXXXX
  if (digits.startsWith("972") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+972${digits.slice(1)}`;

  // Generic: allow E.164-ish lengths
  if (digits.length >= 9 && digits.length <= 15) return digits;
  return "";
}

function safeJsonParse(maybeJson) {
  const s = String(maybeJson || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function runLeadParser({ ssot, callMeta, transcriptText }) {
  // LEAD_PARSER_PROMPT is in SSOT; we keep it there (no change required).
  const prompt = String(ssot?.prompts?.LEAD_PARSER_PROMPT || "").trim();
  if (!prompt) return null;

  const model = env.LEAD_PARSER_MODEL || "gemini-1.5-flash";
  const key = env.GEMINI_API_KEY;
  if (!key) return null;

  // IMPORTANT: Keep cost/latency sane.
  const maxChars = Number(env.LEAD_PARSER_MAX_CHARS || 12000);
  const clipped = transcriptText.length > maxChars ? transcriptText.slice(-maxChars) : transcriptText;

  const userText =
    `SYSTEM:\n${prompt}\n\n` +
    `CALL_META:\n${JSON.stringify(callMeta)}\n\n` +
    `TRANSCRIPT:\n${clipped}\n\n` +
    `Return JSON only.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512,
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const j = await resp.json().catch(() => null);
    const txt =
      j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const parsed = safeJsonParse(txt);
    return parsed;
  } catch (err) {
    logger.warn("LeadParser failed", { error: err?.message || String(err) });
    return null;
  }
}

function createCallState({ streamSid, callSid, caller, called, source }) {
  const callerInfo = normalizeCallerId(caller);

  return {
    streamSid: streamSid || "",
    callSid: callSid || "",
    source: source || "VoiceBot_Blank",
    caller_raw: callerInfo.value,
    caller_withheld: callerInfo.withheld,
    called: called || "",

    started_at: nowIso(),
    ended_at: null,
    duration_ms: 0,

    // Lead capture
    name: "",
    callback_number: callerInfo.withheld ? "" : callerInfo.value,
    has_request: false,

    // Transcripts
    transcript: [],

    // Recording
    recordingSid: "",
    recording_url_public: "",
    recording_provider: "",

    // Guards
    call_log_sent: false,
    finalized: false,

    // Close control
    closing_started_at: 0,
    hangup_timer: null,
  };
}

function transcriptToText(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((x) => `${String(x.who || "").toUpperCase()}: ${String(x.text || "")}`)
    .join("\n");
}

function shouldTriggerHangup(botText, ssot) {
  const t = String(botText || "").trim();
  if (!t) return false;

  // If SSOT has explicit closers, match them.
  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => String(settings[k] || "").trim())
    .filter(Boolean);

  // Fallback: common goodbye marker
  if (t.includes("תודה") && t.includes("להתראות")) return true;

  return closers.some((c) => c && t.startsWith(c.slice(0, Math.min(18, c.length))));
}

async function sendCallLogOnce(state) {
  if (!state || state.call_log_sent) return;
  state.call_log_sent = true;

  const payload = {
    event: "CALL_LOG",
    call: {
      callSid: state.callSid,
      streamSid: state.streamSid,
      caller: state.caller_raw,
      called: state.called,
      source: state.source,
      started_at: state.started_at,
    },
  };

  await deliverWebhook("CALL_LOG", payload, logger);
}

async function maybeStartRecording(state) {
  if (!state?.callSid) return;
  if (String(env.MB_ENABLE_RECORDING) !== "true") return;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;

  const sid = await startCallRecording(state.callSid, logger);
  if (sid) {
    state.recordingSid = sid;
    state.recording_provider = "twilio";
    state.recording_url_public = publicRecordingUrl(sid);
  }
}

function scheduleHangupAfterClosing(state, ssot) {
  if (!state?.callSid) return;
  if (state.hangup_timer) return;

  state.closing_started_at = Date.now();

  // Give enough time for the last TTS chunk(s) to finish reliably.
  const delayMs = Number(env.MB_HANGUP_AFTER_MS || 2200);

  state.hangup_timer = setTimeout(() => {
    // We intentionally DO NOT force hangup here by default to avoid cutting audio.
    // If you really want bot-initiated hangup, set MB_FORCE_HANGUP=true.
    if (String(env.MB_FORCE_HANGUP) === "true") {
      // stopCallRecording is safe even if not started
      stopCallRecording(state.callSid, logger).catch(() => {});
      // Twilio will end the call; Media Stream stop will follow.
      // eslint-disable-next-line no-void
      void deliverWebhook("DEBUG", { event: "HANGUP_SCHEDULED", callSid: state.callSid }, logger).catch(
        () => {}
      );
    }
  }, delayMs);
}

async function finalizeCall({ state, ssot, reason }) {
  if (!state || state.finalized) return;
  state.finalized = true;

  if (state.hangup_timer) {
    clearTimeout(state.hangup_timer);
    state.hangup_timer = null;
  }

  state.ended_at = nowIso();
  state.duration_ms = Math.max(0, Date.now() - new Date(state.started_at).getTime());

  // Build transcript text (for parser only). Do NOT dump full transcript into lead.notes.
  const transcriptText = transcriptToText(state.transcript);

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
    duration_seconds: Math.round(state.duration_ms / 1000),
    end_reason: String(reason || ""),
    recording_provider: state.recording_provider || "",
    recording_url_public: state.recording_url_public || "",
    recording_sid: state.recordingSid || "",
  };

  let lead_parser = null;
  let lead_summary = "";
  let lead_topic = "";
  let lead_details = "";

  if (leadComplete) {
    lead_parser = await runLeadParser({ ssot, callMeta, transcriptText });

    // Normalize parser output into fields we control
    if (lead_parser && typeof lead_parser === "object") {
      lead_summary = String(
        lead_parser.summary || lead_parser.call_summary || lead_parser.crm_summary || ""
      ).trim();
      lead_topic = String(lead_parser.topic || lead_parser.subject || "").trim();
      lead_details = String(lead_parser.details || lead_parser.request || "").trim();
    }
  }

  const payload = {
    event: eventType,
    call: callMeta,
    lead: {
      name: state.name || "",
      phone: state.callback_number || "",
      topic: lead_topic,
      details: lead_details,
      summary: lead_summary,
      lead_parser, // keep full JSON for future fields
    },
    // Keep full transcript ONLY if explicitly enabled (for debugging)
    ...(String(env.MB_INCLUDE_TRANSCRIPT_IN_WEBHOOK) === "true"
      ? { transcript: transcriptText }
      : {}),
  };

  await deliverWebhook(eventType, payload, logger);
}

// -----------------------------------------------------------------------------
// WS Install (no express-ws; works with plain http.Server)
// -----------------------------------------------------------------------------

function installTwilioMediaWs(server) {
  if (!server || typeof server.on !== "function") {
    throw new Error("installTwilioMediaWs(server): server must be an http.Server");
  }

  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", async (ws) => {
    logger.info("Twilio media WS connected");

    const ssot = await loadSSOT(false).catch(() => null);

    let state = null;
    let session = null;

    // Optional passive context object (if your repo has it)
    let passiveCtx = null;
    try {
      if (typeof passiveCallContextFactory === "function") {
        passiveCtx = passiveCallContextFactory();
      } else if (passiveCallContextFactory?.createPassiveCallContext) {
        passiveCtx = passiveCallContextFactory.createPassiveCallContext();
      }
    } catch (_) {
      passiveCtx = null;
    }

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const event = msg?.event;
      if (!event) return;

      logger.info("Twilio WS event", {
        event,
        streamSid: msg?.start?.streamSid || msg?.streamSid || msg?.stop?.streamSid || null,
        callSid: msg?.start?.callSid || msg?.callSid || msg?.stop?.callSid || null,
      });

      // START
      if (event === "start") {
        const streamSid = msg?.start?.streamSid || "";
        const callSid = msg?.start?.callSid || "";
        const custom = msg?.start?.customParameters || {};

        const caller = custom.caller || "";
        const called = custom.called || "";
        const source = custom.source || "VoiceBot_Blank";

        state = createCallState({ streamSid, callSid, caller, called, source });

        await sendCallLogOnce(state);
        await maybeStartRecording(state);

        session = new GeminiLiveSession({
          meta: { streamSid, callSid, caller, called, source },
          ssot: ssot || {},
          onGeminiAudioUlaw8kBase64: (ulaw8kB64) => {
            try {
              ws.send(JSON.stringify({ event: "media", media: { payload: ulaw8kB64 } }));
            } catch (_) {}
          },
          onGeminiText: (t) => {
            logger.debug("Gemini text", { ...state, t });
          },
          onTranscript: (tr) => {
            if (!state) return;

            const who = tr?.who || tr?.role || "";
            const text = String(tr?.text || "").trim();
            if (!text) return;

            state.transcript.push({ who, text, ts: nowIso(), normalized: tr?.normalized, lang: tr?.lang });

            // Feed passive context if exists
            try {
              passiveCtx?.ingest?.({ who, text, ts: Date.now(), meta: state });
            } catch (_) {}

            if (who === "user") {
              // Capture name (only once) from early utterances
              if (!state.name) {
                const nm = extractNameHe(tr?.normalized || text);
                if (nm) state.name = nm;
              }

              // If caller ID is withheld, capture callback number when caller says digits.
              if (state.caller_withheld && !state.callback_number) {
                const phone = extractPhone(tr?.normalized || text);
                if (phone) state.callback_number = phone;
              }

              // Mark "has_request" when user says actual content after name.
              if (state.name && (tr?.normalized || text).length >= 4) {
                // avoid counting pure confirmations as a "request"
                const low = String(tr?.normalized || text).trim().toLowerCase();
                if (!["כן", "כן.", "כן בבקשה", "לא", "לא.", "אוקיי", "אוקיי."].includes(low)) {
                  state.has_request = true;
                }
              }
            }

            if (who === "bot") {
              if (shouldTriggerHangup(text, ssot || {})) {
                scheduleHangupAfterClosing(state, ssot || {});
              }
            }

            // Backward-compatible transcript logs
            logger.info(`TRANSCRIPT ${who}`, { ...state, text });
          },
        });

        session.start();
        return;
      }

      // MEDIA
      if (event === "media") {
        if (!session) return;
        const payload = msg?.media?.payload;
        if (!payload) return;
        session.sendUlaw8kFromTwilio(payload);
        return;
      }

      // STOP
      if (event === "stop") {
        const streamSid = msg?.stop?.streamSid || "";
        const callSid = msg?.stop?.callSid || "";
        logger.info("Twilio stream stop", { streamSid, callSid });

        try {
          session?.endInput?.();
          session?.stop?.();
        } catch (_) {}

        try {
          await finalizeCall({ state, ssot: ssot || {}, reason: "stop" });
        } catch (err) {
          logger.error("finalizeCall failed", { error: err?.message || String(err) });
        }

        state = null;
        session = null;
        passiveCtx = null;
      }
    });

    ws.on("close", async () => {
      logger.info("Twilio media WS closed", {
        streamSid: state?.streamSid || null,
        callSid: state?.callSid || null,
      });

      try {
        session?.endInput?.();
        session?.stop?.();
      } catch (_) {}

      // If close happens before stop, finalize as ABANDONED/FINAL once.
      try {
        await finalizeCall({ state, ssot: ssot || {}, reason: "ws_close" });
      } catch (_) {}
    });

    ws.on("error", (err) => {
      logger.error("Twilio media WS error", { error: err?.message || String(err) });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      if (!req?.url) return socket.destroy();
      if (req.url.startsWith("/twilio-media-stream")) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    } catch (_) {
      try {
        socket.destroy();
      } catch {}
    }
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
