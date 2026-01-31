// src/server.js
"use strict";

const http = require("http");
const express = require("express");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");
const { healthRouter } = require("./routes/health");
const { adminReloadRouter } = require("./routes/adminReloadSheets");
const { loadSSOT } = require("./ssot/ssotClient");
const { attachTwilioMediaWs } = require("./telephony/twilioMediaWs");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);
app.use(adminReloadRouter);

app.use((req, res) => res.status(404).json({ error: "not_found" }));

const server = http.createServer(app);

// WebSocket: /twilio-media-stream
attachTwilioMediaWs(server);

server.listen(env.PORT, async () => {
  logger.info("Service started", {
    port: env.PORT,
    provider_mode: env.PROVIDER_MODE,
  });

  // Best-effort preload SSOT
  try {
    await loadSSOT(false);
  } catch (err) {
    logger.error("SSOT preload failed", { error: err.message });
  }
});
