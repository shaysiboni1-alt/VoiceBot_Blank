// src/routes/twilioStatus.js
"use strict";

const express = require("express");
const { logger } = require("../utils/logger");

const twilioStatusRouter = express.Router();

/**
 * Twilio Call Status Callback endpoint.
 * MUST respond fast (<= 1s). Do not do any heavy work here.
 *
 * Twilio sends x-www-form-urlencoded by default.
 * server.js already has express.urlencoded(...) enabled.
 */
twilioStatusRouter.post("/twilio/status", (req, res) => {
  try {
    // Log only minimal fields (avoid huge bodies)
    const callSid = req.body?.CallSid || req.body?.CallSid?.toString?.();
    const callStatus = req.body?.CallStatus || req.body?.CallStatus?.toString?.();
    const from = req.body?.From || req.body?.From?.toString?.();
    const to = req.body?.To || req.body?.To?.toString?.();
    const eventType = req.body?.EventType || req.body?.EventType?.toString?.();

    logger.info("Twilio status callback", {
      callSid: callSid || null,
      callStatus: callStatus || null,
      from: from || null,
      to: to || null,
      eventType: eventType || null,
    });

    // Respond immediately (Twilio expects fast ACK)
    return res.status(200).json({ ok: true });
  } catch (e) {
    // Still return 200 so Twilio stops retry/timeouts
    try {
      logger.warn("Twilio status callback error", { err: String(e) });
    } catch (_) {}
    return res.status(200).json({ ok: true });
  }
});

module.exports = { twilioStatusRouter };
