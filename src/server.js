/**
 * src/server.js
 * Render entrypoint.
 * Goals:
 *  - Bind HTTP on 0.0.0.0:${PORT} so Render port scan succeeds.
 *  - Keep / (and /health) fast (no SSOT/network awaits) to avoid 499/scan timeouts.
 *  - Expose Twilio status webhook endpoint that returns immediately (prevents Twilio 502 timeout).
 *  - Do NOT change the audio / WS pipeline.
 */

'use strict';

const express = require('express');
const env = require('./config/env');
const { logger } = require('./utils/logger');

const { installTwilioMediaWs } = require('./telephony/twilioStreamServer');
const { loadSSOT, startSSOTAutoRefresh } = require('./ssot/ssotClient');

// Routers (keep paths consistent with current repo layout)
const { healthRouter } = require('./routes/health');
const { adminReloadSheetsRouter } = require('./routes/adminReloadSheets');
const { twilioStatusRouter } = require('./routes/twilioStatus');
const { recordingsRouter } = require('./routes/recordings'); // optional; safe even if not used

const app = express();

// Twilio webhooks are often application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));

/**
 * IMPORTANT: Render port scan hits GET /
 * Keep this handler trivial and synchronous.
 */
app.get('/', (req, res) => {
  res.status(200).send('ok');
});

// Mount routers (keep them fast; no long awaits in handlers)
app.use(healthRouter);
app.use(adminReloadSheetsRouter);
app.use(twilioStatusRouter);

// Recording proxy/public endpoints (if present in your repo)
if (recordingsRouter) {
  app.use(recordingsRouter);
}

// 404 fast path (also helps port scan / random probes)
app.use((req, res) => {
  res.status(404).send('not_found');
});

const port = Number(env.PORT || process.env.PORT || 10000);

// Bind explicitly to 0.0.0.0 to satisfy Render scanner.
const server = app.listen(port, '0.0.0.0', () => {
  logger.info('Service started', { port, provider_mode: env.PROVIDER_MODE });
});

// Optional: tighten timeouts to avoid long-hanging requests
server.requestTimeout = 30_000;
server.headersTimeout = 35_000;

/**
 * Boot sequence:
 * - Start WS server for Twilio Media Streams (voice path).
 * - Load SSOT in background (DO NOT block HTTP readiness).
 * - Start SSOT auto-refresh (if your ssotClient supports it).
 */
installTwilioMediaWs(server);

// Background SSOT load (non-blocking)
loadSSOT()
  .then((info) => logger.info('SSOT loaded', info))
  .catch((err) => logger.error('SSOT load failed', { err: String(err?.message || err) }));

// If supported: periodic refresh without blocking
try {
  startSSOTAutoRefresh?.();
} catch (e) {
  // ignore if not implemented in this repo version
}
