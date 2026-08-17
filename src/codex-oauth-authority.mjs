import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { buildProcessLaunch, executeProcessSync } from './process-launch.mjs';
import { sha256 } from './util.mjs';

export const CODEX_OAUTH_AUTHORITY_SCHEMA = 'codex-oauth-model-authority-v1';
const CODEX_AUTHORITY_BASENAMES = new Set([
  'codex', 'codex.real', 'codex.exe', 'codex.cmd', 'codex.bat'
]);

function validCodexBasename(value) {
  return CODEX_AUTHORITY_BASENAMES.has(String(value || '').toLowerCase());
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function authorityPayload(record) {
  const payload = { ...record };
  delete payload.authoritySha256;
  return payload;
}

function safeModelEntry(entry) {
  return {
    slug: entry.slug,
    displayName: entry.display_name || null,
    visibility: entry.visibility || null,
    supportedInApi: entry.supported_in_api === true,
    supportedReasoningLevels: (Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
      : []).map((item) => ({
      effort: String(item?.effort || ''),
      description: String(item?.description || '')
    })),
    defaultReasoningLevel: entry.default_reasoning_level || null,
    serviceTiers: (Array.isArray(entry.service_tiers) ? entry.service_tiers : [])
      .map((item) => ({
        id: String(item?.id || ''),
        name: String(item?.name || '')
      }))
  };
}

export function createCodexOAuthAuthorityRecord({
  binaryPath,
  binaryBytes,
  versionOutput,
  loginStatusOutput,
  catalogOutput,
  requestedModel,
  reasoningEffort
} = {}) {
  const path = String(binaryPath || '');
  const model = String(requestedModel || '');
  const effort = String(reasoningEffort || '');
  const version = String(versionOutput || '').trim();
  const login = String(loginStatusOutput || '').trim();
  const catalogText = String(catalogOutput || '');
  if (!isAbsolute(path) || !validCodexBasename(basename(path))) {
    return refused('CODEX_BINARY_INVALID', 'Codex authority requires an absolute allowlisted Codex executable path.');
  }
  if (!Buffer.isBuffer(binaryBytes) || binaryBytes.length === 0) {
    return refused('CODEX_BINARY_UNREADABLE', 'Codex authority requires readable executable bytes.');
  }
  if (!/^codex-cli\s+\S+$/i.test(version)) {
    return refused('CODEX_VERSION_UNPROVEN', 'Codex CLI version output is missing or malformed.');
  }
  if (!/^logged in using chatgpt$/i.test(login)) {
    return refused('CODEX_OAUTH_UNPROVEN', 'Codex is not authenticated using ChatGPT OAuth.');
  }
  let catalog;
  try {
    catalog = JSON.parse(catalogText);
  } catch {
    return refused('CODEX_CATALOG_INVALID', 'Codex model catalog is not valid JSON.');
  }
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const matches = models.filter((entry) => String(entry?.slug || '') === model);
  if (matches.length !== 1) {
    return refused('CODEX_MODEL_UNAVAILABLE', `Authenticated Codex catalog does not contain exactly one ${model} entry.`);
  }
  const modelEntry = safeModelEntry(matches[0]);
  if (!modelEntry.supportedReasoningLevels.some((item) => item.effort === effort)) {
    return refused('CODEX_REASONING_UNAVAILABLE', `Authenticated ${model} catalog entry does not support ${effort} reasoning.`);
  }
  const payload = {
    schemaVersion: CODEX_OAUTH_AUTHORITY_SCHEMA,
    authMode: 'chatgpt-oauth',
    requestedModel: model,
    reasoningEffort: effort,
    binary: {
      path,
      basename: basename(path),
      sha256: sha256(binaryBytes),
      bytes: binaryBytes.length,
      version
    },
    catalog: {
      sha256: sha256(Buffer.from(catalogText)),
      modelEntrySha256: sha256(stableJson(modelEntry)),
      model: modelEntry
    },
    selectionAuthority: 'oauth-catalog+explicit-model-flag',
    backendIdentitySurface: 'codex-exec-jsonl-optional'
  };
  return {
    status: 'OK',
    record: {
      ...payload,
      authoritySha256: sha256(stableJson(payload))
    }
  };
}

export function validateCodexOAuthAuthorityRecord(record) {
  if (!record || typeof record !== 'object') {
    return refused('CODEX_AUTHORITY_MISSING', 'Codex OAuth authority record is missing.');
  }
  if (record.schemaVersion !== CODEX_OAUTH_AUTHORITY_SCHEMA
      || record.authMode !== 'chatgpt-oauth'
      || record.selectionAuthority !== 'oauth-catalog+explicit-model-flag'
      || record.backendIdentitySurface !== 'codex-exec-jsonl-optional'
      || !isAbsolute(String(record.binary?.path || ''))
      || !validCodexBasename(record.binary?.basename)
      || basename(record.binary.path) !== record.binary.basename
      || !/^[a-f0-9]{64}$/.test(String(record.binary?.sha256 || ''))
      || !Number.isInteger(record.binary?.bytes)
      || record.binary.bytes <= 0
      || !/^codex-cli\s+\S+$/i.test(String(record.binary?.version || ''))
      || !/^[a-f0-9]{64}$/.test(String(record.catalog?.sha256 || ''))
      || !/^[a-f0-9]{64}$/.test(String(record.catalog?.modelEntrySha256 || ''))
      || String(record.catalog?.model?.slug || '') !== String(record.requestedModel || '')
      || !Array.isArray(record.catalog?.model?.supportedReasoningLevels)
      || !record.catalog.model.supportedReasoningLevels
        .some((item) => item?.effort === record.reasoningEffort)
      || record.catalog.modelEntrySha256 !== sha256(stableJson(record.catalog.model))
      || record.authoritySha256 !== sha256(stableJson(authorityPayload(record)))) {
    return refused('CODEX_AUTHORITY_INVALID', 'Codex OAuth authority record failed validation.');
  }
  return { status: 'OK', record };
}

export function captureCodexOAuthAuthority({
  binaryPath,
  requestedModel,
  reasoningEffort,
  env = process.env,
  runner = null,
  platform = process.platform,
  readBytes = readFileSync,
  exists = existsSync,
  stat = statSync
} = {}) {
  const path = resolve(String(binaryPath || ''));
  try {
    if (!isAbsolute(String(binaryPath || ''))
        || !exists(path)
        || !stat(path).isFile()) {
      return refused('CODEX_BINARY_UNREADABLE', 'Configured Codex authority binary is not an existing absolute file.');
    }
    const childEnv = { ...env };
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.OPENAI_BASE_URL;
    delete childEnv.CODEX_ACCESS_TOKEN;
    const run = (args) => {
      const launch = buildProcessLaunch({
        binPath: path,
        args,
        platform,
        env: childEnv
      });
      const result = runner
        ? runner(launch.file, launch.args, {
          env: childEnv,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
          windowsVerbatimArguments: launch.windowsVerbatimArguments
        })
        : executeProcessSync(launch, {
          env: childEnv,
          timeoutMs: 30_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8'
        });
      if (typeof result === 'string' || Buffer.isBuffer(result)) {
        return { stdout: String(result), stderr: '' };
      }
      if (result?.error || result?.status !== 0) {
        throw new Error(
          `Codex metadata command failed: ${args.join(' ')} (exit ${result?.status ?? 'unknown'})`
        );
      }
      return {
        stdout: String(result?.stdout || ''),
        stderr: String(result?.stderr || '')
      };
    };
    const version = run(['--version']);
    const login = run(['login', 'status']);
    const catalog = run(['debug', 'models']);
    return createCodexOAuthAuthorityRecord({
      binaryPath: path,
      binaryBytes: readBytes(path),
      versionOutput: version.stdout || version.stderr,
      loginStatusOutput: login.stdout || login.stderr,
      catalogOutput: catalog.stdout || catalog.stderr,
      requestedModel,
      reasoningEffort
    });
  } catch (error) {
    return refused(
      'CODEX_AUTHORITY_CAPTURE_FAILED',
      `Codex OAuth authority capture failed: ${String(error?.message || error)}`
    );
  }
}
