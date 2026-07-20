# Public canary evidence

This directory is the no-paid, fresh-checkout evidence packet for the persisted
`context-isolation-canary-20260719` run.

Run from the repository root:

```bash
npm run verify:submission
```

The verifier does not trust a saved `PASS` field. It checks the file manifest,
validates the public canary inputs, invokes Loop Factory's existing read-only
canary verifier, re-hashes every referenced artifact, re-derives token usage
from raw transcripts, and enforces the submission-specific expected counts and
outcomes.

## Byte preservation

The 47 worker artifacts under `state/runs/.../artifacts/` are byte-identical
copies of the sealed local proof. Their source and bundle SHA-256 values match
in `bundle-manifest.json`.

`canary-inputs.json`, `state.json`, and the source excerpt are explicitly
declared public projections. They replace the operator home prefix with
`/Users/[USER]/`, replace ephemeral worker roots with deterministic
`capsule://worker-NN` identifiers, collapse the private three-file source
capsule into one disclosed excerpt, remove precomputed verdict fields, and
recompute the portable plan hash and blind labels. The manifest records the
original source hashes and the transformation boundary.

## Honest result

The experiment is valid and shows causal movement: the challenger beat its
paired baseline in all five replicates, while the irrelevant sham never moved
and controls never regressed. Challenger target quality was `0.3333` or
`0.6667`, never `1.0`; this packet does not claim the target problem was fully
solved. Promotion was disabled and no promotion was recorded.
