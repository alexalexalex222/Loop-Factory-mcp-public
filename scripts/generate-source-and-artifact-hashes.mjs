#!/usr/bin/env node

import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_ARTIFACT_MANIFEST,
  buildSourceAndArtifactManifest,
  verifySourceAndArtifactManifest
} from '../src/source-artifact-manifest.mjs';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const built = buildSourceAndArtifactManifest(ROOT);
if (built.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
  process.exit(1);
}
const output = join(ROOT, SOURCE_ARTIFACT_MANIFEST);
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, built.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
renameSync(temporary, output);
const verified = verifySourceAndArtifactManifest(ROOT);
process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
process.exit(verified.status === 'OK' ? 0 : 1);
