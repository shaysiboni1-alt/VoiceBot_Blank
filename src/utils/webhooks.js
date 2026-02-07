'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

function pickUrl(eventType) {
  const map = {
    CALL_LOG: process.env.CALL_LOG_WEBHOOK_URL,
    FINAL: process.env.FINAL_WEBHOOK_URL,
    ABANDONED: process.env.ABANDONED_WEBHOOK_URL,
  };
  return map[eventType] || '';
}

async function postJson(url, payload, { timeoutMs = 7000 } = {}) {
  if (!url) return { ok: false, status: 0, error: 'no_url' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => '');
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function deliverWebhook(eventType, payload, logger, opts = {}) {
  const url = pickUrl(eventType);
  if (!url) {
    logger?.info?.('Webhook skipped (no URL)', { eventType });
    return { ok: true, skipped: true };
  }

  const maxAttempts = Number(opts.maxAttempts ?? 3);
  const baseDelayMs = Number(opts.baseDelayMs ?? 350);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await postJson(url, payload, { timeoutMs: Number(opts.timeoutMs ?? 7000) });
    if (r.ok) {
      logger?.info?.('Webhook delivered', { eventType, status: r.status, attempt });
      return r;
    }
    logger?.warn?.('Webhook delivery failed', { eventType, attempt, status: r.status, error: r.error, text: r.text?.slice?.(0, 300) });
    if (attempt < maxAttempts) await sleep(baseDelayMs * attempt);
  }

  return { ok: false, status: 0, error: 'max_attempts_exceeded' };
}

module.exports = { deliverWebhook };
