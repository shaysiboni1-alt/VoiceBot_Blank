// src/server.js
"use strict";

const express = require("express");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");
const { healthRouter } = require("./routes/health");
const { adminReloadRouter } = require("./routes/adminReloadSheets");
const { loadSSOT } = require("./ssot/ssotClient");
const { installTwilioMediaWs } = require("./ws/twilioMediaWs");

const app = express();

app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);
app.use(adminReloadRouter);

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
    logger.error("SSOT preload failed", { error: err.message });
  }
});

// IMPORTANT: attach WS upgrade handler to the real HTTP server
installTwilioMediaWs(server);
