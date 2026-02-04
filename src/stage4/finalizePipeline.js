"use strict";

/**
 * STAGE 4 – Post-call Finalization Pipeline (isolated)
 *
 * Guarantees:
 * - Never throws (all exceptions are caught)
 * - CALL_LOG sent at most once per phase (dedup state outside or inside caller)
 * - FINAL and ABANDONED are mutually exclusive
 * - FINAL decision does NOT depend on transcript (only on lead fields captured during the call)
 * - Recording is best-effort and must not block webhook delivery
 */

function truthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function safeSplitWords(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * lead fields contract:
 * - full_name
 * - subject
 * - callback_to_number
 * - subject_min_words
 */
function decideLead(lead) {
  const fullName = String(lead?.full_name || "").trim();
  const subject = String(lead?.subject || "").trim();
  const cb = String(lead?.callback_to_number || "").trim();
  const minWords = Number(lead?.subject_min_words || 3);

  if (!fullName) return { type: "ABANDONED", reason: "missing_name" };
  if (!subject || safeSplitWords(subject).length < minWords) {
    return { type: "ABANDONED", reason: "subject_too_short" };
  }
  if (!cb) return { type: "ABANDONED", reason: "missing_callback" };

  return { type: "FINAL", reason: "lead_complete" };
}

async function finalizePipeline({ snapshot, env, senders, logger, state }) {
  const log = logger || console;

  const safe = async (fn, label) => {
    try {
      return await fn();
    } catch (err) {
      log?.warn?.(`[STAGE4:${label}] failed`, { error: err?.message || String(err) });
      return null;
    }
  };

  // local state to dedup (optional external state can also be passed)
  const st = state || {
    callLogSentStart: false,
    callLogSentEnd: false
  };

  const callLogAtStart = truthy(env?.CALL_LOG_AT_START);
  const callLogAtEnd = truthy(env?.CALL_LOG_AT_END);
  const callLogMode = String(env?.CALL_LOG_MODE || "start").trim().toLowerCase(); // start|end|both

  const wantStart = (callLogMode === "start" || callLogMode === "both") && callLogAtStart;
  const wantEnd = (callLogMode === "end" || callLogMode === "both") && callLogAtEnd;

  // NOTE: finalizePipeline is called at end-of-call.
  // If mode=start בלבד, אנחנו עדיין שולחים CALL_LOG "start" כאן (כי ריכזנו את השליחה לסוף),
  // אבל בצורה דטרמיניסטית ובדיוק פעם אחת.
  // אם תרצה בעתיד “אמיתי start בזמן חיבור” – נעשה זאת ב-ws בלי לשבור קול.
  const phaseToSend =
    wantEnd ? "end" : (wantStart ? "start" : null);

  if (phaseToSend && senders?.sendCallLog) {
    const already =
      phaseToSend === "start" ? st.callLogSentStart : st.callLogSentEnd;

    if (!already) {
      if (phaseToSend === "start") st.callLogSentStart = true;
      else st.callLogSentEnd = true;

      await safe(() => senders.sendCallLog({ ...snapshot, phase: phaseToSend }), "CALL_LOG");
    }
  }

  const decision = decideLead(snapshot?.lead || {});

  // Recording – best effort
  const recording = senders?.resolveRecording
    ? await safe(() => senders.resolveRecording(snapshot), "RECORDING")
    : null;

  const basePayload = {
    call: snapshot?.call || {},
    lead: snapshot?.lead || {},
    decision_reason: decision.reason,
    recording_provider: recording?.recording_provider || "",
    recording_sid: recording?.recording_sid || "",
    recording_url_public: recording?.recording_url_public || ""
  };

  if (decision.type === "FINAL" && senders?.sendFinal) {
    await safe(() => senders.sendFinal({ event: "FINAL", ...basePayload }), "FINAL");
  } else if (decision.type === "ABANDONED" && senders?.sendAbandoned) {
    await safe(() => senders.sendAbandoned({ event: "ABANDONED", ...basePayload }), "ABANDONED");
  }

  return { finalized: true, decision: decision.type, reason: decision.reason };
}

module.exports = { finalizePipeline, decideLead };
