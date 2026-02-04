// src/stage4/finalizePipeline.js

export async function finalizePipeline({
  snapshot,
  env,
  senders,
  logger = console,
}) {
  const safe = async (fn, label) => {
    try {
      return await fn();
    } catch (err) {
      logger.error(`[STAGE4:${label}]`, err);
      return null;
    }
  };

  const sent = {
    callLog: false,
    final: false,
    abandoned: false,
  };

  // 1) CALL_LOG – exactly once
  if (env.CALL_LOG_AT_START || env.CALL_LOG_AT_END) {
    await safe(() => senders.sendCallLog(snapshot), "CALL_LOG");
    sent.callLog = true;
  }

  // 2) החלטה דטרמיניסטית
  const decision = decideLead(snapshot);

  // 3) Recording – חובה, best-effort
  const recording = await safe(
    () => senders.resolveRecording(snapshot),
    "RECORDING"
  );

  // 4) FINAL / ABANDONED – אחד בלבד
  if (decision.type === "FINAL" && !sent.final) {
    const payload = {
      ...snapshot.basePayload,
      event_type: "FINAL",
      lead_decision: "FINAL",
      decision_reason: decision.reason,
      recording_provider: recording?.provider || "twilio",
      recording_sid: recording?.sid || null,
      recording_url_public: recording?.publicUrl || null,
    };

    await safe(() => senders.sendFinal(payload), "FINAL");
    sent.final = true;
  }

  if (decision.type === "ABANDONED" && !sent.abandoned) {
    const payload = {
      ...snapshot.basePayload,
      event_type: "ABANDONED",
      lead_decision: "ABANDONED",
      decision_reason: decision.reason,
      recording_provider: recording?.provider || "twilio",
      recording_sid: recording?.sid || null,
      recording_url_public: recording?.publicUrl || null,
    };

    await safe(() => senders.sendAbandoned(payload), "ABANDONED");
    sent.abandoned = true;
  }

  return {
    finalized: true,
    decision: decision.type,
    reason: decision.reason,
  };
}

function decideLead(snapshot) {
  const {
    full_name,
    subject,
    callback_to_number,
    subject_min_words,
  } = snapshot.lead || {};

  if (!full_name) {
    return { type: "ABANDONED", reason: "missing_name" };
  }

  if (
    !subject ||
    subject.split(/\s+/).length < (subject_min_words || 3)
  ) {
    return { type: "ABANDONED", reason: "subject_too_short" };
  }

  if (!callback_to_number) {
    return { type: "ABANDONED", reason: "missing_callback" };
  }

  return { type: "FINAL", reason: "lead_complete" };
}
