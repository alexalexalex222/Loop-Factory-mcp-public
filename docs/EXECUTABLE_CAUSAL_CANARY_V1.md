# Executable Causal Canary v1

## Objective

Measure whether one retrieved, evidence-backed improvement mechanism causes
GPT-5.6 Sol to produce better executable repairs than both:

1. the same model with no mechanism memory; and
2. the same model with a schema-matched but task-irrelevant mechanism.

The canary measures hidden deterministic behavior. It does not use a model to
grade another model, infer quality from prose, or treat a shorter prompt as an
improvement.

## Experimental Unit

One unit is a sealed mutation shard:

- one visible single-file JavaScript module;
- one visible incident report and public acceptance boundary;
- one hidden target/control case set;
- one withheld reference repair used only for local instrument qualification;
- repository provenance tying the mutation to a real Loop Factory invariant.

Every worker returns the complete replacement module in the existing strict
proposal schema. The supervisor writes that module into a fresh capsule and
runs the hidden inputs through it. Expected outputs remain in the supervisor
process and never enter the candidate process.

## Partitions

The pools are disjoint.

- **Qualification pool:** five shards, baseline arm only.
- **Confirmation pool:** five fresh shards, all three arms.
- **Public partition:** candidate source and incident report; worker-visible.
- **Oracle partition:** hidden inputs and expected outputs; never worker-visible.
- **Reference partition:** known-good repair; never worker-visible and never
  used as a model answer.
- **Mechanism-evidence partition:** provenance for the routed memory; private to
  the supervisor.

Qualification output is not reused as confirmation evidence.

## Calls

Maximum exposure is twenty model calls:

- up to five qualification baseline calls;
- fifteen confirmation calls, one call per arm for each of five fresh shards.

Qualification stops early once three baseline failures become mathematically
impossible. There are no retries or fallback models.

The confirmation schedule is blocked and balanced:

| shard | first | second | third |
|---|---|---|---|
| 1 | baseline | routed | sham |
| 2 | routed | sham | baseline |
| 3 | sham | baseline | routed |
| 4 | baseline | sham | routed |
| 5 | routed | baseline | sham |

Workers receive opaque task identities. They are not told that they are in a
benchmark, which arm they occupy, the hidden cases, the expected outputs, the
other arms, scores, thresholds, or outcomes.

## Treatments

- **baseline:** no assigned mechanism capsule.
- **routed:** one replayable capsule selected from valid harvest evidence.
- **sham:** a byte-distinct capsule with the same schema and cardinality that
  contains a genuine but task-irrelevant presentation mechanism. It does not
  instruct the worker to avoid fixing the task.

Apart from the assigned mechanism capsule, the three confirmation contracts
for a shard are byte-identical.

## Local Instrument Qualification

Before plan approval, every shard must prove:

- the unmodified mutant fails at least one target case;
- the unmodified mutant passes every regression control;
- the withheld reference repair passes every target and control;
- source, oracle, reference, provenance, and mechanism partitions are
  path-disjoint and content-disjoint;
- the evaluator sandbox blocks filesystem access outside the candidate and
  bootstrap, child processes, workers, and network access.

Failure blocks the plan before any model call.

## Causal Gates

Qualification requires at least three of five unaided repairs to leave a
target failure. Confirmation passes only when all of the following are true:

- all scheduled calls and deterministic evaluations are valid;
- the confirmation baseline leaves target headroom on at least two shards;
- routed fully repairs at least two baseline-failed shards;
- routed produces at least two more paired full repairs than sham;
- routed passes every control on every shard;
- routed does not regress a target that baseline solved;
- no retry, fallback, partition leak, receipt mismatch, or promotion occurs.

A valid failure remains evidence. Gates are not weakened after observing data.

## Candidate Sandbox

Candidate modules execute under both:

1. Node's permission model, allowing reads only for the candidate and a fixed
   bootstrap while denying filesystem writes, child processes, and workers;
2. macOS `sandbox-exec` with all network operations denied.

The process receives a minimal environment, a bounded input payload, a
15-second timeout, a 128 MiB V8 heap cap, and a bounded stdout/stderr buffer.
The bootstrap receives hidden inputs over stdin and returns candidate outputs.
Expected outputs remain in the parent supervisor.

## Persistence And Verification

The append-only run stores:

- approved plan, resolved config, implementation, runtime authority, and every
  sealed partition;
- exact prompt and contract bytes for every call;
- raw/final model output and invocation receipts;
- complete candidate source;
- sandbox argv/profile hashes, stdout/stderr, and derived measurements;
- schedule, qualification decision, outcome, and no-promotion state.

The independently invoked verifier rehashes all artifacts, rebuilds every
prompt, replays mechanism routing, checks arm parity and partition isolation,
reruns every persisted candidate against the sealed hidden inputs, recomputes
the causal gates, and exits nonzero unless `experimentValid === true`.

## Non-Claims

A passing canary proves causal benefit for the pre-registered mechanism and
task family under this model/runtime. It does not prove universal benefit,
authorize automatic promotion, or establish that every future routed memory is
useful. Broader activation requires a separate untouched confirmation cohort.
