import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_SCHEMA,
  createAdaptiveCanaryImportRecord,
  createMechanismFamilyRecord,
  isCausallyAdmittedCanaryImport,
  validateAdaptiveRecord
} from '../src/adaptive-records.mjs';
import {
  createBaselinePolicyEpoch
} from '../src/adaptive-policy.mjs';
import {
  listAdaptiveRecords,
  loadMechanismCatalog,
  persistAdaptiveRecord
} from '../src/mechanism-catalog.mjs';
import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import { sha256 } from '../src/util.mjs';

function program() {
  return {
    schemaVersion: 'mechanism-program-v1',
    bindingPolicy: 'closed-world',
    roles: ['baseline.quality', 'candidate.quality'],
    selectors: [],
    bindings: [],
    forbiddenBindings: [],
    metrics: [{
      metricId: 'quality-delta',
      operator: 'subtract',
      leftRole: 'candidate.quality',
      rightRole: 'baseline.quality'
    }],
    rules: [{
      ruleId: 'accept-quality',
      kind: 'decision',
      exceptionOf: null,
      when: {
        operator: 'greater-than',
        left: { kind: 'metric', id: 'quality-delta' },
        right: { kind: 'literal', value: 0 }
      },
      emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
    }],
    fallback: { decision: 'REJECT', code: 'NO_GAIN' }
  };
}

function family() {
  const result = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'unbound-evidence',
      interventionKind: 'bind-before-route',
      operationKind: 'verified-canary-import',
      expectedEffectKind: 'fewer-false-routes',
      preconditions: ['sealed-verifier'],
      procedureSteps: ['verify-v4', 'pair-confirmation', 'route-only'],
      program: program(),
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['quality'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(result.status, 'OK', result.message);
  return result.record;
}

function canaryImport(familyRecord, overrides = {}) {
  const hashes = Object.fromEntries([
    'configSha256',
    'planSha256',
    'verifierEvidenceSha256',
    'programSha256',
    'evaluatorAuthoritySha256',
    'interfaceSetSha256',
    'caseSetSha256',
    'compilationSetSha256',
    'evaluationArtifactSetSha256',
    'tokenReceiptSetSha256',
    'measurementSha256',
    'mechanismCapsuleSha256'
  ].map((field) => [field, sha256(`canary-${field}`)]));
  const result = createAdaptiveCanaryImportRecord({
    familyId: familyRecord.familyId,
    source: {
      kind: 'adaptive-executable-canary-v4',
      runId: 'canary-run-001'
    },
    context: {
      targetSha256: sha256('canary-target'),
      taskMode: 'improve',
      loopRole: 'supervisor',
      taskValueDimensions: ['quality'],
      resourceDimensions: ['token-cost']
    },
    routing: {
      routingDecisionId: `route-${sha256('route').slice(0, 24)}`,
      routingDecisionSha256: sha256('route-decision'),
      routingPacketSha256: sha256('route-packet'),
      policyEpochId: `epoch-${sha256('epoch').slice(0, 24)}`,
      policyEpochSha256: sha256('policy-epoch'),
      allocation: 'related',
      schedulePosition: 0
    },
    outcome: {
      qualityDelta: 1,
      tokenCostDeltaPct: 0.0767,
      shamMovement: 0,
      controlRegressions: 0,
      targetRegressions: 0,
      shamWins: 0,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: true,
        evidenceSha256: sha256('held-out')
      }, {
        kind: 'negativeControl',
        attempted: true,
        passed: true,
        evidenceSha256: sha256('negative-control')
      }, {
        kind: 'freshReplay',
        attempted: true,
        passed: true,
        evidenceSha256: sha256('fresh-replay')
      }],
      ...overrides.outcome
    },
    authority: {
      profile: 'adaptive-executable-canary-v4',
      model: 'gpt-5.6-sol',
      authMode: 'chatgpt-oauth',
      fixtureOnly: false,
      verificationStatus: 'PASS',
      experimentValid: true,
      causalPass: true,
      allVerifierGatesPassed: true,
      retries: 0,
      promotionRecorded: false,
      activation: 'routing-only',
      ...overrides.authority
    },
    evidence: {
      ...hashes,
      familySha256: familyRecord.familySha256,
      confirmationCaseCount: 5,
      evaluationArtifactCount: 20,
      evaluationArtifactSha256s: Array.from(
        { length: 20 },
        (_, index) => sha256(`evaluation-${index}`)
      ),
      tokenReceiptArtifactCount: 20,
      tokenReceiptArtifactSha256s: Array.from(
        { length: 20 },
        (_, index) => sha256(`token-receipt-${index}`)
      ),
      ...overrides.evidence
    }
  });
  return result;
}

test('adaptive canary import is immutable, causally admitted, and fail-closed', () => {
  const familyRecord = family();
  const built = canaryImport(familyRecord);
  assert.equal(built.status, 'OK', built.message);
  assert.equal(validateAdaptiveRecord(built.record).status, 'OK');
  assert.equal(isCausallyAdmittedCanaryImport(built.record), true);
  assert.equal(built.record.authority.activation, 'routing-only');
  assert.equal(built.record.outcome.tokenCostDeltaPct, 0.0767);

  const tampered = structuredClone(built.record);
  tampered.outcome.qualityDelta = 0.5;
  assert.equal(validateAdaptiveRecord(tampered).status, 'REFUSED');

  for (const outcome of [
    { shamMovement: 0.2, shamWins: 1 },
    { controlRegressions: 1 },
    { targetRegressions: 1 }
  ]) {
    assert.equal(canaryImport(familyRecord, { outcome }).status, 'REFUSED');
  }
  assert.equal(canaryImport(familyRecord, {
    authority: { fixtureOnly: true }
  }).status, 'REFUSED');
});

test('generic catalog persistence refuses caller-minted canary imports', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-canary-catalog-'));
  const familyRecord = family();
  const importRecord = canaryImport(familyRecord).record;
  assert.equal(persistAdaptiveRecord({ homeDir: home, record: familyRecord }).status, 'OK');
  const refused = persistAdaptiveRecord({ homeDir: home, record: importRecord });
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.code, 'CANARY_IMPORT_VERIFIER_REQUIRED');

  const listed = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: ADAPTIVE_SCHEMA.CANARY_IMPORT
  });
  assert.equal(listed.status, 'OK');
  assert.equal(listed.records.length, 0);
  const loaded = loadMechanismCatalog({ homeDir: home });
  assert.equal(loaded.status, 'OK', loaded.message);
  assert.equal(loaded.catalog.counts[ADAPTIVE_SCHEMA.CANARY_IMPORT], 0);
  assert.equal(loaded.catalog.families[0].routingEligible, false);
  assert.doesNotMatch(readFileSync(loaded.catalogPath, 'utf8'), /\/private\/|canaryHome/);
});

test('a verified canary import can seed a later route without updating policy evidence', () => {
  const familyRecord = family();
  const importRecord = canaryImport(familyRecord).record;
  const epoch = createBaselinePolicyEpoch({
    policyScopeId: 'canary-routing-scope',
    evidenceWindowSha256: sha256('canary-routing-window')
  });
  assert.equal(epoch.status, 'OK', epoch.message);
  const routed = buildMechanismRoutingDecision({
    families: [familyRecord],
    applications: [importRecord, structuredClone(importRecord)],
    target: {
      taskMode: 'improve',
      loopRole: 'supervisor',
      taskValueDimensions: ['quality'],
      resourceDimensions: ['token-cost']
    },
    policyEpoch: epoch.record,
    seed: 'canary-import-route',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  const importedSlots = routed.decision.allocationSchedule.filter((item) => (
    item.applicationReceiptId === importRecord.applicationReceiptId
  ));
  assert.ok(importedSlots.length > 0);
  assert.ok(importedSlots.every((item) => item.allocation !== 'control'));
  assert.ok(routed.decision.allocationSchedule.some((item) => item.allocation === 'control'));
  assert.equal(routed.capsule.items[0].evidence.applicationSha256, importRecord.applicationSha256);
  assert.equal(routed.candidatePool[0].applications.length, 1);
});
