"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { getLogger } = require("../utils/logger");
const { getAccessToken } = require("../utils/gcpAuth");

const log = getLogger();

/**
 * GeminiLiveSession
 * - Supports Developer API (API key) OR Vertex AI (OAuth token) based on GEMINI_VERTEX_ENABLED
 * - Exposes a stable interface:
 *    - start(): Promise<void>
 *    - sendUlaw8kFromTwilio(b64): void
 *    - sendText(text): void
 *    - close(code?, reason?): void
 *    - isOpen(): boolean
 */
class GeminiLiveSession {
  constructor({
    streamSid,
    callSid,
    onGeminiText,
    onGeminiAudioUlaw8kB64,
    onGeminiTurnEnd,
    systemInstruction,
    generationConfig,
    responseModalities = ["AUDIO"] // IMPORTANT: default to audio-only to reduce junk text latency
  }) {
    this.streamSid = streamSid;
    this.callSid = callSid;

    this.onGeminiText = onGeminiText;
    this.onGeminiAudioUlaw8kB64 = onGeminiAudioUlaw8kB64;
    this.onGeminiTurnEnd = onGeminiTurnEnd;

    this.systemInstruction = systemInstruction || "";
    this.generationConfig = generationConfig || {};
    this.responseModalities = responseModalities;

    this.ws = null;
    this._closed = false;
    this._started = false;
  }

  isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    const { url, headers } = await this._buildWsTarget();

    this.ws = new WebSocket(url, { headers });

    this.ws.on("open", () => {
      log.info("Gemini Live WS connected", { streamSid: this.streamSid, callSid: this.callSid });
      this._sendSetup();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleGeminiMessage(msg);
      } catch (e) {
        log.warn("Gemini message parse failed", { err: String(e) });
      }
    });

    this.ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : "";
      log.info("Gemini Live WS closed", { streamSid: this.streamSid, callSid: this.callSid, code, reason });
      this._closed = true;
    });

    this.ws.on("error", (err) => {
      log.error("Gemini Live WS error", { streamSid: this.streamSid, callSid: this.callSid, err: String(err) });
    });
  }

  close(code = 1000, reason = "") {
    this._closed = true;
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(code, reason);
      }
    } catch (_) {}
  }

  // Stable alias used by Twilio bridge
  sendUlaw8kFromTwilio(b64) {
    // Never throw here; Twilio audio can keep coming even if WS died.
    try {
      if (!this.isOpen()) return;

      // For Gemini Live, audio chunk message is typically:
      // { realtimeInput: { mediaChunks: [{ mimeType, data }] } }
      const mimeType = "audio/mulaw"; // ulaw8k
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType, data: b64 }]
          }
        })
      );
    } catch (e) {
      log.warn("sendUlaw8kFromTwilio failed", { err: String(e) });
    }
  }

  sendText(text) {
    try {
      if (!this.isOpen()) return;
      this.ws.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true
          }
        })
      );
    } catch (e) {
      log.warn("sendText failed", { err: String(e) });
    }
  }

  _sendSetup() {
    // Minimize output text: audio-only default
    const setup = {
      setup: {
        model: env.GEMINI_LIVE_MODEL,
        generationConfig: this.generationConfig,
        systemInstruction: this.systemInstruction ? { parts: [{ text: this.systemInstruction }] } : undefined,
        responseModalities: this.responseModalities
      }
    };

    // Remove undefined for cleaner payload
    if (!setup.setup.systemInstruction) delete setup.setup.systemInstruction;

    try {
      this.ws.send(JSON.stringify(setup));
    } catch (e) {
      log.error("Gemini setup send failed", { err: String(e) });
    }
  }

  _handleGeminiMessage(msg) {
    // Text (optional)
    if (msg?.serverContent?.modelTurn?.parts) {
      for (const p of msg.serverContent.modelTurn.parts) {
        if (p?.text && this.onGeminiText) this.onGeminiText(p.text);
        // Audio output (if any)
        if (p?.inlineData?.data && this.onGeminiAudioUlaw8kB64) {
          // In many Live responses, inlineData contains base64 audio bytes
          this.onGeminiAudioUlaw8kB64(p.inlineData.data);
        }
      }
    }

    // Turn end
    if (msg?.serverContent?.turnComplete) {
      if (this.onGeminiTurnEnd) this.onGeminiTurnEnd();
    }
  }

  async _buildWsTarget() {
    // Vertex AI mode
    if (env.GEMINI_VERTEX_ENABLED) {
      const token = await getAccessToken();
      const location = env.GEMINI_LOCATION || "us-central1";
      const projectId = env.GEMINI_PROJECT_ID;

      if (!projectId) {
        throw new Error("GEMINI_PROJECT_ID is required when GEMINI_VERTEX_ENABLED=true");
      }

      // Vertex Live WS endpoint (matches your existing geminiVertexLive.js style)
      const url =
        `wss://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
        `/locations/${location}/publishers/google/models/${env.GEMINI_LIVE_MODEL}:streamGenerateContent`;

      return {
        url,
        headers: {
          Authorization: `Bearer ${token}`
        }
      };
    }

    // Developer API mode (API key)
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when GEMINI_VERTEX_ENABLED=false");

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    return { url, headers: {} };
  }
}

module.exports = { GeminiLiveSession };
