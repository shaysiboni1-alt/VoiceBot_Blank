// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { getSSOT } = require("../ssot/ssotClient");
const { env } = require("../config/env");

// -----------------------------
// helpers
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
    low === "withheld" ||
    low === "private"
  ) {
    return { value: s, withheld: true };
  }

  const digits = s.replace(/\D/g, "");
  if (!digits) return { value: s, withheld: false };
  return { value: s, withheld: false };
}

function extractNameHe(text) {
  const t = safeStr(text).trim();
  if (!t) return "";

  // common patterns
  const m =
    t.match(/(?:השם שלי(?: זה)?|קוראים לי|שמי|אני)\s+(.+)$/i) ||
    t.match(/^(.+)$/i);

  let name = (m && m[1]) ? m[1] : "";
  name = safeStr(name).trim();

  // strip trailing punctuation / quotes
  name = name.replace(/^[\s"'“”‘’]+/, "").replace(/[\s,.;:!?'"“”‘’]+$/g, "");
  // too long? probably sentence, not a name
  if (name.length > 40) return "";
  return name;
}

function summarizeRequestHe(userUtterancesAfterName) {
  // lightweight fallback summary if you don't want model-call here
  const joined = userUtterancesAfterName.map((x) => x.text).join(" ");
  const s = joined.trim();
  if (!s) return "";
  // keep it short for CRM
  return s.length > 240 ? s.slice(0, 237) + "..." : s;
}

async function deliverWebhook(ssot, eventType, payload) {
  const url = safeStr(ssot?.settings?.FINAL_WEBHOOK_URL || ssot?.settings?.WEBHOOK_URL).trim();
  if (!url) return { skipped: true };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_type: eventType,
        ts: nowIso(),
        ...payload,
      }),
    });

    logger.info("Webhook delivered", {
      eventType,
      status: res.status,
      attempt: 1,
    });

    return { ok: true, status: res.status };
  } catch (e) {
    logger.error("Webhook delivery failed", { eventType, error: String(e) });
    return { ok: false, error: String(e) };
  }
}

// -----------------------------
// main installer
// -----------------------------

function installTwilioMediaWs(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer });

  wss.on("connection", async (ws, req) => {
    logger.info("Twilio media WS connected");

    // state (always defined)
    const state = {
      created_at_ms: nowMs(),
      started_at_iso: "",
      ended_at_iso: "",
      streamSid: "",
      callSid: "",
      caller: "",
      called: "",
      source: "VoiceBot_Blank",
      caller_withheld: false,

      // lead
      lead: {
        name: "",
        phone: "",
        request_text: "",
        pleasing: "",
        notes: "",
      },

      // transcript always array
      transcript: [], // { who: 'user'|'bot', text, ts }
      got_name: false,
      got_request: false,

      // finalize guard
      finalized: false,
      sent: {
        call_log_start: false,
        call_log_end: false,
        final: false,
        abandoned: false,
      },
    };

    let ssot = null;
    try {
      ssot = await getSSOT();
    } catch (e) {
      logger.error("SSOT load failed (ws)", { error: String(e) });
      ssot = null;
    }

    let session = null;

    function pushTranscript(who, text) {
      const t = safeStr(text).trim();
      if (!t) return;
      state.transcript.push({ who, text: t, ts: nowIso() });
    }

    async function sendCallLogStartIfNeeded() {
      if (state.sent.call_log_start) return;
      state.sent.call_log_start = true;

      await deliverWebhook(ssot, "CALL_LOG", {
        phase: "start",
        streamSid: state.streamSid,
        callSid: state.callSid,
        caller: state.caller,
        called: state.called,
        source: state.source,
        started_at: state.started_at_iso || nowIso(),
      });
    }

    async function sendCallLogEndIfNeeded() {
      if (state.sent.call_log_end) return;
      state.sent.call_log_end = true;

      await deliverWebhook(ssot, "CALL_LOG", {
        phase: "end",
        streamSid: state.streamSid,
        callSid: state.callSid,
        caller: state.caller,
        called: state.called,
        source: state.source,
        started_at: state.started_at_iso || "",
        ended_at: state.ended_at_iso || nowIso(),
      });
    }

    async function sendFinalIfNeeded() {
      if (state.sent.final) return;
      state.sent.final = true;

      await deliverWebhook(ssot, "FINAL", {
        streamSid: state.streamSid,
        callSid: state.callSid,
        caller: state.caller,
        called: state.called,
        source: state.source,
        started_at: state.started_at_iso || "",
        ended_at: state.ended_at_iso || "",
        lead: state.lead,
      });
    }

    async function sendAbandonedIfNeeded(lastUtterance) {
      if (state.sent.abandoned) return;
      state.sent.abandoned = true;

      await deliverWebhook(ssot, "ABANDONED", {
        streamSid: state.streamSid,
        callSid: state.callSid,
        caller: state.caller,
        called: state.called,
        source: state.source,
        started_at: state.started_at_iso || "",
        ended_at: state.ended_at_iso || "",
        last_utterance: safeStr(lastUtterance || ""),
        lead_partial: {
          name: state.lead.name || "",
          phone: state.lead.phone || "",
        },
      });
    }

    async function finalizeOnce(reason) {
      if (state.finalized) return;
      state.finalized = true;

      state.ended_at_iso = nowIso();

      try {
        // always send end CALL_LOG exactly once
        await sendCallLogEndIfNeeded();

        // decide FINAL / ABANDONED
        const userUtterances = state.transcript.filter((x) => x.who === "user");
        const lastUser = userUtterances.length ? userUtterances[userUtterances.length - 1].text : "";

        // lead completion rules:
        // - abandoned if no name
        // - final if name + request_text
        if (!state.got_name || !state.lead.name) {
          await sendAbandonedIfNeeded(lastUser);
          return;
        }

        if (!state.got_request || !state.lead.request_text) {
          await sendAbandonedIfNeeded(lastUser);
          return;
        }

        await sendFinalIfNeeded();
      } catch (e) {
        logger.warn("Finalize failed", { error: String(e), reason });

        // best-effort: if finalize crashed, at least try abandoned once (never both)
        try {
          if (!state.sent.final && !state.sent.abandoned) {
            const userUtterances = state.transcript.filter((x) => x.who === "user");
            const lastUser = userUtterances.length ? userUtterances[userUtterances.length - 1].text : "";
            await sendAbandonedIfNeeded(lastUser);
          }
        } catch (_) {}
      }
    }

    // -----------------------------
    // Twilio WS event handler
    // -----------------------------
    ws.on("message", async (msg) => {
      let evt;
      try {
        evt = JSON.parse(msg.toString("utf8"));
      } catch (e) {
        logger.warn("Twilio WS non-json message", { err: String(e) });
        return;
      }

      const eventType = evt?.event;
      logger.info("Twilio WS event", {
        event: eventType,
        streamSid: evt?.streamSid || null,
        callSid: evt?.start?.callSid || null,
      });

      if (eventType === "start") {
        state.streamSid = safeStr(evt?.start?.streamSid || evt?.streamSid);
        state.callSid = safeStr(evt?.start?.callSid);
        state.started_at_iso = nowIso();

        const cp = evt?.start?.customParameters || {};
        state.source = safeStr(cp.source || "VoiceBot_Blank");
        state.caller = safeStr(cp.caller || "");
        state.called = safeStr(cp.called || "");
        const callerNorm = normalizeCallerId(state.caller);
        state.caller_withheld = callerNorm.withheld;

        // phone for lead capture defaults to caller id (policy may override later)
        state.lead.phone = state.caller_withheld ? "" : state.caller;

        logger.info("Twilio stream start", {
          streamSid: state.streamSid,
          callSid: state.callSid,
          customParameters: cp,
        });

        // start CALL_LOG once
        await sendCallLogStartIfNeeded();

        // Create Gemini live session (audio path stays untouched)
        session = new GeminiLiveSession({
          streamSid: state.streamSid,
          callSid: state.callSid,
          caller: state.caller,
          called: state.called,
          source: state.source,

          // transcript callbacks
          onUtterance: (who, text, normalized, lang) => {
            // keep your existing logs
            logger.info("UTTERANCE " + who, {
              streamSid: state.streamSid,
              callSid: state.callSid,
              caller: state.caller,
              called: state.called,
              source: state.source,
              text,
              normalized,
              lang,
            });

            // always store transcript safely
            pushTranscript(who, text);

            // capture lead fields (simple deterministic)
            if (who === "user") {
              // name gate
              if (!state.got_name) {
                const name = extractNameHe(text);
                if (name) {
                  state.got_name = true;
                  state.lead.name = name;
                }
              } else if (!state.got_request) {
                // first user content after name becomes request_text baseline
                const t = safeStr(text).trim();
                if (t) {
                  state.got_request = true;
                  state.lead.request_text = t;
                  // default pleasing/notes (without full transcript)
                  state.lead.pleasing = t;
                  // notes = short CRM summary (fallback)
                  const afterName = state.transcript.filter(
                    (x) => x.who === "user"
                  );
                  state.lead.notes = summarizeRequestHe(afterName);
                }
              } else {
                // accumulate request_text a bit more (optional)
                const t = safeStr(text).trim();
                if (t) {
                  const combined = (state.lead.request_text + " " + t).trim();
                  state.lead.request_text = combined.length > 400 ? combined.slice(0, 397) + "..." : combined;
                  state.lead.pleasing = state.lead.request_text;
                  const afterName = state.transcript.filter((x) => x.who === "user");
                  state.lead.notes = summarizeRequestHe(afterName);
                }
              }
            }
          },

          // debug text from model (keep)
          onDebugText: (t) => {
            logger.debug("Gemini text", {
              streamSid: state.streamSid,
              callSid: state.callSid,
              t: safeStr(t),
            });
          },
        });

        await session.connect();

        return;
      }

      if (eventType === "media") {
        // If we got media before start, just ignore (prevents weird states)
        if (!session) return;
        const payload = evt?.media?.payload;
        if (!payload) return;

        // forward audio to Gemini live session
        session.ingestTwilioMedia(payload);
        return;
      }

      if (eventType === "stop") {
        logger.info("Twilio stream stop", {
          streamSid: state.streamSid || null,
          callSid: state.callSid || null,
        });

        try {
          if (session) await session.close();
        } catch (_) {}

        await finalizeOnce("stop");
        return;
      }
    });

    ws.on("close", async () => {
      logger.info("Twilio media WS closed", {
        streamSid: state.streamSid || null,
        callSid: state.callSid || null,
      });

      try {
        if (session) await session.close();
      } catch (_) {}

      await finalizeOnce("ws_close");
    });

    ws.on("error", async (err) => {
      logger.warn("Twilio media WS error", { error: String(err) });

      try {
        if (session) await session.close();
      } catch (_) {}

      await finalizeOnce("ws_error");
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
