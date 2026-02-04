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

function publicRecordingUrl(recordingSid) {
  const base = process.env.PUBLIC_BASE_URL || '';
  if (!base || !recordingSid) return null;
  return `${base.replace(/\/$/, '')}/recordings/${recordingSid}.mp3`;
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
      logger?.warn?.('Twilio hangup failed', { status: resp.status, body: t?.slice?.(0, 250) });
      return false;
    }
    return true;
  } catch (e) {
    logger?.warn?.('Twilio hangup exception', { err: String(e) });
    return false;
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
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { authorization: twilioAuthHeader() },
    });

    if (!resp.ok) {
      const t = await resp.text();
      res.statusCode = resp.status;
      res.end(t);
      return;
    }

    res.setHeader('content-type', 'audio/mpeg');
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
