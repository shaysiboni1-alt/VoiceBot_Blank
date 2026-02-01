"use strict";

const { env } = require("../config/env");

function log(level, msg, meta) {
  const line = {
    time: new Date().toISOString(),
    level,
    msg
  };
  if (meta && typeof meta === "object") line.meta = meta;
  console.log(JSON.stringify(line));
}

const logger = {
  info: (msg, meta) => log("info", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  error: (msg, meta) => log("error", msg, meta),
  debug: (msg, meta) => {
    if (env.MB_DEBUG) log("debug", msg, meta);
  }
};

module.exports = { logger };
