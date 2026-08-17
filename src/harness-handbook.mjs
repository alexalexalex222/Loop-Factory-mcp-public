import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const HARNESS_HANDBOOK_SCHEMA = 'vnext-harness-handbook-v1';
export const DEFAULT_HANDBOOK_FILE_SIZE_CAP = 1024 * 1024;

const MAX_FILE_SIZE_CAP = 16 * 1024 * 1024;
const BEHAVIOR_KEYS = new Set([
  'dependencies',
  'description',
  'generatedSummary',
  'id',
  'locators',
  'permissions',
  'tests'
]);
const LOCATOR_KEYS = new Set(['endLine', 'path', 'startLine', 'symbol']);

class HandbookRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return plainObject(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value, label, maximum = 2000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new HandbookRefusal(
      'HANDBOOK_INPUT_INVALID',
      `${label} must be non-empty text no longer than ${maximum} characters.`
    );
  }
  return value.trim();
}

function boundedStringSet(values, label, maximumItems = 128) {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new HandbookRefusal('HANDBOOK_INPUT_INVALID', `${label} must be a bounded array.`);
  }
  const normalized = values.map((value, index) => (
    boundedText(value, `${label}[${index}]`, 240)
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new HandbookRefusal('HANDBOOK_INPUT_INVALID', `${label} must not contain duplicates.`);
  }
  return normalized.sort();
}

function normalizeSizeCap(value) {
  const cap = value ?? DEFAULT_HANDBOOK_FILE_SIZE_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_FILE_SIZE_CAP) {
    throw new HandbookRefusal(
      'HANDBOOK_FILE_SIZE_CAP_INVALID',
      `maxFileBytes must be an integer between 1 and ${MAX_FILE_SIZE_CAP}.`
    );
  }
  return cap;
}

function validateRoot(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim().length === 0) {
    throw new HandbookRefusal('HANDBOOK_ROOT_INVALID', 'repositoryRoot is required.');
  }
  const root = resolve(repositoryRoot);
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    throw new HandbookRefusal('HANDBOOK_ROOT_INVALID', 'repositoryRoot must exist.');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new HandbookRefusal(
      'HANDBOOK_ROOT_UNSAFE',
      'repositoryRoot must be a real directory, not a symlink.'
    );
  }
  return { root, realRoot: realpathSync(root) };
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 500
      || value.includes('\0')
      || isAbsolute(value)) {
    throw new HandbookRefusal('HANDBOOK_PATH_INVALID', 'Source paths must be bounded relative paths.');
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new HandbookRefusal(
      'HANDBOOK_PATH_TRAVERSAL',
      'Source paths cannot contain empty, dot, or traversal segments.'
    );
  }
  return parts.join('/');
}

function assertNoSymlinkSegments(root, relativePath) {
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = join(cursor, part);
    let stats;
    try {
      stats = lstatSync(cursor);
    } catch {
      throw new HandbookRefusal('HANDBOOK_SOURCE_MISSING', `${relativePath} does not exist.`);
    }
    if (stats.isSymbolicLink()) {
      throw new HandbookRefusal(
        'HANDBOOK_SYMLINK_REJECTED',
        `${relativePath} contains a symlink.`
      );
    }
  }
}

function readBoundedSource(rootInfo, inputPath, maxFileBytes) {
  const path = normalizeRelativePath(inputPath);
  const absolute = resolve(rootInfo.root, ...path.split('/'));
  const rel = relative(rootInfo.realRoot, realpathParentSafe(rootInfo.root, path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HandbookRefusal('HANDBOOK_PATH_TRAVERSAL', `${path} resolves outside repositoryRoot.`);
  }
  assertNoSymlinkSegments(rootInfo.root, path);

  let descriptor;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw new HandbookRefusal('HANDBOOK_SOURCE_NOT_FILE', `${path} must be a regular file.`);
    }
    const openedRealPath = realpathSync(absolute);
    const openedRelative = relative(rootInfo.realRoot, openedRealPath);
    const openedPathStats = statSync(openedRealPath);
    if (openedRelative === '..'
        || openedRelative.startsWith(`..${sep}`)
        || isAbsolute(openedRelative)
        || openedPathStats.dev !== before.dev
        || openedPathStats.ino !== before.ino) {
      throw new HandbookRefusal(
        'HANDBOOK_SOURCE_RACE_REJECTED',
        `${path} did not remain bound to a repository file while opened.`
      );
    }
    if (before.size > maxFileBytes) {
      throw new HandbookRefusal(
        'HANDBOOK_FILE_TOO_LARGE',
        `${path} exceeds the ${maxFileBytes}-byte source cap.`
      );
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || bytes.length !== after.size) {
      throw new HandbookRefusal('HANDBOOK_SOURCE_CHANGED_DURING_READ', `${path} changed while read.`);
    }
    return { bytes, path, sourceSha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof HandbookRefusal) throw error;
    throw new HandbookRefusal('HANDBOOK_SOURCE_READ_FAILED', `Could not safely read ${path}.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function realpathParentSafe(root, relativePath) {
  const parts = relativePath.split('/');
  const parent = parts.length === 1
    ? root
    : join(root, ...parts.slice(0, -1));
  try {
    return join(realpathSync(parent), parts.at(-1));
  } catch {
    throw new HandbookRefusal('HANDBOOK_SOURCE_MISSING', `${relativePath} does not exist.`);
  }
}

function lineSpan(bytes, startLine, endLine) {
  const starts = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) starts.push(index + 1);
  }
  if (!Number.isSafeInteger(startLine)
      || !Number.isSafeInteger(endLine)
      || startLine < 1
      || endLine < startLine
      || endLine > starts.length) {
    throw new HandbookRefusal(
      'HANDBOOK_LOCATOR_INVALID',
      `Line locator ${startLine}:${endLine} is outside the source.`
    );
  }
  const start = starts[startLine - 1];
  const end = endLine < starts.length ? starts[endLine] : bytes.length;
  return bytes.subarray(start, end);
}

function normalizeLocator(locator, label, readSource) {
  if (!hasOnlyKeys(locator, LOCATOR_KEYS)
      || Object.keys(locator).length !== LOCATOR_KEYS.size) {
    throw new HandbookRefusal(
      'HANDBOOK_LOCATOR_INVALID',
      `${label} must contain exactly path, symbol, startLine, and endLine.`
    );
  }
  const symbol = boundedText(locator.symbol, `${label}.symbol`, 240);
  const source = readSource(locator.path);
  const span = lineSpan(source.bytes, locator.startLine, locator.endLine);
  if (!span.toString('utf8').includes(symbol)) {
    throw new HandbookRefusal(
      'HANDBOOK_SYMBOL_STALE',
      `${symbol} is not present at ${source.path}:${locator.startLine}-${locator.endLine}.`
    );
  }
  return {
    path: source.path,
    symbol,
    symbolSha256: sha256(symbol),
    startLine: locator.startLine,
    endLine: locator.endLine,
    sourceSha256: source.sourceSha256,
    locatorSha256: sha256(span)
  };
}

function locatorOrder(left, right) {
  return `${left.path}:${String(left.startLine).padStart(12, '0')}:${left.symbol}`
    .localeCompare(`${right.path}:${String(right.startLine).padStart(12, '0')}:${right.symbol}`);
}

function normalizeBehavior(behavior, readSource) {
  if (!hasOnlyKeys(behavior, BEHAVIOR_KEYS)
      || !isSafeId(behavior.id)
      || !Array.isArray(behavior.locators)
      || behavior.locators.length === 0
      || behavior.locators.length > 128
      || !Array.isArray(behavior.tests)
      || behavior.tests.length > 128) {
    throw new HandbookRefusal('HANDBOOK_BEHAVIOR_INVALID', 'Each behavior requires a safe id and bounded locator/test arrays.');
  }
  const locators = behavior.locators
    .map((locator, index) => normalizeLocator(locator, `locators[${index}]`, readSource))
    .sort(locatorOrder);
  const tests = behavior.tests
    .map((locator, index) => normalizeLocator(locator, `tests[${index}]`, readSource))
    .sort(locatorOrder);
  return {
    id: behavior.id,
    description: boundedText(behavior.description, `${behavior.id}.description`),
    locators,
    tests,
    dependencies: boundedStringSet(behavior.dependencies, `${behavior.id}.dependencies`),
    permissions: boundedStringSet(behavior.permissions, `${behavior.id}.permissions`),
    summary: behavior.generatedSummary == null ? null : {
      text: boundedText(behavior.generatedSummary, `${behavior.id}.generatedSummary`, 4000),
      authority: 'descriptive-only',
      canAuthorizeEdits: false
    }
  };
}

function refusal(error) {
  if (error instanceof HandbookRefusal) {
    return { status: 'REFUSED', code: error.code, message: error.message };
  }
  throw error;
}

export function buildHarnessHandbook({
  repositoryRoot,
  behaviors,
  maxFileBytes = DEFAULT_HANDBOOK_FILE_SIZE_CAP
} = {}) {
  try {
    const rootInfo = validateRoot(repositoryRoot);
    const cap = normalizeSizeCap(maxFileBytes);
    if (!Array.isArray(behaviors) || behaviors.length === 0 || behaviors.length > 128) {
      throw new HandbookRefusal('HANDBOOK_INPUT_INVALID', 'behaviors must be a non-empty bounded array.');
    }
    const cache = new Map();
    const readSource = (path) => {
      const normalized = normalizeRelativePath(path);
      if (!cache.has(normalized)) {
        cache.set(normalized, readBoundedSource(rootInfo, normalized, cap));
      }
      return cache.get(normalized);
    };
    const normalizedBehaviors = behaviors.map((behavior) => normalizeBehavior(behavior, readSource));
    normalizedBehaviors.sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(normalizedBehaviors.map(({ id }) => id)).size !== normalizedBehaviors.length) {
      throw new HandbookRefusal('HANDBOOK_BEHAVIOR_INVALID', 'Behavior ids must be unique.');
    }
    const core = {
      schemaVersion: HARNESS_HANDBOOK_SCHEMA,
      repositoryRootSha256: sha256(rootInfo.realRoot),
      authority: 'descriptive-source-map-only',
      canAuthorizeEdits: false,
      behaviors: normalizedBehaviors
    };
    return {
      status: 'OK',
      behaviorMap: {
        ...core,
        behaviorMapSha256: sha256(canonicalVNextJson(core))
      }
    };
  } catch (error) {
    return refusal(error);
  }
}

function mapCore(behaviorMap) {
  const {
    behaviorMapSha256: ignored,
    ...core
  } = behaviorMap;
  return core;
}

function freshnessFinding(kind, locator, code, detail) {
  return {
    behaviorId: kind.behaviorId,
    kind: kind.kind,
    path: locator.path,
    symbol: locator.symbol,
    code,
    detail
  };
}

export function verifyHarnessHandbookFreshness({
  repositoryRoot,
  behaviorMap,
  maxFileBytes = DEFAULT_HANDBOOK_FILE_SIZE_CAP
} = {}) {
  try {
    const rootInfo = validateRoot(repositoryRoot);
    const cap = normalizeSizeCap(maxFileBytes);
    if (!plainObject(behaviorMap)
        || behaviorMap.schemaVersion !== HARNESS_HANDBOOK_SCHEMA
        || behaviorMap.repositoryRootSha256 !== sha256(rootInfo.realRoot)
        || behaviorMap.behaviorMapSha256 !== sha256(canonicalVNextJson(mapCore(behaviorMap)))) {
      throw new HandbookRefusal('HANDBOOK_MAP_TAMPERED', 'Behavior map integrity or repository binding failed.');
    }
    const cache = new Map();
    const findings = [];
    for (const behavior of behaviorMap.behaviors || []) {
      for (const [kind, locators] of [['source', behavior.locators], ['test', behavior.tests]]) {
        for (const locator of locators || []) {
          let source;
          try {
            if (!cache.has(locator.path)) {
              cache.set(locator.path, readBoundedSource(rootInfo, locator.path, cap));
            }
            source = cache.get(locator.path);
          } catch (error) {
            if (!(error instanceof HandbookRefusal)) throw error;
            findings.push(freshnessFinding(
              { behaviorId: behavior.id, kind },
              locator,
              error.code,
              error.message
            ));
            continue;
          }
          if (source.sourceSha256 !== locator.sourceSha256) {
            findings.push(freshnessFinding(
              { behaviorId: behavior.id, kind },
              locator,
              'HANDBOOK_SOURCE_TAMPERED',
              'The source byte hash changed.'
            ));
          }
          let span;
          try {
            span = lineSpan(source.bytes, locator.startLine, locator.endLine);
          } catch (error) {
            findings.push(freshnessFinding(
              { behaviorId: behavior.id, kind },
              locator,
              'HANDBOOK_LOCATOR_STALE',
              error.message
            ));
            continue;
          }
          if (sha256(span) !== locator.locatorSha256) {
            findings.push(freshnessFinding(
              { behaviorId: behavior.id, kind },
              locator,
              'HANDBOOK_LOCATOR_STALE',
              'The exact locator bytes changed.'
            ));
          }
          if (sha256(locator.symbol) !== locator.symbolSha256
              || !span.toString('utf8').includes(locator.symbol)) {
            findings.push(freshnessFinding(
              { behaviorId: behavior.id, kind },
              locator,
              'HANDBOOK_SYMBOL_STALE',
              'The declared symbol is no longer present at the locator.'
            ));
          }
        }
      }
    }
    findings.sort((left, right) => canonicalVNextJson(left).localeCompare(canonicalVNextJson(right)));
    return { status: 'OK', fresh: findings.length === 0, findings };
  } catch (error) {
    return refusal(error);
  }
}

export const buildBehaviorMap = buildHarnessHandbook;
export const verifyBehaviorMapFreshness = verifyHarnessHandbookFreshness;
