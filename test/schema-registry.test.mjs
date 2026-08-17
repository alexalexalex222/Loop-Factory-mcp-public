import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'schemas'
);

test('every shipped JSON Schema has a unique registry id', () => {
  const byId = new Map();
  for (const file of readdirSync(SCHEMA_ROOT).filter((name) => name.endsWith('.json'))) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_ROOT, file), 'utf8'));
    if (schema.$id == null) continue;
    const files = byId.get(schema.$id) ?? [];
    files.push(file);
    byId.set(schema.$id, files);
  }
  const duplicates = [...byId]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files }));
  assert.deepEqual(duplicates, []);
});
