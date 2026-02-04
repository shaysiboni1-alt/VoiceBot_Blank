// src/server.js
"use strict";

const express = require("express");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");
const { healthRouter } = require("./routes/health");
const { adminReloadRouter } = require("./routes/adminReloadSheets");
const { loadSSOT } = require("./ssot/ssotClient");
const { installTwilioMediaWs } = require("./ws/twilioMediaWs");
const { proxyRecordingMp3 } = require("./utils/twilioRecording");

// Optional route (exists in repo structure; keep non-breaking if missing)
let twilioStatusRouter = null;
try {
  // eslint-disable-next-line global-require
  const mod = require("./routes/twilioStatus");
  twilioStatusRouter = mod?.twilioStatusRouter || mod?.router || null;
} catch (_) {
  twilioStatusRouter = null;
}

const app = express();

app.use(express.json({ limit: "1mb" }));

// Health + Admin
app.use(healthRouter);
app.use(adminReloadRouter);

// Twilio status callback (if present)
if (typeof twilioStatusRouter === "function") {
  app.use(twilioStatusRouter);
}

// Public recording proxy: /recordings/{RecordingSid}.mp3
app.get("/recordings/:sid.mp3", async (req, res) => {
  try {
    await proxyRecordingMp3(req.params.sid, res, logger);
  } catch (err) {
    logger.error("proxyRecordingMp3 failed", { error: err?.message || String(err) });
    res.status(500).send("recording_proxy_error");
  }
});

// Default 404
app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

const server = app.listen(env.PORT, async () => {
  logger.info("Service started", {
    port: env.PORT,
    provider_mode: env.PROVIDER_MODE
  });

  // Best-effort preload SSOT
  try {
    await loadSSOT(false);
  } catch (err) {
    logger.error("SSOT preload failed", { error: err?.message || String(err) });
  }
});

// IMPORTANT: attach WS upgrade handler to the real HTTP server
installTwilioMediaWs(server);
