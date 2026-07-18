// Shared model-policy fixtures for tests. Assert POLICY-ENGINE BEHAVIOR, not
// hard-coded model hatred — defaults match today's historical banlist; mode "off"
// accepts routes that mode "default" rejects.
import {
  defaultModelPolicy, normalizeModelPolicy, modelPolicyPreset, makePolicy
} from '../../src/models.mjs';
import { DEFAULT_PRIMARY_MODEL, BUILDER_GATING_ROUTES } from '../../src/constants.mjs';

/** Historical default policy (enter / "defaults" / just-go). */
export const DEFAULT_POLICY = defaultModelPolicy('defaults');

/** Convenience route names under the default policy. */
export const ROUTES = {
  primary: DEFAULT_PRIMARY_MODEL,
  frontier: [DEFAULT_PRIMARY_MODEL, 'gpt-5.5', 'glm-5.2'],
  builders: [...BUILDER_GATING_ROUTES],
  judge: DEFAULT_PRIMARY_MODEL,
  banned: 'claude-haiku-4-5',
  bannedMini: 'gpt-5.5-mini',
  nonBuilder: 'gpt-5.5'
};

/** Banlist off — previously-banned routes clear classifyRoute. */
export const POLICY_OFF = normalizeModelPolicy({
  ...DEFAULT_POLICY,
  source: 'operator-init',
  banlist: { mode: 'off', extraDeny: [], extraAllow: [] }
});

/** Strict banlist — unknown frontier confidence rejected. */
export const POLICY_STRICT = normalizeModelPolicy({
  ...DEFAULT_POLICY,
  source: 'operator-init',
  banlist: { mode: 'strict', extraDeny: [], extraAllow: [] },
  allowUnknownFrontier: false
});

/** Build Week preset: GPT-5.6 Sol primary/test worker; trusted builders/judge preserved. */
export const GPT56_POLICY = modelPolicyPreset('gpt-5.6-sol');

/**
 * Apply a modelPolicy to a run after init (or at init via initialize_loop_run args).
 * Prefer init-time: engine.initialize_loop_run({ ..., modelPolicy }).
 * This helper re-opens a run only when you need to assert mid-flight mutations
 * are NOT supported — modelPolicy is write-once at init; use a fresh run instead.
 */
export function withPolicy(engine, runId, policy, { task } = {}) {
  const pol = normalizeModelPolicy(policy, { source: policy.source || 'operator-init' });
  return engine.initialize_loop_run({
    runId,
    task: task || 'Improve the strip-miner loop to raise candidate precision by at least 10% while keeping token cost under the current benchmark.',
    modelPolicy: pol,
    model: pol.primary
  });
}

export { defaultModelPolicy, normalizeModelPolicy, modelPolicyPreset, makePolicy, DEFAULT_PRIMARY_MODEL, BUILDER_GATING_ROUTES };
