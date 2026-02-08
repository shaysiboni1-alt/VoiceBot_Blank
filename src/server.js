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

const app = express();

// Twilio webhooks default to application/x-www-form-urlencoded.
// Keep limits small; we do not expect large bodies.
app.use(express.urlencoded({ extended: false, limit: "256kb" }));
app.use(express.json({ limit: "1mb" }));

// Render/Twilio probes sometimes hit '/' — keep it fast and 200.
app.get("/", (req, res) => res.status(200).send("ok"));

app.use(healthRouter);
app.use(adminReloadRouter);
app.use(recordingsRouter);
app.use(twilioStatusRouter);

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

const server = app.listen(env.PORT, "0.0.0.0", () => {
  logger.info("Service started", {
    port: env.PORT,
    provider_mode: env.PROVIDER_MODE
  });

  // Do not block the HTTP listener with startup work.
  void preloadSsot();
});

async function preloadSsot() {
  try {
    await loadSSOT(false);
  } catch (err) {
    logger.error("SSOT preload failed", { error: err?.message || String(err) });
  }
}

// IMPORTANT: attach WS upgrade handler to the real HTTP server
installTwilioMediaWs(server);

module.exports = { app, server };
