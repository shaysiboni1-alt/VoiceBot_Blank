"use strict";

const express = require("express");
const { logger } = require("../utils/logger");

const router = express.Router();

router.post("/twilio/status", express.urlencoded({ extended: false }), (req, res) => {
  // Twilio שולח application/x-www-form-urlencoded כברירת מחדל
  const callSid = req.body?.CallSid || req.body?.CallSid?.toString();
  const callStatus = req.body?.CallStatus || req.body?.CallStatus?.toString();
  const from = req.body?.From || req.body?.From?.toString();
  const to = req.body?.To || req.body?.To?.toString();

  logger.info("Twilio status webhook received", {
    callSid,
    callStatus,
    from,
    to
  });

  return res.status(200).json({ ok: true });
});

module.exports = { twilioStatusRouter: router };
