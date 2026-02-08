// src/server.js
"use strict";

const express = require("express");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");
const { healthRouter } = require("./routes/health");
const { adminReloadRouter } = require("./routes/adminReloadSheets");
const { recordingsRouter } = require("./routes/recordings");
const { loadSSOT } = require("./ssot/ssotClient");
const { installTwilioMediaWs } = require("./ws/twilioMediaWs");

const app = express();

// Keep HTTP responsiveness extremely fast (Render port scan/health checks)
app.use(express.json({ limit: "1mb" }));

// Fast root handler (Render may probe "/")
app.get("/", (req, res) => {
  res.status(200).json({ ok: true, service: "voicebot_blank" });
});
app.head("/", (req, res) => res.sendStatus(200));

app.use(healthRouter);
app.use(adminReloadRouter);
app.use(recordingsRouter);

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Render injects PORT. Fall back to env.PORT for local/dev.
const port = Number(process.env.PORT || env.PORT || 10000);

// Bind explicitly to 0.0.0.0 for containerized environments.
const server = app.listen(port, "0.0.0.0", () => {
  logger.info("Service started", {
    port,
    provider_mode: env.PROVIDER_MODE
  });

  // Best-effort preload SSOT, but DO NOT block the event loop during startup.
  // If SSOT fetch/auth takes time, Render's probes can time out and show:
  // "No open HTTP ports detected..." / 499.
  setImmediate(() => {
    loadSSOT(false)
      .then(() => {})
      .catch((err) => {
        logger.error("SSOT preload failed", { error: err?.message || String(err) });
      });
  });
});

// IMPORTANT: attach WS upgrade handler to the real HTTP server
installTwilioMediaWs(server);
