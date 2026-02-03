// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { getSSOT } = require("../ssot/ssotClient");
const { env } = require("../config/env");

// -----------------------------
// small helpers
// -----------------------------

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x);
}

function normalizeCallerId(caller) {
  const s = safeStr(caller).trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (
    low === "anonymous" ||
    low === "restricted" ||
    low === "unavailable" ||
    low === "unknown" ||
    low === "withheld"
  ) {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = safeStr(text).trim();
  if (!t) return "";
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return m[1].trim();
  if (t.length <= 25 && !t.match(/[0-9]/)) return t.replace(/^אה+[, ]*/g, "").trim();
  return "";
}

function extractPhoneAny(text) {
  const digits = safeStr(text).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return "+" + digits;
    if (digits.startsWith("0") && digits.length === 10) return "+972" + digits.slice(1);
    if (digits.startsWith("+") && digits.length >= 10) return digits;
    return digits;
  }
  return "";
}

function twilioBasicAuthHeader() {
  const sid = env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN; // user confirmed exists
  if (!sid || !token) return "";
  const b64 = Buffer.from(`${sid}:${token}`).toString("base64");
  return `Basic ${b64}`;
}

function twilioRecordingMp3Url(recordingSid) {
  const sid = env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !recordingSid) return "";
  return `https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${recordingSid}.mp3`;
}

async function startTwilioCallRecording(callSid) {
  try {
    const sid = env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return "";

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(
      callSid
    )}/Recordings.json`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: twilioBasicAuthHeader(),
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        RecordingChannels: "dual",
        RecordingStatusCallbackEvent: "completed"
      }).toString()
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      logger.warn("Twilio startRecording failed", { callSid, status: resp.status, body: t.slice(0, 300) });
      return "";
    }

    const j = await resp.json().catch(() => null);
    const recSid = j?.sid ? String(j.sid) : "";
    return recSid;
  } catch (e) {
    logger.warn("Twilio startRecording exception", { callSid, error: String(e?.message || e) });
    return "";
  }
}

function webhookUrlFor(eventType) {
  if (eventType === "CALL_LOG") return process.env.CALL_LOG_WEBHOOK_URL || "";
  if (eventType === "FINAL") return process.env.FINAL_WEBHOOK_URL || "";
  if (eventType === "ABANDONED") return process.env.ABANDONED_URL || "";
  return "";
}

async function deliverWebhook(eventType, payload) {
  const url = webhookUrlFor(eventType);
  if (!url) return;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    logger.info("Webhook delivered", {
      eventType,
      status: resp.status,
      attempt: 1
    });
  } catch (e) {
    logger.warn("Webhook delivery failed", { eventType, error: String(e?.message || e) });
  }
}

// -----------------------------
// Lead Parser (postcall)
// -----------------------------

function buildLeadParserPrompt(style) {
  // keep deterministic schema so Make can map reliably
  const base =
    "Return JSON ONLY. No markdown. No extra text.\n" +
    "Schema:\n" +
    "{\n" +
    '  "subject": string,\n' +
    '  "request": string,\n' +
    '  "details": string,\n' +
    '  "action_needed": string,\n' +
    '  "urgency": "low"|"normal"|"high",\n' +
    '  "entities": { "years": string[], "documents": string[], "topics": string[] }\n' +
    "}\n" +
    "Rules: do not hallucinate. If unknown, use empty string/arrays.\n";

  if (style === "crm_short") {
    return (
      base +
      "Write very short CRM-friendly fields (1-2 sentences per field). Prefer Hebrew if the call is Hebrew."
    );
  }

  return base + "Write concise CRM fields.";
}

async function runLeadParserPostcall({ model, style, call, transcriptText }) {
  const enabled = String(process.env.LEAD_PARSER_ENABLED || "").toLowerCase() === "true";
  const mode = String(process.env.LEAD_PARSER_MODE || "").toLowerCase();
  if (!enabled) return null;
  if (mode && mode !== "postcall") return null;

  const key = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return null;

  const m = model || process.env.LEAD_PARSER_MODEL || "gemini-1.5-flash";
  const prompt = buildLeadParserPrompt(style || process.env.LEAD_SUMMARY_STYLE || "crm_short");

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      m
    )}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `${prompt}\n\nCALL:\n${JSON.stringify(call)}\n\nTRANSCRIPT:\n` +
                transcriptText.slice(0, 14000)
            }
          ]
        }
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const j = await resp.json().catch(() => null);
    const txt = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const trimmed = String(txt || "").trim();

    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }

    return null;
  } catch (e) {
    logger.warn("Lead parser failed", { error: String(e?.message || e) });
    return null;
  }
}

// -----------------------------
// WS install
// -----------------------------

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/twilio-media-stream")) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    // Call/session state (do not affect audio pipeline)
    let streamSid = null;
    let callSid = null;
    let customParameters = {};
    let gemini = null;

    const startedAtMs = nowMs();
    const startedAtIso = nowIso();

    const callerInfo = { value: "", withheld: true };
    const lead = {
      name: "",
      phone: "",
      request_text: "", // what caller needs
      transcript: [] // {role,text}
    };

    const recording = {
      provider: "",
      recording_sid: "",
      recording_url_public: ""
    };

    function sendToTwilioMedia(ulaw8kB64) {
      if (!streamSid) return;
      const payload = {
        event: "media",
        streamSid,
        media: { payload: ulaw8kB64 }
      };
      try {
        twilioWs.send(JSON.stringify(payload));
      } catch {}
    }

    async function finalizeCall(finalizeReason) {
      const endedAtMs = nowMs();
      const endedAtIso = nowIso();
      const durationMs = Math.max(0, endedAtMs - startedAtMs);

      const call = {
        callSid: callSid || "",
        streamSid: streamSid || "",
        caller: callerInfo.value || safeStr(customParameters?.caller),
        called: safeStr(customParameters?.called),
        source: safeStr(customParameters?.source) || "VoiceBot_Blank",
        started_at: startedAtIso,
        ended_at: endedAtIso,
        duration_ms: durationMs,
        caller_withheld: !!callerInfo.withheld,
        recording_provider: recording.provider || "",
        recording_sid: recording.recording_sid || "",
        recording_url_public: recording.recording_url_public || "",
        finalize_reason: finalizeReason || ""
      };

      // CALL_LOG (END)
      await deliverWebhook("CALL_LOG", { event: "CALL_LOG", phase: "end", call });

      const transcriptText = lead.transcript.map((x) => `${x.role}: ${x.text}`).join("\n").trim();

      const leadComplete = Boolean(lead.name && (lead.request_text || "").trim());
      const eventType = leadComplete ? "FINAL" : "ABANDONED";

      let lead_parser = null;
      if (leadComplete) {
        lead_parser = await runLeadParserPostcall({
          model: process.env.LEAD_PARSER_MODEL || process.env.LEAD_PARSER_MODEL,
          style: process.env.LEAD_SUMMARY_STYLE || "crm_short",
          call,
          transcriptText
        });
      }

      // What goes to CRM:
      // - notes should be summary-oriented (NOT full transcript)
      // - full transcript can be optionally included with env flag
      const includeTranscript = String(process.env.LEAD_INCLUDE_TRANSCRIPT || "").toLowerCase() === "true";

      const notesFromParser =
        lead_parser && typeof lead_parser === "object"
          ? [
              lead_parser.subject ? `נושא: ${lead_parser.subject}` : "",
              lead_parser.request ? `בקשה: ${lead_parser.request}` : "",
              lead_parser.details ? `פרטים: ${lead_parser.details}` : "",
              lead_parser.action_needed ? `מה צריך: ${lead_parser.action_needed}` : "",
              lead_parser.urgency ? `דחיפות: ${lead_parser.urgency}` : ""
            ]
              .filter(Boolean)
              .join("\n")
          : "";

      const payload = {
        event: eventType,
        call,
        lead: {
          name: lead.name || "",
          phone: lead.phone || "",
          // IMPORTANT: do not dump full transcript by default
          notes: notesFromParser || lead.request_text || "",
          lead_parser: lead_parser || null,
          ...(includeTranscript ? { transcript: transcriptText } : {})
        }
      };

      await deliverWebhook(eventType, payload);
    }

    twilioWs.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const ev = msg.event;

      if (ev === "connected") {
        logger.info("Twilio WS event", { event: "connected", streamSid: null, callSid: null });
        return;
      }

      if (ev === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;
        customParameters = msg?.start?.customParameters || {};

        // normalize caller now
        const c = normalizeCallerId(customParameters?.caller);
        callerInfo.value = c.value;
        callerInfo.withheld = c.withheld;

        // set default callback phone if not withheld
        if (!callerInfo.withheld && c.value) {
          lead.phone = c.value;
        }

        logger.info("Twilio stream start", { streamSid, callSid, customParameters });

        // SSOT already preloaded in server; keep non-breaking
        const ssot = getSSOT();

        // Start recording best-effort
        if (String(process.env.MB_ENABLE_RECORDING || "").toLowerCase() === "true" && callSid) {
          const recSid = await startTwilioCallRecording(callSid);
          if (recSid) {
            recording.provider = "twilio";
            recording.recording_sid = recSid;
            recording.recording_url_public = twilioRecordingMp3Url(recSid);
          }
        }

        // Create Gemini session exactly like Stage3 (same methods)
        try {
          gemini = new GeminiLiveSession({
            meta: {
              streamSid,
              callSid,
              caller: customParameters?.caller,
              called: customParameters?.called,
              source: customParameters?.source
            },
            ssot,
            onGeminiAudioUlaw8kBase64: (ulawB64) => sendToTwilioMedia(ulawB64),
            onGeminiText: (t) => logger.debug("Gemini text", { streamSid, callSid, t }),
            onTranscript: ({ who, text, normalized }) => {
              // keep your existing transcript logs
              logger.info(`TRANSCRIPT ${who}`, { streamSid, callSid, text });

              // capture minimal lead state WITHOUT affecting audio
              const s = (normalized || text || "").trim();

              if (who === "user") {
                // 1) name capture
                if (!lead.name) {
                  const nm = extractNameHe(s);
                  if (nm) lead.name = nm;
                } else {
                  // 2) after name, capture request text (first meaningful user content)
                  if (!lead.request_text && s.length >= 3) {
                    lead.request_text = s;
                  } else if (lead.request_text && s.length >= 3) {
                    // keep last meaningful line as "latest request"
                    lead.request_text = s;
                  }

                  // 3) if caller withheld and user says number, capture phone
                  if (callerInfo.withheld && !lead.phone) {
                    const ph = extractPhoneAny(s);
                    if (ph) lead.phone = ph;
                  }
                }
              }

              // store short transcript always (for parser), cap size
              const role = who === "bot" ? "BOT" : "USER";
              if (s) {
                lead.transcript.push({ role, text: s });
                if (lead.transcript.length > 120) lead.transcript.shift();
              }
            }
          });

          gemini.start();
        } catch (e) {
          logger.error("Failed to start Gemini session", { streamSid, callSid, error: String(e?.message || e) });
        }

        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (b64 && gemini) gemini.sendUlaw8kFromTwilio(b64);
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });

        try {
          if (gemini) {
            gemini.endInput();
            gemini.stop();
          }
        } catch {}

        // finalize (STOP is the canonical "final" point)
        await finalizeCall("stop_called");

        return;
      }
    });

    twilioWs.on("close", async () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });

      try {
        if (gemini) gemini.stop();
      } catch {}

      // If WS closed without stop, still finalize once
      // (Twilio usually sends stop, but be defensive)
      await finalizeCall("ws_closed");
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      try {
        if (gemini) gemini.stop();
      } catch {}
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
