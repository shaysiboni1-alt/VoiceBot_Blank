// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { loadSSOT } = require("../ssot/ssotClient");
const { deliverWebhook } = require("../utils/webhooks");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { startCallRecording, hangupCall, publicRecordingUrl } = require("../utils/twilioRecording");

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function normalizeCallerId(caller) {
  const s = safeStr(caller);
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (["anonymous", "restricted", "unavailable", "unknown", "private"].includes(low)) {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = safeStr(text);
  if (!t) return "";

  // Common patterns: "קוראים לי X", "השם שלי X", "שמי X", "אני X"
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return m[1].trim();

  // Fallback: short token without digits/punctuation
  if (t.length <= 25 && !/[0-9]/.test(t)) {
    return t.replace(/^אה+[, ]*/g, "").replace(/[.?!,]+$/g, "").trim();
  }
  return "";
}

function extractPhone(text) {
  const digits = safeStr(text).replace(/\D/g, "");
  if (!digits) return "";
  // Israeli numbers 9-13 digits, maybe with 972
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return "+" + digits;
    if (digits.startsWith("0") && digits.length === 10) return "+972" + digits.slice(1);
    // If already with +972 etc
    if (digits.length >= 11 && digits.length <= 13) return "+" + digits;
    return digits;
  }
  return "";
}

function shouldTriggerHangup(botText, ssot) {
  const t = safeStr(botText);
  if (!t) return false;

  // Fast path
  if (t.includes("תודה") && t.includes("להתראות")) return true;

  // SSOT closers
  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => safeStr(settings[k]))
    .filter(Boolean);

  return closers.some((c) => c && t.startsWith(c.slice(0, Math.min(18, c.length))));
}

function hangupDelayMs(botText) {
  const t = safeStr(botText);
  const len = t.length;
  // Heuristic: give TTS time to finish.
  // 60ms per char (Hebrew), clamp 2s..7s
  const ms = Math.round(len * 60);
  return Math.max(2000, Math.min(7000, ms));
}

function createCallState({ callSid, streamSid, caller, called, source }) {
  const callerInfo = normalizeCallerId(caller);
  return {
    callSid: safeStr(callSid),
    streamSid: safeStr(streamSid),
    source: safeStr(source) || "VoiceBot_Blank",
    caller_raw: callerInfo.value,
    caller_withheld: callerInfo.withheld,
    called: safeStr(called),
    started_at: nowIso(),
    ended_at: null,

    // Lead fields
    name: "",
    callback_number: callerInfo.withheld ? "" : callerInfo.value,
    request: "",
    extra: "",

    // telemetry
    transcript: [], // {role,text,normalized,lang,ts}
    intent_last: null,

    // recording
    recordingSid: "",
    recording_url_public: "",

    // guards
    callLogSent: false,
    finalized: false,
    closing_initiated: false
  };
}

async function maybeStartRecording(state) {
  if (String(env.MB_ENABLE_RECORDING) !== "true") return;
  if (!state?.callSid) return;

  const sid = await startCallRecording(state.callSid, logger);
  if (sid) {
    state.recordingSid = sid;
    state.recording_url_public = publicRecordingUrl(sid);
  }
}

async function runLeadParser({ ssot, transcriptText, callMeta }) {
  if (String(env.LEAD_PARSER_ENABLED) !== "true") return null;

  const prompt = safeStr(ssot?.prompts?.LEAD_PARSER_PROMPT);
  const system = prompt || "Return JSON only. Summarize the call for CRM. No hallucinations.";

  const model = safeStr(env.GEMINI_LEAD_PARSER_MODEL) || "gemini-1.5-flash";
  const key = safeStr(env.GEMINI_API_KEY);

  if (!key) return null;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `SYSTEM:\n${system}\n\n` +
                `CALL_META:\n${JSON.stringify(callMeta)}\n\n` +
                `TRANSCRIPT:\n${transcriptText}\n\n` +
                `Return JSON only.`
            }
          ]
        }
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const j = await resp.json().catch(() => null);
    const txt = j?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") || "";
    const trimmed = safeStr(txt);
    if (!trimmed) return null;

    // tolerate ```json ... ```
    const cleaned = trimmed
      .replace(/^```json/i, "")
      .replace(/^```/i, "")
      .replace(/```$/i, "")
      .trim();

    if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
      return JSON.parse(cleaned);
    }

    return null;
  } catch (e) {
    logger.warn({ msg: "LeadParser LLM failed", meta: { error: e?.message || String(e) } });
    return null;
  }
}

function buildTranscriptText(state) {
  const lines = (state?.transcript || []).map((x) => `${String(x.role || "").toUpperCase()}: ${safeStr(x.text)}`);
  return lines.join("\n").trim();
}

function deterministicLeadSummary(state) {
  const name = safeStr(state?.name);
  const request = safeStr(state?.request);
  const extra = safeStr(state?.extra);

  const parts = [];
  if (request) parts.push(`בקשה: ${request}`);
  if (extra) parts.push(`פרטים נוספים: ${extra}`);

  // Fallback to last user utterance if request empty
  if (!parts.length) {
    const lastUser = [...(state?.transcript || [])].reverse().find((x) => x.role === "user");
    if (lastUser?.text) parts.push(`פנייה: ${safeStr(lastUser.text)}`);
  }

  return {
    summary: parts.join(" | "),
    request: request || "",
    extra: extra || "",
    name: name || ""
  };
}

async function finalizeAndWebhook({ state, ssot }) {
  if (!state || state.finalized) return;
  state.finalized = true;

  state.ended_at = nowIso();

  const transcriptText = buildTranscriptText(state);

  const leadComplete = Boolean(state.name && (state.request || state.extra));
  const eventType = leadComplete ? "FINAL" : "ABANDONED";

  const call = {
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
  };

  let lead_parser = null;
  if (eventType === "FINAL") {
    lead_parser = await runLeadParser({ ssot, transcriptText, callMeta: call });
  }

  const det = deterministicLeadSummary(state);

  const payload = {
    event: eventType,
    call,
    lead: {
      name: safeStr(state.name),
      phone: safeStr(state.callback_number),
      request: det.request,
      extra: det.extra,
      summary: safeStr(lead_parser?.summary || lead_parser?.request_summary || det.summary),
      lead_parser: lead_parser || undefined
    }
  };

  // Optional raw transcript for debugging (off by default)
  if (String(env.MB_INCLUDE_TRANSCRIPT_IN_WEBHOOK) === "true") {
    payload.call.transcript = transcriptText;
  }

  await deliverWebhook(eventType, payload, logger);
}

async function sendCallLogOnce(state) {
  if (!state || state.callLogSent) return;
  state.callLogSent = true;

  await deliverWebhook(
    "CALL_LOG",
    {
      event: "CALL_LOG",
      call: {
        callSid: state.callSid,
        streamSid: state.streamSid,
        caller: state.caller_raw,
        called: state.called,
        source: state.source,
        started_at: state.started_at
      }
    },
    logger
  );
}

// -----------------------------------------------------------------------------
// WS install
// -----------------------------------------------------------------------------

function installTwilioMediaWs(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/twilio-media-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (ws) => {
    logger.info({ msg: "Twilio media WS connected" });

    // Load SSOT per connection (cached client-side by ssotClient)
    let ssot = null;
    try {
      ssot = await loadSSOT(false);
    } catch (e) {
      logger.warn({ msg: "SSOT load failed (continuing)", meta: { error: e?.message || String(e) } });
      ssot = null;
    }

    let state = null;
    let session = null;

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const ev = msg?.event;
      if (!ev) return;

      // Light debug line (kept small)
      if (String(env.DEBUG) === "true") {
        logger.info({ msg: "Twilio WS event", meta: { event: ev, streamSid: state?.streamSid || null, callSid: state?.callSid || null } });
      }

      if (ev === "start") {
        const streamSid = safeStr(msg?.start?.streamSid);
        const callSid = safeStr(msg?.start?.callSid) || safeStr(msg?.start?.customParameters?.callSid);
        const custom = msg?.start?.customParameters || {};
        const caller = safeStr(custom?.caller);
        const called = safeStr(custom?.called);
        const source = safeStr(custom?.source) || "VoiceBot_Blank";

        state = createCallState({ callSid, streamSid, caller, called, source });

        logger.info({ msg: "Twilio stream start", meta: { streamSid, callSid, customParameters: custom } });

        await sendCallLogOnce(state);
        await maybeStartRecording(state);

        // Gemini session for this call
        session = new GeminiLiveSession({
          ssot,
          meta: { streamSid, callSid, caller, called, source },

          onGeminiAudioUlaw8kBase64: (ulaw8kBase64) => {
            // Gemini -> Twilio
            try {
              ws.send(JSON.stringify({ event: "media", media: { payload: ulaw8kBase64 } }));
            } catch {}
          },

          onGeminiText: (t) => {
            logger.debug({ msg: "Gemini text", meta: { streamSid, callSid, t } });
          },

          onTranscript: async (u) => {
            if (!state) return;

            // Backwards compatible payloads:
            // - Stage3: { who, text, normalized, lang }
            // - Older: { role, text }
            const role = safeStr(u?.who || u?.role);
            const text = safeStr(u?.text);
            if (!role || !text) return;

            const normalized = safeStr(u?.normalized);
            const lang = safeStr(u?.lang);

            state.transcript.push({ role, text, normalized, lang, ts: nowIso() });

            if (role === "user") {
              // Name extraction
              if (!state.name) {
                const name = extractNameHe(normalized || text);
                if (name) state.name = name;
              } else {
                // Capture callback number if caller withheld
                if (state.caller_withheld && !state.callback_number) {
                  const phone = extractPhone(normalized || text);
                  if (phone) state.callback_number = phone;
                }

                // Build request/extra (best-effort)
                const utt = normalized || text;
                if (!state.request) {
                  if (utt.length >= 4) state.request = utt;
                } else {
                  if (utt.length >= 4) state.extra = state.extra ? `${state.extra} | ${utt}` : utt;
                }
              }
            }

            if (role === "bot") {
              if (!state.closing_initiated && shouldTriggerHangup(text, ssot)) {
                state.closing_initiated = true;
                const delay = hangupDelayMs(text);
                setTimeout(() => {
                  if (!state?.callSid) return;
                  hangupCall(state.callSid, logger).catch(() => {});
                }, delay);
              }
            }
          }
        });

        session.start();
        return;
      }

      if (ev === "media") {
        // Twilio -> Gemini
        // Guard: Twilio can occasionally send media before we fully init.
        if (!session) return;

        const payloadB64 = msg?.media?.payload;
        if (!payloadB64) return;

        try {
          session.sendUlaw8kFromTwilio(String(payloadB64));
        } catch (e) {
          logger.debug({ msg: "sendUlaw8kFromTwilio failed", meta: { error: e?.message || String(e) } });
        }
        return;
      }

      if (ev === "stop") {
        const streamSid = safeStr(msg?.stop?.streamSid) || state?.streamSid || null;
        const callSid = safeStr(msg?.stop?.callSid) || state?.callSid || null;

        logger.info({ msg: "Twilio stream stop", meta: { streamSid, callSid } });

        try {
          session?.endInput?.();
          session?.stop?.();
        } catch {}

        try {
          await finalizeAndWebhook({ state, ssot });
        } catch (e) {
          logger.warn({ msg: "Finalize webhook failed", meta: { error: e?.message || String(e) } });
        }

        state = null;
        session = null;
        return;
      }
    });

    ws.on("close", async () => {
      logger.info({ msg: "Twilio media WS closed", meta: { streamSid: state?.streamSid || null, callSid: state?.callSid || null } });

      try {
        session?.endInput?.();
        session?.stop?.();
      } catch {}

      // If Twilio closes without stop, finalize best-effort (ABANDONED likely).
      try {
        await finalizeAndWebhook({ state, ssot });
      } catch {}

      state = null;
      session = null;
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
