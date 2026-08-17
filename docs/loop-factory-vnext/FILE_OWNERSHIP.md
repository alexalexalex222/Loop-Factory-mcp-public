# VNext Implementation File Ownership

Shared contracts are frozen before implementation lanes begin. No two lanes may
edit the same file.

## Lane A: Research And Retrieval

Owns only new files:

- `src/research-dossier.mjs`
- `src/vnext-evidence-bank.mjs`
- `src/hybrid-retrieval.mjs`
- `src/hypothesis-falsifier.mjs`
- matching new focused tests

## Lane B: Evaluation, Candidates, And Statistics

Owns only new files:

- `src/isolated-evaluator.mjs`
- `src/vnext-candidate-generators.mjs`
- `src/pace-acceptor.mjs`
- matching new focused tests

## Lane C: Observability And Semantic Safety

Owns only new files:

- `src/harness-handbook.mjs`
- `src/task-agent-feedback.mjs`
- `src/conceptual-signature.mjs`
- matching new focused tests

## Lead Integrator

Exclusively owns shared and integration files:

- all existing Loop Factory source and tests;
- `src/vnext-contracts.mjs` and `src/vnext-model-contracts.mjs`;
- resource budgets, run leases, task packs, campaign series, causal-memory
  studies, operator actions, and pipeline orchestration;
- schemas, scripts, package metadata, docs, manifests, benchmark fixtures;
- all Sling/Hermes integration files;
- final verification, browser QA, packaging, and live-run decisions.

Each lane must report assumptions, changed files, tests, unresolved risks, and a
diff. The lead reviews and tests each lane before integration work consumes it.
