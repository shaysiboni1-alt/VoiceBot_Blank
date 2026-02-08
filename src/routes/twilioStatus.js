// src/routes/twilioStatus.js
"use strict";

const express = require("express");
const { logger } = require("../utils/logger");

const twilioStatusRouter = express.Router();

/**
 * Twilio "Call status changes" webhook endpoint.
 *
 * Twilio expects this URL to return HTTP 200 quickly. If the handler hangs,
 * Twilio will show Warning 15003 / HTTP 502 (timeout ~30s).
 *
 * We keep it minimal: log the payload and respond 200 immediately.
 */
twilioStatusRouter.all("/twilio/status", (req, res) => {
  try {
    // Twilio often sends x-www-form-urlencoded; server.js enables urlencoded().
    logger.info("Twilio status callback", {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"],
        "user-agent": req.headers["user-agent"],
      },
      body: req.body,
      query: req.query,
    });
  } catch (e) {
    // Never break Twilio callback.
  }

  return res.status(200).send("ok");
});

module.exports = { twilioStatusRouter };
