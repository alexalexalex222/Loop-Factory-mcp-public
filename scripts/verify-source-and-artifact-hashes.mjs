#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySourceAndArtifactManifest } from '../src/source-artifact-manifest.mjs';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const verified = verifySourceAndArtifactManifest(ROOT);
process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
process.exit(verified.status === 'OK' ? 0 : 1);
