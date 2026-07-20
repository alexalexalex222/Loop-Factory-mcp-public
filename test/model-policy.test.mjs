// Model-policy redesign: schema, banlist modes, extraAllow/extraDeny, judge
// fallback, and persistence across resume-by-runId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRoute, rejectedRoutes, isBuilderGatingRoute, rejectedBuilderRoutes,
  defaultModelPolicy, normalizeModelPolicy, modelPolicyPreset, parseModelChoiceText, ensureModelPolicy
} from '../src/models.mjs';
import { freshEngine, SPECIFIC_TASK, initThroughBaselineBar, BASELINE_BODY, recordMeasurement } from './helpers.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';
import {
  DEFAULT_POLICY, ROUTES, POLICY_OFF, POLICY_STRICT, GPT56_POLICY, withPolicy
} from './fixtures/model-policy.mjs';

test('defaultModelPolicy schema matches the v1 contract', () => {
  const p = defaultModelPolicy();
  assert.equal(p.version, 1);
  assert.equal(p.source, 'defaults');
  assert.equal(p.primary, ROUTES.primary);
  assert.deepEqual(p.testRoutes, ROUTES.frontier);
  assert.deepEqual(p.builderRoutes, ROUTES.builders);
  assert.equal(p.judgeRoute, ROUTES.judge);
  assert.equal(p.banlist.mode, 'default');
  assert.deepEqual(p.banlist.extraDeny, []);
  assert.deepEqual(p.banlist.extraAllow, []);
  assert.equal(p.allowUnknownFrontier, true);
});

test('normalizeModelPolicy fills missing fields from defaults', () => {
  const p = normalizeModelPolicy({ primary: 'gpt-5.5', banlist: { mode: 'off' } }, { source: 'operator-init' });
  assert.equal(p.primary, 'gpt-5.5');
  assert.equal(p.banlist.mode, 'off');
  assert.equal(p.source, 'operator-init');
  assert.ok(p.builderRoutes.length >= 1);
  assert.equal(p.version, 1);
});

test('gpt-5.6-sol preset selects GPT-5.6 Sol for primary/test work without widening builder or judge trust', () => {
  const p = modelPolicyPreset('gpt-5.6-sol');
  assert.deepEqual(p, GPT56_POLICY);
  assert.equal(p.source, 'preset:gpt-5.6-sol');
  assert.equal(p.primary, 'gpt-5.6-sol');
  assert.equal(p.testRoutes[0], 'gpt-5.6-sol');
  assert.ok(p.testRoutes.includes('gpt-5.6-sol'));
  assert.deepEqual(p.builderRoutes, ROUTES.builders);
  assert.equal(p.judgeRoute, ROUTES.judge);
  assert.equal(classifyRoute('gpt-5.6-sol', p).ok, true);
  assert.equal(isBuilderGatingRoute('gpt-5.6-sol', p), false);
  assert.equal(modelPolicyPreset('gpt-5.6').primary, 'gpt-5.6-sol', 'family alias canonicalizes to Sol');
  assert.equal(modelPolicyPreset('unknown'), null);
});

test('banlist mode "default" rejects haiku; mode "off" accepts it', () => {
  const def = classifyRoute(ROUTES.banned, DEFAULT_POLICY);
  assert.equal(def.ok, false);
  assert.match(def.reason, /haiku|non-frontier/i);
  const off = classifyRoute(ROUTES.banned, POLICY_OFF);
  assert.equal(off.ok, true);
});

test('banlist mode "strict" rejects frontierConfidence:unknown', () => {
  const unknown = 'some-brand-new-sota-model-99';
  assert.equal(classifyRoute(unknown, DEFAULT_POLICY).ok, true, 'default allows unknown frontier');
  const strict = classifyRoute(unknown, POLICY_STRICT);
  assert.equal(strict.ok, false);
  assert.match(strict.reason, /strict|unknown/i);
});

test('extraAllow punches a hole; extraDeny always applies', () => {
  const allowHaiku = normalizeModelPolicy({
    banlist: { mode: 'default', extraAllow: ['claude-haiku-4-5'], extraDeny: [] }
  });
  assert.equal(classifyRoute('claude-haiku-4-5', allowHaiku).ok, true);

  const denyOpus = normalizeModelPolicy({
    banlist: { mode: 'off', extraAllow: [], extraDeny: ['claude-opus'] }
  });
  assert.equal(classifyRoute(ROUTES.primary, denyOpus).ok, false, 'extraDeny applies even under mode off');
});

test('empty route is always rejected (all modes)', () => {
  for (const pol of [DEFAULT_POLICY, POLICY_OFF, POLICY_STRICT]) {
    assert.equal(classifyRoute('', pol).ok, false);
    assert.equal(classifyRoute('   ', pol).ok, false);
  }
});

test('isBuilderGatingRoute respects policy; gpt-5.5 is not a default builder', () => {
  assert.equal(isBuilderGatingRoute(ROUTES.primary, DEFAULT_POLICY), true);
  assert.equal(isBuilderGatingRoute(ROUTES.builders[1], DEFAULT_POLICY), true);
  assert.equal(isBuilderGatingRoute(ROUTES.nonBuilder, DEFAULT_POLICY), false);
  const bad = rejectedBuilderRoutes([ROUTES.nonBuilder], DEFAULT_POLICY);
  assert.equal(bad.length, 1);
});

test('judge fallback uses policy.primary, never a hard-coded Opus constant alone', () => {
  const custom = normalizeModelPolicy({
    primary: 'glm-5.2',
    builderRoutes: ['glm-5.2'],
    judgeRoute: 'glm-5.2',
    source: 'operator-init'
  });
  assert.equal(custom.judgeRoute, 'glm-5.2');
  assert.equal(isBuilderGatingRoute(custom.judgeRoute, custom), true);
  // gpt judge still refused under this policy
  assert.equal(isBuilderGatingRoute('gpt-5.5', custom), false);
});

test('parseModelChoiceText: defaults / any model / primary name', () => {
  assert.equal(parseModelChoiceText('defaults').policy.banlist.mode, 'default');
  assert.equal(parseModelChoiceText('').policy.source, 'defaults');
  assert.equal(parseModelChoiceText('any model').policy.banlist.mode, 'off');
  const p = parseModelChoiceText('primary: gpt-5.5');
  assert.equal(p.policy.primary, 'gpt-5.5');
  assert.equal(p.source, 'operator-init');
  const preset = parseModelChoiceText('use the gpt-5.6 sol preset');
  assert.equal(preset.source, 'preset:gpt-5.6-sol');
  assert.equal(preset.policy.primary, 'gpt-5.6-sol');
});

test('policy persists across resume-by-runId', () => {
  const { engine, store } = freshEngine();
  withPolicy(engine, 'persist-1', POLICY_OFF);
  const first = store.load('persist-1');
  assert.equal(first.config.modelPolicy.banlist.mode, 'off');

  // Resume: same runId, already initialized — policy must not be clobbered.
  const resume = engine.initialize_loop_run({ runId: 'persist-1', task: SPECIFIC_TASK });
  assert.match(resume.message, /Already initialized/i);
  assert.equal(resume.modelPolicy.banlist.mode, 'off');
  assert.equal(store.load('persist-1').config.modelPolicy.banlist.mode, 'off');
});

test('explicit modelPolicy survives model-looking answer text without route widening', () => {
  const { engine, store } = freshEngine();
  const exactPolicy = normalizeModelPolicy({
    source: 'operator-init',
    primary: 'gpt-5.6-sol',
    testRoutes: ['gpt-5.6-sol'],
    builderRoutes: ['gpt-5.6-sol'],
    judgeRoute: 'gpt-5.6-sol',
    banlist: { mode: 'strict', extraDeny: [], extraAllow: [] },
    allowUnknownFrontier: false
  }, { source: 'operator-init' });
  const init = engine.initialize_loop_run({
    runId: 'mp-explicit-policy-precedence',
    task: SPECIFIC_TASK,
    answers: [
      'prove post-fix zero-inference idle',
      'mine once, then idle',
      'sealed empty corpus only',
      'preserve operator control',
      'gpt-5.6-sol only',
      'operator stop-file'
    ],
    answerSource: 'config',
    model: 'gpt-5.6-sol',
    modelPolicy: exactPolicy
  });

  assert.equal(init.status, 'OK');
  assert.deepEqual(init.modelPolicy, exactPolicy);
  assert.deepEqual(store.load('mp-explicit-policy-precedence').config.modelPolicy, exactPolicy);
});

test('ensureModelPolicy backfills pre-redesign state without modelPolicy', () => {
  const legacy = {
    config: {
      model: { primary: 'claude-opus-4-8', declared: false, autoSelected: true }
      // no modelPolicy
    }
  };
  const pol = ensureModelPolicy(legacy);
  assert.equal(pol.version, 1);
  assert.equal(pol.primary, 'claude-opus-4-8');
  assert.equal(legacy.config.modelPolicy.banlist.mode, 'default');
});

test('engine init with modelPolicy:{banlist off} accepts haiku at register_hypotheses', () => {
  const { engine } = freshEngine();
  withPolicy(engine, 'mp-off', POLICY_OFF);
  engine.artifact_record({ runId: 'mp-off', role: 'baseline', name: 'b.md', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({
    runId: 'mp-off',
    benchmarks: [{
      name: 't',
      taskValueDimensions: ['q'],
      resourceDimensions: ['c'],
      cases: [{ id: 'c1', input: 'i', expect: 'e' }],
      oracle: DEFAULT_QUALITY_ORACLE
    }]
  });
  engine.benchmark_select({ runId: 'mp-off', benchmarkId: prop.benchmarkIds[0] });
  engine.benchmark_run({
    runId: 'mp-off', arm: 'baseline',
    measurementRef: recordMeasurement(engine, 'mp-off', 'bar', 1000, 0.7)
  });
  const r = engine.register_hypotheses({
    runId: 'mp-off',
    hypotheses: [
      { title: 'a', route: { model: ROUTES.banned } },
      { title: 'b', route: { model: ROUTES.primary } },
      { title: 'c', route: { model: ROUTES.builders[1] } }
    ]
  });
  assert.equal(r.status, 'OK', r.message);
});

test('engine init accepts modelPreset:gpt-5.6-sol and persists its source across resume', () => {
  const { engine, store } = freshEngine();
  const init = engine.initialize_loop_run({
    runId: 'mp-gpt56',
    task: SPECIFIC_TASK,
    modelPreset: 'gpt-5.6-sol'
  });
  assert.equal(init.status, 'OK');
  assert.equal(init.modelPolicy.source, 'preset:gpt-5.6-sol');
  assert.equal(init.modelPolicy.primary, 'gpt-5.6-sol');
  assert.ok(init.modelPolicy.testRoutes.includes('gpt-5.6-sol'));
  assert.deepEqual(init.modelPolicy.builderRoutes, ROUTES.builders);
  assert.equal(store.load('mp-gpt56').config.modelPolicy.source, 'preset:gpt-5.6-sol');
  const resume = engine.initialize_loop_run({ runId: 'mp-gpt56' });
  assert.equal(resume.modelPolicy.source, 'preset:gpt-5.6-sol');
});

test('engine init refuses an unknown model preset instead of silently falling back', () => {
  const { engine, store } = freshEngine();
  const init = engine.initialize_loop_run({
    runId: 'mp-unknown-preset',
    task: SPECIFIC_TASK,
    modelPreset: 'future-model'
  });
  assert.equal(init.status, 'BLOCKED');
  assert.equal(init.code, 'BAD_INPUT');
  assert.match(init.message, /No fallback was applied/);
  assert.equal(store.exists('mp-unknown-preset'), false);
});

test('rejectedRoutes under default still bans the historical set', () => {
  const bad = rejectedRoutes(['claude-haiku-4-5', 'gpt-5.5-mini', 'gpt-4o'], DEFAULT_POLICY);
  assert.equal(bad.length, 3);
});

test('banned primary at init: needsConfirmation holds run; confirm resolves once', () => {
  const { engine, store } = freshEngine();
  const hold = engine.initialize_loop_run({
    runId: 'mp-conf',
    task: SPECIFIC_TASK,
    model: ROUTES.banned
  });
  assert.equal(hold.needsConfirmation, true);
  assert.equal(hold.runStatus, 'AWAITING_ANSWERS');
  assert.equal(hold.confirmation.requested, ROUTES.banned);
  assert.ok(hold.confirmation.options.useAnyway);
  assert.equal(store.load('mp-conf').status, 'AWAITING_ANSWERS');

  const done = engine.initialize_loop_run({ runId: 'mp-conf', answers: ['use it anyway'] });
  assert.equal(done.needsConfirmation, false);
  assert.equal(done.runStatus, 'INITIALIZED');
  assert.equal(store.load('mp-conf').config.modelPolicy.banlist.mode, 'off');
  assert.equal(store.load('mp-conf').config.model.primary, ROUTES.banned);
  assert.equal(store.load('mp-conf').pendingModelConfirmation, null);

  // Never re-asks after resolve.
  const again = engine.initialize_loop_run({ runId: 'mp-conf' });
  assert.match(again.message, /Already initialized/i);
  assert.equal(again.needsConfirmation, false);
});
