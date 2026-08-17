# Executable Causal Canary V3

V3 keeps the V2 isolation, hidden-case, three-arm, and verification protocol.
It changes one endpoint: a repair is complete only when both target and control
quality equal `1`.

## Why V3 Exists

V2 qualified headroom from `targetQuality < 1`, but its causal win required a
full repair:

```text
targetQuality === 1 && controlQuality === 1
```

That mismatch could stop an experiment when no-memory workers repaired the
reported target but broke stable controls. V3 uses the full-repair definition
throughout. V1 and V2 retain their historical behavior and plan hashes.

## Frozen Endpoint

V3 records `repairFailureMetric: "full-repair"` in the plan contract.

- Qualification failure: target quality or control quality is below `1`.
- Qualification opens after at least three failures among five disjoint tasks.
- Confirmation baseline failure: the paired baseline is not a full repair.
- Routed win: routed output is a full repair for a baseline-incomplete task.
- Sham win: sham output is a full repair for a baseline-incomplete task.
- Routed advantage: routed wins minus sham wins.
- Solved-baseline guard: routing may not make a complete baseline incomplete.

The existing pass gates remain:

- at least two confirmation baseline failures;
- at least two routed paired wins;
- routed advantage of at least two;
- zero routed control failures;
- zero routed regressions;
- valid execution, evidence, isolation, hashes, schedule, and model authority.

## Unchanged Safety

- Five qualification tasks and five separate confirmation tasks.
- Balanced blinded baseline, routed, and sham confirmation arms.
- Hidden expected outputs never enter a model process.
- Exact `gpt-5.6-sol`, high reasoning, ChatGPT OAuth.
- Ephemeral read-only capsules with tools and user config disabled.
- Zero retries.
- Promotion disabled.
- Exact plan-hash approval before execution.
- Independent verification from persisted state and artifacts.

## Interpretation

- `NO_HEADROOM`: fewer than three unaided qualification outputs were incomplete.
- `NO_CAUSAL_LIFT`: comparison was valid but failed one or more causal gates.
- `PASS`: routed memory produced the required full-repair advantage over both
  no memory and the irrelevant sham.

A V3 pass establishes evidence for the sealed task population and mechanism.
It does not authorize promotion or claim universal transfer.
