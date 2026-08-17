import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCodexOAuthAuthority,
  createCodexOAuthAuthorityRecord,
  validateCodexOAuthAuthorityRecord
} from '../src/codex-oauth-authority.mjs';

const MODEL_ENTRY = {
  slug: 'gpt-5.6-sol',
  display_name: 'GPT-5.6 Sol',
  visibility: 'list',
  supported_in_api: true,
  supported_reasoning_levels: [
    { effort: 'high', description: 'Greater reasoning depth' },
    { effort: 'max', description: 'Maximum reasoning depth' }
  ],
  default_reasoning_level: 'high',
  service_tiers: [{ id: 'priority', name: 'Fast' }]
};

function fixtureRecord(overrides = {}) {
  return createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('codex-binary-fixture'),
    versionOutput: 'codex-cli 0.144.5\n',
    loginStatusOutput: 'Logged in using ChatGPT\n',
    catalogOutput: JSON.stringify({ models: [MODEL_ENTRY] }),
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    ...overrides
  });
}

test('OAuth authority binds executable, ChatGPT login, exact catalog model, and reasoning', () => {
  const built = fixtureRecord();
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.record.authMode, 'chatgpt-oauth');
  assert.equal(built.record.requestedModel, 'gpt-5.6-sol');
  assert.equal(built.record.reasoningEffort, 'high');
  assert.equal(built.record.catalog.model.slug, 'gpt-5.6-sol');
  assert.ok(built.record.catalog.model.supportedReasoningLevels
    .some((item) => item.effort === 'high'));
  assert.equal(validateCodexOAuthAuthorityRecord(built.record).status, 'OK');
});

test('OAuth authority refuses wrong auth, missing model, and unsupported reasoning', () => {
  assert.equal(fixtureRecord({
    loginStatusOutput: 'Logged in using API key\n'
  }).code, 'CODEX_OAUTH_UNPROVEN');
  assert.equal(fixtureRecord({
    catalogOutput: JSON.stringify({ models: [] })
  }).code, 'CODEX_MODEL_UNAVAILABLE');
  assert.equal(fixtureRecord({
    reasoningEffort: 'ultra'
  }).code, 'CODEX_REASONING_UNAVAILABLE');
});

test('OAuth authority hash detects record tampering', () => {
  const built = fixtureRecord();
  const tampered = structuredClone(built.record);
  tampered.catalog.model.visibility = 'hidden';
  assert.equal(validateCodexOAuthAuthorityRecord(tampered).code, 'CODEX_AUTHORITY_INVALID');
});

test('OAuth authority accepts the allowlisted Windows Codex launch forms', () => {
  for (const name of ['codex.exe', 'codex.cmd', 'codex.bat']) {
    const built = fixtureRecord({ binaryPath: `/opt/codex/${name}` });
    assert.equal(built.status, 'OK', `${name}: ${built.message || ''}`);
    assert.equal(validateCodexOAuthAuthorityRecord(built.record).status, 'OK');
  }
});

test('capture removes API credentials and invokes only read-only Codex metadata commands', () => {
  const calls = [];
  const runner = (binary, args, options) => {
    calls.push({ binary, args, env: options.env });
    if (args[0] === '--version') {
      return { status: 0, stdout: 'codex-cli 0.144.5\n', stderr: '' };
    }
    if (args[0] === 'login') {
      return { status: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
    }
    return {
      status: 0,
      stdout: JSON.stringify({ models: [MODEL_ENTRY] }),
      stderr: 'non-authoritative warning\n'
    };
  };
  const captured = captureCodexOAuthAuthority({
    binaryPath: '/opt/codex/codex.real',
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'must-not-pass',
      OPENAI_BASE_URL: 'must-not-pass',
      CODEX_ACCESS_TOKEN: 'must-not-pass'
    },
    runner,
    readBytes: () => Buffer.from('codex-binary-fixture'),
    exists: () => true,
    stat: () => ({ isFile: () => true })
  });
  assert.equal(captured.status, 'OK', captured.message);
  assert.deepEqual(calls.map((item) => item.args), [
    ['--version'],
    ['login', 'status'],
    ['debug', 'models']
  ]);
  assert.ok(calls.every((item) => (
    item.binary === '/opt/codex/codex.real'
    && item.env.OPENAI_API_KEY === undefined
    && item.env.OPENAI_BASE_URL === undefined
    && item.env.CODEX_ACCESS_TOKEN === undefined
  )));
});

test('capture adapts Windows command shims without shell execution', () => {
  const calls = [];
  const outputs = [
    'codex-cli 0.144.5\n',
    'Logged in using ChatGPT\n',
    JSON.stringify({ models: [MODEL_ENTRY] })
  ];
  const captured = captureCodexOAuthAuthority({
    binaryPath: '/opt/codex/codex.cmd',
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    runner: (binary, args, options) => {
      calls.push({ binary, args, options });
      return { status: 0, stdout: outputs.shift(), stderr: '' };
    },
    readBytes: () => Buffer.from('codex-command-shim'),
    exists: () => true,
    stat: () => ({ isFile: () => true })
  });
  assert.equal(captured.status, 'OK', captured.message);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ binary, args, options }) => (
    binary === 'C:\\Windows\\System32\\cmd.exe'
    && args.slice(0, 4).join(' ') === '/d /s /v:off /c'
    && options.shell === false
    && options.windowsVerbatimArguments === true
  )));
});
