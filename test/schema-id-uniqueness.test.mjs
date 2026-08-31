import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const SCHEMA_ROOT = new URL('../src/schemas/', import.meta.url);

test('every shipped JSON schema declares a unique $id', () => {
  const owners = new Map();
  const files = readdirSync(SCHEMA_ROOT)
    .filter((name) => name.endsWith('.json'))
    .sort();

  for (const file of files) {
    const schema = JSON.parse(readFileSync(new URL(file, SCHEMA_ROOT), 'utf8'));
    if (schema.$id === undefined) continue;
    assert.equal(typeof schema.$id, 'string', `${file} must declare a string $id`);
    assert.notEqual(schema.$id, '', `${file} must declare a non-empty $id`);
    assert.equal(
      owners.get(schema.$id),
      undefined,
      `${file} duplicates $id ${schema.$id} from ${owners.get(schema.$id)}`
    );
    owners.set(schema.$id, file);
  }
});
