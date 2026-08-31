# Executable Causal Canary v2

## Objective

Measure whether an evidence-backed, ordered improvement procedure causes GPT-5.6
Sol to produce better executable repairs than both no memory and a
schema-matched irrelevant procedure.

V2 preserves the V1 isolation, receipts, partitions, balanced schedule,
headroom qualification, deterministic execution, exact-output gates, and
no-promotion policy. It changes only the two surfaces falsified by the first
live executable canary.

## Actionable Mechanism

A routable mechanism family may carry `procedureSteps`, an ordered list of
bounded task-general operations. Family identity and hashes bind step content
and order. The router renders those steps as an imperative procedure while
retaining evidence, policy, and applicability bindings.

Legacy families without procedure steps remain valid and retain the V1 generic
instruction. Public routing summaries continue to omit private mechanism
procedure content.

The irrelevant arm has the same capsule shape and procedure cardinality. Its
steps describe document presentation, not release behavior, and never instruct
the worker to avoid a repair.

## Visible Interface Contract

Every mutation shard adds one worker-visible interface contract declaring:

- the exported function;
- all possible input property paths;
- the allowed `ACCEPT` and `REJECT` dispositions;
- every supervisor code and its meaning.

The contract does not contain case IDs, case inputs, expected outputs, arm
identity, scores, thresholds, or outcomes.

Before plan approval, the supervisor recursively enumerates every hidden oracle
input path and expected disposition/code. Any vocabulary absent from the
visible interface blocks the plan. Hidden values remain private; hidden API
vocabulary is forbidden.

## Diagnostic Axes

Exact output remains the causal and promotion gate. V2 additionally persists:

- decision accuracy for target and control cases;
- supervisor-code accuracy for target and control cases.

These axes explain failures without changing the frozen winner rule. A correct
decision with the wrong declared code is visible but is not a full repair.

## Runtime Compatibility And Failed Calls

V2 requires Codex CLI `0.145.0` or newer for GPT-5.6 Sol. This floor was added
after a sealed `0.142.2` launch passed catalog inspection but the backend
rejected Sol as requiring a newer client. The selected binary version, bytes,
hash, OAuth catalog, and explicit model flag remain plan-bound.

A failed process invocation is an observed call even when it produces no model
result or token receipt. The independent verifier replays its contract and
prompt, validates raw stdout/stderr hashes, checks its schedule slot and
attempt number, and reports token usage as unmeasured rather than zero. Such a
run remains incomplete and cannot satisfy experiment-validity or causal gates.

## Experimental Contract

- Five fresh qualification shards, no-memory only.
- Five disjoint fresh confirmation shards.
- Baseline, routed, and irrelevant arms on each confirmation shard.
- Maximum twenty exact-model calls.
- Zero retries and zero fallback models.
- Exact `gpt-5.6-sol`, high reasoning, ChatGPT OAuth launch authority.
- Hidden deterministic cases execute in the sealed local sandbox.
- At least two routed full repairs and a two-win advantage over sham.
- Zero routed control failures and zero routed target regressions.
- Promotion disabled.

The independent verifier replays interface coverage, prompts, treatments,
candidate execution, diagnostic axes, exact scores, schedule, receipts, hashes,
and the causal outcome from disk.

## Non-Claims

A V2 pass supports one ordered mechanism on one pre-registered task family. It
does not prove universal self-improvement or authorize automatic promotion. A
valid failure remains evidence and must not be repaired by moving the gates.
