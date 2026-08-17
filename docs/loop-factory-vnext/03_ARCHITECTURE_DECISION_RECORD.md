# VNext Architecture Decision Record

Status: frozen for implementation on `2026-08-05`.

## Decision

VNext is an additive evidence pipeline around the existing V2 recursive runner.
It does not replace the mechanism catalog, deterministic router, replicated
four-arm canary, verifier, or activation gate.

```text
normalized failure
  -> verifier-eligible evidence bank
  -> deterministic eligible-memory retrieval
  -> optional fresh browser-only primary-source discovery
  -> deterministic DNS/TLS/byte capture and replay
  -> internal research synthesis
  -> frozen compact dossier
  -> fresh hypothesis context
  -> fresh adversarial falsifier context
  -> one feature-flagged candidate strategy
  -> candidate execution
  -> objective verification
  -> fresh anonymous semantic evaluator when needed
  -> task-cluster statistical acceptor
  -> append-only evidence update
  -> routing-only activation, quarantine, or rollback
```

Every arrow is an immutable `loop-factory-vnext-stage-envelope-v1` artifact.
Every model-produced payload uses a closed JSON schema from
`src/vnext-model-contracts.mjs` and `src/schemas/vnext-*-output-v1.schema.json`.

## Compatibility

- Existing feature-off behavior remains unchanged.
- The deterministic router remains the baseline, hard filter, and fallback.
- Existing V1/V2 records are read through adapters; they are not rewritten.
- Existing recursive thresholds are unchanged.
- VNext activation remains routing-only.
- Existing model-facing MCP tools do not gain quarantine, rollback, evaluator,
  or promotion authority.

## New Modules

- `vnext-contracts.mjs`: common immutable stage envelope.
- `vnext-model-contracts.mjs`: closed model-output payloads.
- `research-dossier.mjs`: internal/external evidence normalization and compact
  dossier construction.
- `vnext-evidence-bank.mjs`: cross-run positive, negative, contradiction,
  transfer, cost, and lifecycle records.
- `hybrid-retrieval.mjs`: deterministic filtering, broad retrieval, optional
  reranking, diversity, negative precedent, and frozen receipt.
- `hypothesis-falsifier.mjs`: fresh-context adversarial hypothesis review.
- `vnext-candidate-generators.mjs`: shared plugin interface and five strategies.
- `vnext-candidate-strategies.mjs`: distinct deterministic planning and replay
  semantics for native, Pareto, bounded-skill, bank-recombination, and code
  strategies.
- `vnext-external-research.mjs`: closed discovery policy, fresh-context browser
  prompt, allowlist enforcement, and deterministic fetch-plan materialization.
- `vnext-external-research-worker.mjs`: public-address DNS guard, TLS/MIME/byte
  capture, portable raw evidence, and independent replay.
- `vnext-code-worktree.mjs`: detached worktree execution, network-denied tests,
  exact patch/log receipts, and disk verifier.
- `isolated-evaluator.mjs`: anonymous request contract, separate state/process
  launcher, and evaluator receipt verification.
- `pace-acceptor.mjs`: task-cluster paired anytime-valid evidence.
- `harness-handbook.mjs`: behavior-to-source map and locator freshness.
- `task-agent-feedback.mjs`: noisy post-run feedback artifact.
- `conceptual-signature.mjs`: deterministic conceptual clone candidates and
  conservative model-assisted merge review.
- `resource-budget.mjs`: pre-dispatch token/call/USD ledger.
- `run-lease.mjs`: exclusive supervisor lease and stale recovery.
- `vnext-task-pack.mjs`: provenance-bound development/validation/final packs.
- `campaign-series.mjs`: finite sealed waves under a continuous zero-inference
  outer scheduler.
- `memory-causal-study.mjs`: relevant/no-memory/irrelevant-memory experiment.
- `vnext-operator-actions.mjs`: restrictive deny, quarantine, and rollback
  receipts.
- `vnext-pipeline.mjs`: stage orchestration only; no credit authority.

## Statistical Decision

Replicates are averaged within a task. A task cluster contributes at most one
paired outcome to the e-process. PACE-style wealth is a supplementary gate for
one fixed candidate. Campaign-level alpha spending still controls the adaptive
candidate stream, and untouched confirmation remains mandatory.

## Continuous Operation

The outer series scheduler may repeatedly consume already sealed, disjoint wave
descriptors. It may ask a task-pack builder to stage a later wave, but a wave is
not executable until objective provenance, oracle separation, leakage checks,
budget, model, evaluator, and implementation hashes are sealed. No-work idle
performs zero inference.

## Code Evolution

The code-level strategy is disabled by default. It may create one
task-agnostic, component-scoped patch in a disposable worktree. Protected
surface edits fail as authority violations. The patch cannot modify or run
against final sealed tasks and cannot deploy itself. The executor preserves the
literal test argv, executable identity, sandbox profile, input packet, patch,
and logs; `verify:vnext:code-candidate` recomputes them from disk.
