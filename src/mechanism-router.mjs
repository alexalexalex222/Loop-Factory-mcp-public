import { isSafeId, round, sha256 } from './util.mjs';
import { canonicalJson, META_POLICY_V1, policySha256 } from './meta-policy.mjs';
import {
  ADAPTIVE_SCHEMA,
  canonicalAdaptiveJson,
  createRoutingDecisionRecord,
  isCausallyAdmittedApplication,
  isCausallyAdmittedCanaryImport,
  selectLatestApplicationRevisions,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { applicationUtility } from './adaptive-policy.mjs';
import { mechanismProgramSemanticSha256 } from './mechanism-mutation.mjs';
import { validateAdaptiveMeasurementRecord } from './adaptive-measurement-v2.mjs';
import {
  MECHANISM_EVOLUTION_ADMISSION_V2,
  validateMechanismEvolutionAdmissionV2
} from './mechanism-evolution-admission-v2.mjs';
import {
  validateRecursiveReplicatedAnalysis
} from './adaptive-recursive-statistics.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/;
const POSITIVE_VERDICTS = new Set(['improvement']);
const FAILURE_VERDICTS = new Set(['no_improvement', 'tradeoff', 'regression']);
const VERDICTS = new Set(['improvement', 'no_improvement', 'tradeoff', 'invalid', 'regression']);
const LIFECYCLES = new Set(['observed', 'replicated', 'contradicted']);

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function finite(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function tokenize(values) {
  const parts = Array.isArray(values) ? values : [values];
  return [...new Set(parts
    .flatMap((value) => String(value == null ? '' : value).toLowerCase().split(/[^a-z0-9._-]+/))
    .filter((token) => token.length > 1 && token.length <= 64))]
    .sort();
}

function overlap(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits++;
  return hits / a.size;
}

function receiptPayload(receipt) {
  const { receiptId: ignoredId, receiptSha256: ignoredHash, ...payload } = receipt;
  return payload;
}

function receiptIntegrity(receipt) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'MALFORMED_RECEIPT' };
  if (receipt.schemaVersion !== 'improvement-mechanism-v1') {
    return { ok: false, reason: 'WRONG_SCHEMA' };
  }
  if (!/^mech-[a-f0-9]{24}$/.test(String(receipt.mechanismId || ''))
    || !/^receipt-[a-f0-9]{24}$/.test(String(receipt.receiptId || ''))
    || !SHA256_RE.test(String(receipt.receiptSha256 || ''))) {
    return { ok: false, reason: 'BAD_IDENTITY' };
  }
  if (!VERDICTS.has(receipt.outcome?.verdict)
    || !LIFECYCLES.has(receipt.lifecycle?.state)) {
    return { ok: false, reason: 'BAD_ENUM' };
  }
  const digest = sha256(canonicalJson(receiptPayload(receipt)));
  if (digest !== receipt.receiptSha256
    || receipt.receiptId !== `receipt-${digest.slice(0, 24)}`) {
    return { ok: false, reason: 'RECEIPT_HASH_MISMATCH' };
  }
  return { ok: true };
}

function targetView(target = {}) {
  const taskValueDimensions = tokenize(target.taskValueDimensions);
  const resourceDimensions = tokenize(target.resourceDimensions);
  return {
    signatureTokens: tokenize([
      ...(Array.isArray(target.signatureTokens) ? target.signatureTokens : []),
      target.query,
      target.title,
      target.bottleneck,
      target.operation
    ]),
    taskValueDimensions,
    resourceDimensions,
    taskMode: String(target.taskMode || ''),
    loopId: String(target.loopId || '')
  };
}

function confidenceScore(receipt, reasons) {
  let score = 0.1;
  if (receipt.outcome?.valid === true) {
    score += 0.15;
    reasons.push('VALID_MEASUREMENT');
  }
  if (receipt.measurement?.reverified === true) {
    score += 0.3;
    reasons.push('REVERIFIED');
  }
  if (receipt.lifecycle?.state === 'replicated') {
    score += 0.2;
    reasons.push('REPLICATED');
  } else if (receipt.lifecycle?.state === 'observed') {
    score += 0.05;
    reasons.push('OBSERVED');
  } else if (receipt.lifecycle?.state === 'contradicted') {
    reasons.push('CONTRADICTED');
  }
  const samples = finite(receipt.measurement?.challenger?.samples);
  if (samples != null) score += Math.min(0.1, samples * 0.02);
  if (receipt.measurement?.qualityAuthority === 'tool-computed') {
    score += 0.1;
    reasons.push('TOOL_QUALITY');
  }
  if ((receipt.provenance?.artifacts || []).length > 0) score += 0.05;
  if ((receipt.provenance?.evidenceRefs || []).length > 0) score += 0.05;
  return clamp(score);
}

function evidenceEffect(receipt, reasons) {
  let effect = 0;
  const quality = finite(receipt.measurement?.delta?.quality);
  const costPct = finite(receipt.measurement?.delta?.tokenCostPct);
  const shamMovement = finite(receipt.measurement?.shamMovement);
  const controls = finite(receipt.measurement?.controlRegressions);
  if (quality != null) {
    effect += clamp(quality, -1, 1) * 0.55;
    reasons.push(quality > 0 ? 'QUALITY_GAIN' : (quality < 0 ? 'QUALITY_REGRESSION' : 'QUALITY_FLAT'));
  }
  if (costPct != null) {
    effect += clamp(-costPct, -1, 1) * 0.2;
    reasons.push(costPct < 0 ? 'COST_IMPROVED' : (costPct > 0 ? 'COST_REGRESSION' : 'COST_FLAT'));
  }
  if (shamMovement != null && shamMovement > 0) {
    effect -= Math.min(0.2, shamMovement * 0.2);
    reasons.push('SHAM_MOVEMENT');
  }
  if (controls != null && controls > 0) {
    effect -= Math.min(0.4, controls * 0.1);
    reasons.push('CONTROL_REGRESSION');
  }
  return clamp(effect, -1, 1);
}

function contradictionPenalty(receipt, reasons) {
  let penalty = 0;
  if (receipt.lifecycle?.state === 'contradicted') penalty += 0.45;
  const controls = finite(receipt.measurement?.controlRegressions);
  if (controls != null && controls > 0) penalty += Math.min(0.3, controls * 0.1);
  for (const check of receipt.measurement?.transferChecks || []) {
    if (check?.attempted === true && check.passed === false) {
      penalty += 0.15;
      reasons.push('TRANSFER_FAILED');
    } else if (check?.attempted === true && check.passed === true) {
      reasons.push('TRANSFER_PASSED');
    }
  }
  return clamp(penalty);
}

function relevanceScore(receipt, target, reasons) {
  const receiptTarget = receipt.target || {};
  const signature = overlap(target.signatureTokens, tokenize(receiptTarget.signatureTokens));
  const mechanism = overlap(target.signatureTokens, tokenize([
    receipt.mechanism?.title,
    receipt.mechanism?.bottleneck,
    receipt.mechanism?.operation,
    receipt.mechanism?.expectedMovement,
    receipt.mechanism?.falsifier
  ]));
  const dimensions = (
    overlap(target.taskValueDimensions, tokenize(receiptTarget.taskValueDimensions))
    + overlap(target.resourceDimensions, tokenize(receiptTarget.resourceDimensions))
  ) / 2;
  const modeMatch = target.taskMode && target.taskMode === receiptTarget.taskMode ? 1 : 0;
  const loopMatch = target.loopId && target.loopId === receiptTarget.loopId ? 1 : 0;
  if (signature > 0 || mechanism > 0 || dimensions > 0) reasons.push('TARGET_OVERLAP');
  else reasons.push('NO_TARGET_OVERLAP');
  if (modeMatch) reasons.push('TASK_MODE_MATCH');
  if (loopMatch) reasons.push('LOOP_MATCH');
  return round(clamp(
    signature * 0.45
    + mechanism * 0.25
    + dimensions * 0.15
    + modeMatch * 0.075
    + loopMatch * 0.075
  ));
}

function scoredReceipt(receipt, target, policy) {
  const reasonCodes = [];
  const relevance = relevanceScore(receipt, target, reasonCodes);
  const confidence = confidenceScore(receipt, reasonCodes);
  const effect = evidenceEffect(receipt, reasonCodes);
  const contradiction = contradictionPenalty(receipt, reasonCodes);
  const weights = policy.scoring || META_POLICY_V1.scoring;
  const score = round(
    relevance * weights.relevanceWeight
    + confidence * weights.confidenceWeight
    + Math.max(0, effect) * weights.positiveEffectWeight
    - contradiction * weights.contradictionPenaltyWeight
  );
  const failureScore = round(
    relevance * 0.55
    + confidence * 0.45
    - contradiction * 0.15
  );
  return {
    receipt,
    relevance,
    confidence,
    effect: round(effect),
    contradiction: round(contradiction),
    score,
    failureScore,
    reasonCodes: [...new Set(reasonCodes)].sort()
  };
}

function publicRow(row) {
  const receipt = row.receipt;
  const source = receipt.source || {};
  return {
    mechanismId: receipt.mechanismId,
    receiptId: receipt.receiptId,
    receiptSha256: receipt.receiptSha256,
    source: {
      runId: isSafeId(source.runId) ? source.runId : null,
      findingId: isSafeId(source.findingId) ? source.findingId : null,
      hypothesisId: isSafeId(source.hypothesisId) ? source.hypothesisId : null,
      testId: isSafeId(source.testId) ? source.testId : null
    },
    verdict: receipt.outcome?.verdict || null,
    lifecycle: receipt.lifecycle?.state || null,
    relevance: row.relevance,
    confidence: row.confidence,
    effect: row.effect,
    contradiction: row.contradiction,
    score: row.score,
    reasonCodes: row.reasonCodes
  };
}

function compareRows(left, right, scoreKey = 'score') {
  return right[scoreKey] - left[scoreKey]
    || right.confidence - left.confidence
    || String(left.receipt.mechanismId).localeCompare(String(right.receipt.mechanismId))
    || String(left.receipt.receiptId).localeCompare(String(right.receipt.receiptId));
}

function operationKey(row) {
  return tokenize(row.receipt.mechanism?.operation).slice(0, 8).join('|');
}

function pickDiverse(rows, count, selected, usedRuns, usedOperations, scoreKey = 'score') {
  const picks = [];
  const localSelected = new Set(selected);
  const localRuns = new Set(usedRuns);
  const localOperations = new Set(usedOperations);
  while (picks.length < count) {
    const available = rows.filter((row) => !localSelected.has(row.receipt.mechanismId));
    if (!available.length) break;
    const diverse = available.filter((row) => {
      const runId = row.receipt.source?.runId;
      const operation = operationKey(row);
      return (!runId || !localRuns.has(runId)) && (!operation || !localOperations.has(operation));
    });
    const pool = (diverse.length ? diverse : available)
      .sort((a, b) => compareRows(a, b, scoreKey));
    const chosen = pool[0];
    picks.push(chosen);
    localSelected.add(chosen.receipt.mechanismId);
    if (chosen.receipt.source?.runId) localRuns.add(chosen.receipt.source.runId);
    const operation = operationKey(chosen);
    if (operation) localOperations.add(operation);
  }
  return picks;
}

function selectedRow(row, slot, probability, slotReason) {
  return {
    ...publicRow(row),
    slot,
    slotReason,
    selectionProbability: round(probability)
  };
}

function filteredInput(receipts) {
  const counts = {
    malformed: 0,
    wrongPartition: 0,
    ineligible: 0,
    duplicateMechanism: 0
  };
  const valid = [];
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const integrity = receiptIntegrity(receipt);
    if (!integrity.ok) {
      counts.malformed++;
      continue;
    }
    if (receipt.partition !== 'harvest') {
      counts.wrongPartition++;
      continue;
    }
    if (receipt.eligibleForRouting !== true) {
      counts.ineligible++;
      continue;
    }
    if (receipt.outcome?.valid !== true) {
      counts.malformed++;
      continue;
    }
    valid.push(receipt);
  }
  return { counts, valid };
}

function deduplicate(rows, counts) {
  const byMechanism = new Map();
  for (const row of [...rows].sort((a, b) => compareRows(a, b))) {
    if (!byMechanism.has(row.receipt.mechanismId)) {
      byMechanism.set(row.receipt.mechanismId, row);
    } else {
      counts.duplicateMechanism++;
    }
  }
  return [...byMechanism.values()].sort((a, b) => compareRows(a, b));
}

function normalizedSeed(seed) {
  return `seed-${sha256(String(seed || 'meta-policy-v1-default')).slice(0, 16)}`;
}

function finalizePacket(payload) {
  const packetSha256 = sha256(canonicalJson(payload));
  return { ...payload, packetSha256 };
}

export function buildShadowMechanismPacket({
  receipts = [],
  target = {},
  seed = 'meta-policy-v1-default',
  policy = META_POLICY_V1
} = {}) {
  const effectivePolicySha256 = policySha256(policy);
  const seedId = normalizedSeed(seed);
  const targetData = targetView(target);
  const targetSha256 = sha256(canonicalJson(targetData));
  const { counts, valid } = filteredInput(receipts);
  const rows = deduplicate(
    valid.map((receipt) => scoredReceipt(receipt, targetData, policy)),
    counts
  );
  const poolItems = rows.map(publicRow);
  const eligiblePoolSha256 = sha256(canonicalJson(poolItems));
  const base = {
    schemaVersion: 1,
    packetVersion: 'shadow-mechanism-packet-v1',
    mode: 'shadow',
    policyId: isSafeId(policy.policyId) ? policy.policyId : META_POLICY_V1.policyId,
    policySha256: effectivePolicySha256,
    targetSha256,
    seed: seedId,
    affectedExecution: false,
    inputCount: Array.isArray(receipts) ? receipts.length : 0,
    filtered: counts,
    eligiblePool: {
      count: poolItems.length,
      sha256: eligiblePoolSha256,
      items: poolItems
    }
  };
  if (!rows.length) {
    return finalizePacket({
      ...base,
      status: 'ABSTAINED',
      abstentionReason: 'NO_ELIGIBLE_HARVEST_RECEIPTS',
      missingSlots: ['related-1', 'related-2', 'adjacent', 'wildcard', 'failure-derived'],
      selected: []
    });
  }

  const thresholds = policy.thresholds || META_POLICY_V1.thresholds;
  const selected = [];
  const selectedIds = new Set();
  const usedRuns = new Set();
  const usedOperations = new Set();
  const add = (row, slot, probability, reason) => {
    if (!row || selectedIds.has(row.receipt.mechanismId)) return;
    selectedIds.add(row.receipt.mechanismId);
    if (row.receipt.source?.runId) usedRuns.add(row.receipt.source.runId);
    const operation = operationKey(row);
    if (operation) usedOperations.add(operation);
    selected.push(selectedRow(row, slot, probability, reason));
  };

  const positives = rows.filter((row) => (
    row.receipt.outcome?.valid === true
    && POSITIVE_VERDICTS.has(row.receipt.outcome?.verdict)
    && row.receipt.lifecycle?.state !== 'contradicted'
  ));
  const related = positives.filter((row) => row.relevance >= thresholds.relatedMinRelevance);
  pickDiverse(related, policy.slots?.related ?? 2, selectedIds, usedRuns, usedOperations)
    .forEach((row, index) => add(row, `related-${index + 1}`, 1, 'TOP_RELATED_POSITIVE'));

  const adjacent = positives.filter((row) => (
    row.relevance >= thresholds.adjacentMinRelevance
    && row.relevance < thresholds.relatedMinRelevance
  ));
  const adjacentPick = pickDiverse(
    adjacent,
    policy.slots?.adjacent ?? 1,
    selectedIds,
    usedRuns,
    usedOperations
  )[0];
  add(adjacentPick, 'adjacent', 1, 'ADJACENT_POSITIVE');

  const wildcardPool = positives
    .filter((row) => !selectedIds.has(row.receipt.mechanismId))
    .sort((a, b) => String(a.receipt.mechanismId).localeCompare(String(b.receipt.mechanismId)));
  if (wildcardPool.length && (policy.slots?.wildcard ?? 1) > 0) {
    const wildcardHash = sha256(canonicalJson({
      seed: seedId,
      policySha256: effectivePolicySha256,
      candidates: wildcardPool.map((row) => row.receipt.receiptId)
    }));
    const index = Number.parseInt(wildcardHash.slice(0, 12), 16) % wildcardPool.length;
    add(wildcardPool[index], 'wildcard', 1 / wildcardPool.length, 'SEEDED_WILDCARD');
  }

  const failures = rows
    .filter((row) => (
      row.receipt.outcome?.valid === true
      && (FAILURE_VERDICTS.has(row.receipt.outcome?.verdict)
        || row.receipt.lifecycle?.state === 'contradicted')
      && !selectedIds.has(row.receipt.mechanismId)
    ))
    .sort((a, b) => compareRows(a, b, 'failureScore'));
  const failurePick = pickDiverse(
    failures,
    policy.slots?.failureDerived ?? 1,
    selectedIds,
    usedRuns,
    usedOperations,
    'failureScore'
  )[0];
  add(failurePick, 'failure-derived', 1, 'FAILURE_DERIVED');

  const expectedSlots = ['related-1', 'related-2', 'adjacent', 'wildcard', 'failure-derived'];
  const present = new Set(selected.map((item) => item.slot));
  const missingSlots = expectedSlots.filter((slot) => !present.has(slot));
  return finalizePacket({
    ...base,
    status: selected.length === expectedSlots.length ? 'COMPLETE' : (selected.length ? 'PARTIAL' : 'ABSTAINED'),
    abstentionReason: selected.length ? null : 'NO_ROUTABLE_EVIDENCE',
    missingSlots,
    selected
  });
}

function adaptiveTargetView(target = {}) {
  return {
    taskMode: tokenize(target.taskMode)[0] || null,
    loopRole: tokenize(target.loopRole ?? target.loopId)[0] || null,
    taskValueDimensions: tokenize(target.taskValueDimensions),
    resourceDimensions: tokenize(target.resourceDimensions)
  };
}

function adaptiveMean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function adaptiveRelevance(applications, target) {
  if (!applications.length) return 0;
  return round(Math.max(...applications.map((application) => {
    const context = application.context || {};
    const mode = target.taskMode && context.taskMode === target.taskMode ? 1 : 0;
    const role = target.loopRole && context.loopRole === target.loopRole ? 1 : 0;
    const taskDimensions = overlap(
      target.taskValueDimensions,
      tokenize(context.taskValueDimensions)
    );
    const resourceDimensions = overlap(
      target.resourceDimensions,
      tokenize(context.resourceDimensions)
    );
    return clamp(
      mode * 0.3
      + role * 0.2
      + taskDimensions * 0.3
      + resourceDimensions * 0.2
    );
  })));
}

function adaptiveCandidate(family, applications, target, quarantined) {
  const valid = applications.filter((application) => (
    application.partition === 'harvest'
    && application.eligibleForRouting === true
    && application.outcome.valid === true
  ));
  if (!valid.length || quarantined.has(family.familyId)) return null;
  const positive = valid.filter((application) => application.credit.positiveEvidence === true);
  const failures = valid.filter((application) => application.credit.failureDerived === true);
  const contradictions = valid.filter((application) => (
    application.outcome.verdict === 'regression'
    || Number(application.outcome.controlRegressions) > 0
    || (application.outcome.transferChecks || [])
      .some((check) => check.attempted && check.passed === false)
    || (application.outcome.contradictionCodes || []).length > 0
  ));
  const relevance = adaptiveRelevance(valid, target);
  const confidenceValues = valid
    .map((application) => application.credit.confidence)
    .filter(Number.isFinite);
  const confidence = confidenceValues.length
    ? adaptiveMean(confidenceValues)
    : 0;
  const utilityValues = valid.map(applicationUtility).filter(Number.isFinite);
  const utility = utilityValues.length ? adaptiveMean(utilityValues) : 0;
  const evidenceStrength = round(clamp(
    confidence * 0.45
    + Math.min(1, valid.length / 3) * 0.2
    + Math.min(1, positive.filter((item) => item.outcome.reverified).length / 2) * 0.25
    - Math.min(0.5, contradictions.length * 0.2)
    + (utility > 0 ? Math.min(0.1, utility * 0.1) : 0)
  ));
  const bestPositive = [...positive].sort((left, right) => (
    Number(right.outcome.reverified) - Number(left.outcome.reverified)
    || (applicationUtility(right) ?? -Infinity) - (applicationUtility(left) ?? -Infinity)
    || left.applicationReceiptId.localeCompare(right.applicationReceiptId)
  ))[0] || null;
  const bestFailure = [...failures].sort((left, right) => (
    Number(right.outcome.reverified) - Number(left.outcome.reverified)
    || relevanceScoreForFailure(right) - relevanceScoreForFailure(left)
    || left.applicationReceiptId.localeCompare(right.applicationReceiptId)
  ))[0] || null;
  return {
    family,
    relevance,
    confidence: round(confidence),
    utility: round(utility),
    evidenceStrength,
    positiveCount: positive.length,
    failureCount: failures.length,
    contradictionCount: contradictions.length,
    bestPositive,
    bestFailure,
    score: round(
      relevance * 0.55
      + evidenceStrength * 0.35
      + Math.max(0, utility) * 0.1
      - Math.min(0.6, contradictions.length * 0.2)
    )
  };
}

function relevanceScoreForFailure(application) {
  const utility = applicationUtility(application);
  return utility == null ? 0 : -utility;
}

function adaptiveCandidatePublic(candidate) {
  const applications = [candidate.bestPositive, candidate.bestFailure]
    .filter(Boolean)
    .map((application) => ({
      applicationReceiptId: application.applicationReceiptId,
      applicationSha256: application.applicationSha256,
      verdict: application.outcome.verdict,
      reverified: application.outcome.reverified,
      confidence: application.credit.confidence
    }))
    .sort((a, b) => a.applicationReceiptId.localeCompare(b.applicationReceiptId));
  return {
    familyId: candidate.family.familyId,
    familySha256: candidate.family.familySha256,
    fingerprintSha256: candidate.family.fingerprintSha256,
    semanticSha256: adaptiveSemanticKey(candidate),
    relevance: candidate.relevance,
    confidence: candidate.confidence,
    utility: candidate.utility,
    evidenceStrength: candidate.evidenceStrength,
    positiveCount: candidate.positiveCount,
    failureCount: candidate.failureCount,
    contradictionCount: candidate.contradictionCount,
    score: candidate.score,
    applications
  };
}

function adaptiveSemanticKey(candidate) {
  const program = candidate.family.causalFingerprint?.program;
  if (!program) return `legacy-${candidate.family.fingerprintSha256}`;
  const semantic = mechanismProgramSemanticSha256(program);
  return semantic.status === 'OK'
    ? semantic.semanticSha256
    : `invalid-${candidate.family.familyId}`;
}

function deduplicateSemanticCandidates(candidates) {
  const bySemantic = new Map();
  let semanticCloneFamilies = 0;
  for (const candidate of candidates) {
    const key = adaptiveSemanticKey(candidate);
    const existing = bySemantic.get(key);
    if (!existing) {
      bySemantic.set(key, candidate);
      continue;
    }
    semanticCloneFamilies++;
    if (candidate.score > existing.score
        || candidate.score === existing.score
          && candidate.family.familyId.localeCompare(existing.family.familyId) < 0) {
      bySemantic.set(key, candidate);
    }
  }
  return {
    candidates: [...bySemantic.values()].sort((a, b) => (
      b.score - a.score || a.family.familyId.localeCompare(b.family.familyId)
    )),
    semanticCloneFamilies
  };
}

function deduplicateAdaptiveFamilies(families) {
  const byId = new Map();
  let duplicateFamilies = 0;
  for (const family of families) {
    const existing = byId.get(family.familyId);
    if (!existing) {
      byId.set(family.familyId, family);
      continue;
    }
    if (existing.familySha256 !== family.familySha256
        || existing.fingerprintSha256 !== family.fingerprintSha256) {
      return {
        status: 'REFUSED',
        code: 'FAMILY_ID_CONFLICT',
        message: 'One mechanism family ID resolved to conflicting persisted records.'
      };
    }
    duplicateFamilies++;
  }
  return {
    status: 'OK',
    families: [...byId.values()].sort((a, b) => a.familyId.localeCompare(b.familyId)),
    duplicateFamilies
  };
}

function adaptiveDiversityKey(candidate) {
  const fingerprint = candidate.family.causalFingerprint || {};
  return `${fingerprint.interventionKind || ''}|${fingerprint.operationKind || ''}`;
}

function readableKind(value) {
  return String(value || '').replace(/[._-]+/g, ' ');
}

export function mechanismInstruction(causalFingerprint = {}, semantics = 'positive-transfer') {
  const steps = Array.isArray(causalFingerprint.procedureSteps)
    ? causalFingerprint.procedureSteps
    : [];
  if (!steps.length) {
    return semantics === 'failure-inversion'
      ? 'Use this only as an inversion or avoidance lesson; it is not positive evidence.'
      : 'Use this as evidence-backed mechanism input, subject to the frozen objective and gates.';
  }
  const ordered = steps
    .map((step, index) => `${index + 1}. ${readableKind(step)}`)
    .join('; ');
  if (semantics === 'failure-inversion') {
    return `Treat this failed procedure as an ordered avoidance lesson: ${ordered}. Do not copy the failed behavior; invert only steps that map to the supplied task.`;
  }
  return `Apply this evidence-backed procedure in order: ${ordered}. Map each step to the supplied interface, preserve valid controls, and fail closed when a required precondition is absent.`;
}

function deterministicUnit(seed, label) {
  return Number.parseInt(sha256(`${seed}:${label}`).slice(0, 13), 16) / 0x10000000000000;
}

function weightedAllocation(policy, seed, index) {
  const weights = [
    ['related', policy.allocations.related],
    ['adjacent', policy.allocations.adjacent],
    ['failure-derived', policy.allocations.failureDerived],
    ['wildcard', policy.allocations.wildcard]
  ];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let point = deterministicUnit(seed, `allocation:${index}`) * total;
  for (const [name, weight] of weights) {
    if (point < weight) return { name, probability: round(weight / total) };
    point -= weight;
  }
  const [name, weight] = weights.at(-1);
  return { name, probability: round(weight / total) };
}

function chooseAdaptiveCandidate({
  allocation,
  candidates,
  selectedFamilies,
  selectedDiversityKeys,
  seed,
  position
}) {
  const available = candidates.filter((candidate) => !selectedFamilies.has(candidate.family.familyId));
  const positives = available.filter((candidate) => candidate.bestPositive);
  const failures = available.filter((candidate) => candidate.bestFailure);
  let pool;
  if (allocation === 'related') {
    pool = positives.filter((candidate) => candidate.relevance >= 0.5)
      .sort((a, b) => b.score - a.score || a.family.familyId.localeCompare(b.family.familyId));
  } else if (allocation === 'adjacent') {
    pool = positives.filter((candidate) => candidate.relevance > 0 && candidate.relevance < 0.5)
      .sort((a, b) => b.score - a.score || a.family.familyId.localeCompare(b.family.familyId));
  } else if (allocation === 'failure-derived') {
    pool = failures.sort((a, b) => (
      b.relevance - a.relevance
      || b.evidenceStrength - a.evidenceStrength
      || a.family.familyId.localeCompare(b.family.familyId)
    ));
  } else {
    pool = positives.sort((a, b) => a.family.familyId.localeCompare(b.family.familyId));
  }
  if (!pool.length) return { candidate: null, candidateProbability: 0 };
  const diverse = pool.filter((candidate) => !selectedDiversityKeys.has(adaptiveDiversityKey(candidate)));
  const diversityPreferred = diverse.length > 0;
  const selectionPool = diversityPreferred ? diverse : pool;
  if (allocation !== 'wildcard') {
    return {
      candidate: selectionPool[0],
      candidateProbability: 1,
      diversityPreferred
    };
  }
  const index = Math.floor(deterministicUnit(seed, `wildcard:${position}`) * selectionPool.length);
  return {
    candidate: selectionPool[Math.min(index, selectionPool.length - 1)],
    candidateProbability: 1 / selectionPool.length,
    diversityPreferred
  };
}

function controlPositions(hypothesisCount, controlAllocation, seed) {
  const count = Math.max(1, Math.min(
    hypothesisCount,
    Math.round(hypothesisCount * controlAllocation)
  ));
  return new Set(Array.from({ length: hypothesisCount }, (_, index) => ({
    index,
    rank: sha256(`${seed}:control-position:${index}`)
  }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, count)
    .map((item) => item.index));
}

export function deriveActiveEvolutionRoutingApplications({
  families = [],
  evolutions = [],
  measurements = [],
  admissions = [],
  analyses = []
} = {}) {
  const familyById = new Map((Array.isArray(families) ? families : [])
    .filter((family) => (
      family.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
      && validateAdaptiveRecord(family).status === 'OK'
    ))
    .map((family) => [family.familyId, family]));
  const measurementById = new Map((Array.isArray(measurements) ? measurements : [])
    .filter((measurement) => validateAdaptiveMeasurementRecord(measurement).status === 'OK')
    .map((measurement) => [measurement.measurementId, measurement]));
  const evolutionBySha = new Map((Array.isArray(evolutions) ? evolutions : [])
    .filter((evolution) => validateAdaptiveRecord(evolution).status === 'OK')
    .map((evolution) => [evolution.evolutionSha256, evolution]));
  const analysisBySha = new Map((Array.isArray(analyses) ? analyses : [])
    .filter((analysis) => validateRecursiveReplicatedAnalysis(analysis).status === 'OK')
    .map((analysis) => [analysis.analysisSha256, analysis]));
  const applications = [];
  const rejected = [];
  const evidenceHashes = new Map();
  for (const evolution of (Array.isArray(evolutions) ? evolutions : [])) {
    if (evolution?.schemaVersion !== ADAPTIVE_SCHEMA.EVOLUTION
        || evolution.state !== 'ACTIVE'
        || validateAdaptiveRecord(evolution).status !== 'OK') continue;
    const family = familyById.get(evolution.candidate?.familyId);
    const measurement = measurementById.get(
      evolution.evidence?.verificationMeasurementId
    );
    const valid = family
      && family.familySha256 === evolution.candidate.familySha256
      && measurement
      && measurement.measurementSha256
        === evolution.evidence.verificationMeasurementSha256
      && measurement.profile === 'recursive-causal-v1'
      && measurement.source.verifierEvidenceSha256
        === evolution.evidence.verifierEvidenceSha256
      && measurement.mechanismBindings.parent === evolution.parent.programSha256
      && measurement.mechanismBindings.treatment === evolution.candidate.programSha256
      && evolution.authority.activation === 'routing-only'
      && evolution.authority.promotionAuthorized === false
      && evolution.outcome.exactVsParentDelta
        === measurement.contrasts.treatmentVsParent.metrics.exact.delta
      && evolution.outcome.shamExactVsBaselineDelta
        === measurement.contrasts.shamVsBaseline.metrics.exact.delta
      && evolution.outcome.controlRegressions === 0
      && evolution.outcome.targetRegressions === 0;
    if (!valid) {
      rejected.push({
        evolutionReceiptId: evolution.evolutionReceiptId,
        code: 'ACTIVE_EVOLUTION_EVIDENCE_INVALID'
      });
      continue;
    }
    const evidenceSha256 = evolution.evidence.verifierEvidenceSha256;
    const existing = evidenceHashes.get(evidenceSha256);
    if (existing && existing !== evolution.evolutionSha256) {
      return {
        status: 'REFUSED',
        code: 'ACTIVE_EVOLUTION_EVIDENCE_CONFLICT',
        message: 'One verifier evidence hash produced conflicting active descendants.'
      };
    }
    evidenceHashes.set(evidenceSha256, evolution.evolutionSha256);
    const applicability = family.causalFingerprint.applicability;
    const exact = measurement.contrasts.treatmentVsParent.metrics.exact;
    const confidence = round(Math.min(1, 0.5
      + Math.max(0, exact.delta) * 0.25
      + Math.min(0.25, exact.sampleSize / 100)));
    applications.push({
      schemaVersion: 'active-evolution-routing-evidence-v1',
      applicationReceiptId: `app-receipt-${sha256(evolution.evolutionReceiptId).slice(0, 24)}`,
      applicationSha256: evolution.evolutionSha256,
      familyId: family.familyId,
      partition: 'harvest',
      eligibleForRouting: true,
      source: {
        runId: measurement.source.runId,
        hypothesisId: evolution.evolutionId,
        testId: measurement.measurementId
      },
      context: {
        targetSha256: measurement.source.caseSetSha256,
        taskMode: applicability.taskModes[0] || null,
        loopRole: applicability.loopRoles[0] || null,
        taskValueDimensions: applicability.taskValueDimensions,
        resourceDimensions: applicability.resourceDimensions
      },
      routing: {
        routingDecisionId: null,
        routingDecisionSha256: null,
        routingPacketSha256: null,
        policyEpochId: null,
        policyEpochSha256: null,
        allocation: null,
        schedulePosition: null
      },
      outcome: {
        verdict: 'improvement',
        valid: true,
        qualityDelta: exact.delta,
        tokenCostDeltaPct:
          measurement.contrasts.treatmentVsParent.tokenCost.relativeDelta,
        shamMovement:
          measurement.contrasts.shamVsBaseline.metrics.exact.delta,
        controlRegressions: evolution.outcome.controlRegressions,
        reverified: true,
        transferChecks: [{
          kind: 'heldOut',
          attempted: true,
          passed: true,
          evidenceSha256: measurement.measurementSha256
        }, {
          kind: 'negativeControl',
          attempted: true,
          passed: true,
          evidenceSha256
        }],
        contradictionCodes: []
      },
      credit: {
        confidence,
        authority: 'independent-recursive-verifier',
        positiveEvidence: true,
        failureDerived: false
      },
      recursiveEvolution: {
        evolutionReceiptId: evolution.evolutionReceiptId,
        evolutionSha256: evolution.evolutionSha256,
        measurementId: measurement.measurementId,
        measurementSha256: measurement.measurementSha256,
        verifierEvidenceSha256: evidenceSha256
      }
    });
  }
  for (const admission of (Array.isArray(admissions) ? admissions : [])) {
    if (admission?.schemaVersion !== MECHANISM_EVOLUTION_ADMISSION_V2
        || admission.state !== 'ACTIVE'
        || validateMechanismEvolutionAdmissionV2(admission).status !== 'OK') continue;
    const family = familyById.get(admission.candidate?.familyId);
    const sourceEvolution = evolutionBySha.get(
      admission.sourceEvolution?.evolutionSha256
    );
    const calibrationMeasurement = measurementById.get(
      admission.evidence?.calibrationMeasurementId
    );
    const confirmationMeasurement = measurementById.get(
      admission.evidence?.confirmationMeasurementId
    );
    const calibrationAnalysis = analysisBySha.get(
      admission.evidence?.calibrationAnalysisSha256
    );
    const confirmationAnalysis = analysisBySha.get(
      admission.evidence?.confirmationAnalysisSha256
    );
    const outcome = admission.outcome;
    const valid = family
      && family.familySha256 === admission.candidate.familySha256
      && family.causalFingerprint.program
      && sourceEvolution?.state === 'SHADOW'
      && sourceEvolution.evolutionId === admission.sourceEvolution.evolutionId
      && sourceEvolution.evolutionReceiptId
        === admission.sourceEvolution.evolutionReceiptId
      && calibrationMeasurement?.measurementSha256
        === admission.evidence.calibrationMeasurementSha256
      && confirmationMeasurement?.measurementSha256
        === admission.evidence.confirmationMeasurementSha256
      && calibrationAnalysis?.stage === 'calibration'
      && calibrationAnalysis.qualified === true
      && confirmationAnalysis?.stage === 'confirmation'
      && confirmationAnalysis.causalPass === true
      && confirmationAnalysis.calibrationAnalysisSha256
        === calibrationAnalysis.analysisSha256
      && calibrationMeasurement.source.verifierEvidenceSha256
        === admission.evidence.verifierEvidenceSha256
      && confirmationMeasurement.source.verifierEvidenceSha256
        === admission.evidence.verifierEvidenceSha256
      && calibrationMeasurement.mechanismBindings.parent
        === admission.parent.programSha256
      && calibrationMeasurement.mechanismBindings.treatment
        === admission.candidate.programSha256
      && confirmationMeasurement.mechanismBindings.parent
        === admission.parent.programSha256
      && confirmationMeasurement.mechanismBindings.treatment
        === admission.candidate.programSha256
      && admission.authority.activation === 'routing-only'
      && admission.authority.promotionAuthorized === false
      && outcome.exactVsBaselineDelta
        === confirmationMeasurement.contrasts.treatmentVsBaseline.metrics.exact.delta
      && outcome.exactVsParentDelta
        === confirmationMeasurement.contrasts.treatmentVsParent.metrics.exact.delta
      && outcome.shamExactVsBaselineDelta
        === confirmationMeasurement.contrasts.shamVsBaseline.metrics.exact.delta
      && outcome.candidateVsParentLower95
        === confirmationAnalysis.summary.candidateVsParent.lower95
      && outcome.placeboUpper95 === calibrationAnalysis.placeboUpper95
      && outcome.adjustedExactDelta === confirmationAnalysis.summary.adjusted.mean
      && outcome.targetRegressions === 0
      && outcome.controlRegressions === 0;
    if (!valid) {
      rejected.push({
        admissionReceiptId: admission.admissionReceiptId,
        code: 'ACTIVE_REPLICATED_ADMISSION_EVIDENCE_INVALID'
      });
      continue;
    }
    const evidenceSha256 = admission.evidence.verifierEvidenceSha256;
    const existing = evidenceHashes.get(evidenceSha256);
    if (existing && existing !== admission.admissionSha256) {
      return {
        status: 'REFUSED',
        code: 'ACTIVE_EVOLUTION_EVIDENCE_CONFLICT',
        message: 'One verifier evidence hash produced conflicting active descendants.'
      };
    }
    evidenceHashes.set(evidenceSha256, admission.admissionSha256);
    const applicability = family.causalFingerprint.applicability;
    const exact = confirmationMeasurement.contrasts.treatmentVsParent.metrics.exact;
    const confidence = round(Math.min(1, 0.6
      + Math.max(0, confirmationAnalysis.summary.candidateVsParent.lower95) * 0.25
      + Math.min(0.15, exact.sampleSize / 500)));
    applications.push({
      schemaVersion: 'active-evolution-routing-evidence-v2',
      applicationReceiptId:
        `app-receipt-${sha256(admission.admissionReceiptId).slice(0, 24)}`,
      applicationSha256: admission.admissionSha256,
      familyId: family.familyId,
      partition: 'harvest',
      eligibleForRouting: true,
      source: {
        runId: confirmationMeasurement.source.runId,
        hypothesisId: admission.sourceEvolution.evolutionId,
        testId: confirmationMeasurement.measurementId
      },
      context: {
        targetSha256: confirmationMeasurement.source.caseSetSha256,
        taskMode: applicability.taskModes[0] || null,
        loopRole: applicability.loopRoles[0] || null,
        taskValueDimensions: applicability.taskValueDimensions,
        resourceDimensions: applicability.resourceDimensions
      },
      routing: {
        routingDecisionId: null,
        routingDecisionSha256: null,
        routingPacketSha256: null,
        policyEpochId: null,
        policyEpochSha256: null,
        allocation: null,
        schedulePosition: null
      },
      outcome: {
        verdict: 'improvement',
        valid: true,
        qualityDelta: exact.delta,
        tokenCostDeltaPct: outcome.candidateTokenDelta,
        shamMovement: outcome.shamExactVsBaselineDelta,
        placeboUpper95: outcome.placeboUpper95,
        adjustedQualityDelta: outcome.adjustedExactDelta,
        controlRegressions: 0,
        reverified: true,
        transferChecks: [{
          kind: 'heldOut',
          attempted: true,
          passed: true,
          evidenceSha256: confirmationAnalysis.analysisSha256
        }, {
          kind: 'negativeControl',
          attempted: true,
          passed: true,
          evidenceSha256: calibrationAnalysis.analysisSha256
        }],
        contradictionCodes: []
      },
      credit: {
        confidence,
        authority: 'independent-replicated-verifier',
        positiveEvidence: true,
        failureDerived: false
      },
      recursiveEvolution: {
        admissionReceiptId: admission.admissionReceiptId,
        admissionSha256: admission.admissionSha256,
        sourceEvolutionSha256: sourceEvolution.evolutionSha256,
        calibrationMeasurementId: calibrationMeasurement.measurementId,
        confirmationMeasurementId: confirmationMeasurement.measurementId,
        calibrationAnalysisSha256: calibrationAnalysis.analysisSha256,
        confirmationAnalysisSha256: confirmationAnalysis.analysisSha256,
        verifierEvidenceSha256: evidenceSha256
      }
    });
  }
  applications.sort((left, right) => (
    left.applicationReceiptId.localeCompare(right.applicationReceiptId)
  ));
  rejected.sort((left, right) => (
    String(left.evolutionReceiptId || left.admissionReceiptId)
      .localeCompare(String(right.evolutionReceiptId || right.admissionReceiptId))
  ));
  return { status: 'OK', applications, rejected };
}

export function buildMechanismRoutingDecision({
  families = [],
  applications = [],
  evolutions = [],
  measurements = [],
  admissions = [],
  analyses = [],
  target = {},
  policyEpoch,
  seed = 'adaptive-routing-v1',
  hypothesisCount = 5,
  mode = 'shadow'
} = {}) {
  if (validateAdaptiveRecord(policyEpoch).status !== 'OK'
      || policyEpoch.schemaVersion !== ADAPTIVE_SCHEMA.POLICY_EPOCH) {
    return {
      status: 'REFUSED',
      code: 'INVALID_POLICY_EPOCH',
      message: 'Adaptive routing needs a valid persisted policy epoch.'
    };
  }
  if (!Number.isInteger(hypothesisCount) || hypothesisCount < 1 || hypothesisCount > 20) {
    return {
      status: 'REFUSED',
      code: 'INVALID_HYPOTHESIS_COUNT',
      message: 'hypothesisCount must be an integer from 1 through 20.'
    };
  }
  if (!['shadow', 'active-canary'].includes(mode)) {
    return {
      status: 'REFUSED',
      code: 'INVALID_ROUTING_MODE',
      message: 'Adaptive routing mode must be shadow or active-canary.'
    };
  }
  const validatedFamilies = (Array.isArray(families) ? families : [])
    .filter((family) => (
      family.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
      && validateAdaptiveRecord(family).status === 'OK'
    ))
    .sort((a, b) => a.familyId.localeCompare(b.familyId));
  const deduplicatedFamilies = deduplicateAdaptiveFamilies(validatedFamilies);
  if (deduplicatedFamilies.status !== 'OK') return deduplicatedFamilies;
  const validFamilies = deduplicatedFamilies.families;
  const familyIds = new Set(validFamilies.map((family) => family.familyId));
  const selectedApplications = selectLatestApplicationRevisions(
    (Array.isArray(applications) ? applications : []).filter((application) => (
      application.schemaVersion === ADAPTIVE_SCHEMA.APPLICATION
      && validateAdaptiveRecord(application).status === 'OK'
      && familyIds.has(application.familyId)
      && application.partition === 'harvest'
      && application.eligibleForRouting === true
      && application.routing?.allocation !== 'control'
    ))
  );
  if (selectedApplications.status !== 'OK') return selectedApplications;
  const canaryCandidates = (Array.isArray(applications) ? applications : [])
    .filter((application) => (
      application.schemaVersion === ADAPTIVE_SCHEMA.CANARY_IMPORT
      && validateAdaptiveRecord(application).status === 'OK'
      && familyIds.has(application.familyId)
      && application.partition === 'harvest'
      && application.eligibleForRouting === true
      && application.routing?.allocation !== 'control'
      && isCausallyAdmittedCanaryImport(application)
    ));
  const canaryByEvidence = new Map();
  for (const application of canaryCandidates) {
    const evidenceSha256 = application.evidence.verifierEvidenceSha256;
    const existing = canaryByEvidence.get(evidenceSha256);
    if (existing && existing.applicationSha256 !== application.applicationSha256) {
      return {
        status: 'REFUSED',
        code: 'CANARY_IMPORT_EVIDENCE_CONFLICT',
        message: 'One verifier evidence hash produced conflicting adaptive canary imports.'
      };
    }
    canaryByEvidence.set(evidenceSha256, application);
  }
  const canaryImports = [...canaryByEvidence.values()];
  const recursive = deriveActiveEvolutionRoutingApplications({
    families: validFamilies,
    evolutions,
    measurements,
    admissions,
    analyses
  });
  if (recursive.status !== 'OK') return recursive;
  const validApplications = [
    ...selectedApplications.applications.filter(isCausallyAdmittedApplication),
    ...canaryImports,
    ...recursive.applications
  ].sort((left, right) => (
    left.applicationReceiptId.localeCompare(right.applicationReceiptId)
  ));
  const byFamily = new Map();
  for (const application of validApplications) {
    const rows = byFamily.get(application.familyId) || [];
    rows.push(application);
    byFamily.set(application.familyId, rows);
  }
  const targetView = adaptiveTargetView(target);
  const targetSha256 = sha256(canonicalAdaptiveJson(targetView));
  const quarantined = new Set(policyEpoch.quarantinedFamilyIds || []);
  const rankedCandidates = validFamilies
    .map((family) => adaptiveCandidate(
      family,
      byFamily.get(family.familyId) || [],
      targetView,
      quarantined
    ))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.family.familyId.localeCompare(b.family.familyId));
  const semanticCandidates = deduplicateSemanticCandidates(rankedCandidates);
  const candidates = semanticCandidates.candidates;
  const candidatePool = candidates.map(adaptiveCandidatePublic);
  const candidatePoolSha256 = sha256(canonicalAdaptiveJson(candidatePool));
  const normalizedSeed = sha256(String(seed || 'adaptive-routing-v1'));
  const controls = controlPositions(
    hypothesisCount,
    policyEpoch.policy.allocations.control,
    normalizedSeed
  );
  const plans = [];
  for (let position = 0; position < hypothesisCount; position++) {
    if (controls.has(position)) {
      plans.push({ position, allocation: 'control', allocationProbability: policyEpoch.policy.allocations.control });
    } else {
      const chosen = weightedAllocation(policyEpoch.policy, normalizedSeed, position);
      plans.push({ position, allocation: chosen.name, allocationProbability: chosen.probability });
    }
  }
  const selectedFamilies = new Set();
  const selectedDiversityKeys = new Set();
  const capsuleItems = [];
  const allocationSchedule = plans.map((plan) => {
    if (plan.allocation === 'control') {
      return {
        allocation: 'control',
        familyId: null,
        applicationReceiptId: null,
        probability: round(plan.allocationProbability),
        evidenceStrength: null,
        reasonCodes: ['NO_MEMORY_CONTROL']
      };
    }
    const selected = chooseAdaptiveCandidate({
      allocation: plan.allocation,
      candidates,
      selectedFamilies,
      selectedDiversityKeys,
      seed: normalizedSeed,
      position: plan.position
    });
    if (!selected.candidate) {
      return {
        allocation: 'control',
        familyId: null,
        applicationReceiptId: null,
        probability: round(plan.allocationProbability),
        evidenceStrength: null,
        reasonCodes: [`NO_ELIGIBLE_${plan.allocation.replaceAll('-', '_').toUpperCase()}`]
      };
    }
    const candidate = selected.candidate;
    selectedFamilies.add(candidate.family.familyId);
    selectedDiversityKeys.add(adaptiveDiversityKey(candidate));
    const evidence = plan.allocation === 'failure-derived'
      ? candidate.bestFailure
      : candidate.bestPositive;
    const semantics = plan.allocation === 'failure-derived'
      ? 'failure-inversion'
      : 'positive-transfer';
    capsuleItems.push({
      position: plan.position,
      allocation: plan.allocation,
      familyId: candidate.family.familyId,
      familySha256: candidate.family.familySha256,
      causalFingerprint: candidate.family.causalFingerprint,
      evidence: {
        applicationReceiptId: evidence.applicationReceiptId,
        applicationSha256: evidence.applicationSha256,
        verdict: evidence.outcome.verdict,
        reverified: evidence.outcome.reverified,
        confidence: evidence.credit.confidence,
        utility: applicationUtility(evidence)
      },
      semantics,
      instruction: mechanismInstruction(candidate.family.causalFingerprint, semantics)
    });
    return {
      allocation: plan.allocation,
      familyId: candidate.family.familyId,
      applicationReceiptId: evidence.applicationReceiptId,
      probability: round(plan.allocationProbability * selected.candidateProbability),
      evidenceStrength: candidate.evidenceStrength,
      reasonCodes: [
        plan.allocation === 'failure-derived' ? 'FAILURE_DERIVED_INVERSION' : 'EVIDENCE_SELECTED',
        plan.allocation.replaceAll('-', '_').toUpperCase(),
        selected.diversityPreferred ? 'DIVERSITY_PREFERRED' : 'DIVERSITY_FALLBACK'
      ]
    };
  });
  capsuleItems.sort((a, b) => a.position - b.position);
  const capsulePayload = {
    schemaVersion: 'mechanism-capsule-v1',
    targetSha256,
    policyEpochId: policyEpoch.policyEpochId,
    policyEpochSha256: policyEpoch.policyEpochSha256,
    candidatePoolSha256,
    items: capsuleItems
  };
  const mechanismCapsuleSha256 = sha256(canonicalAdaptiveJson(capsulePayload));
  const nonControlCount = allocationSchedule.filter((item) => item.allocation !== 'control').length;
  const routingStatus = nonControlCount === 0
    ? 'ABSTAINED'
    : nonControlCount + controls.size === hypothesisCount
      ? 'COMPLETE'
      : 'PARTIAL';
  const built = createRoutingDecisionRecord({
    mode,
    status: routingStatus,
    targetSha256,
    candidatePoolSha256,
    candidatePoolCount: candidatePool.length,
    policyEpochId: policyEpoch.policyEpochId,
    policyEpochSha256: policyEpoch.policyEpochSha256,
    mechanismCapsuleSha256,
    seed: normalizedSeed,
    abstentionCode: nonControlCount === 0 ? 'NO_ELIGIBLE_MECHANISM_FAMILIES' : null,
    allocationSchedule
  });
  if (built.status !== 'OK') return built;
  return {
    status: 'OK',
    decision: built.record,
    capsule: {
      ...capsulePayload,
      mechanismCapsuleSha256
    },
    candidatePool,
    filtered: {
      inputFamilies: Array.isArray(families) ? families.length : 0,
      validFamilies: validFamilies.length,
      duplicateFamilies: deduplicatedFamilies.duplicateFamilies,
      semanticCloneFamilies: semanticCandidates.semanticCloneFamilies,
      inputApplications: Array.isArray(applications) ? applications.length : 0,
      inputEvolutions: Array.isArray(evolutions) ? evolutions.length : 0,
      validActiveEvolutions: recursive.applications.length,
      rejectedActiveEvolutions: recursive.rejected.length,
      validHarvestApplications: validApplications.length,
      quarantinedFamilies: validFamilies.filter((family) => quarantined.has(family.familyId)).length
    }
  };
}
