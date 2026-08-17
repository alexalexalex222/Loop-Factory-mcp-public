import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VNEXT_CANDIDATE_GENERATOR_FLAGS,
  buildCandidateGeneratorPrompt,
  buildCandidateStageArtifact,
  createCandidateGeneratorRegistry,
  getCandidateGenerator,
  validateCandidateContract,
  validateCandidateVerification
} from '../src/vnext-candidate-generators.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  createVNextStageArtifact
} from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';
import { validateCandidateStrategyPlan } from '../src/vnext-candidate-strategies.mjs';

const sha = (character) => character.repeat(64);
const strategies = [
  'native',
  'reflective-pareto',
  'bounded-skill',
  'bank-recombination',
  'code-level-experimental'
];

function stage(stageName, idCharacter) {
  const built = createVNextStageArtifact({
    stage: stageName,
    status: 'OK',
    createdAt: '2026-08-05T00:00:00.000Z',
    authority: {
      actorId: `actor-${idCharacter}`,
      kind: 'test-builder',
      model: null,
      promptSha256: null,
      toolPolicy: 'none'
    },
    inputRefs: [],
    permittedInformation: ['development evidence'],
    forbiddenInformation: ['sealed tasks'],
    provenance: [],
    replay: { module: 'test', exportName: 'fixture', version: 'v1' },
    failure: null,
    payload: { id: `payload-${idCharacter}` }
  });
  assert.equal(built.status, 'OK');
  return built.artifact;
}

function contractInput(overrides = {}) {
  const behaviorMapCore = {
    schemaVersion: 'vnext-harness-handbook-v1',
    repositoryRootSha256: sha('f'),
    authority: 'descriptive-source-map-only',
    canAuthorizeEdits: false,
    behaviors: [{
      id: 'retrieval', description: 'Bounded retrieval behavior.',
      locators: [{
        path: 'negative-selection-rule', symbol: 'negativeSelectionRule',
        symbolSha256: sha256('negativeSelectionRule'), startLine: 1, endLine: 1,
        sourceSha256: sha('a'), locatorSha256: sha('a')
      }, {
        path: 'src/retrieval.mjs', symbol: 'selectEvidence',
        symbolSha256: sha256('selectEvidence'), startLine: 2, endLine: 2,
        sourceSha256: sha('b'), locatorSha256: sha('b')
      }],
      tests: [], dependencies: [], permissions: [], summary: null
    }]
  };
  return {
    hypothesisArtifact: stage(VNEXT_STAGE.HYPOTHESIS, 'h'),
    falsificationArtifact: stage(VNEXT_STAGE.FALSIFICATION, 'f'),
    retrievalArtifact: stage(VNEXT_STAGE.RETRIEVAL, 'r'),
    selectedEvidence: [{ id: 'evidence-1', sha256: sha('e') }],
    behaviorMap: {
      ...behaviorMapCore,
      behaviorMapSha256: sha256(canonicalVNextJson(behaviorMapCore))
    },
    allowedComponent: 'retrieval',
    parentArtifact: { schemaVersion: 'parent-v1', value: 'frozen' },
    parentItemHashes: [{
      target: 'negative-selection-rule',
      component: 'retrieval',
      sha256: sha('a')
    }],
    maxOperations: 3,
    protectedSurfaces: [
      'evaluator',
      'verifier',
      'statistics',
      'sealed-tasks',
      'promotion'
    ],
    taskAgnostic: true,
    ...overrides
  };
}

function strategyState(strategy) {
  if (strategy === 'native') return null;
  if (strategy === 'reflective-pareto') {
    return {
      trajectories: [{
        trajectoryId: 'trajectory-success', outcome: 'success', quality: 0.8,
        tokenCost: 120, regressions: 0, summary: 'Negative evidence prevented a repeated failure.',
        evidenceIds: ['evidence-1'], availableAt: '2026-08-04T00:00:00.000Z'
      }, {
        trajectoryId: 'trajectory-failure', outcome: 'failure', quality: 0.3,
        tokenCost: 180, regressions: 1, summary: 'Positive-only retrieval repeated a contradicted edit.',
        evidenceIds: ['evidence-1'], availableAt: '2026-08-04T00:00:01.000Z'
      }]
    };
  }
  if (strategy === 'bounded-skill') {
    const value = 'Reserve one verified negative precedent.';
    return {
      skill: {
        skillId: 'retrieval-skill', version: 'v1',
        items: [{ target: 'negative-selection-rule', value, sha256: sha256(value) }]
      },
      successReflections: [{
        reflectionId: 'success-reflection', evidenceId: 'evidence-1',
        statement: 'Negative precedent retrieval prevented repetition.',
        availableAt: '2026-08-04T00:00:00.000Z'
      }],
      failureReflections: [{
        reflectionId: 'failure-reflection', evidenceId: 'evidence-1',
        statement: 'Unbounded context obscured the applicable precedent.',
        availableAt: '2026-08-04T00:00:01.000Z'
      }],
      limits: { maximumChangedItems: 1, maximumChangedBytes: 256 }
    };
  }
  if (strategy === 'bank-recombination') {
    const donor = (mechanismId, familyId, operationKind, content) => ({
      mechanismId, familyId, component: 'retrieval', operationKind, content,
      compatibilityTags: ['negative-evidence', 'retrieval'], incompatibleWith: [],
      evidenceIds: ['evidence-1'], lifecycle: 'replicated', qualityDelta: 0.2,
      regressions: 0, sha256: sha256(content)
    });
    return {
      targetTags: ['negative-evidence', 'retrieval'],
      mechanisms: [
        donor('donor-alpha', 'family-alpha', 'reserve-negative', 'Reserve a negative precedent.'),
        donor('donor-beta', 'family-beta', 'diversify-context', 'Diversify the selected context.')
      ]
    };
  }
  return {
    disposableWorktree: true,
    maximumFiles: 1,
    maximumPatchBytes: 1024,
    requiredTests: [{
      testId: 'retrieval-test', executable: '/opt/homebrew/bin/node',
      executableSha256: sha('c'), args: ['--test', 'test/retrieval.test.mjs'],
      timeoutMs: 120000
    }]
  };
}

function candidate(strategy, overrides = {}) {
  const operation = strategy === 'bank-recombination'
    ? {
        op: 'recombine', target: 'negative-selection-rule', beforeSha256: sha('a'),
        value: 'Combine donor-alpha with donor-beta.'
      }
    : strategy === 'code-level-experimental'
      ? {
          op: 'replace', target: 'src/retrieval.mjs', beforeSha256: sha('b'),
          value: 'export const negativePrecedentReserve = 1;'
        }
      : {
          op: 'replace', target: 'negative-selection-rule', beforeSha256: sha('a'),
          value: 'reserve one negative precedent'
        };
  return {
    schemaVersion: 'vnext-candidate-output-v1',
    strategy,
    targetBehavior: 'preserve negative evidence during retrieval',
    component: 'retrieval',
    taskAgnostic: true,
    prediction: 'negative precedent recall increases without positive recall loss',
    falsifier: 'negative recall is unchanged or positive recall regresses',
    operations: [operation],
    evidenceIds: ['evidence-1'],
    rollback: 'restore the exact parent item',
    protectedSurfaceTouches: [],
    ...overrides
  };
}

test('feature flags gate strategies and code-level evolution is disabled by default', () => {
  const defaults = createCandidateGeneratorRegistry();
  assert.equal(getCandidateGenerator(defaults, 'native').status, 'OK');
  for (const strategy of strategies.slice(1)) {
    assert.equal(getCandidateGenerator(defaults, strategy).status, 'REFUSED');
  }
  const enabled = createCandidateGeneratorRegistry({
    [VNEXT_CANDIDATE_GENERATOR_FLAGS['code-level-experimental']]: true
  });
  assert.equal(
    getCandidateGenerator(enabled, 'code-level-experimental').status,
    'OK'
  );
});

test('all five plugins share one output contract but produce distinct strategy plans and prompts', () => {
  const flags = Object.fromEntries(strategies.map((strategy) => (
    [VNEXT_CANDIDATE_GENERATOR_FLAGS[strategy], true]
  )));
  const registry = createCandidateGeneratorRegistry(flags);
  const verificationKeys = new Set();
  const plannerIds = new Set();
  const prompts = new Set();
  for (const strategy of strategies) {
    const selected = getCandidateGenerator(registry, strategy);
    assert.equal(selected.status, 'OK');
    assert.deepEqual(
      Object.keys(selected.plugin).sort(),
      ['buildPrompt', 'createContract', 'featureFlag', 'id', 'normalizeOutput', 'plannerId', 'verifyCandidate', 'version']
    );
    const built = selected.plugin.createContract(contractInput({
      strategyState: strategyState(strategy)
    }));
    assert.equal(built.status, 'OK');
    assert.equal(validateCandidateStrategyPlan(built.contract.strategyPlan).status, 'OK');
    plannerIds.add(built.contract.strategyPlan.plannerId);
    prompts.add(selected.plugin.buildPrompt(built.contract));
    const normalized = selected.plugin.normalizeOutput(
      JSON.stringify(candidate(strategy)),
      built.contract
    );
    assert.equal(normalized.status, 'OK');
    const verified = selected.plugin.verifyCandidate(
      normalized.candidate,
      built.contract
    );
    assert.equal(verified.status, 'OK');
    verificationKeys.add(Object.keys(verified.verification).sort().join(','));
    assert.equal(verified.verification.activationAuthority, false);
  }
  assert.equal(verificationKeys.size, 1);
  assert.equal(plannerIds.size, strategies.length);
  assert.equal(prompts.size, strategies.length);
});

test('reflective Pareto planning requires chronological success and failure trajectories', () => {
  const registry = createCandidateGeneratorRegistry({
    [VNEXT_CANDIDATE_GENERATOR_FLAGS['reflective-pareto']]: true
  });
  const plugin = getCandidateGenerator(registry, 'reflective-pareto').plugin;
  const valid = plugin.createContract(contractInput({
    strategyState: strategyState('reflective-pareto')
  }));
  assert.equal(valid.status, 'OK');
  assert.deepEqual(valid.contract.strategyPlan.context.paretoFrontierIds, [
    'trajectory-success'
  ]);

  const future = strategyState('reflective-pareto');
  future.trajectories[1].availableAt = '2026-08-06T00:00:00.000Z';
  assert.equal(plugin.createContract(contractInput({ strategyState: future })).status, 'REFUSED');

  const missingFailureEvidence = candidate('reflective-pareto', { evidenceIds: [] });
  assert.equal(
    plugin.verifyCandidate(missingFailureEvidence, valid.contract).status,
    'REFUSED'
  );
});

test('bounded skill planning enforces separate reflections and byte limits', () => {
  const registry = createCandidateGeneratorRegistry({
    [VNEXT_CANDIDATE_GENERATOR_FLAGS['bounded-skill']]: true
  });
  const plugin = getCandidateGenerator(registry, 'bounded-skill').plugin;
  const state = strategyState('bounded-skill');
  const built = plugin.createContract(contractInput({ strategyState: state }));
  assert.equal(built.status, 'OK');
  assert.equal(built.contract.strategyPlan.policy.maximumChangedItems, 1);

  const oversized = candidate('bounded-skill', {
    operations: [{
      op: 'replace', target: 'negative-selection-rule', beforeSha256: sha('a'),
      value: 'x'.repeat(300)
    }]
  });
  assert.equal(plugin.verifyCandidate(oversized, built.contract).status, 'REFUSED');

  const noFailures = structuredClone(state);
  noFailures.failureReflections = [];
  assert.equal(
    plugin.createContract(contractInput({ strategyState: noFailures })).status,
    'REFUSED'
  );
});

test('bank recombination selects compatible distinct donors and binds both lineages', () => {
  const registry = createCandidateGeneratorRegistry({
    [VNEXT_CANDIDATE_GENERATOR_FLAGS['bank-recombination']]: true
  });
  const plugin = getCandidateGenerator(registry, 'bank-recombination').plugin;
  const state = strategyState('bank-recombination');
  const built = plugin.createContract(contractInput({ strategyState: state }));
  assert.equal(built.status, 'OK');
  assert.deepEqual(
    built.contract.strategyPlan.context.donors.map(({ mechanismId }) => mechanismId),
    ['donor-alpha', 'donor-beta']
  );

  const omittedDonor = candidate('bank-recombination', {
    operations: [{
      op: 'recombine', target: 'negative-selection-rule', beforeSha256: sha('a'),
      value: 'Use donor-alpha only.'
    }]
  });
  assert.equal(plugin.verifyCandidate(omittedDonor, built.contract).status, 'REFUSED');

  const incompatible = structuredClone(state);
  incompatible.mechanisms[0].incompatibleWith = ['donor-beta'];
  assert.equal(
    plugin.createContract(contractInput({ strategyState: incompatible })).status,
    'REFUSED'
  );
});

test('code-level strategy is source-target and disposable-worktree bound', () => {
  const registry = createCandidateGeneratorRegistry({
    [VNEXT_CANDIDATE_GENERATOR_FLAGS['code-level-experimental']]: true
  });
  const plugin = getCandidateGenerator(registry, 'code-level-experimental').plugin;
  const built = plugin.createContract(contractInput({
    strategyState: strategyState('code-level-experimental')
  }));
  assert.equal(built.status, 'OK');
  assert.equal(built.contract.strategyPlan.policy.disposableWorktree, true);
  assert.deepEqual(built.contract.strategyPlan.context.sourceTargets, [{
    target: 'src/retrieval.mjs', sourceSha256: sha('b')
  }]);

  const nonCodeEdit = candidate('code-level-experimental', {
    operations: [{
      op: 'replace', target: 'negative-selection-rule', beforeSha256: sha('a'),
      value: 'not a source path'
    }]
  });
  assert.equal(plugin.verifyCandidate(nonCodeEdit, built.contract).status, 'REFUSED');
});

test('strategy replay rejects a hash-resealed malformed plan', () => {
  const registry = createCandidateGeneratorRegistry({
    [VNEXT_CANDIDATE_GENERATOR_FLAGS['reflective-pareto']]: true
  });
  const plugin = getCandidateGenerator(registry, 'reflective-pareto').plugin;
  const built = plugin.createContract(contractInput({
    strategyState: strategyState('reflective-pareto')
  }));
  const resealed = structuredClone(built.contract.strategyPlan);
  resealed.context.failureTrajectoryIds = ['trajectory-success'];
  const core = structuredClone(resealed);
  delete core.planSha256;
  resealed.planSha256 = sha256(canonicalVNextJson(core));
  assert.equal(validateCandidateStrategyPlan(resealed).status, 'REFUSED');
});

test('verification binds exact parent hashes, evidence, component, and operation count', () => {
  const registry = createCandidateGeneratorRegistry();
  const plugin = getCandidateGenerator(registry, 'native').plugin;
  const built = plugin.createContract(contractInput());
  assert.equal(built.status, 'OK');

  for (const changed of [
    candidate('native', {
      operations: [{
        op: 'replace',
        target: 'negative-selection-rule',
        beforeSha256: sha('x'),
        value: 'drifted parent'
      }]
    }),
    candidate('native', { evidenceIds: ['unbound-evidence'] }),
    candidate('native', { component: 'evaluator' }),
    candidate('native', { taskAgnostic: false }),
    candidate('native', {
      operations: Array.from({ length: 4 }, (_, index) => ({
        op: 'add',
        target: `new-rule-${index}`,
        beforeSha256: null,
        value: 'bounded text'
      }))
    })
  ]) {
    assert.equal(plugin.verifyCandidate(changed, built.contract).status, 'REFUSED');
  }
});

test('a parent item outside the exact behavior locator set remains protected', () => {
  const registry = createCandidateGeneratorRegistry();
  const plugin = getCandidateGenerator(registry, 'native').plugin;
  const built = plugin.createContract(contractInput({
    parentItemHashes: [{
      target: 'negative-selection-rule', component: 'retrieval', sha256: sha('a')
    }, {
      target: 'unmapped-rule', component: 'retrieval', sha256: sha('c')
    }]
  }));
  assert.equal(built.status, 'OK');
  const escaped = candidate('native', {
    operations: [{
      op: 'replace', target: 'unmapped-rule', beforeSha256: sha('c'),
      value: 'attempt an unmapped edit'
    }]
  });
  assert.equal(plugin.verifyCandidate(escaped, built.contract).status, 'REFUSED');
});

test('protected surfaces are derived from operations rather than trusted declarations', () => {
  const registry = createCandidateGeneratorRegistry();
  const plugin = getCandidateGenerator(registry, 'native').plugin;
  const built = plugin.createContract(contractInput());
  const disguised = candidate('native', {
    operations: [{
      op: 'add',
      target: 'evaluator/prompts/public-rubric',
      beforeSha256: null,
      value: 'change the trust root'
    }],
    protectedSurfaceTouches: []
  });
  assert.equal(plugin.verifyCandidate(disguised, built.contract).status, 'REFUSED');

  for (const target of [
    'src//isolated-evaluator.mjs',
    'src/./isolated-evaluator.mjs',
    'src/%2e%2e/src/isolated-evaluator.mjs',
    'SRC\\isolated-evaluator.mjs',
    'https://example.com/edit',
    '/absolute/path'
  ]) {
    const bypass = candidate('native', {
      operations: [{ op: 'add', target, beforeSha256: null, value: 'unsafe' }]
    });
    assert.equal(plugin.verifyCandidate(bypass, built.contract).status, 'REFUSED');
  }

  const omittedByCaller = plugin.createContract(contractInput({
    protectedSurfaces: ['unrelated-surface']
  }));
  assert.equal(omittedByCaller.status, 'OK');
  const mandatory = candidate('native', {
    operations: [{
      op: 'add',
      target: 'src/isolated-evaluator.mjs',
      beforeSha256: null,
      value: 'attempted trust-root edit'
    }]
  });
  assert.equal(
    plugin.verifyCandidate(mandatory, omittedByCaller.contract).status,
    'REFUSED'
  );
});

test('candidate contracts and verification receipts are tamper evident', () => {
  const registry = createCandidateGeneratorRegistry();
  const plugin = getCandidateGenerator(registry, 'native').plugin;
  const built = plugin.createContract(contractInput());
  const tampered = structuredClone(built.contract);
  tampered.maximumOperations = 99;
  assert.equal(validateCandidateContract(tampered).code, 'VNEXT_CANDIDATE_CONTRACT_TAMPERED');

  const verified = plugin.verifyCandidate(candidate('native'), built.contract);
  assert.equal(verified.status, 'OK');
  const receipt = structuredClone(verified.verification);
  receipt.parentArtifactSha256 = sha('1');
  assert.notEqual(receipt.parentArtifactSha256, verified.verification.parentArtifactSha256);
  assert.equal(
    validateCandidateVerification(receipt, {
      candidate: verified.candidate,
      contract: built.contract
    }).code,
    'VNEXT_CANDIDATE_VERIFICATION_TAMPERED'
  );
  assert.equal(
    validateCandidateVerification(verified.verification, {
      candidate: verified.candidate,
      contract: built.contract
    }).status,
    'OK'
  );
  assert.match(buildCandidateGeneratorPrompt(built.contract), /no execution, scoring, admission/i);
  const staged = buildCandidateStageArtifact({
    candidate: verified.candidate,
    verification: verified.verification,
    contract: built.contract,
    createdAt: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(staged.status, 'OK');
  assert.equal(staged.artifact.payload.activationAuthority, false);
});
