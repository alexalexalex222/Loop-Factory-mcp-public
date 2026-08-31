# Recursive Harness V2

## Purpose

Recursive Harness V2 lets Loop Factory change the deterministic mechanism that
guides later hypotheses. The model proposes. The supervisor binds. Executable
oracles measure. The independent verifier decides whether the mechanism may
enter routing.

It does not let a model rewrite its evaluator, change the objective, approve
itself, retry a failed dispatch, or promote canonical loop bytes.

## One Generation

```text
measured failures + immutable mechanism memory
                    |
deterministic related / adjacent / failure / wildcard / control routing
                    |
one schema-bound mutation proposal, at most three operations
                    |
supervisor-owned mutation plan and semantic clone check
                    |
5 calibration tasks x 3 replicates x 4 arms = 60 calls
                    |
independent placebo-envelope replay
          | qualified                 | rejected
          v                           v
5 untouched tasks x 3 x 4 = 60       valid stop at 60
          |
independent confirmation replay
          |
ACTIVE routing admission or measured rejection
          |
immutable learning receipt for the next generation
```

The four arms are `candidate`, `parent`, `sham`, and `cold`. Calibration passes
only when the candidate's lower 95% bound clears the sham-derived upper noise
bound, all five task effects are positive, the sign tests pass, controls do not
regress, targets do not regress, and candidate token cost stays within the
frozen limit. Confirmation reuses the frozen noise threshold on a task set that
was sealed before launch and untouched during calibration.

A multi-generation wave also predeclares a familywise alpha of `0.05` and uses
Bonferroni allocation over the maximum generation count. A child may become a
development signal at its ordinary task gate, but it enters global routing only
when its adjusted block sign-test probability also clears the campaign's
per-generation alpha. This prevents a long search from repeatedly testing at
`0.05` and selecting the luckiest descendant.

## Context And Memory

Every generation records the proposed operation, cited memory, candidate
mechanism, calibration and confirmation hashes, adjusted effect, placebo
movement, regressions, and verifier authority.

Context policy uses CLI-reported input and output tokens. It needs five valid
observations and moves one bounded 10% step:

- high saturation without measured lift can narrow the next allocation;
- low saturation with repeated positive lift can expand it;
- high usage with positive lift is retained; and
- missing lift keeps the allocation unchanged.

Lossless projection never deletes or rewrites a mechanism. Full content remains
in immutable artifacts. The model-visible capsule may inline the highest-value
records and reference the rest by artifact and semantic hash. Hydration refuses
if the bytes no longer match.

## Restart And Stop

Mutation and child dispatches are journaled before launch. A cold restart after
a completed receipt resumes the same generation and child run ID. An ambiguous
in-flight dispatch is recorded and never silently retried.

The dashboard stop action writes `runs/<run-id>/OPERATOR_STOP`. The runner checks
it between durable calls. `IDLE_NO_NEW_WORK` performs no inference and is not a
claim of global completion. `WAVE_DRAINED` means the approved finite exposure
was consumed.

## Commands

Plan without launching a worker:

```bash
npm run recursive-campaign:plan -- \
  --config /absolute/path/campaign.json \
  --artifact-root /absolute/path/to/sealed/tasks \
  --run-id recursive-wave-01 \
  --home /absolute/path/to/proof-home
```

The plan prints the exact SHA-256, model argv, maximum generations, maximum
calls, historical token estimate, absence of hard token/USD ceilings, and stop
file. A generation has at most 121 calls: one mutation plus 120 child calls.

After approving that exact parent plan and setting the OAuth authority locks:

```bash
SUPER_LOOP_ALLOW_EXEC=1 npm run recursive-campaign -- \
  --config /absolute/path/campaign.json \
  --artifact-root /absolute/path/to/sealed/tasks \
  --approved-plan <sha256> \
  --run-id recursive-wave-01 \
  --home /absolute/path/to/proof-home
```

Independent replay:

```bash
npm run verify:recursive-campaign -- \
  --run recursive-wave-01 \
  --home /absolute/path/to/proof-home
```

## Hermes And Sling Contract

The local dashboard server exposes a versioned, sanitized API:

```text
GET  /api/v1/runs
GET  /api/v1/runs/:runId
GET  /api/v1/runs/:runId/events?after=<cursor>
POST /api/v1/runs/:runId/stop
```

Run envelopes include lifecycle, call exposure, causal stages, verifier gates,
machine admission decisions, context policy, token receipts, memory metadata,
and capabilities. Event cursors are hash chained. Prompt bodies, stdout,
credentials, argv, and absolute paths are removed. Stop requires the same-origin
session token and is idempotent.

## Claim Boundary

The implementation and deterministic local tests can prove that the machinery
behaves as specified. They cannot prove that retrieved memory improves real
future work. That claim requires a paid live campaign with disjoint generations,
an honest baseline, a sham, repeated samples, untouched confirmation, and an
independent verifier result reconstructed from disk.
