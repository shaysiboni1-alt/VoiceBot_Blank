"use strict";

const { logger } = require("../utils/logger");
const { createGeminiLiveClient } = require("../providers/geminiLiveWs");

/**
 * Twilio <Stream> sends JSON messages:
 * - event: "start" (with start.customParameters, callSid, streamSid)
 * - event: "media" (media.payload base64 audio)
 * - event: "stop"
 *
 * To send audio back to Twilio, we send:
 * { event:"media", streamSid, media:{ payload:"<base64>" } }
 */
function attachTwilioMediaBridge(twilioWs) {
  let streamSid = null;
  let callSid = null;
  let gemini = null;

  function safeSendToTwilio(obj) {
    try {
      if (twilioWs.readyState === 1) twilioWs.send(JSON.stringify(obj));
    } catch (e) {
      logger.warn("Failed sending to Twilio WS", { error: e.message || String(e) });
    }
  }

  twilioWs.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }

    const ev = msg.event;

    if (ev === "start") {
      streamSid = msg.streamSid || (msg.start && msg.start.streamSid) || null;
      callSid = (msg.start && msg.start.callSid) || msg.callSid || null;

      const customParameters = (msg.start && msg.start.customParameters) || {};
      logger.info("Twilio stream start", { streamSid, callSid, customParameters });

      // MVP system prompt — כרגע קבוע. בהמשך נביא מ-SSOT (כולל פתיח לפי שעה וכו').
      const systemPromptText =
        "את/ה עוזר/ת קולי/ת. דבר/י בעברית, משפטים קצרים. המתן/י למשתמש ואז ענה/י. אם צריך לסיים שיחה, תגיד/י סגירה קצרה.";

      gemini = createGeminiLiveClient({ callSid, streamSid, systemPromptText });

      // Receive from Gemini and forward any audio back to Twilio
      gemini.ws.on("message", (gBuf) => {
        let g;
        try {
          g = JSON.parse(gBuf.toString("utf8"));
        } catch {
          return;
        }

        // אנחנו לא מניחים מבנה אחד בלבד.
        // מחפשים כל inline audio pcma/pcmu base64 בתוך ההודעה.
        const b64List = extractAudioBase64(g);

        for (const b64 of b64List) {
          safeSendToTwilio({
            event: "media",
            streamSid,
            media: { payload: b64 }
          });
        }

        // אם יש טקסט/סמנים — אפשר לוג (אופציונלי)
        if (g && typeof g === "object") {
          if (g.server_content && g.server_content.model_turn && g.server_content.model_turn.parts) {
            const texts = [];
            for (const p of g.server_content.model_turn.parts) {
              if (p.text) texts.push(p.text);
            }
            if (texts.length) {
              logger.info("Gemini assistant text", { callSid, streamSid, text: texts.join(" ").slice(0, 400) });
            }
          }
        }
      });

      return;
    }

    if (ev === "media") {
      const payload = msg.media && msg.media.payload;
      if (payload && gemini) {
        // Twilio sends audio as base64 ulaw8k (pcmu). We forward as audio/pcmu.
        gemini.sendAudioBase64Pcmu(payload);
      }
      return;
    }

    if (ev === "stop") {
      logger.info("Twilio stream stop", { streamSid, callSid });

      try {
        if (gemini && gemini.ws && gemini.ws.readyState === 1) gemini.ws.close();
      } catch {}

      return;
    }
  });

  twilioWs.on("close", () => {
    logger.info("Twilio media WS closed", { streamSid, callSid });
    try {
      if (gemini && gemini.ws && gemini.ws.readyState === 1) gemini.ws.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    logger.warn("Twilio media WS error", { error: err.message || String(err), streamSid, callSid });
  });
}

function extractAudioBase64(obj) {
  const out = [];
  walk(obj, (node) => {
    // נפוץ: inlineData / inline_data
    const inline = node.inlineData || node.inline_data;
    if (inline && typeof inline === "object") {
      const mt = inline.mimeType || inline.mime_type;
      const data = inline.data;
      if (typeof data === "string" && typeof mt === "string") {
        if (mt.toLowerCase().includes("audio") && mt.toLowerCase().includes("pcmu")) {
          out.push(data);
        }
      }
    }

    // לפעמים: node.audio = { data, mime_type }
    if (node.audio && typeof node.audio === "object") {
      const mt = node.audio.mimeType || node.audio.mime_type;
      const data = node.audio.data;
      if (typeof data === "string" && typeof mt === "string") {
        if (mt.toLowerCase().includes("audio") && mt.toLowerCase().includes("pcmu")) {
          out.push(data);
        }
      }
    }
  });
  return out;
}

function walk(obj, fn) {
  if (!obj || typeof obj !== "object") return;
  fn(obj);
  if (Array.isArray(obj)) {
    for (const it of obj) walk(it, fn);
  } else {
    for (const k of Object.keys(obj)) walk(obj[k], fn);
  }
}

module.exports = { attachTwilioMediaBridge };
