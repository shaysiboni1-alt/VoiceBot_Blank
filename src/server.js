// src/server.js
"use strict";

const express = require("express");

const { env } = require("./config/env");
const { logger } = require("./utils/logger");

const { healthRouter } = require("./routes/health");
const { adminReloadRouter } = require("./routes/adminReloadSheets");
const { recordingsRouter } = require("./routes/recordings");
const { twilioStatusRouter } = require("./routes/twilioStatus");

const { loadSSOT } = require("./ssot/ssotClient");
const { installTwilioMediaWs } = require("./ws/twilioMediaWs");

const { setRecordingForCall } = require("./utils/recordingRegistry");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// Render probe
app.get("/", (req, res) => res.status(200).send("ok"));

// Routers
app.use(healthRouter);
app.use(adminReloadRouter);
app.use(twilioStatusRouter);

// Public recording proxy endpoints
app.use(recordingsRouter);

// Twilio async recording callback
app.post("/twilio-recording-callback", (req, res) => {
  try {
    const callSid = String(req.body?.CallSid || "").trim();
    const recordingSid = String(req.body?.RecordingSid || "").trim();
    const recordingUrl = String(req.body?.RecordingUrl || "").trim();

    // log only minimal fields
    logger.info("Twilio recording callback received", {
      callSid: callSid || null,
      recordingSid: recordingSid || null,
      hasRecordingUrl: Boolean(recordingUrl),
    });

    if (callSid) {
      setRecordingForCall(callSid, {
        recordingSid: recordingSid || null,
        recordingUrl: recordingUrl || null,
      });
    }

    res.status(200).type("application/json").send(JSON.stringify({ ok: true }));
  } catch (e) {
    logger.warn("twilio-recording-callback error", { err: String(e) });
    res.status(200).type("application/json").send(JSON.stringify({ ok: true }));
  }
});

app.use((req, res) => res.status(404).json({ error: "not_found" }));

const server = app.listen(env.PORT, "0.0.0.0", async () => {
  logger.info("Service started", { port: env.PORT, provider_mode: env.PROVIDER_MODE });

  try {
    await loadSSOT(false);
  } catch (err) {
    logger.error("SSOT preload failed", { error: err?.message || String(err) });
  }
});

installTwilioMediaWs(server);
