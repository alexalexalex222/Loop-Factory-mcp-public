import { canonicalVNextJson } from './vnext-contracts.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const VNEXT_OPERATOR_CONTROL_SCHEMA =
  'loop-factory-vnext-operator-control-v1';

const SHA256 = /^[a-f0-9]{64}$/;

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function payload(projection) {
  return {
    schemaVersion: projection.schemaVersion,
    revision: projection.revision,
    previousProjectionSha256: projection.previousProjectionSha256,
    actionId: projection.actionId,
    actionSha256: projection.actionSha256,
    appliedAt: projection.appliedAt,
    disposition: projection.disposition,
    quarantinedFamilyIds: projection.quarantinedFamilyIds,
    shadowOnlyFamilyIds: projection.shadowOnlyFamilyIds,
    policyOverride: projection.policyOverride,
    activationAuthorized: projection.activationAuthorized,
    promotionAuthorized: projection.promotionAuthorized
  };
}

export function sealVNextOperatorControlProjection(core) {
  return {
    ...core,
    projectionSha256: sha256(canonicalVNextJson(core))
  };
}

export function createInitialVNextOperatorControl({ createdAt } = {}) {
  if (!Number.isFinite(Date.parse(createdAt))) {
    return refused(
      'VNEXT_OPERATOR_CONTROL_TIME_INVALID',
      'Operator control initialization needs an ISO timestamp.'
    );
  }
  return {
    status: 'OK',
    projection: sealVNextOperatorControlProjection({
      schemaVersion: VNEXT_OPERATOR_CONTROL_SCHEMA,
      revision: 0,
      previousProjectionSha256: null,
      actionId: null,
      actionSha256: null,
      appliedAt: createdAt,
      disposition: 'INITIALIZED',
      quarantinedFamilyIds: [],
      shadowOnlyFamilyIds: [],
      policyOverride: null,
      activationAuthorized: false,
      promotionAuthorized: false
    })
  };
}

export function validateVNextOperatorControlProjection(projection) {
  const expected = [
    'schemaVersion', 'revision', 'previousProjectionSha256', 'actionId',
    'actionSha256', 'appliedAt', 'disposition', 'quarantinedFamilyIds',
    'shadowOnlyFamilyIds', 'policyOverride', 'activationAuthorized',
    'promotionAuthorized', 'projectionSha256'
  ].sort();
  const keys = projection && typeof projection === 'object' && !Array.isArray(projection)
    ? Object.keys(projection).sort()
    : [];
  const familyList = (values) => Array.isArray(values)
    && values.every((value) => /^family-[a-f0-9]{24}$/.test(String(value)))
    && canonicalVNextJson(values) === canonicalVNextJson(sortedUnique(values));
  const override = projection?.policyOverride;
  const overrideValid = override === null || (
    override
    && typeof override === 'object'
    && !Array.isArray(override)
    && Object.keys(override).sort().join(',') === 'id,scopeId,sha256'
    && /^epoch-[a-f0-9]{24}$/.test(String(override.id || ''))
    && SHA256.test(String(override.sha256 || ''))
    && isSafeId(override.scopeId)
  );
  if (keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])
      || projection.schemaVersion !== VNEXT_OPERATOR_CONTROL_SCHEMA
      || !Number.isInteger(projection.revision)
      || projection.revision < 0
      || (projection.revision === 0) !== (projection.previousProjectionSha256 === null)
      || (projection.revision === 0) !== (projection.actionId === null)
      || (projection.revision === 0) !== (projection.actionSha256 === null)
      || (projection.revision > 0
        && (!SHA256.test(String(projection.previousProjectionSha256 || ''))
          || !isSafeId(projection.actionId)
          || !SHA256.test(String(projection.actionSha256 || ''))))
      || !Number.isFinite(Date.parse(projection.appliedAt))
      || !isSafeId(projection.disposition)
      || !familyList(projection.quarantinedFamilyIds)
      || !familyList(projection.shadowOnlyFamilyIds)
      || projection.quarantinedFamilyIds.some((familyId) => (
        projection.shadowOnlyFamilyIds.includes(familyId)
      ))
      || !overrideValid
      || projection.activationAuthorized !== false
      || projection.promotionAuthorized !== false
      || projection.projectionSha256 !== sha256(canonicalVNextJson(payload(projection)))) {
    return refused(
      'VNEXT_OPERATOR_CONTROL_TAMPERED',
      'Operator control projection failed its closed shape or hash contract.'
    );
  }
  return { status: 'OK', projection };
}
