#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/util.mjs';
import { canonicalJson } from '../src/meta-policy.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import {
  createVNextEvidenceRecord,
  createVNextFixtureEvidenceAuthority
} from '../src/vnext-evidence-bank.mjs';
import { runChronologicalRetrievalBenchmark } from '../src/retrieval-benchmark.mjs';
import { compareOfflineAcceptors } from '../src/pace-acceptor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_AT = '2026-08-05T06:00:00.000Z';
const FIXTURE_AUTHORITY = createVNextFixtureEvidenceAuthority(
  'vnext-offline-evidence'
).authority;
const DOMAINS = [
  ['incident-triage', 'failure disposition evidence'],
  ['schema-integrity', 'closed schema extension'],
  ['context-saturation', 'adaptive context allocation'],
  ['evaluator-isolation', 'arm label leakage'],
  ['routing-contradiction', 'negative precedent retrieval'],
  ['crash-recovery', 'ambiguous dispatch retry'],
  ['operator-control', 'quarantine revision binding'],
  ['transfer-check', 'disjoint domain confirmation']
];

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.new`;
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(next, path);
}

function mechanism(key, verdict = 'improvement') {
  const hex = sha256(key).slice(0, 24);
  const payload = {
    schemaVersion: 'improvement-mechanism-v1',
    mechanismId: `mech-${hex}`,
    generatedAt: GENERATED_AT,
    partition: 'harvest',
    eligibleForRouting: true,
    source: {
      runId: `run-${hex.slice(0, 8)}`,
      findingId: null,
      hypothesisId: `hyp-${hex.slice(0, 8)}`,
      testId: `test-${hex.slice(0, 8)}`,
      benchmarkId: 'offline-fixture-benchmark',
      benchmarkSha256: sha256('offline-fixture-benchmark'),
      policyId: null,
      policySha256: null
    },
    target: {
      taskSha256: sha256(`task:${key}`),
      taskMode: 'improve',
      loopId: 'loop-de-loop',
      taskValueDimensions: ['quality'],
      resourceDimensions: ['token-cost'],
      signatureTokens: key.split('-')
    },
    mechanism: {
      title: key,
      bottleneck: key,
      operation: key,
      expectedMovement: 'quality',
      falsifier: 'no gain'
    },
    measurement: {
      baseline: {
        quality: 0.5,
        tokenCost: 100,
        artifactOutputTokenEstimate: 100,
        cliReceiptTokenCost: 100,
        samples: 3
      },
      challenger: {
        quality: verdict === 'improvement' ? 0.7 : 0.4,
        tokenCost: 100,
        artifactOutputTokenEstimate: 100,
        cliReceiptTokenCost: 100,
        samples: 3
      },
      delta: {
        quality: verdict === 'improvement' ? 0.2 : -0.1,
        tokenCost: 0,
        tokenCostPct: 0
      },
      qualityAuthority: 'tool-computed',
      reverified: true,
      shamMovement: 0,
      controlRegressions: 0,
      transferChecks: []
    },
    outcome: {
      verdict,
      code: verdict === 'improvement' ? 'MOVED_FRONTIER' : 'NO_IMPROVEMENT',
      valid: true,
      observedAt: GENERATED_AT,
      reverifiedAt: GENERATED_AT
    },
    provenance: { evidenceRefs: [], artifacts: [] },
    lifecycle: {
      state: verdict === 'improvement' ? 'replicated' : 'contradicted',
      reason: 'offline contract fixture'
    }
  };
  const receiptSha256 = sha256(canonicalJson(payload));
  return {
    ...payload,
    receiptId: `receipt-${receiptSha256.slice(0, 24)}`,
    receiptSha256
  };
}

function evidence(recordId, kind, statement, tags, availableAt, qualityDelta) {
  return createVNextEvidenceRecord({
    recordId,
    kind,
    availableAt,
    createdAt: availableAt,
    sourceIds: ['offline-fixture-source'],
    verifierEvidenceHashes: [sha256(`${recordId}:verifier`)],
    authority: FIXTURE_AUTHORITY,
    compatibility: {
      domains: [],
      tags,
      component: 'retrieval',
      schemaVersions: [],
      models: [],
      harnessSha256s: [],
      toolEnvironmentSha256s: [],
      permissions: [],
      securityRequirements: [],
      versionConstraints: []
    },
    lifecycle: {
      state: kind === 'contradiction' ? 'contradicted' : 'replicated',
      quarantined: false,
      quarantineReason: null
    },
    metrics: {
      qualityDelta,
      costUsd: 0,
      latencyMs: 0,
      tokenCost: 0,
      uncertainty: 0.1
    },
    content: { statement },
    callerClaims: {}
  }, { allowFixtureRecords: true }).record;
}

function ranking(recordId, expectedBenefit, contradictionRisk = 0.1) {
  return {
    recordId,
    applicability: 0.9,
    structuralSimilarity: 0.9,
    expectedBenefit,
    transferUncertainty: 0.1,
    contradictionRisk,
    reason: 'frozen offline fixture ranking',
    confidence: 0.9
  };
}

function retrievalCase([domain, phrase], index) {
  const queryAt = `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`;
  const futureAt = `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`;
  const positive = mechanism(`${domain}-verified-positive`);
  const negative = mechanism(`${domain}-failed-precedent`, 'no_improvement');
  const harmful = mechanism(`${domain}-misleading-shortcut`, 'no_improvement');
  const records = [
    evidence(positive.mechanismId, 'positive', `${phrase} verified transfer`, [domain, ...phrase.split(' ')], queryAt, 0.2),
    evidence(negative.mechanismId, 'contradiction', `${phrase} failed precedent`, [domain, 'failed', 'precedent'], queryAt, -0.1),
    evidence(harmful.mechanismId, 'regression', `task specific shortcut for ${domain}`, [domain, 'shortcut'], queryAt, -0.3),
    evidence(`future-${index + 1}`, 'positive', `future result for ${domain}`, [domain], futureAt, 0.4)
  ];
  const reranker = {
    schemaVersion: 'vnext-reranker-output-v1',
    abstain: false,
    abstainReason: null,
    rankings: [
      ranking(positive.mechanismId, 0.9),
      ranking(negative.mechanismId, 0.15, 0.8),
      ranking(harmful.mechanismId, 0, 0.95)
    ]
  };
  return {
    caseId: `offline-${String(index + 1).padStart(2, '0')}-${domain}`,
    queryAt,
    query: { summary: `${domain} ${phrase}` },
    records,
    queryEmbedding: [1, 0, 0],
    embeddings: {
      [positive.mechanismId]: [1, 0, 0],
      [negative.mechanismId]: [0.8, 0.2, 0],
      [harmful.mechanismId]: [0, 1, 0]
    },
    hybridRerankerOutput: reranker,
    unfilteredRerankerOutput: reranker,
    deterministicRouter: {
      receipts: [positive, negative, harmful],
      availableAtByMechanism: {
        [positive.mechanismId]: queryAt,
        [negative.mechanismId]: queryAt,
        [harmful.mechanismId]: queryAt
      },
      target: {
        signatureTokens: [domain, ...phrase.split(' ')],
        taskValueDimensions: ['quality'],
        resourceDimensions: ['token-cost'],
        taskMode: 'improve',
        loopId: 'loop-de-loop'
      },
      seed: `offline-seed-${index + 1}`
    },
    labels: {
      beneficialIds: [positive.mechanismId],
      harmfulIds: [harmful.mechanismId],
      negativePrecedentIds: [negative.mechanismId],
      utilityById: {
        [positive.mechanismId]: 1,
        [negative.mechanismId]: 0.2,
        [harmful.mechanismId]: -0.5
      }
    },
    costs: {}
  };
}

const retrieval = await runChronologicalRetrievalBenchmark({
  cases: DOMAINS.map(retrievalCase),
  k: 2,
  allowFixtureRecords: true
});
if (retrieval.status !== 'OK') throw new Error(retrieval.message || retrieval.code);
const retrievalCore = {
  schemaVersion: 'loop-factory-vnext-offline-retrieval-evidence-v1',
  generatedAt: GENERATED_AT,
  fixtureOnly: true,
  historicalOutcomeAuthority: false,
  generalizedImprovementClaim: false,
  purpose: 'Contract and leakage-resistance ablation only.',
  report: retrieval.report
};
const retrievalArtifact = {
  ...retrievalCore,
  artifactSha256: sha256(canonicalVNextJson(retrievalCore))
};

const cluster = (taskId, candidate, incumbent) => ({
  taskId,
  objectiveVerified: true,
  replicates: Array.from({ length: 3 }, (_, replicate) => ({
    replicate,
    candidate,
    incumbent
  }))
});
const acceptorConfig = {
  candidateId: 'offline-acceptor-fixture',
  outerAlphaAllocation: {
    allocationId: 'offline-acceptor-allocation',
    alpha: 0.05,
    familyAlpha: 0.05,
    policySha256: sha256('offline-acceptor-policy')
  },
  lambdaPolicy: { kind: 'fixed', value: 0.5 },
  fixedDelta: 0.5
};
const streams = {
  consistentGain: Array.from({ length: 12 }, (_, index) => cluster(`gain-${index + 1}`, 1, 0)),
  nullEffect: Array.from({ length: 12 }, (_, index) => cluster(`null-${index + 1}`, 1, 1)),
  alternatingNoise: Array.from({ length: 12 }, (_, index) => (
    index % 2 === 0
      ? cluster(`noise-${index + 1}`, 1, 0)
      : cluster(`noise-${index + 1}`, 0, 1)
  ))
};
const acceptorComparisons = Object.fromEntries(Object.entries(streams).map(([name, stream]) => {
  const result = compareOfflineAcceptors({ ...acceptorConfig, stream });
  if (result.status !== 'OK') throw new Error(result.message || result.code);
  return [name, result.comparison];
}));
const acceptorCore = {
  schemaVersion: 'loop-factory-vnext-offline-acceptor-evidence-v1',
  generatedAt: GENERATED_AT,
  fixtureOnly: true,
  generalizedImprovementClaim: false,
  samePredeclaredStreams: true,
  comparisons: acceptorComparisons,
  activationAuthority: false
};
const acceptorArtifact = {
  ...acceptorCore,
  artifactSha256: sha256(canonicalVNextJson(acceptorCore))
};

atomicJson(join(ROOT, 'RETRIEVAL_EVAL_RESULTS.json'), retrievalArtifact);
atomicJson(join(ROOT, 'proof', 'vnext-offline-evidence', 'ACCEPTOR_EVAL_RESULTS.json'), acceptorArtifact);
console.log(JSON.stringify({
  status: 'OK',
  fixtureOnly: true,
  retrievalArtifactSha256: retrievalArtifact.artifactSha256,
  retrievalReportSha256: retrieval.report.reportSha256,
  acceptorArtifactSha256: acceptorArtifact.artifactSha256
}, null, 2));
