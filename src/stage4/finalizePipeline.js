"use strict";

/**
 * Stage 4 – Canonical Call Finalization (Adapter + SSOT)
 * - Supports snapshot-based invocation (current runtime)
 * - CALL_LOG always
 * - FINAL xor ABANDONED (deterministic LeadGate)
 */

function nowIso() {
  return new Date().toISOString();
}

function wordsCount(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v);
}

function computeLeadGate(lead) {
  const name = safeStr(lead?.full_name);
  const subject = safeStr(lead?.subject);
  const phone = safeStr(lead?.callback_to_number);

  if (!name || name.length < 2) {
    return { ok: false, reason: "missing_name" };
  }

  const minWords = Number(lead?.subject_min_words || 3);
  if (!subject || wordsCount(subject) < minWords) {
    return { ok: false, reason: "missing_subject" };
  }

  if (!phone) {
    return { ok: false, reason: "missing_phone" };
  }

  return { ok: true, reason: "lead_complete" };
}

/**
 * finalizeCall – canonical (callState-based)
 */
async function finalizeCall({ reason, callState, env, logger, senders }) {
  if (!callState || typeof callState !== "object") {
    throw new TypeError("finalizeCall: callState is missing/invalid");
  }

  // 0) Guard – run exactly once
  if (callState.finalized) {
    logger?.debug?.("finalizeCall: already finalized");
    return;
  }
  callState.finalized = true;

  // 1) Close timing
  const endedAt = nowIso();
  callState.ended_at = endedAt;

  const startedAtMs = new Date(callState.started_at || Date.now()).getTime();
  const durationMs = Date.now() - startedAtMs;

  // 2) Resolve recording (best-effort, blocking)
  let recording = {
    recording_provider: "",
    recording_sid: "",
    recording_url_public: ""
  };

  // IMPORTANT: keep it best-effort; do not block webhooks if resolveRecording fails.
  try {
    const enableRecording =
      !!env?.MB_ENABLE_RECORDING || String(env?.MB_ENABLE_RECORDING || "").toLowerCase() === "true";

    if (enableRecording && senders?.resolveRecording) {
      const r = await senders.resolveRecording();
      if (r && typeof r === "object") {
        recording = {
          recording_provider: safeStr(r.recording_provider),
          recording_sid: safeStr(r.recording_sid),
          recording_url_public: safeStr(r.recording_url_public)
        };
      }
    }
  } catch (e) {
    logger?.warn?.("Recording resolve failed", { error: String(e) });
  }

  // 3) LeadGate – deterministic decision
  const gate = computeLeadGate(callState.lead);

  // 4) Build base payload (stable contract)
  const basePayload = {
    event: null,

    call: {
      callSid: safeStr(callState.callSid),
      streamSid: safeStr(callState.streamSid),
      caller: safeStr(callState.caller),
      called: safeStr(callState.called),
      source: safeStr(callState.source),

      caller_withheld: !!callState.caller_withheld,

      started_at: safeStr(callState.started_at),
      ended_at: endedAt,
      duration_ms: durationMs,

      finalize_reason: safeStr(reason)
    },

    lead: {
      ...(callState.lead || {}),
      decision_reason: gate.reason
    },

    recording_provider: recording.recording_provider,
    recording_sid: recording.recording_sid,
    recording_url_public: recording.recording_url_public
  };

  // 5) CALL_LOG – always
  try {
    if (senders?.sendCallLog) {
      await senders.sendCallLog({ ...basePayload, event: "CALL_LOG" });
    }
  } catch (e) {
    logger?.warn?.("CALL_LOG webhook failed", { error: String(e) });
  }

  // 6) FINAL xor ABANDONED
  if (gate.ok) {
    try {
      if (senders?.sendFinal) {
        await senders.sendFinal({ ...basePayload, event: "FINAL" });
      }
    } catch (e) {
      logger?.warn?.("FINAL webhook failed", { error: String(e) });
    }
  } else {
    try {
      if (senders?.sendAbandoned) {
        await senders.sendAbandoned({ ...basePayload, event: "ABANDONED" });
      }
    } catch (e) {
      logger?.warn?.("ABANDONED webhook failed", { error: String(e) });
    }
  }
}

/**
 * finalizePipeline – ADAPTER (snapshot-based)
 * This matches the current runtime call site in geminiLiveSession.js
 */
async function finalizePipeline({ reason, snapshot, env, logger, senders } = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError("finalizePipeline: snapshot is missing/invalid");
  }

  // allow caller to store guard on snapshot
  if (snapshot.__finalized_stage4) {
    logger?.debug?.("finalizePipeline: snapshot already finalized");
    return;
  }
  snapshot.__finalized_stage4 = true;

  const call = snapshot.call || {};
  const lead = snapshot.lead || {};

  const callState = {
    finalized: false,

    callSid: call.callSid,
    streamSid: call.streamSid,
    caller: call.caller,
    called: call.called,
    source: call.source,

    caller_withheld: !!call.caller_withheld,

    started_at: call.started_at || nowIso(),
    ended_at: call.ended_at || null,

    lead
  };

  const effectiveReason = safeStr(reason || call.finalize_reason || call.reason || "unknown");

  return finalizeCall({
    reason: effectiveReason,
    callState,
    env,
    logger,
    senders
  });
}

module.exports = {
  finalizePipeline,
  finalizeCall,
  computeLeadGate
};
