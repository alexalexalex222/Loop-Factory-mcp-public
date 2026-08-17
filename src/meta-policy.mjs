import { sha256 } from './util.mjs';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])])
  );
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const definition = {
  schemaVersion: 1,
  policyId: 'meta-policy-v1',
  mode: 'shadow',
  partitions: ['harvest'],
  slots: {
    related: 2,
    adjacent: 1,
    wildcard: 1,
    failureDerived: 1
  },
  thresholds: {
    relatedMinRelevance: 0.35,
    adjacentMinRelevance: 0.05
  },
  scoring: {
    relevanceWeight: 0.6,
    confidenceWeight: 0.25,
    positiveEffectWeight: 0.15,
    contradictionPenaltyWeight: 1
  }
};

export const META_POLICY_V1 = deepFreeze({
  ...definition,
  policySha256: sha256(canonicalJson(definition))
});

export function policySha256(policy = META_POLICY_V1) {
  if (policy === META_POLICY_V1) return META_POLICY_V1.policySha256;
  const { policySha256: ignored, ...payload } = policy || {};
  return sha256(canonicalJson(payload));
}
