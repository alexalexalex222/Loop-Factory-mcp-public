#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const [candidatePath, exportName] = process.argv.slice(2);
if (!candidatePath || !exportName) {
  process.stderr.write('candidate path and export name are required\n');
  process.exit(2);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let request;
try {
  request = JSON.parse(raw);
} catch {
  process.stderr.write('sandbox input must be JSON\n');
  process.exit(2);
}

if (!Array.isArray(request?.inputs)
    || request.inputs.some((item) => (
      !item
      || typeof item !== 'object'
      || typeof item.id !== 'string'
      || !item.id
      || !Object.hasOwn(item, 'input')
    ))) {
  process.stderr.write('sandbox input requires identified inputs\n');
  process.exit(2);
}

try {
  const candidate = await import(pathToFileURL(candidatePath).href);
  const decide = candidate[exportName];
  if (typeof decide !== 'function') {
    throw new Error(`candidate must export function ${exportName}`);
  }
  const outputs = [];
  for (const item of request.inputs) {
    const output = await decide(structuredClone(item.input));
    outputs.push({ id: item.id, output });
  }
  process.stdout.write(`${JSON.stringify({ outputs })}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
}
