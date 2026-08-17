import { sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_ABLATION_PROFILE_SCHEMA = 'vnext-ablation-profile-v1';

const GENERATOR_ARMS = Object.freeze({
  B5a: 'reflective-pareto',
  B5b: 'bounded-skill',
  B5c: 'bank-recombination'
});

const FIXED_PROFILES = Object.freeze({
  B0: {
    internalResearchEnabled: false,
    hypothesisFalsificationEnabled: false,
    modelRerankerEnabled: false,
    candidateStrategy: 'native'
  },
  B1: {
    internalResearchEnabled: false,
    hypothesisFalsificationEnabled: false,
    modelRerankerEnabled: false,
    candidateStrategy: 'native'
  },
  B2: {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: false,
    modelRerankerEnabled: false,
    candidateStrategy: 'native'
  },
  B3: {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: true,
    modelRerankerEnabled: false,
    candidateStrategy: 'native'
  },
  B4: {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: true,
    modelRerankerEnabled: true,
    candidateStrategy: 'native'
  },
  B5a: {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: true,
    modelRerankerEnabled: true,
    candidateStrategy: GENERATOR_ARMS.B5a
  },
  B5b: {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: true,
    modelRerankerEnabled: true,
    candidateStrategy: GENERATOR_ARMS.B5b
  },
  B5c: {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: true,
    modelRerankerEnabled: true,
    candidateStrategy: GENERATOR_ARMS.B5c
  },
  B7: {
    internalResearchEnabled: true,
    hypothesisFalsificationEnabled: true,
    modelRerankerEnabled: true,
    candidateStrategy: 'code-level-experimental'
  }
});

const PROFILE_KEYS = Object.freeze([
  'activationAuthority',
  'armId',
  'candidateStrategy',
  'evaluatorIsolationRequired',
  'hypothesisFalsificationEnabled',
  'internalResearchEnabled',
  'modelRerankerEnabled',
  'performanceClaimAuthority',
  'profileSha256',
  'schemaVersion',
  'selectedGeneratorArm'
]);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...keys].sort());
}

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function profileCore({ armId, selectedGeneratorArm = null } = {}) {
  let definition = FIXED_PROFILES[armId] ?? null;
  if (armId === 'B6') {
    const strategy = GENERATOR_ARMS[selectedGeneratorArm];
    if (!strategy) return null;
    definition = {
      internalResearchEnabled: true,
      hypothesisFalsificationEnabled: true,
      modelRerankerEnabled: true,
      candidateStrategy: strategy
    };
  } else if (selectedGeneratorArm != null) {
    return null;
  }
  if (!definition) return null;
  return {
    schemaVersion: VNEXT_ABLATION_PROFILE_SCHEMA,
    armId,
    internalResearchEnabled: definition.internalResearchEnabled,
    hypothesisFalsificationEnabled: definition.hypothesisFalsificationEnabled,
    modelRerankerEnabled: definition.modelRerankerEnabled,
    candidateStrategy: definition.candidateStrategy,
    selectedGeneratorArm: armId === 'B6' ? selectedGeneratorArm : null,
    evaluatorIsolationRequired: true,
    performanceClaimAuthority: 'none-until-matched-live-verification',
    activationAuthority: false
  };
}

export function createVNextAblationProfile(input = {}) {
  const core = profileCore(input);
  if (!core) {
    return refused(
      'VNEXT_ABLATION_PROFILE_INPUT_INVALID',
      'Ablation profiles must be one declared B0-B6 arm; B6 also requires the predeclared winning B5 arm.'
    );
  }
  const profile = {
    ...core,
    profileSha256: sha256(canonicalVNextJson(core))
  };
  return { status: 'OK', profile: Object.freeze(profile) };
}

export function validateVNextAblationProfile(profile) {
  if (!exactKeys(profile, PROFILE_KEYS)
      || profile.schemaVersion !== VNEXT_ABLATION_PROFILE_SCHEMA
      || typeof profile.profileSha256 !== 'string') {
    return refused('VNEXT_ABLATION_PROFILE_INVALID', 'Ablation profile shape is invalid.');
  }
  const expected = createVNextAblationProfile({
    armId: profile.armId,
    selectedGeneratorArm: profile.selectedGeneratorArm
  });
  return expected.status === 'OK'
      && canonicalVNextJson(expected.profile) === canonicalVNextJson(profile)
    ? { status: 'OK', profile }
    : refused('VNEXT_ABLATION_PROFILE_TAMPERED', 'Ablation profile does not match its declared arm.');
}

export function vnextAblationPreparationMaximumCalls(
  profile,
  { externalResearchEnabled = false } = {}
) {
  const calls = vnextAblationPreparationRoleCalls(profile, {
    externalResearchEnabled
  });
  return calls == null
    ? null
    : Object.values(calls).reduce((sum, value) => sum + value, 0);
}

export function vnextAblationPreparationRoleCalls(
  profile,
  { externalResearchEnabled = false } = {}
) {
  if (validateVNextAblationProfile(profile).status !== 'OK'
      || typeof externalResearchEnabled !== 'boolean') return null;
  return Object.freeze({
    'candidate-generator': 1,
    falsifier: profile.hypothesisFalsificationEnabled ? 2 : 0,
    hypothesizer: profile.hypothesisFalsificationEnabled ? 2 : 1,
    reranker: profile.modelRerankerEnabled ? 1 : 0,
    researcher: profile.internalResearchEnabled ? 1 : 0,
    'external-researcher': externalResearchEnabled ? 1 : 0
  });
}

export function validateVNextAblationPreparation(profile, preparation) {
  if (validateVNextAblationProfile(profile).status !== 'OK'
      || !plainObject(preparation)) {
    return refused('VNEXT_ABLATION_PREPARATION_INVALID', 'A valid profile and preparation are required.');
  }
  return preparation.internalResearchEnabled === profile.internalResearchEnabled
      && preparation.hypothesisFalsificationEnabled
        === profile.hypothesisFalsificationEnabled
      && preparation.enableModelReranker === profile.modelRerankerEnabled
      && preparation.candidateStrategy === profile.candidateStrategy
    ? { status: 'OK', profile, preparation }
    : refused(
      'VNEXT_ABLATION_PREPARATION_DRIFT',
      'Preparation stage switches or candidate strategy drifted from the frozen ablation arm.'
    );
}

export const VNEXT_ABLATION_ARMS = Object.freeze([
  'B0', 'B1', 'B2', 'B3', 'B4', 'B5a', 'B5b', 'B5c', 'B6', 'B7'
]);
