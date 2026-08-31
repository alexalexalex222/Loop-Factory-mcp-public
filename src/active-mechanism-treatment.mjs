import {
  ADAPTIVE_SCHEMA,
  canonicalAdaptiveJson,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { compileMechanismCapsule } from './mechanism-compiler.mjs';
import { sha256 } from './util.mjs';

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function validateCapsule(capsule) {
  if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)
      || capsule.schemaVersion !== 'mechanism-capsule-v1'
      || !Array.isArray(capsule.items)
      || !/^[a-f0-9]{64}$/.test(String(capsule.mechanismCapsuleSha256 || ''))) {
    return refused('MECHANISM_CAPSULE_INVALID', 'Mechanism capsule shape is invalid.');
  }
  const payload = { ...capsule };
  delete payload.mechanismCapsuleSha256;
  if (sha256(canonicalAdaptiveJson(payload)) !== capsule.mechanismCapsuleSha256) {
    return refused(
      'MECHANISM_CAPSULE_HASH_MISMATCH',
      'Mechanism capsule hash does not bind the capsule payload.'
    );
  }
  return { status: 'OK' };
}

function bindSchedule(routingDecision, mechanismCapsule) {
  const itemsByPosition = new Map();
  for (const item of mechanismCapsule.items) {
    if (!Number.isInteger(item?.position)
        || itemsByPosition.has(item.position)
        || item.position < 0
        || item.position >= routingDecision.allocationSchedule.length) {
      return refused(
        'SCHEDULE_POSITION_MISMATCH',
        'Capsule items must bind unique positions in the routing schedule.'
      );
    }
    itemsByPosition.set(item.position, item);
  }

  const positions = [];
  for (const scheduleItem of routingDecision.allocationSchedule) {
    const capsuleItem = itemsByPosition.get(scheduleItem.position) || null;
    if (scheduleItem.allocation === 'control') {
      if (capsuleItem) {
        return refused(
          'SCHEDULE_POSITION_MISMATCH',
          'A no-memory control position may not contain a mechanism treatment.',
          { position: scheduleItem.position }
        );
      }
    } else if (!capsuleItem) {
      return refused(
        'SCHEDULE_POSITION_MISMATCH',
        'Every non-control schedule position must have one capsule item.',
        { position: scheduleItem.position }
      );
    } else if (capsuleItem.familyId !== scheduleItem.familyId) {
      return refused(
        'FAMILY_MISMATCH',
        'The capsule family does not match the family selected for this schedule position.',
        { position: scheduleItem.position }
      );
    } else if (capsuleItem.allocation !== scheduleItem.allocation) {
      return refused(
        'ALLOCATION_MISMATCH',
        'The capsule allocation does not match the routing schedule.',
        { position: scheduleItem.position }
      );
    }
    positions.push({
      position: scheduleItem.position,
      allocation: scheduleItem.allocation,
      familyId: scheduleItem.familyId,
      capsuleItem,
      compiledTreatment: null,
      legacyTreatment: null
    });
  }

  if (itemsByPosition.size !== positions.filter((item) => item.capsuleItem).length) {
    return refused(
      'SCHEDULE_POSITION_MISMATCH',
      'Capsule items and non-control schedule positions must match exactly.'
    );
  }
  return { status: 'OK', positions };
}

function compilationCapsule(mechanismCapsule, executableItems) {
  if (executableItems.length === mechanismCapsule.items.length) return mechanismCapsule;
  const payload = { ...mechanismCapsule, items: executableItems };
  delete payload.mechanismCapsuleSha256;
  return {
    ...payload,
    mechanismCapsuleSha256: sha256(canonicalAdaptiveJson(payload))
  };
}

export function prepareActiveMechanismTreatment({
  routingDecision,
  mechanismCapsule,
  interfaceContract
} = {}) {
  try {
    const decisionValidation = validateAdaptiveRecord(routingDecision);
    if (decisionValidation.status !== 'OK'
        || routingDecision?.schemaVersion !== ADAPTIVE_SCHEMA.ROUTING_DECISION) {
      return refused(
        'ROUTING_DECISION_INVALID',
        'Active treatment requires a valid persisted routing-decision-v1.'
      );
    }
    if (routingDecision.mode !== 'active-canary') {
      return refused(
        'ROUTING_DECISION_NOT_ACTIVE',
        'Only active-canary routing decisions may produce supervisor treatments.'
      );
    }

    const capsuleValidation = validateCapsule(mechanismCapsule);
    if (capsuleValidation.status !== 'OK') return capsuleValidation;
    if (routingDecision.mechanismCapsuleSha256
        !== mechanismCapsule.mechanismCapsuleSha256) {
      return refused(
        'DECISION_CAPSULE_HASH_MISMATCH',
        'The routing decision does not bind this mechanism capsule.'
      );
    }
    if (mechanismCapsule.targetSha256 !== routingDecision.targetSha256
        || mechanismCapsule.policyEpochId !== routingDecision.policyEpochId
        || mechanismCapsule.policyEpochSha256 !== routingDecision.policyEpochSha256
        || mechanismCapsule.candidatePoolSha256 !== routingDecision.candidatePoolSha256) {
      return refused(
        'CAPSULE_CONTEXT_MISMATCH',
        'The mechanism capsule context does not match its routing decision.'
      );
    }

    const bound = bindSchedule(routingDecision, mechanismCapsule);
    if (bound.status !== 'OK') return bound;
    const selected = bound.positions.filter((item) => item.capsuleItem);
    if (selected.length === 0) {
      return {
        status: 'OK',
        treatmentMode: 'NONE',
        routingDecisionId: routingDecision.routingDecisionId,
        mechanismCapsuleSha256: mechanismCapsule.mechanismCapsuleSha256,
        compiledCapsule: null,
        positions: bound.positions
      };
    }

    const executableItems = selected
      .map((item) => item.capsuleItem)
      .filter((item) => item?.causalFingerprint?.program != null);
    if (executableItems.length === 0) {
      return {
        status: 'OK',
        treatmentMode: 'LEGACY',
        routingDecisionId: routingDecision.routingDecisionId,
        mechanismCapsuleSha256: mechanismCapsule.mechanismCapsuleSha256,
        compiledCapsule: null,
        positions: bound.positions.map((item) => ({
          ...item,
          legacyTreatment: item.capsuleItem
        }))
      };
    }

    const compiled = compileMechanismCapsule({
      capsule: compilationCapsule(mechanismCapsule, executableItems),
      interfaceContract
    });
    if (compiled.status !== 'OK') {
      return refused(
        compiled.code || 'EXECUTABLE_COMPILATION_REFUSED',
        compiled.message || 'Executable mechanism compilation was refused.'
      );
    }
    if (compiled.compiledCapsule.status !== 'COMPILED'
        || compiled.compiledCapsule.coverage.abstained !== 0
        || compiled.compiledCapsule.coverage.ratio !== 1) {
      const abstained = compiled.compiledCapsule.items.find(
        (item) => item.compilation.status !== 'COMPILED'
      );
      return refused(
        'EXECUTABLE_COMPILATION_ABSTAINED',
        'Every executable family must compile with complete coverage.',
        {
          position: abstained?.position ?? null,
          familyId: abstained?.familyId ?? null,
          compilerReasonCode: abstained?.compilation?.reasonCode
            || compiled.compiledCapsule.reasonCode
        }
      );
    }

    const compiledByPosition = new Map(
      compiled.compiledCapsule.items.map((item) => [item.position, item.compilation])
    );
    const executablePositions = new Set(executableItems.map((item) => item.position));
    return {
      status: 'OK',
      treatmentMode: executableItems.length === selected.length ? 'COMPILED' : 'MIXED',
      routingDecisionId: routingDecision.routingDecisionId,
      mechanismCapsuleSha256: mechanismCapsule.mechanismCapsuleSha256,
      compiledCapsule: compiled.compiledCapsule,
      positions: bound.positions.map((item) => ({
        ...item,
        compiledTreatment: compiledByPosition.get(item.position) || null,
        legacyTreatment: item.capsuleItem && !executablePositions.has(item.position)
          ? item.capsuleItem
          : null
      }))
    };
  } catch (error) {
    return refused(
      'ACTIVE_MECHANISM_TREATMENT_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
}
