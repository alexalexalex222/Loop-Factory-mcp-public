// Frozen facts the whole server is built around. Pure data only — no logic, no I/O.

// The two mandated, hash-locked FULL PRIVATE loop sources. These hashes are the
// contract: loops.mjs refuses to start if the bundled bytes do not match, and the
// test suite re-derives both from disk. Both are byte-identical to the operator's
// full private sources (no lite/public/summarized/reconstructed text). The
// supervisor — not edits to the loop text — owns stop policy, so the loops stay
// verbatim. The 345-line file is The Strip Miner Loop (the local big cross-agent
// miner, NOT the short 3-paragraph GitHub one); the 75-line file is Loop-de-loop
// (Loop 2), the full private improvement loop. "Loop hardener" is NOT a product
// name; the product loop is Loop-de-loop. ("loop-hardener"/"hardener" survive only
// as back-compat resolution aliases.)
export const MANDATED_LOOPS = {
  'strip-miner': {
    id: 'strip-miner',
    file: 'strip-miner.txt',
    sha256: '5270d691319120758423503e74c5aa6b378409b55f30bc6d2f2f7ca283ed9ec9',
    lines: 345,
    trigger: '/loop strip-miner',
    aka: ['the-strip-miner-loop', 'strip-miner-loop', 'cross-agent-strip-miner', 'miner'],
    role: 'mine',
    title: 'The Strip Miner Loop',
    // A few section headers that exist ONLY in the full 345-line miner. Used to
    // prove the short GitHub miner was not substituted in.
    bigMinerMarkers: [
      'DURABLE READER WAVES',
      'CONTRADICTION SWEEP',
      'CLEAN-CONTEXT REPLAY',
      'INDEPENDENT ROOT-TASK PROOF',
      'WEB LOOP SCOUTING AND EXTERNAL INSPIRATION',
      'PUBLICATION AND SHARING BOUNDARY'
    ]
  },
  'loop-de-loop': {
    id: 'loop-de-loop',
    file: 'loop-de-loop.md',
    sha256: '70090e033e995374710722771372d1afb17b6f0f823b2ce2911d9bfd38022b44',
    lines: 75,
    trigger: '/loop loop-de-loop',
    aka: ['loop-2', 'loop2', 'loop-de-loop-hardener', 'loop-hardener', 'hardener'],
    role: 'improve',
    title: 'Loop-de-loop (Loop 2)',
    bigMinerMarkers: []
  }
};

// Dashboard warning string — asserted verbatim in tests so the contract stays
// visible. Operator-specified exact text.
export const STOP_CONDITION_WARNING =
  'WARNING: You are the stop condition. This loop does not stop until you stop it.';

// On-start notice: tell the WORKER its runtime's native continuous/agentic command
// so the campaign is not stopped early by the runtime itself. Surfaced at init
// alongside the stop-condition warning; the operator is still the only stop condition.
// NOTE: Claude Code's convergence driver is /goal (progress-driven — the next turn
// starts automatically when the previous finishes, against an objective only the
// operator can complete); its /loop is interval polling or self-paced wake-ups, not
// a convergence campaign. Codex's is /goal too. Keep BOTH /goal and /loop tokens —
// do not collapse to one. (Ref: https://code.claude.com/docs/en/goal)
export const NATIVE_CONTINUATION_NOTICE =
  'On start, engage your runtime’s native continuous mode so this run is not stopped early: ' +
  'Claude Code → /goal (progress-driven: the next turn starts when the previous finishes; set an objective only the operator can complete), Codex → /goal, other runtimes → your equivalent continuous/agentic loop command. ' +
  '(Claude Code’s /loop is for interval polling or self-paced wake-ups, not a convergence campaign — prefer /goal here.) ' +
  'Then keep working the phase gate until the operator stops you — do not self-complete. ' +
  'EXEC_DISABLED, saturation, and no-improvement advisories are checkpoints, not stops.';

// Cold-start contract (Step 7): surfaced on a FRESH run (not a resume) so the agent
// does not resurrect a prior campaign, reuse an earlier run's answers, or assume a
// path (improve / mine / discover) from memory or a recalled note. A real resume is
// explicit — the operator passes an existing runId.
export const COLD_START_NOTICE =
  'New run: start clean. Do not continue a prior campaign, reuse an earlier run’s answers, or assume a path (improve / mine / discover) from memory or a recalled note — infer only from THIS operator’s message and the ask-once answers. To resume an existing campaign instead, pass its runId.';

// Per-host continuous-mode setup, as PURE DATA. engine.buildHostSetup() reads the
// host from SUPER_LOOP_HOST and fills {OBJECTIVE}. The hard fact baked in here: in
// Claude Code the convergence driver is /goal (progress-driven — the next turn starts
// automatically when the previous finishes, against an objective only the operator can
// complete); its /loop is interval polling or self-paced wake-ups, not a convergence
// campaign. In Codex it is /goal too. A model that confuses these stalls the campaign,
// so each branch is explicit. (Ref: https://code.claude.com/docs/en/goal)
export const CONTINUOUS_MODE_BY_HOST = {
  claude: {
    host: 'claude',
    command: '/goal',
    engageStep:
      'Engage continuous mode now: run /goal with this objective: "{OBJECTIVE}", and give it a completion condition only the operator can satisfy — Claude Code starts the next turn automatically when the previous finishes and keeps driving until the operator stops you. Never let the goal complete on a measurement checkpoint (EXEC_DISABLED / saturation / no-improvement) — those are not stops. (/loop is for interval polling or self-paced wake-ups, not this convergence campaign.)'
  },
  codex: {
    host: 'codex',
    command: '/goal',
    engageStep:
      'Engage continuous mode now: create a Codex goal (/goal) with this objective: "{OBJECTIVE}", and keep it active across turns. Never mark the goal blocked or complete on a measurement checkpoint (EXEC_DISABLED / saturation / no-improvement) — those are not stops.'
  },
  unknown: {
    host: 'unknown',
    command: null,
    engageStep:
      'Engage your runtime’s native continuous/agentic mode now with this objective: "{OBJECTIVE}". Claude Code → /goal (progress-driven; /loop only for interval polling or self-paced wake-ups); Codex → /goal; other runtimes → your equivalent continuous loop command. Keep it active until the operator stops you.'
  }
};

// The states a worker must NOT read as "stop". Surfaced in hostSetup so the model
// has the list in front of it before it ever hits one.
export const NEVER_STOP_ON = [
  'EXEC_DISABLED — live exec is opt-in; record run-logs via artifact_record + test_hypothesis instead, and keep going',
  'Strip Miner saturation — the supervisor auto-pivots to the next lane',
  'a 10–15 no-improvement advisory — a risk note only, never a stop',
  'reports, dashboard updates, report_export — checkpoints, not stopping points'
];

// Default model the server proposes when the operator does not name one.
// "the most capable available model" — the operator may override at init, and
// the agent is told to web-search current SOTA before committing.
export const DEFAULT_PRIMARY_MODEL = 'claude-opus-4-8';

// Named current-frontier routes (advisory only — banlist below is the hard gate).
export const KNOWN_FRONTIER_EXAMPLES = ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2', 'gemini-3-pro'];

// Builds and IN-LOOP GATING route ONLY to these trusted builder/gating workers.
// Codex/GPT remains a supported HOST surface but is NOT a trusted in-loop builder
// or gating worker (it keeps re-architecting the spec), so it is excluded here.
// This does not narrow the general frontier set used for hypothesis test workers.
export const BUILDER_GATING_ROUTES = ['claude-opus-4-8', 'glm-5.2'];

export const DEFAULTS = {
  failurePatience: 12, // consecutive no-improvement full tests before a RISK ADVISORY (spec: 10–15); advisory never stops the run
  branchRetirementBatches: 30, // valid full real test batches with no qualifying improvement before a branch RETIRES and PIVOTS to the next lane (never a campaign stop)
  hypothesisMin: 3,
  hypothesisMax: 5,
  fullTestAgentsMin: 3, // each full test = 3–5 agents actually running the loop
  fullTestAgentsMax: 5,
  promotion: {
    minQualityGain: 0.05, // quality is 0..1; a real win moves it by >= 5 pts
    costRegressionTolerance: 0.15, // a quality win may cost up to +15% tokens
    minCostSaving: 0.10 // a cost win must cut >= 10% tokens with no quality loss
  }
};

// Campaign lane vocabulary. Lanes are how the supervisor models the target queue:
// a 'mine' lane runs the Strip Miner; an 'improve' lane runs Loop-de-loop. On
// saturation/retirement the supervisor AUTO-TRANSITIONS to the next lane. None of
// these are pause/await/stop states — there is no valid terminal campaign state.
export const LANE_KIND = { MINE: 'mine', IMPROVE: 'improve' };
export const LANE_STATUS = { ACTIVE: 'active', SATURATED: 'saturated', RETIRED: 'retired' };

// Run / cycle status vocabulary.
export const STATUS = {
  AWAITING_ANSWERS: 'AWAITING_ANSWERS',
  INITIALIZED: 'INITIALIZED',
  ACTIVE: 'ACTIVE',
  NEEDS_RESUME: 'NEEDS_RESUME'
};

// Block codes — every BLOCKED result carries one so callers (and tests) can branch.
export const BLOCK = {
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  UNKNOWN_RUN: 'UNKNOWN_RUN',
  NO_ACTIVE_LOOP: 'NO_ACTIVE_LOOP',
  NOT_STARTED: 'NOT_STARTED',
  PHASE_SKIP: 'PHASE_SKIP',
  UNKNOWN_LOOP: 'UNKNOWN_LOOP',
  BASELINE_FIRST: 'BASELINE_FIRST',
  BASELINE_LOCKED: 'BASELINE_LOCKED',
  BASELINE_BAR_FIRST: 'BASELINE_BAR_FIRST',
  BASELINE_PLACEHOLDER: 'BASELINE_PLACEHOLDER',       // baseline content reads as a placeholder/stub, not a real reference
  BASELINE_TOO_SHALLOW: 'BASELINE_TOO_SHALLOW',       // baseline content too thin/unstructured to be a real bar
  BASELINE_AUTHOR_FORBIDDEN: 'BASELINE_AUTHOR_FORBIDDEN', // worker tried to set its own bar (or claim maker/operator without the out-of-band authority)
  BENCHMARK_FIRST: 'BENCHMARK_FIRST',
  BENCHMARK_FROZEN: 'BENCHMARK_FROZEN',
  WEAK_BENCHMARK: 'WEAK_BENCHMARK',
  HYPOTHESIS_COUNT: 'HYPOTHESIS_COUNT',
  BANNED_ROUTE: 'BANNED_ROUTE',
  UNKNOWN_HYPOTHESIS: 'UNKNOWN_HYPOTHESIS',
  FULLTEST_AGENTS: 'FULLTEST_AGENTS',
  MODEL_REPORTED: 'MODEL_REPORTED',
  NO_SCORE_MATRIX: 'NO_SCORE_MATRIX',
  NOT_REVERIFIED: 'NOT_REVERIFIED',
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
  BELOW_FLOOR: 'BELOW_FLOOR',
  STAGED_TRADEOFF: 'STAGED_TRADEOFF',
  OPERATOR_IS_STOP: 'OPERATOR_IS_STOP',
  DASHBOARD_ONLY: 'DASHBOARD_ONLY',
  MEASUREMENT_AUTHORITY: 'MEASUREMENT_AUTHORITY', // a caller-reported (not tool-computed) cost reached a gate
  QUALITY_UNVERIFIED: 'QUALITY_UNVERIFIED',       // a quality win the MCP cannot tool-verify → dashboard, never auto-promote
  PROMOTION_NEEDS_APPROVAL: 'PROMOTION_NEEDS_APPROVAL', // pareto+integrity win, but no operator dashboard Approve yet → cannot ship
  PROMOTION_REJECTED: 'PROMOTION_REJECTED',       // operator declined the champion on the dashboard (Sludge/Reject)
  LOOP_EXISTS: 'LOOP_EXISTS',                     // custom loop id collides with a mandated/registered loop
  LOOP_SOURCE: 'LOOP_SOURCE',                     // custom loop source is empty/too small to phase-gate
  NO_ACTIVE_LANE: 'NO_ACTIVE_LANE',               // a supervisor lane op ran with no active lane
  BUILDER_ROUTE: 'BUILDER_ROUTE',                 // a build / in-loop gating step routed to a non-builder (e.g. codex/gpt) worker
  EXEC_DISABLED: 'EXEC_DISABLED',                 // live worker execution requested but SUPER_LOOP_ALLOW_EXEC is not set
  EXEC_FAILED: 'EXEC_FAILED',                     // a launched worker failed/timed out/was not allowlisted → invalid batch (does not count)
  ROUTE_UNSPAWNABLE: 'ROUTE_UNSPAWNABLE',         // a registered route has no executor binary (opencode not on PATH) and was not recorded manually with provenance
  MANUAL_PROVENANCE_REQUIRED: 'MANUAL_PROVENANCE_REQUIRED', // an artifact for a hypothesis with no Loop Factory-executed run must carry provenance (a hand-run result, made traceable)
  // Integrity Gate — ONE coarse worker-visible code for every anti-gaming hit. The
  // specific sealed reason and forensic detail are written only to the supervisor ledger.
  INTEGRITY_GATE: 'INTEGRITY_GATE',
  TARGET_SATURATED_NEEDS_NEW_TARGET: 'TARGET_SATURATED_NEEDS_NEW_TARGET',
  BAD_INPUT: 'BAD_INPUT'
};

// Verdicts a measured full test can carry. NO_IMPROVEMENT is never "perfect".
export const VERDICT = {
  MOVED_FRONTIER: 'MOVED_FRONTIER',
  NO_IMPROVEMENT: 'NO_IMPROVEMENT',
  NEEDS_MEASUREMENT: 'NEEDS_MEASUREMENT'
};
