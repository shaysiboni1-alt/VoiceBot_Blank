"use strict";

// src/ws/twilioMediaWs.js
// Twilio Media Streams <-> Gemini Live bridge
// Non-breaking design: keep SSOT-driven behavior; add deterministic lead gating + webhooks.

const WebSocket = require("ws");
const { createGeminiLiveSession } = require("../vendor/geminiLiveSession");
const { logger } = require("../utils/logger");
const { loadSSOT } = require("../ssot/ssotClient");
const { deliverWebhook } = require("../utils/webhooks");
const {
  startCallRecording,
  hangupCall,
  publicRecordingUrl,
} = require("../utils/twilioRecording");

const {
  createPassiveCallContext,
  appendUtterance,
  finalizeCtx,
} = require("../logic/passiveCallContext");

function nowIso() {
  return new Date().toISOString();
}

function transcriptToText(transcriptArr) {
  return (transcriptArr || [])
    .map((x) => `${String(x.role || "").toUpperCase()}: ${x.text || ""}`)
    .join("\n");
}

function shouldTriggerHangup(botText, ssot) {
  const t = String(botText || "").trim();
  if (!t) return false;

  // Fast heuristic
  if (t.includes("תודה") && t.includes("להתראות")) return true;

  // Match explicit closers in SETTINGS_CONTEXT
  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => String(settings[k] || "").trim())
    .filter(Boolean);

  return closers.some((c) => c && t.startsWith(c.slice(0, Math.min(18, c.length))));
}

async function maybeStartRecording(ctx) {
  if (String(process.env.MB_ENABLE_RECORDING) !== "true") return;
  if (!ctx?.callSid) return;

  try {
    const recSid = await startCallRecording(ctx.callSid, logger);
    if (recSid) {
      ctx.recordingSid = recSid;
      ctx.recording_url_public = publicRecordingUrl(recSid);
    }
  } catch (e) {
    logger.warn({ msg: "Recording start failed", meta: { error: String(e) } });
  }
}

async function runLeadParser({ ssot, transcript, callMeta }) {
  // Your existing system already has LEAD_PARSER_PROMPT in SSOT;
  // Here we keep it "best-effort" and do NOT break calls if it fails.
  if (!process.env.LEAD_PARSER_ENABLED || String(process.env.LEAD_PARSER_ENABLED) === "false") {
    return null;
  }

  // If you already implemented a parser elsewhere in your repo, keep using it there.
  // For now: return null to keep behavior safe, unless you explicitly want the postcall LLM parser here.
  // (We will lock the full parser later once everything is stable.)
  return null;
}

async function finalizeAndWebhook({ ctx, ssot }) {
  if (!ctx) return;

  finalizeCtx(ctx);

  const transcriptText = transcriptToText(ctx.transcript);
  const duration_ms =
    ctx.started_at && ctx.ended_at
      ? Math.max(0, new Date(ctx.ended_at).getTime() - new Date(ctx.started_at).getTime())
      : 0;

  // Lead completeness rule (Stage 4 rule): name + request => FINAL, else ABANDONED
  const leadComplete = Boolean(ctx.name && ctx.has_request);
  const eventType = leadComplete ? "FINAL" : "ABANDONED";

  const callMeta = {
    callSid: ctx.callSid,
    streamSid: ctx.streamSid,
    caller: ctx.caller_raw || "",
    called: ctx.called || "",
    source: ctx.source || "VoiceBot_Blank",
    started_at: ctx.started_at,
    ended_at: ctx.ended_at,
    duration_ms,
    caller_withheld: !!ctx.caller_withheld,

    recording_provider: ctx.recordingSid ? "twilio" : "",
    recording_url_public: ctx.recording_url_public || "",
  };

  let leadParser = null;
  if (leadComplete) {
    leadParser = await runLeadParser({ ssot, transcript: transcriptText, callMeta });
  }

  const payload = {
    event: eventType,
    call: callMeta,
    lead: {
      name: ctx.name || "",
      phone: ctx.callback_number || "",
      notes: transcriptText,
      lead_parser: leadParser,
    },
  };

  await deliverWebhook(eventType, payload, logger);
}

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", async (ws) => {
    logger.info({ msg: "Twilio media WS connected" });

    // Load SSOT (cached by ssotClient TTL)
    const ssot = await loadSSOT();

    let session = null;
    let ctx = null;
    let closingInitiated = false;

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.event === "start") {
        const streamSid = msg?.start?.streamSid || "";
        const callSid = msg?.start?.callSid || "";
        const custom = msg?.start?.customParameters || {};
        const caller = custom.caller || "";
        const called = custom.called || "";
        const source = custom.source || "VoiceBot_Blank";

        logger.info({
          msg: "Twilio stream start",
          meta: { streamSid, callSid, customParameters: custom },
        });

        ctx = createPassiveCallContext({ callSid, streamSid, caller, called, source });

        // Optional recording info fields (safe default)
        ctx.recordingSid = "";
        ctx.recording_url_public = "";

        // CALL_LOG as early as possible (start-of-stream signal)
        await deliverWebhook(
          "CALL_LOG",
          {
            event: "CALL_LOG",
            call: {
              callSid,
              streamSid,
              caller: ctx.caller_raw || "",
              called: ctx.called || "",
              source: ctx.source || "VoiceBot_Blank",
              started_at: ctx.started_at,
            },
          },
          logger
        );

        await maybeStartRecording(ctx);

        // Create Gemini Live session (SSOT-driven)
        session = createGeminiLiveSession({
          ssot,
          meta: { streamSid, callSid, caller, called, source },
        });

        // Gemini -> Twilio audio
        session.on("audio", (audioChunk) => {
          try {
            // Accept Buffer or base64 string
            const b64 =
              Buffer.isBuffer(audioChunk)
                ? audioChunk.toString("base64")
                : String(audioChunk || "");

            if (b64) {
              ws.send(JSON.stringify({ event: "media", media: { payload: b64 } }));
            }
          } catch (e) {
            logger.warn({ msg: "Failed to forward audio", meta: { error: String(e) } });
          }
        });

        // Utterances (user/bot) with normalized/lang if provided by your Stage3 NLP
        session.on("utterance", (u) => {
          try {
            appendUtterance(ctx, u);

            // If bot says a closing phrase: proactively hang up after a short delay
            if (u?.role === "bot") {
              const text = String(u?.text || "");
              if (!closingInitiated && shouldTriggerHangup(text, ssot)) {
                closingInitiated = true;
                setTimeout(() => {
                  if (ctx?.callSid) {
                    hangupCall(ctx.callSid, logger).catch(() => {});
                  }
                }, 900);
              }
            }
          } catch (e) {
            logger.warn({ msg: "Utterance handling failed", meta: { error: String(e) } });
          }
        });

        session.on("log", (entry) => {
          logger.debug({ msg: "Gemini log", meta: { entry } });
        });

        session.start();
        return;
      }

      if (msg.event === "media") {
        if (!session) return;
        try {
          const b = Buffer.from(msg?.media?.payload || "", "base64");
          session.sendAudio(b);
        } catch {
          // ignore
        }
        return;
      }

      if (msg.event === "stop") {
        const streamSid = msg?.stop?.streamSid || "";
        const callSid = msg?.stop?.callSid || "";
        logger.info({ msg: "Twilio stream stop", meta: { streamSid, callSid } });

        try {
          session?.stop();
        } catch {}

        // FINAL/ABANDONED is emitted ONLY on stop (your requirement)
        await finalizeAndWebhook({ ctx, ssot });

        ctx = null;
        session = null;
        return;
      }
    });

    ws.on("close", async () => {
      logger.info({ msg: "Twilio media WS closed" });

      // If stop wasn't received, try best-effort finalize as ABANDONED/FINAL based on ctx.
      // (This is safer than losing everything.)
      try {
        if (ctx) {
          await finalizeAndWebhook({ ctx, ssot });
        }
      } catch {}

      try {
        session?.stop();
      } catch {}

      ctx = null;
      session = null;
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
