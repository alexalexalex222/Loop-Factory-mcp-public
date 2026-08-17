import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from './util.mjs';

export const SOURCE_ARTIFACT_MANIFEST = 'SOURCE_AND_ARTIFACT_HASHES.sha256';

const ROOT_FILES = Object.freeze([
  '.gitattributes',
  '.github/workflows/portability.yml',
  '.gitignore',
  'ABLATION_MATRIX.csv',
  'BENCHMARK_MANIFEST.json',
  'CONTEXT_BOUNDARY_TESTS.json',
  'LICENSE',
  'package.json',
  'README.md',
  'RESEARCH_PROVENANCE.json',
  'RESEARCH_PROVENANCE.md',
  'RETRIEVAL_EVAL_RESULTS.json',
  'server.mjs'
]);

const OPTIONAL_ROOT_FILES = Object.freeze([
  'SLING_INTEGRATION_MANIFEST.json'
]);

const SOURCE_DIRECTORIES = Object.freeze([
  '.handoff',
  'docs',
  'examples',
  'hosts',
  'loops',
  'scripts',
  'src',
  'test'
]);

// Public release hashes cover only committed, distributable inputs. Private
// launch receipts remain independently hashed under ignored proof homes and are
// never made an undeclared prerequisite for replaying this source manifest.
const PROOF_INPUTS = Object.freeze([]);

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel));
}

function collectPath(root, path, files) {
  const absolute = resolve(root, path);
  if (!within(root, absolute) || !existsSync(absolute)) {
    throw new Error(`manifest input is missing or escaped: ${path}`);
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`manifest input is a symlink: ${path}`);
  if (stat.isFile()) {
    files.push(path.split(sep).join('/'));
    return;
  }
  if (!stat.isDirectory()) throw new Error(`manifest input is not regular: ${path}`);
  for (const name of readdirSync(absolute).sort()) {
    if (name === '.DS_Store') continue;
    collectPath(root, join(path, name), files);
  }
}

export function collectSourceAndArtifactFiles(rootDir, {
  rootFiles = ROOT_FILES,
  optionalRootFiles = OPTIONAL_ROOT_FILES,
  sourceDirectories = SOURCE_DIRECTORIES,
  proofInputs = PROOF_INPUTS
} = {}) {
  const root = resolve(rootDir);
  const files = [];
  try {
    for (const path of rootFiles) collectPath(root, path, files);
    for (const path of optionalRootFiles) {
      if (existsSync(resolve(root, path))) collectPath(root, path, files);
    }
    for (const path of sourceDirectories) collectPath(root, path, files);
    for (const path of proofInputs) collectPath(root, path, files);
  } catch (error) {
    return refused('SOURCE_ARTIFACT_MANIFEST_INPUT_INVALID', error.message);
  }
  const unique = [...new Set(files)].sort();
  return { status: 'OK', files: unique };
}

export function buildSourceAndArtifactManifest(rootDir, options = {}) {
  const root = resolve(rootDir);
  const collected = collectSourceAndArtifactFiles(root, options);
  if (collected.status !== 'OK') return collected;
  const entries = collected.files.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path)))
  }));
  return {
    status: 'OK',
    entries,
    text: `${entries.map(({ path, sha256: digest }) => (
      `${digest}  ${path}`
    )).join('\n')}\n`
  };
}

export function verifySourceAndArtifactManifest(rootDir, options = {}) {
  const root = resolve(rootDir);
  const manifestPath = resolve(
    root,
    options.manifestName ?? SOURCE_ARTIFACT_MANIFEST
  );
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) {
    return refused(
      'SOURCE_ARTIFACT_MANIFEST_MISSING',
      'Source and artifact manifest is missing or unsafe.'
    );
  }
  const expected = buildSourceAndArtifactManifest(root, options);
  if (expected.status !== 'OK') return expected;
  const actualText = readFileSync(manifestPath, 'utf8');
  const lines = actualText.split('\n').filter(Boolean);
  const malformed = lines.filter((line) => !/^[a-f0-9]{64}  [^\0\r\n]+$/.test(line));
  const paths = lines.map((line) => line.slice(66));
  if (malformed.length > 0 || new Set(paths).size !== paths.length) {
    return refused(
      'SOURCE_ARTIFACT_MANIFEST_INVALID',
      'Source and artifact manifest is malformed or contains duplicate paths.'
    );
  }
  if (actualText !== expected.text) {
    const actual = new Map(lines.map((line) => [line.slice(66), line.slice(0, 64)]));
    const wanted = new Map(expected.entries.map((entry) => [entry.path, entry.sha256]));
    return refused(
      'SOURCE_ARTIFACT_MANIFEST_DRIFT',
      'Source and artifact membership or bytes changed after manifest generation.',
      {
        missing: [...wanted.keys()].filter((path) => !actual.has(path)),
        dangling: [...actual.keys()].filter((path) => !wanted.has(path)),
        mismatched: [...wanted.keys()].filter((path) => (
          actual.has(path) && actual.get(path) !== wanted.get(path)
        ))
      }
    );
  }
  return {
    status: 'OK',
    path: manifestPath,
    fileCount: expected.entries.length,
    manifestSha256: sha256(actualText)
  };
}
