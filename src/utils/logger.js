"use strict";

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Error);
}

function serializeError(err) {
  if (!err) return null;
  return {
    message: err.message || String(err),
    name: err.name || "Error",
    code: err.code,
    stack: err.stack,
  };
}

function normalizeArgs(msg, meta) {
  if (isPlainObject(msg) && typeof msg.msg === "string") {
    return {
      msg: msg.msg,
      meta: isPlainObject(msg.meta) ? msg.meta : undefined,
    };
  }

  if (msg instanceof Error) {
    return {
      msg: msg.message || "Error",
      meta: { error: serializeError(msg), ...(isPlainObject(meta) ? meta : {}) },
    };
  }

  if (isPlainObject(msg)) {
    return {
      msg: msg.event || msg.label || msg.message || "object_log",
      meta: msg,
    };
  }

  return {
    msg: String(msg ?? ""),
    meta: isPlainObject(meta)
      ? meta
      : meta instanceof Error
        ? { error: serializeError(meta) }
        : undefined,
  };
}

function emit(level, msg, meta) {
  const normalized = normalizeArgs(msg, meta);
  const line = {
    time: nowIso(),
    level,
    msg: normalized.msg,
  };
  if (normalized.meta && Object.keys(normalized.meta).length) {
    line.meta = normalized.meta;
  }

  const s = JSON.stringify(line);
  if (level === "error") console.error(s);
  else console.log(s);
}

const logger = {
  info: (msg, meta) => emit("info", msg, meta),
  debug: (msg, meta) => emit("debug", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};

function getLogger() {
  return logger;
}

module.exports = { logger, getLogger };
