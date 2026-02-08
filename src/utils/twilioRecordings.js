'use strict';

const { Readable } = require('node:stream');

function twilioAuthHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  const basic = Buffer.from(`${sid}:${token}`).toString('base64');
  return `Basic ${basic}`;
}

function twilioBase() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  return `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
}

async function startCallRecording(callSid, logger) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    logger?.warn?.('TWILIO creds missing; cannot start recording');
    return { ok: false, recordingSid: null };
  }
  try {
    const url = `${twilioBase()}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;
    const body = new URLSearchParams({
      RecordingChannels: 'dual',
      RecordingTrack: 'both',
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: twilioAuthHeader(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const txt = await resp.text();
    if (!resp.ok) {
      logger?.warn?.('Twilio start recording failed', { status: resp.status, body: txt?.slice?.(0, 300) });
      return { ok: false, recordingSid: null };
    }

    const j = JSON.parse(txt);
    return { ok: true, recordingSid: j.sid || null };
  } catch (e) {
    logger?.warn?.('Twilio start recording exception', { err: String(e) });
    return { ok: false, recordingSid: null };
  }
}

// NOTE: keep URL shape consistent with what you already send in webhooks
function publicRecordingUrl(recordingSid) {
  const base = process.env.PUBLIC_BASE_URL || '';
  if (!base || !recordingSid) return null;
  return `${base.replace(/\/$/, '')}/recording/${recordingSid}.mp3`;
}

async function hangupCall(callSid, logger) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return false;
  try {
    const url = `${twilioBase()}/Calls/${encodeURIComponent(callSid)}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: twilioAuthHeader(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!resp.ok) {
      const t = await resp.text();
      logger?.warn?.('Twilio hangup failed', { status: resp.status, body: t?.slice?.(0, 200) });
      return false;
    }
    return true;
  } catch (e) {
    logger?.warn?.('Twilio hangup exception', { err: String(e) });
    return false;
  }
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchTwilioMp3(recordingSid, logger) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const auth = twilioAuthHeader();

  const url1 = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;

  // Hard timeout to avoid “infinite loading”
  const { signal, cancel } = withTimeout(15000);

  try {
    // 1) First request (manual redirect)
    const r1 = await fetch(url1, {
      method: 'GET',
      headers: { authorization: auth },
      redirect: 'manual',
      signal,
    });

    // Twilio often responds with redirect to CDN
    if ([301, 302, 307, 308].includes(r1.status)) {
      const loc = r1.headers.get('location');
      if (!loc) return { ok: false, status: 502, text: 'missing_redirect_location' };

      // Follow redirect WITHOUT auth (CDN url is usually public)
      const r2 = await fetch(loc, {
        method: 'GET',
        redirect: 'follow',
        signal,
      });

      if (!r2.ok) {
        const t = await r2.text().catch(() => '');
        return { ok: false, status: r2.status, text: t || 'cdn_fetch_failed' };
      }
      return { ok: true, resp: r2 };
    }

    if (!r1.ok) {
      const t = await r1.text().catch(() => '');
      return { ok: false, status: r1.status, text: t || 'twilio_fetch_failed' };
    }

    return { ok: true, resp: r1 };
  } catch (e) {
    logger?.warn?.('Twilio mp3 fetch exception', { err: String(e) });
    return { ok: false, status: 504, text: 'twilio_fetch_timeout_or_error' };
  } finally {
    cancel();
  }
}

async function proxyRecordingMp3(recordingSid, res, logger) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!accountSid || !process.env.TWILIO_AUTH_TOKEN) {
    res.statusCode = 503;
    res.end('twilio_not_configured');
    return;
  }

  try {
    const out = await fetchTwilioMp3(recordingSid, logger);
    if (!out.ok) {
      res.statusCode = out.status || 502;
      res.end((out.text || '').slice(0, 2000));
      return;
    }

    const resp = out.resp;

    // Forward headers if present
    res.statusCode = 200;
    res.setHeader('content-type', resp.headers.get('content-type') || 'audio/mpeg');

    const len = resp.headers.get('content-length');
    if (len) res.setHeader('content-length', len);

    if (!resp.body) {
      res.statusCode = 502;
      res.end('empty_body');
      return;
    }

    const nodeStream = Readable.fromWeb(resp.body);
    nodeStream.on('error', (e) => {
      logger?.warn?.('recording proxy stream error', { err: String(e) });
      try { res.end(); } catch (_) {}
    });
    nodeStream.pipe(res);
  } catch (e) {
    logger?.warn?.('recording proxy exception', { err: String(e) });
    res.statusCode = 500;
    res.end('proxy_error');
  }
}

module.exports = {
  startCallRecording,
  publicRecordingUrl,
  hangupCall,
  proxyRecordingMp3,
};
