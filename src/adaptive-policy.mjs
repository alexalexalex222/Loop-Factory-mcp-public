import {
  ADAPTIVE_SCHEMA,
  ADAPTIVE_POLICY_FIELDS,
  canonicalAdaptiveJson,
  createMetaPolicyEpochRecord,
  isCausallyAdmittedApplication,
  policyDriftTier,
  selectLatestApplicationRevisions,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { round, sha256 } from './util.mjs';

export const DEFAULT_ADAPTIVE_POLICY = Object.freeze({
  allocations: Object.freeze({
    control: 0.2,
    related: 0.35,
    adjacent: 0.15,
    failureDerived: 0.15,
    wildcard: 0.15
  }),
  scoring: Object.freeze({
    relevanceWeight: 0.6,
    confidenceWeight: 0.25,
    positiveEffectWeight: 0.15,
    contradictionPenaltyWeight: 1
  }),
  penalties: Object.freeze({
    cooldown: 0.1,
    failedTransfer: 0.25
  })
});

const ALLOCATION_FIELDS = Object.freeze({
  related: 'related',
  adjacent: 'adjacent',
  'failure-derived': 'failureDerived',
  wildcard: 'wildcard'
});
const ALLOCATION_FLOORS = Object.freeze({
  related: 0.1,
  adjacent: 0.05,
  'failure-derived': 0.05,
  wildcard: 0.05
});

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function clone(value) {
  return structuredClone(value);
}

function clamp(value, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function decisionMap(decisions) {
  const map = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (validateAdaptiveRecord(decision).status !== 'OK'
        || decision.schemaVersion !== ADAPTIVE_SCHEMA.ROUTING_DECISION) {
      continue;
    }
    map.set(decision.routingDecisionId, decision);
  }
  return map;
}

function validateApplicationBinding(application, decisions, previousEpoch) {
  if (validateAdaptiveRecord(application).status !== 'OK'
      || application.schemaVersion !== ADAPTIVE_SCHEMA.APPLICATION) {
    return refused('INVALID_APPLICATION_RECORD', 'Policy evidence contains an invalid application record.');
  }
  if (!isCausallyAdmittedApplication(application)) {
    return refused(
      'INELIGIBLE_POLICY_EVIDENCE',
      'Only reverified, control-complete, independently checked harvest applications may update policy.'
    );
  }
  const binding = application.routing;
  const decision = decisions.get(binding.routingDecisionId);
  if (!decision) {
    return refused('MISSING_ROUTING_DECISION', 'Application routing decision is missing or invalid.');
  }
  if (binding.routingDecisionSha256 !== decision.routingDecisionSha256
      || binding.routingPacketSha256 !== decision.routingPacketSha256
      || binding.policyEpochId !== decision.policyEpochId
      || binding.policyEpochSha256 !== decision.policyEpochSha256
      || application.context.targetSha256 !== decision.targetSha256
      || decision.policyEpochId !== previousEpoch.policyEpochId
      || decision.policyEpochSha256 !== previousEpoch.policyEpochSha256) {
    return refused('APPLICATION_BINDING_MISMATCH', 'Application does not bind the frozen routing and policy bytes.');
  }
  const scheduled = decision.allocationSchedule[binding.schedulePosition];
  if (!scheduled
      || scheduled.position !== binding.schedulePosition
      || scheduled.allocation !== binding.allocation
      || binding.allocation !== 'control' && scheduled.familyId !== application.familyId
      || binding.allocation === 'control' && scheduled.familyId !== null) {
    return refused('ALLOCATION_BINDING_MISMATCH', 'Application allocation does not match the persisted schedule.');
  }
  return ok({ decision, scheduled });
}

export function applicationUtility(application) {
  if (!application || application.outcome?.valid !== true) return null;
  const quality = finite(application.outcome.qualityDelta);
  const cost = finite(application.outcome.tokenCostDeltaPct);
  const failedTransfers = (application.outcome.transferChecks || [])
    .filter((check) => check.attempted && check.passed === false).length;
  const controls = Number.isInteger(application.outcome.controlRegressions)
    ? Math.max(0, application.outcome.controlRegressions)
    : 0;
  const contradictions = Array.isArray(application.outcome.contradictionCodes)
    ? application.outcome.contradictionCodes.length
    : 0;
  const hasSignal = quality != null
    || cost != null
    || application.credit?.failureDerived === true
    || failedTransfers > 0
    || controls > 0
    || contradictions > 0;
  if (!hasSignal) return null;
  let utility = 0;
  if (quality != null) utility += clamp(quality);
  if (cost != null) utility += clamp(-cost) * 0.25;
  if (application.credit?.failureDerived === true) utility -= 0.2;
  utility -= Math.min(0.5, failedTransfers * 0.25);
  utility -= Math.min(0.5, controls * 0.25);
  utility -= Math.min(0.3, contradictions * 0.1);
  if (application.outcome.reverified !== true) utility -= 0.05;
  return round(clamp(utility));
}

function quarantineFamilies(applications) {
  return [...new Set(applications
    .filter((application) => (
      application.outcome.verdict === 'regression'
      || Number(application.outcome.controlRegressions) > 0
      || (application.outcome.transferChecks || [])
        .some((check) => check.attempted && check.passed === false)
      || (application.outcome.contradictionCodes || []).length > 0
    ))
    .map((application) => application.familyId))]
    .sort();
}

function evidenceSummary(applications) {
  const byAllocation = {};
  for (const name of ['control', 'related', 'adjacent', 'failure-derived', 'wildcard']) {
    const rows = applications.filter((application) => application.routing.allocation === name);
    const utilities = rows.map(applicationUtility).filter(Number.isFinite);
    byAllocation[name] = {
      applications: rows.length,
      measured: utilities.length,
      meanUtility: utilities.length ? round(mean(utilities)) : null
    };
  }
  const familyCounts = new Map();
  let failedTransfers = 0;
  for (const application of applications) {
    familyCounts.set(application.familyId, (familyCounts.get(application.familyId) || 0) + 1);
    failedTransfers += (application.outcome.transferChecks || [])
      .filter((check) => check.attempted && check.passed === false).length;
  }
  return {
    byAllocation,
    failedTransfers,
    maxApplicationsPerFamily: Math.max(0, ...familyCounts.values())
  };
}

function allocationTransfer(policy, summary) {
  const next = clone(policy);
  if (!Number.isFinite(summary.byAllocation.control.meanUtility)) {
    return { policy: next, transfer: null };
  }
  const ranked = Object.keys(ALLOCATION_FIELDS)
    .map((name) => ({
      name,
      utility: summary.byAllocation[name].meanUtility
    }))
    .filter((item) => Number.isFinite(item.utility))
    .sort((a, b) => b.utility - a.utility || a.name.localeCompare(b.name));
  if (ranked.length < 2 || ranked[0].utility - ranked.at(-1).utility < 0.05) {
    return { policy: next, transfer: null };
  }
  const receiver = ranked[0].name;
  const donor = ranked.at(-1).name;
  const donorField = ALLOCATION_FIELDS[donor];
  const receiverField = ALLOCATION_FIELDS[receiver];
  const amount = Math.min(
    0.05,
    next.allocations[donorField] - ALLOCATION_FLOORS[donor]
  );
  if (amount <= 1e-12) return { policy: next, transfer: null };
  next.allocations[donorField] = round(next.allocations[donorField] - amount);
  next.allocations[receiverField] = round(next.allocations[receiverField] + amount);
  return {
    policy: next,
    transfer: {
      from: donor,
      to: receiver,
      amount: round(amount),
      utilityGap: round(ranked[0].utility - ranked.at(-1).utility)
    }
  };
}

function policyValue(policy, field) {
  return field.split('.').reduce((value, part) => value[part], policy);
}

export function evaluatePolicyDrift(baselinePolicy, policy) {
  const drift = round(ADAPTIVE_POLICY_FIELDS.reduce(
    (sum, field) => sum + Math.abs(policyValue(policy, field) - policyValue(baselinePolicy, field)),
    0
  ));
  return { drift, driftTier: policyDriftTier(drift) };
}

export function createBaselinePolicyEpoch({
  policy = DEFAULT_ADAPTIVE_POLICY,
  evidenceWindowSha256 = sha256('adaptive-policy-baseline-v1'),
  policyScopeId = 'global'
} = {}) {
  return createMetaPolicyEpochRecord({
    policyScopeId,
    epochNumber: 0,
    trigger: 'initial',
    previousEpoch: null,
    validApplicationCount: 0,
    evidenceWindowSha256,
    baselinePolicy: policy,
    policy,
    quarantinedFamilyIds: []
  });
}

function stepToward(current, target) {
  const next = clone(current);
  const allocationNames = Object.keys(ALLOCATION_FIELDS);
  const donors = allocationNames
    .filter((name) => current.allocations[ALLOCATION_FIELDS[name]] > target.allocations[ALLOCATION_FIELDS[name]])
    .sort();
  const receivers = allocationNames
    .filter((name) => current.allocations[ALLOCATION_FIELDS[name]] < target.allocations[ALLOCATION_FIELDS[name]])
    .sort();
  let budget = 0.05;
  for (const donor of donors) {
    if (budget <= 1e-12) break;
    const donorField = ALLOCATION_FIELDS[donor];
    let available = Math.min(
      budget,
      current.allocations[donorField] - target.allocations[donorField]
    );
    for (const receiver of receivers) {
      if (available <= 1e-12) break;
      const receiverField = ALLOCATION_FIELDS[receiver];
      const need = target.allocations[receiverField] - next.allocations[receiverField];
      if (need <= 1e-12) continue;
      const moved = Math.min(available, need, 0.05);
      next.allocations[donorField] = round(next.allocations[donorField] - moved);
      next.allocations[receiverField] = round(next.allocations[receiverField] + moved);
      available -= moved;
      budget -= moved;
    }
  }
  for (const group of ['scoring', 'penalties']) {
    for (const key of Object.keys(next[group])) {
      const delta = target[group][key] - current[group][key];
      next[group][key] = round(current[group][key] + clamp(delta, -0.05, 0.05));
    }
  }
  return next;
}

export function createRollbackPolicyEpoch({
  previousEpoch,
  targetEpoch,
  applications = [],
  evidenceWindowSha256
} = {}) {
  if (validateAdaptiveRecord(previousEpoch).status !== 'OK'
      || validateAdaptiveRecord(targetEpoch).status !== 'OK'
      || previousEpoch.schemaVersion !== ADAPTIVE_SCHEMA.POLICY_EPOCH
      || targetEpoch.schemaVersion !== ADAPTIVE_SCHEMA.POLICY_EPOCH
      || targetEpoch.epochNumber >= previousEpoch.epochNumber) {
    return refused('INVALID_ROLLBACK_CHAIN', 'Rollback needs valid current and earlier target epochs.');
  }
  const quarantinedFamilyIds = quarantineFamilies(applications);
  const stepped = stepToward(previousEpoch.policy, targetEpoch.policy);
  const built = createMetaPolicyEpochRecord({
    policyScopeId: previousEpoch.policyScopeId,
    epochNumber: previousEpoch.epochNumber + 1,
    trigger: 'rollback',
    previousEpoch,
    validApplicationCount: applications.length,
    evidenceWindowSha256,
    baselinePolicy: previousEpoch.baselinePolicy,
    policy: stepped,
    quarantinedFamilyIds: [
      ...(previousEpoch.quarantinedFamilyIds || []),
      ...quarantinedFamilyIds
    ],
    rollbackTargetEpochId: targetEpoch.policyEpochId,
    metaCanaryReceiptSha256: previousEpoch.metaCanaryReceiptSha256
  });
  return built.status === 'OK'
    ? ok({
        epoch: built.record,
        action: 'ROLLBACK',
        quarantinedFamilyIds,
        targetEpochId: targetEpoch.policyEpochId
      })
    : built;
}

export function proposePolicyEpoch({
  previousEpoch,
  baselineEpoch = null,
  applications = [],
  routingDecisions = [],
  trigger = 'valid-attempt-window',
  evidenceWindowSha256,
  metaCanaryReceiptSha256 = null
} = {}) {
  if (validateAdaptiveRecord(previousEpoch).status !== 'OK'
      || previousEpoch.schemaVersion !== ADAPTIVE_SCHEMA.POLICY_EPOCH) {
    return refused('INVALID_PREVIOUS_EPOCH', 'Policy update needs a valid persisted previous epoch.');
  }
  const decisions = decisionMap(routingDecisions);
  const selected = selectLatestApplicationRevisions(
    Array.isArray(applications) ? applications : []
  );
  if (selected.status !== 'OK') return selected;
  const latest = selected.applications;
  const valid = [];
  const rejected = [];
  for (const application of latest) {
    const binding = validateApplicationBinding(application, decisions, previousEpoch);
    if (binding.status === 'OK') valid.push(application);
    else rejected.push({
      applicationReceiptId: application?.applicationReceiptId || null,
      code: binding.code
    });
  }
  if (rejected.length) {
    return refused('INVALID_POLICY_EVIDENCE', 'One or more policy applications failed binding checks.', {
      rejected
    });
  }
  if (trigger === 'valid-attempt-window' && valid.length < 5) {
    return refused('POLICY_WINDOW_TOO_SMALL', 'A policy update requires five valid bound applications.');
  }
  if (!evidenceWindowSha256 || !/^[a-f0-9]{64}$/.test(String(evidenceWindowSha256))) {
    return refused('INVALID_EVIDENCE_WINDOW', 'Policy update needs a persisted evidence-window hash.');
  }
  const computedEvidenceWindowSha256 = sha256(canonicalAdaptiveJson(
    valid.map((application) => ({
      applicationReceiptId: application.applicationReceiptId,
      applicationSha256: application.applicationSha256
    }))
  ));
  if (computedEvidenceWindowSha256 !== evidenceWindowSha256) {
    return refused(
      'EVIDENCE_WINDOW_HASH_MISMATCH',
      'Policy evidence bytes do not match the declared evidence-window hash.',
      { computedEvidenceWindowSha256 }
    );
  }
  const summary = evidenceSummary(valid);
  const quarantinedFamilyIds = quarantineFamilies(valid);
  const controlUtility = summary.byAllocation.control.meanUtility;
  const routedUtilities = Object.entries(summary.byAllocation)
    .filter(([name, row]) => name !== 'control' && Number.isFinite(row.meanUtility))
    .map(([, row]) => row.meanUtility);
  const routedUtility = routedUtilities.length ? mean(routedUtilities) : null;
  const forcedRegression = Number.isFinite(controlUtility)
    && Number.isFinite(routedUtility)
    && routedUtility < controlUtility - 0.05
    && quarantinedFamilyIds.length > 0;
  if (forcedRegression && baselineEpoch) {
    return createRollbackPolicyEpoch({
      previousEpoch,
      targetEpoch: baselineEpoch,
      applications: valid,
      evidenceWindowSha256
    });
  }

  const allocation = allocationTransfer(previousEpoch.policy, summary);
  const nextPolicy = allocation.policy;
  if (summary.failedTransfers > 0) {
    nextPolicy.penalties.failedTransfer = round(Math.min(
      1,
      previousEpoch.policy.penalties.failedTransfer + 0.05
    ));
  }
  if (summary.maxApplicationsPerFamily > 2) {
    nextPolicy.penalties.cooldown = round(Math.min(
      1,
      previousEpoch.policy.penalties.cooldown + 0.05
    ));
  }
  const built = createMetaPolicyEpochRecord({
    policyScopeId: previousEpoch.policyScopeId,
    epochNumber: previousEpoch.epochNumber + 1,
    trigger,
    previousEpoch,
    validApplicationCount: valid.length,
    evidenceWindowSha256,
    baselinePolicy: previousEpoch.baselinePolicy,
    policy: nextPolicy,
    quarantinedFamilyIds: [
      ...(previousEpoch.quarantinedFamilyIds || []),
      ...quarantinedFamilyIds
    ],
    metaCanaryReceiptSha256
  });
  if (built.status !== 'OK') return built;
  return ok({
    epoch: built.record,
    action: 'UPDATE',
    evidenceSummary: summary,
    transfer: allocation.transfer,
    quarantinedFamilyIds,
    evidenceWindowSha256: computedEvidenceWindowSha256
  });
}

export function classifyFamilyLifecycle({
  familyId,
  applications = [],
  quarantinedFamilyIds = []
} = {}) {
  const selected = selectLatestApplicationRevisions(applications);
  if (selected.status !== 'OK') return selected;
  const familyApplications = selected.applications
    .filter((application) => application.familyId === familyId);
  if (quarantinedFamilyIds.includes(familyId)) {
    return { state: 'quarantined', reason: 'POLICY_QUARANTINE' };
  }
  const contradictions = quarantineFamilies(familyApplications);
  if (contradictions.includes(familyId)) {
    return { state: 'contradicted', reason: 'CONTRADICTION_EVIDENCE' };
  }
  const replicatedRuns = new Set(familyApplications
    .filter((application) => (
      application.credit.positiveEvidence
      && application.outcome.reverified
    ))
    .map((application) => application.source.runId));
  if (replicatedRuns.size >= 2) {
    return { state: 'replicated', reason: 'TWO_REVERIFIED_RUNS' };
  }
  return { state: 'observed', reason: 'INSUFFICIENT_REPLICATION' };
}
