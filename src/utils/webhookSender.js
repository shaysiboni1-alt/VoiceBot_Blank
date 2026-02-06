// src/utils/webhookSender.js
import fetch from "node-fetch";

const sent = new Set();

export async function sendWebhookOnce(key, url, payload, timeoutMs=5000) {
  if (sent.has(key)) return;
  sent.add(key);

  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);

  try {
    await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
  } catch(e) {
    // retry פעם אחת בלבד כמו GilSport
    try {
      await fetch(url, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
    } catch(_) {}
  } finally {
    clearTimeout(t);
  }
}
