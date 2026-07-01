// Run-capture: after a campaign milestone (a promotion banked/queued, or a lane pivot),
// snapshot the run's recorded action trajectory to <runDir>/trajectory-<ts>.jsonl so the
// trace can be reused offline. Read-only over the store — it only calls the engine's
// export_trajectories, which writes one assistant/tool_call line per recorded action.
//
// The held-out firewall is enforced TWICE: here (skip a gate-partitioned run before even
// asking) and inside engine.export_trajectories (which refuses gate runs). A gate-partition
// (held-out) trajectory is never written — defense in depth, so a future caller that forgets
// the pre-check still cannot leak a held-out run's trace.
//
// No side effects on import: every export is a plain function the driver and tests call.

// Campaign-level transcript steps (supervisor `tx(step,…)`) that mark a capture-worthy
// milestone: a promotion reached the gate (banked, or queued for operator approval) or a
// branch retired (lane pivot). subjective_win_queued is intentionally excluded — a judged
// win awaiting approval is a weaker signal than a measured one and need not be captured.
const CAPTURE_STEPS = new Set(['stone_banked', 'promotion_queued', 'branch_retired']);

/** True if a campaign transcript contains a promotion or lane-pivot milestone. */
export function campaignHasCaptureMilestone(transcript = []) {
  return (Array.isArray(transcript) ? transcript : []).some((e) => e && CAPTURE_STEPS.has(e.step));
}

/** A run is gate-partitioned (held-out) once a gate-partition benchmark is frozen onto it. */
export function isGatePartitioned(state) {
  return !!(state && state.benchmark && state.benchmark.frozen
    && state.benchmark.def && state.benchmark.def.benchPartition === 'gate');
}

/** Filesystem-safe wall-clock stamp — colons/dots in an ISO timestamp break some filesystems. */
export function trajectoryStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Capture a run's trajectory after a milestone. Returns a plain result object and never throws
 * on a refused export. Pass `store` to skip held-out (gate) runs before touching the engine;
 * pass `ts` for a deterministic filename (tests). On success writes
 * <runDir>/trajectory-<ts>.jsonl and returns { captured:true, path, sha256, lines }.
 */
export function captureTrajectory(engine, runId, { store = null, ts = null, reason = 'milestone' } = {}) {
  const stamp = ts || trajectoryStamp();
  // Firewall #1: never capture a held-out (gate) run — don't even ask the engine.
  if (store) {
    let state = null;
    try { state = store.load(runId); } catch { state = null; }
    if (isGatePartitioned(state)) return { captured: false, reason: 'gate-partitioned', runId };
  }
  const outPath = `trajectory-${stamp}.jsonl`;
  const res = engine.export_trajectories({ runId, outPath });
  if (res && res.status === 'OK') {
    return { captured: true, runId, reason, path: res.path, sha256: res.sha256, lines: res.lines };
  }
  // Firewall #2 (backstop): the engine refused (gate, unknown run, bad path). No file written.
  return { captured: false, reason: (res && res.code) || 'EXPORT_REFUSED', runId, detail: res && res.message };
}
