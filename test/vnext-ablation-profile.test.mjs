import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVNextAblationProfile,
  validateVNextAblationPreparation,
  validateVNextAblationProfile,
  vnextAblationPreparationMaximumCalls,
  vnextAblationPreparationRoleCalls
} from '../src/vnext-ablation-profile.mjs';

const EXPECTED = {
  B0: [false, false, false, 'native', 2],
  B1: [false, false, false, 'native', 2],
  B2: [true, false, false, 'native', 3],
  B3: [true, true, false, 'native', 6],
  B4: [true, true, true, 'native', 7],
  B5a: [true, true, true, 'reflective-pareto', 7],
  B5b: [true, true, true, 'bounded-skill', 7],
  B5c: [true, true, true, 'bank-recombination', 7],
  B7: [true, true, true, 'code-level-experimental', 7]
};

test('each fixed arm freezes one attributable stage combination', () => {
  for (const [armId, expected] of Object.entries(EXPECTED)) {
    const built = createVNextAblationProfile({ armId });
    assert.equal(built.status, 'OK');
    assert.deepEqual([
      built.profile.internalResearchEnabled,
      built.profile.hypothesisFalsificationEnabled,
      built.profile.modelRerankerEnabled,
      built.profile.candidateStrategy,
      vnextAblationPreparationMaximumCalls(built.profile)
    ], expected);
    assert.equal(validateVNextAblationProfile(built.profile).status, 'OK');
    assert.equal(built.profile.evaluatorIsolationRequired, true);
    assert.equal(built.profile.activationAuthority, false);
  }
});

test('B6 must name one measured B5 generator arm before it can be frozen', () => {
  assert.equal(createVNextAblationProfile({ armId: 'B6' }).status, 'REFUSED');
  for (const [selectedGeneratorArm, candidateStrategy] of [
    ['B5a', 'reflective-pareto'],
    ['B5b', 'bounded-skill'],
    ['B5c', 'bank-recombination']
  ]) {
    const built = createVNextAblationProfile({ armId: 'B6', selectedGeneratorArm });
    assert.equal(built.status, 'OK');
    assert.equal(built.profile.candidateStrategy, candidateStrategy);
  }
});

test('preparation call accounting changes only with enabled stages', () => {
  const calls = (armId) => vnextAblationPreparationRoleCalls(
    createVNextAblationProfile({ armId }).profile
  );
  assert.deepEqual(calls('B0'), {
    'candidate-generator': 1,
    falsifier: 0,
    hypothesizer: 1,
    reranker: 0,
    researcher: 0,
    'external-researcher': 0
  });
  assert.deepEqual(calls('B2'), {
    'candidate-generator': 1,
    falsifier: 0,
    hypothesizer: 1,
    reranker: 0,
    researcher: 1,
    'external-researcher': 0
  });
  assert.deepEqual(calls('B3'), {
    'candidate-generator': 1,
    falsifier: 2,
    hypothesizer: 2,
    reranker: 0,
    researcher: 1,
    'external-researcher': 0
  });
});

test('hash resealing cannot turn one declared arm into another stage combination', () => {
  const built = createVNextAblationProfile({ armId: 'B3' });
  const tampered = {
    ...built.profile,
    modelRerankerEnabled: true
  };
  assert.equal(validateVNextAblationProfile(tampered).status, 'REFUSED');
});

test('wave preparation must exactly match the frozen ablation profile', () => {
  const profile = createVNextAblationProfile({ armId: 'B5b' }).profile;
  const preparation = {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: true,
    enableModelReranker: true,
    candidateStrategy: 'bounded-skill'
  };
  assert.equal(validateVNextAblationPreparation(profile, preparation).status, 'OK');
  assert.equal(validateVNextAblationPreparation(profile, {
    ...preparation,
    candidateStrategy: 'native'
  }).status, 'REFUSED');
});
