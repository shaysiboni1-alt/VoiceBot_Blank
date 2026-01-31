// src/routes/twilioStatus.js
"use strict";

const express = require("express");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

const router = express.Router();

/**
 * Twilio "Call status changes" webhook (incoming from Twilio)
 * Twilio sends x-www-form-urlencoded by default.
 *
 * Minimal response (fast 200) + logs.
 * Later we’ll connect this to ABANDONED/FINAL logic.
 */
router.post("/twilio/status", async (req, res) => {
  // Twilio usually posts fields like:
  // CallSid, CallStatus, From, To, Timestamp, etc.
  const callSid = req.body.CallSid || req.body.CallSID || "";
  const callStatus = req.body.CallStatus || "";
  const from = req.body.From || "";
  const to = req.body.To || "";

  logger.info("Twilio status webhook received", {
    callSid,
    callStatus,
    from,
    to
  });

  // For now: ack only
  return res.status(200).json({ ok: true });
});

module.exports = { twilioStatusRouter: router };
