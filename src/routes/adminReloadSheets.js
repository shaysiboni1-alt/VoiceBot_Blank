"use strict";

const express = require("express");
const { loadSSOT } = require("../ssot/ssotClient");
const { env } = require("../config/env");

const router = express.Router();

router.post("/admin/reload-sheets", async (req, res) => {
  const token = req.headers["x-admin-token"];

  // MVP auth: משתמשים ב-TWILIO_AUTH_TOKEN (כי אין MB_ADMIN_TOKEN כרגע)
  if (!env.TWILIO_AUTH_TOKEN || !token || token !== env.TWILIO_AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const ssot = await loadSSOT(true);
    return res.status(200).json({
      ok: true,
      reloaded_at: ssot.loaded_at,
      settings_keys: ssot.settings_keys,
      prompts_keys: ssot.prompts_keys,
      intents: ssot.intents
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
