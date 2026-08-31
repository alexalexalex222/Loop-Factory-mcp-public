#!/usr/bin/env node

import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import { canonicalAdaptiveJson } from '../src/adaptive-records.mjs';
import { sha256 } from '../src/util.mjs';
import {
  ROUTER_SCALE_TARGET,
  buildScaleCorpus,
  buildScaleEpoch,
  buildScaleEvidence
} from './lib/mechanism-router-scale-fixture.mjs';

const positive = buildScaleCorpus(512);
const failures = Array.from({ length: 32 }, (_, index) => buildScaleEvidence(`failure-${index}`, {
  operationKind: `failure-operation-${index}`,
  interventionKind: `failure-inversion-${index}`,
  verdict: 'no_improvement'
}));
const gate = Array.from({ length: 16 }, (_, index) => buildScaleEvidence(`gate-${index}`, {
  partition: 'gate'
}));
const reference = Array.from({ length: 16 }, (_, index) => buildScaleEvidence(`reference-${index}`, {
  partition: 'reference'
}));
const contradicted = Array.from({ length: 16 }, (_, index) => buildScaleEvidence(`contradicted-${index}`, {
  verdict: 'regression',
  transferPassed: false,
  controlRegressions: 1,
  contradictionCodes: ['FAILED_TRANSFER']
}));
const rows = [...positive, ...failures, ...gate, ...reference, ...contradicted];
const quarantinedFamilyIds = positive.slice(0, 16).map((row) => row.family.familyId).sort();
const policyEpoch = buildScaleEpoch(undefined, quarantinedFamilyIds);
const seed = 'router-scale-gauntlet-v1';
const base = {
  families: rows.map((row) => row.family),
  applications: rows.map((row) => row.application),
  target: ROUTER_SCALE_TARGET,
  policyEpoch,
  seed,
  hypothesisCount: 20,
  mode: 'active-canary'
};

const forward = buildMechanismRoutingDecision(base);
const reverse = buildMechanismRoutingDecision({
  ...base,
  families: [...base.families].reverse(),
  applications: [...base.applications].reverse()
});
const duplicated = buildMechanismRoutingDecision({
  ...base,
  families: base.families.flatMap((family) => [family, family, family])
});
const alternateSeed = buildMechanismRoutingDecision({
  ...base,
  seed: `${seed}-alternate`
});

const checks = [];
function check(name, condition, details = null) {
  checks.push({ name, pass: condition === true, details });
}

check('forward-route-valid', forward.status === 'OK', forward.code || null);
check('reverse-route-valid', reverse.status === 'OK', reverse.code || null);
check('duplicate-route-valid', duplicated.status === 'OK', duplicated.code || null);
check('alternate-seed-valid', alternateSeed.status === 'OK', alternateSeed.code || null);

if (forward.status === 'OK'
    && reverse.status === 'OK'
    && duplicated.status === 'OK'
    && alternateSeed.status === 'OK') {
  const forwardJson = canonicalAdaptiveJson(forward);
  const reverseJson = canonicalAdaptiveJson(reverse);
  const candidatePoolJson = canonicalAdaptiveJson(forward.candidatePool);
  const capsuleJson = canonicalAdaptiveJson(forward.capsule);
  const authoritative = new Map(rows.map((row) => [row.family.familyId, row.family]));
  const fullMechanismsPreserved = forward.capsule.items.every((item) => {
    const family = authoritative.get(item.familyId);
    return family
      && item.familySha256 === family.familySha256
      && canonicalAdaptiveJson(item.causalFingerprint) === canonicalAdaptiveJson(family.causalFingerprint);
  });
  const diversityKeys = forward.capsule.items.map((item) => (
    `${item.causalFingerprint.interventionKind}|${item.causalFingerprint.operationKind}`
  ));
  const rawSeedExposed = forwardJson.includes(seed);
  const failureSemanticsCorrect = forward.capsule.items
    .filter((item) => item.allocation === 'failure-derived')
    .every((item) => item.semantics === 'failure-inversion');

  check('input-order-invariant', forwardJson === reverseJson);
  check(
    'duplicate-family-invariant',
    canonicalAdaptiveJson(duplicated.decision) === canonicalAdaptiveJson(forward.decision)
      && canonicalAdaptiveJson(duplicated.capsule) === capsuleJson
      && canonicalAdaptiveJson(duplicated.candidatePool) === candidatePoolJson,
    { duplicateFamilies: duplicated.filtered.duplicateFamilies }
  );
  check('candidate-pool-unique', new Set(forward.candidatePool.map((row) => row.familyId)).size === forward.candidatePool.length);
  check('partition-and-quarantine-firewall', forward.candidatePool.length === 544, {
    candidatePoolCount: forward.candidatePool.length,
    expectedCandidatePoolCount: 544,
    quarantinedFamilies: forward.filtered.quarantinedFamilies
  });
  check('full-mechanisms-preserved', fullMechanismsPreserved, {
    selectedMechanisms: forward.capsule.items.length
  });
  check('structural-diversity-preferred', new Set(diversityKeys).size === diversityKeys.length, {
    selectedMechanisms: diversityKeys.length,
    structuralKeys: new Set(diversityKeys).size
  });
  check('failure-derived-remains-inversion', failureSemanticsCorrect);
  check('raw-seed-withheld', rawSeedExposed === false);
  check(
    'seed-controls-replayable-exploration',
    alternateSeed.decision.routingDecisionSha256 !== forward.decision.routingDecisionSha256
  );

  const payload = {
    schemaVersion: 'mechanism-router-scale-gauntlet-v1',
    status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL',
    corpus: {
      inputFamilies: base.families.length,
      positiveFamilies: positive.length,
      failureFamilies: failures.length,
      gateFamilies: gate.length,
      referenceFamilies: reference.length,
      contradictedFamilies: contradicted.length,
      quarantinedFamilies: quarantinedFamilyIds.length,
      candidatePoolCount: forward.candidatePool.length,
      selectedMechanisms: forward.capsule.items.length
    },
    context: {
      authoritativeFamiliesRetained: rows.length,
      authoritativeMechanismsCompacted: 0,
      candidatePoolBytes: Buffer.byteLength(candidatePoolJson),
      selectedCapsuleBytes: Buffer.byteLength(capsuleJson)
    },
    hashes: {
      policyEpochSha256: policyEpoch.policyEpochSha256,
      targetSha256: forward.decision.targetSha256,
      candidatePoolSha256: forward.decision.candidatePoolSha256,
      mechanismCapsuleSha256: forward.decision.mechanismCapsuleSha256,
      routingDecisionSha256: forward.decision.routingDecisionSha256
    },
    checks
  };
  const report = {
    ...payload,
    reportSha256: sha256(canonicalAdaptiveJson(payload))
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
} else {
  const payload = {
    schemaVersion: 'mechanism-router-scale-gauntlet-v1',
    status: 'FAIL',
    checks
  };
  process.stdout.write(`${JSON.stringify({
    ...payload,
    reportSha256: sha256(canonicalAdaptiveJson(payload))
  }, null, 2)}\n`);
  process.exitCode = 1;
}
