"use strict";

const express = require("express");
const { loadSSOT, getSSOT } = require("../ssot/ssotClient");
const { env } = require("../config/env");

const router = express.Router();

/**
 * POST /admin/reload-sheets
 * Auth: x-admin-token must equal TWILIO_AUTH_TOKEN (כמו שיש אצלך עכשיו)
 */
router.post("/admin/reload-sheets", async (req, res) => {
  const token = req.headers["x-admin-token"];

  if (!token || token !== env.TWILIO_AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const ssot = await loadSSOT(true);
    return res.status(200).json({
      ok: true,
      reloaded_at: ssot.loaded_at,
      settings_keys: Object.keys(ssot.settings || {}).length,
      prompts_keys: Object.keys(ssot.prompts || {}).length,
      intents: (ssot.intents || []).length
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "reload_failed",
      message: err.message
    });
  }
});

module.exports = { adminReloadRouter: router };
