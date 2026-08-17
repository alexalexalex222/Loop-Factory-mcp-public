# Recursive Mechanism Evolution V1

Loop Factory distinguishes three claims that were previously easy to collapse:

1. A retrieved mechanism helped a later task.
2. New evidence strengthened the receipt for that mechanism.
3. New evidence produced a semantically different mechanism that outperformed its parent.

Only the third claim is recursive improvement. V1 makes that claim testable without giving a model permission to rewrite the harness.

## Measurement V2

`adaptive-measurement-v2` is an immutable, verifier-owned record derived from persisted deterministic evaluation artifacts. It keeps:

- exact case, decision, code, target, control, and full-repair counts;
- paired baseline, parent, treatment, and sham contrasts;
- wins, regressions, sample size, and an explicitly approximate paired confidence interval;
- token totals and relative cost deltas;
- task, evaluator, case-set, artifact, parent-program, and candidate-program hashes.

Perfect-task rate remains a strict release gate. It is not the router's entire learning signal. New V4 imports use exact-case causal lift as routing credit while preserving the existing full-repair admission threshold.

Generic catalog persistence refuses measurement V2 records. They can only enter through a verifier-owned import boundary. Recursive verification persists the measurement together with its exact lifecycle chain; a caller cannot mint `VERIFIED` or `ACTIVE` records through the generic catalog API.

## Bounded Mutation

`mechanism-mutation-plan-v1` permits at most eight exact, hash-bound operations over:

- selectors;
- bindings;
- forbidden bindings;
- metrics;
- ordered rules;
- fallback disposition.

It cannot change program roles, the closed-world policy, routing policy, promotion policy, executor settings, or harness source. Replacements and removals must bind the current item SHA-256. The compiler validates the complete candidate program after every plan.

Internal identifier renames are alpha-normalized. A byte-different program that preserves executable semantics is refused with `NO_SEMANTIC_DELTA`.

## Lifecycle

Each descendant has an append-only chain:

`PROPOSED -> SHADOW -> VERIFIED -> ACTIVE`

Any nonterminal state may instead become `REJECTED`.

- `PROPOSED` binds the parent, candidate, source measurement, mutation plan, and semantic hashes.
- `SHADOW` requires at least one frozen interface to compile a different model-visible treatment.
- `VERIFIED` requires a recursive measurement bound to the exact parent and candidate program hashes. Candidate exactness must beat both cold and parent arms, sham movement must be zero, decision accuracy cannot regress, and target/control regressions must be zero.
- `ACTIVE` is routing-only. The ordinary router may derive evidence from an `ACTIVE` record only when the bound recursive measurement is present and valid. It does not authorize canonical promotion, rewrite policy, or remove the parent.

The catalog accepts observational proposal, shadow, and rejection records. Caller-minted `VERIFIED` and `ACTIVE` records are refused. `persistAdaptiveRecursiveCanaryResult()` reopens the run, invokes the independent verifier, and persists the family, measurement, and lifecycle records only from that replay.

## Router Behavior

Executable families with different descriptive names but the same alpha-normalized program semantics compete once. The deterministic router retains the strongest representative and reports how many semantic clones were suppressed. It does not merge or invent evidence across those families.

## Recursive Canary Plan

`npm run recursive-canary:plan -- --config <config.json> --run-id <run> --home <proof-home>` validates a five-task, four-arm plan:

- `cold`: no memory;
- `parent`: the pre-evolution mechanism;
- `candidate`: the proposed descendant;
- `sham`: a schema-matched irrelevant treatment.

The plan freezes exactly twenty possible calls, one exact GPT-5.6 Sol or Luna route at `high`, `xhigh`, or `max` reasoning through ChatGPT OAuth, zero retries, strict read-only Codex isolation, identical proposal schemas, no fallback model, and no promotion. `Ultra` is not a reasoning level and is not accepted by this contract.

Plan and run boundaries are separate:

```text
npm run recursive-canary:plan -- --config <config.json> --run-id <run> --home <proof-home>
npm run recursive-canary -- --config <config.json> --approved-plan <sha256> --run-id <run> --home <proof-home>
npm run verify:recursive-canary -- --home <proof-home> --run <run>
```

The plan command captures the current Codex OAuth catalog, evaluator authority, implementation bytes, task files, treatment packets, exact argv, and exposure, then launches no worker. The run command requires that exact plan hash and authority lock. It performs each scheduled call once, persists raw and normalized receipts, executes every returned module in the sealed sandbox, and never retries.

The independent verifier reopens disk artifacts and recomputes prompts, model argv, isolation, output schema, candidate execution, case outcomes, token receipts, measurement V2, and lifecycle transitions. A valid causal pass may activate the descendant for adaptive routing. It still cannot promote or change a canonical loop.
