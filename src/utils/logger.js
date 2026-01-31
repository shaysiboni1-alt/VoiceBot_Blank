// src/utils/logger.js
function base(level, msg, meta) {
  const time = new Date().toISOString();
  if (meta !== undefined) {
    console.log(JSON.stringify({ time, level, msg, meta }));
  } else {
    console.log(JSON.stringify({ time, level, msg }));
  }
}

const logger = {
  info: (msg, meta) => base("info", msg, meta),
  warn: (msg, meta) => base("warn", msg, meta),
  error: (msg, meta) => base("error", msg, meta),
  debug: (msg, meta) => base("debug", msg, meta)
};

module.exports = { logger };

