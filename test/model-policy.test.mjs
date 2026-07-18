// Model-policy redesign: schema, banlist modes, extraAllow/extraDeny, judge
// fallback, and persistence across resume-by-runId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRoute, rejectedRoutes, isBuilderGatingRoute, rejectedBuilderRoutes,
  defaultModelPolicy, normalizeModelPolicy, parseModelChoiceText, ensureModelPolicy
} from '../src/models.mjs';
import { freshEngine, SPECIFIC_TASK, initThroughBaselineBar, BASELINE_BODY, recordMeasurement } from './helpers.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';
import {
  DEFAULT_POLICY, ROUTES, POLICY_OFF, POLICY_STRICT, withPolicy
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
