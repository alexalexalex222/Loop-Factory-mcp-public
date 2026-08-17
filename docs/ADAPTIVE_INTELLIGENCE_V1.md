# Adaptive Intelligence V1

Status: implementation contract

This document freezes the first dependency-complete adaptive intelligence
boundary. It does not claim that adaptive routing improves outcomes. That claim
requires the separately verified baseline/routed/sham meta-canary.

## Invariants

1. Workers propose hypotheses and artifacts. The deterministic supervisor owns
   measurements, evidence validity, policy epochs, promotion decisions, campaign
   transitions, and stop authority.
2. Objective, acceptance criteria, baseline, benchmark, oracle, integrity gates,
   evidence partitions, promotion thresholds, and operator stop authority never
   enter the adaptive policy allowlist.
3. `null` evidence stays `null`. Missing measurements are not zeroes.
4. Gate and reference evidence may be audited, but only valid harvest
   applications can affect routing.
5. Failure-derived evidence remains labeled negative or inversion evidence.
6. Controlled randomness is derived from a persisted seed and candidate-pool
   hash. Replaying the same inputs produces the same decision.
7. Feature-off behavior is byte-for-byte compatible at the public state
   boundary. Shadow mode remains observational and records
   `affectedExecution:false`.
8. Active-canary routing happens before hypothesis construction. Every affected
   hypothesis binds the routing decision, packet hash, policy epoch, and one
   primary mechanism family.
9. Automatic approval records an internal champion only. It never overwrites a
   mandated loop or adopts a custom loop.
10. A candidate controller is evaluated by the frozen current controller. The
    active judge is never hot-patched.

## Canonical Encoding

All record hashes use UTF-8 JSON with object keys recursively sorted,
array order preserved, `undefined` omitted, and `null` preserved.

Hash fields and derived IDs are excluded from their own hash payloads. No record
hash contains a filesystem path, environment value, raw prompt, or secret.

## Record Identities

### `mechanism-family-v1`

A family is a reusable causal idea, not an attempt.

`familyId` is:

```text
family-<first 24 hex of sha256(canonical causalFingerprint)>
```

The causal fingerprint contains only normalized, reusable fields:

- `bottleneckKind`
- `interventionKind`
- `operationKind`
- `expectedEffectKind`
- sorted `preconditions`
- sorted `applicability.taskModes`
- sorted `applicability.loopRoles`
- sorted `applicability.taskValueDimensions`
- sorted `applicability.resourceDimensions`

Run IDs, finding IDs, hypothesis IDs, timestamps, outcome values, and prose are
not family identity. Semantically equivalent prose is not guessed to be the
same family; it must produce the same explicit normalized fingerprint.

`familySha256` hashes the full family record without `familySha256`. Because a
family record contains no attempt provenance or timestamp, the same fingerprint
produces the same immutable bytes across runs.

### `mechanism-application-v1`

An application is one family used in one concrete attempt. Its stable
`applicationId` hashes:

- `familyId`
- source `runId`, `hypothesisId`, and nullable `testId`
- `targetSha256`
- nullable `routingDecisionId`
- nullable `routingPacketSha256`

Outcome and reverify changes do not change `applicationId`.

Each immutable revision has an `applicationReceiptId` derived from
`applicationSha256`, which hashes the complete record excluding
`applicationReceiptId` and `applicationSha256`. Observed and reverified revisions
therefore group under one application ID without overwriting history.

### `adaptive-canary-import-v1`

A canary import is routing evidence derived from one independently reverified
V4 executable canary. It uses the application receipt surface so the router can
bind the selected family and evidence hash without pretending the canary was an
ordinary supervisor hypothesis, test, or legacy mechanism receipt.

The record binds the sealed config and plan, verifier evidence, routed family
and executable program, evaluator authority, case/interface/compilation sets,
all evaluation artifact hashes, all token receipts, and the paired confirmation
measurement. It stores no source-home path, prompt, private prose, or canonical
loop bytes.

Imports are always `routing-only`. They may make the verified family eligible
for a later active route, but they are not `mechanism-application-v1` policy
evidence, cannot recalibrate a policy epoch, cannot approve promotion, and
cannot overwrite a canonical loop.

### `routing-decision-v1`

`routingDecisionId` derives from the complete deterministic decision payload:

- mode and `affectedExecution`
- target and candidate-pool hashes
- policy epoch ID and hash
- normalized seed
- ordered allocation schedule
- ordered selections with probabilities and reason codes
- abstention or fallback code

The payload excludes `routingDecisionId` and `routingDecisionSha256`. Changing a
candidate, probability, slot, reason, policy, or target creates another decision.

### `meta-policy-epoch-v1`

`policyEpochId` derives from the complete epoch payload:

- epoch number and previous epoch hash
- trigger and evidence-window hash
- allowlisted allocation/scoring values
- per-field changes
- drift from baseline
- activation tier
- quarantines and rollback target

The payload excludes `policyEpochId` and `policyEpochSha256`. Epoch zero has a
null previous hash. Every later epoch must bind the previous epoch hash.

### `automatic-promotion-decision-v1`

`automaticPromotionDecisionId` derives from the complete supervisor decision:

- run, hypothesis, and test IDs
- frozen benchmark and policy hashes
- measured baseline, challenger, and deltas
- ordered deterministic gate results
- routing decision and policy epoch bindings
- eligibility, disposition, and reason codes
- canonical-change and promotion flags

The payload excludes its derived ID and SHA-256. The record is valid only when
created from persisted supervisor evidence. `canonicalChange` is always false.

## Persistence

Adaptive records live under `<home>/adaptive-memory-v1/`:

```text
families/
application-receipts/
canary-imports/
routing-decisions/
policy-epochs/
automatic-promotion-decisions/
catalog.json
ledger.jsonl
.lock
```

Record files are immutable and created with exclusive writes. A process-level
filesystem lock serializes record creation and reconciliation. The catalog and
ledger are rebuildable from record files; a crash after a record write but
before index replacement is repaired by the next reconciliation. Conflicting
bytes for a derived ID fail closed and are never overwritten.

## Policy Boundary

The only mutable policy fields are:

- `allocations.related`
- `allocations.adjacent`
- `allocations.failureDerived`
- `allocations.wildcard`
- `scoring.relevanceWeight`
- `scoring.confidenceWeight`
- `scoring.positiveEffectWeight`
- `scoring.contradictionPenaltyWeight`
- `penalties.cooldown`
- `penalties.failedTransfer`

`allocations.control` is permanent and cannot fall below `0.20`.
Allocations always sum to `1`. No allowlisted field may move by more than
`0.05` in one epoch. An epoch update requires five new valid applications or a
lane boundary. Unknown fields, non-finite values, or an invalid hash chain are
refused.

Drift is the L1 distance between the current and baseline allowlisted vectors:

- tier 0: `0`
- tier 1: `> 0` and `<= 0.10`
- tier 2: `> 0.10` and `<= 0.25`
- tier 3: `> 0.25`

Tier 3 cannot receive additional active traffic without a valid held-out
three-arm meta-canary receipt. A forced regression creates a rollback epoch
that restores the last non-quarantined policy while the campaign continues.

## Module Interfaces

`src/adaptive-records.mjs`

- `normalizeCausalFingerprint(input)`
- `createMechanismFamilyRecord(input)`
- `createMechanismApplicationRecord(input)`
- `createAdaptiveCanaryImportRecord(input)`
- `createRoutingDecisionRecord(input)`
- `createMetaPolicyEpochRecord(input)`
- `createAutomaticPromotionDecisionRecord(input)`
- `selectLatestApplicationRevisions(applications)`
- `isCausallyAdmittedApplication(application)`
- `isCausallyAdmittedCanaryImport(importRecord)`
- `validateAdaptiveRecord(record)`

`src/mechanism-catalog.mjs`

- `persistAdaptiveRecord({ homeDir, record })`
- `persistAdaptiveCanaryImport({ homeDir, sourceStore, runId, automatic })`
- `reconcileMechanismCatalog({ homeDir })`
- `loadMechanismCatalog({ homeDir })`
- `listAdaptiveRecords({ homeDir, schemaVersion })`

`src/adaptive-policy.mjs`

- `createBaselinePolicyEpoch(input)`
- `proposePolicyEpoch(input)`
- `createRollbackPolicyEpoch(input)`
- `evaluatePolicyDrift(input)`
- `classifyFamilyLifecycle(input)`

`src/mechanism-router.mjs`

- keeps `buildShadowMechanismPacket(...)` for compatibility
- adds `buildMechanismRoutingDecision(...)`
- consumes family/application catalog data, never gate/reference data
- emits an ordered hypothesis allocation schedule with a permanent control

`src/active-mechanism-treatment.mjs`

- `prepareActiveMechanismTreatment(input)` validates the route/capsule binding
- compiles executable families against the supplied interface before the route
  is persisted or hypotheses are registered
- leaves no-memory controls untreated
- fails the whole treatment closed on missing interfaces, hash mismatches, or
  partial compiler coverage

`src/adaptive-control-evidence.mjs`

- accepts only persisted measurement-artifact references at the engine boundary;
  caller-supplied qualities and aggregates are refused
- binds each artifact at creation to one reverified test, arm, metric role, frozen
  benchmark case, benchmark hash, oracle hash, and evaluator hash
- seals exact per-case baseline, routed, and sham arm evidence after reopening
  and verifying those artifacts
- derives sham movement and control regressions from paired tool measurements
- rejects caller aggregates, missing bindings, incomplete case sets, and hash
  drift
- preserves valid negative evidence while marking it ineligible for automatic
  banking

`src/adaptive-canary-import.mjs`

- `deriveAdaptiveCanaryImport(...)` invokes the independent executable-canary
  verifier against persisted state and artifacts; saved reports and caller PASS
  booleans are never inputs
- accepts only exact V4, non-fixture, GPT-5.6 Sol OAuth, zero-retry,
  no-promotion runs with every verifier gate true and complete token receipts
- pairs only the five shared confirmation task IDs; qualification baseline calls
  cannot contaminate confirmation quality or cost deltas
- rejects target/control regressions, sham full-repair wins, missing arms,
  family/program drift, and artifact/hash drift
- derives one immutable routing-only import record and the exact family record
  from the verified routed capsule
- binds the evaluator artifact to both its sealed state reference and config,
  and binds raw/result CLI receipt hashes for every measured token total
- requires `adaptiveMemoryImportEnabled:true` in the sealed pre-launch config
  when the operator requests automatic rather than manual import

Generic `persistAdaptiveRecord(...)` refuses `adaptive-canary-import-v1`.
Only `persistAdaptiveCanaryImport(...)` may write that schema, and it accepts a
source store plus run ID rather than a caller-constructed record.

Engine operator boundary:

- `prepareMechanismRouting(...)` builds and persists routing before hypotheses
- `resumeMechanismRouting(...)` returns persisted pending work and the frozen
  baseline checkpoint
- `retireMechanismRouting(...)` closes an unused route through an immutable,
  reason-bound receipt
- `recordAdaptiveControlEvidence(...)` accepts only independently bound paired
  artifact references, derives the numeric evidence inside the engine, and
  writes the resulting application revision
- `importAdaptiveExecutableCanary(...)` re-verifies a persisted V4 canary and
  idempotently persists its family plus routing-only import receipt
- `advanceMetaPolicy(...)` creates bounded epochs from supervisor-owned evidence

These methods are operator/supervisor-only and are not MCP tools.

### Durable parent scheduler

`src/campaign-scheduler-state.mjs` owns the private
`campaign-scheduler-checkpoints-v1.jsonl` ledger under the parent run directory.
Each logical append binds the exact campaign config, previous checkpoint,
canonical snapshot, sequence, status, and SHA-256. The snapshot includes the
remaining queue, active target, deterministic child run ID, counters, coverage,
deduplication sets, pending and banked promotion state, child run set, and
idle/mining epoch.

The supervisor checkpoints before worker exposure and after every accepted
attempt or scheduler transition. On a cold restart it refuses config or hash
drift, restores in-flight work ahead of the remaining queue, reuses the child
run ID, reopens completed child tests, and does not launch another worker for a
route already proven complete. Missing external-call receipts never count as
progress; a hard crash during an unreceipted external invocation may require
replay, but cannot fabricate a completed attempt.

### Automatic V4 import completion

`src/adaptive-canary-auto-import.mjs` closes the production runner boundary.
When `adaptiveMemoryImportEnabled:true` was sealed into the approved V4 plan, a
causal PASS must clear the verifier-owned import before the CLI exits zero. The
import remains routing-only and idempotent. A valid causal FAIL exits as valid
evidence without creating positive memory, while an invalid experiment or a
causal PASS whose import refuses cannot report closed-loop success.

## Ordinary Supervisor Integration

In `active-canary` mode the ordinary supervisor now enforces this order:

1. freeze and measure the baseline;
2. select only the strongest semantic revision of each application;
3. exclude every application that is not reverified, tool-authoritative,
   control-complete, transfer-checked, and fully provenance-bound;
4. build the route and permanent control allocation;
5. compile executable treatment packets against the target interface;
6. persist the route, capsule, and treatment;
7. bind and register hypotheses;
8. run pending tests, including across a cold supervisor restart;
9. admit paired control evidence and then update or roll back policy;
10. leave canonical adoption and the operator stop boundary unchanged.

A route with registered untested hypotheses blocks replacement. The supervisor
reuses the persisted frozen baseline and drains those hypotheses first. An
unused prepared route can be retired only with one of the allowlisted operator
reason codes, and the receipt is written beside the route artifacts.

The public dashboard derives route progress from persisted hypotheses and tests.
It exposes `PREPARED`, `PENDING_TESTS`, `ROUTE_COMPLETE`, and `RETIRED` instead
of treating every consumed route as generically active.

The ordinary supervisor does not manufacture causal controls from aggregate
scores. Until a real paired evaluator supplies baseline/routed/sham evidence,
the application remains provisional and cannot update policy, route future
work, or auto-bank. The separately verified executable canary and transfer
cohort are the production proof paths for that evidence.

## State Boundary

Active runs may add `state.adaptiveIntelligence`. Public console and dashboard
serialization must use an explicit allowlist and expose only:

- mode and `affectedExecution`
- routing decision and packet hashes
- selected family IDs, allocation class, evidence strength, and reason codes
- policy epoch ID/hash, drift tier, and bounded allocations
- automatic decision disposition and reason codes
- pending human decision count
- quarantined family IDs and rollback status

Mechanism prose, prompts, evidence paths, locators, raw target text, environment
values, and source run/test IDs remain private.

## File Ownership

Main integrator exclusively owns existing shared files:

- `src/engine.mjs`
- `src/supervisor.mjs`
- `src/store.mjs`
- `src/dashboard.mjs`
- `src/console.mjs`
- `src/server.mjs`
- `src/constants.mjs`
- `package.json`
- existing shared tests and documentation

The reserved Qwen lane is new-file-only:

- `src/adaptive-records.mjs`
- the five new JSON schemas
- `test/adaptive-records.test.mjs`

The exact Alibaba Token Plan `qwen3.8-max-preview` route was consulted before
this freeze. Its Claude-compatible adapter returned no usable final response
after an interrupted call, a server-side 500, and bounded no-tool streams.
Those attempts made no repository edits. Until the route produces a complete
handoff, the main integrator may implement the reserved lane and must review it
under the same tests and ownership boundary.

## Activation Claim

Shipping this architecture does not establish recursive self-improvement.
Activation eligibility requires all of the following from one persisted
`adaptive-meta-canary-v2` run:

- three valid proposal receipts
- fifteen valid blinded evaluation receipts
- a valid six-call no-memory qualification with failures on at least four of
  five evaluator-only shards
- routed paired wins over baseline
- no material sham movement
- no control regression
- exact partition isolation
- complete model, schema, token, stdout, result, artifact, packet, family, and
  policy hashes
- promotion disabled during the experiment
- an independent verifier exit code of zero

The v2 canary has three sealed evidence partitions:

1. Proposal-visible development evidence is shared across the no-memory,
   routed, and sham proposal arms.
2. Evaluator-only held-out evidence is divided into exactly five path-disjoint
   shards whose source bytes and target challenge signatures are also distinct.
   Renaming or copying one benchmark case cannot manufacture five shards. Every
   evaluator receives one shard only. Proposal workers receive no held-out path,
   case ID, prompt, locator, or source byte. Shard IDs, case IDs, prompts,
   locators, and evidence paths must also be globally substring-disjoint so one
   shard cannot carry another shard's hidden identity under a suffixed alias.
3. Historical mechanism evidence is private provenance. Its paths, locators,
   and source bytes reach no worker. The routed proposal receives only the
   deterministic mechanism capsule distilled from that history.

Preflight rejects a private mechanism path, locator, or complete source body
that appears in any configured worker-visible partition. Independent
verification checks proposal inputs for all three forms and evaluation inputs
for private paths or complete source bodies. Evaluation outputs may
independently reproduce ordinary mechanism phrases; phrase overlap alone is not
treated as proof that raw private provenance crossed the boundary.

New launchable v2 configs bind this behavior with
`privateEvidencePolicy: "source-qualified-v2"`. Persisted runs created before
that field remain verification-compatible under their sealed legacy policy,
but a new launch without the field fails preflight.

The proposal brief states the observed problem and protected invariants without
including the supervisor-only operation, expected movement, expected decision
code, or held-out cases. The evaluator receives only an opaque arm ID, the
active procedure, one hidden shard, and the output contract. It receives no
mechanism, proposal brief, hypothesis details, development evidence, oracle, or
other shard.

Before routed or sham work, v2 runs one no-memory proposal against all five
hidden shards. Fewer than four target failures produces an independently
verifiable `NO_HEADROOM` result after six calls. That is a valid negative
experiment, not activation evidence. Only a qualified run spends the remaining
twelve calls.

Persisted `adaptive-meta-canary-v1` runs remain verification-compatible. New
plan and execution commands reject v1 configs; legacy support is read-only and
cannot launch another answer-visible experiment.

## Adaptive Meta-Canary Commands

The adaptive proof is separate from the shipped one-proposal canary. It uses no
retries and cannot promote anything. A full qualified run makes three proposal
calls plus fifteen blinded evaluation calls. An unqualified run stops after one
proposal plus five evaluations.

```bash
npm run meta-canary:plan -- \
  --config <filled-config.json> \
  --run-id <new-run-id> \
  --home <proof-home>
```

The plan command prints the exact plan SHA-256, strict Codex argv, six-call
qualification boundary, conditional twelve-call continuation, 18-call maximum,
180-minute sequential timeout ceiling, and the absence of hard token or USD
ceilings. It launches no worker. The plan hash binds all three evidence
manifests, five shard identities and schedules, a fixed manifest of the runner,
verifier, transitive local
dependencies, output schemas, package command surface, and active loop bytes.
The matching implementation capsule is persisted but never included in a
worker prompt. Changing any bound implementation byte changes the plan hash.
Before a plan can be sealed, the supervisor records and hashes the exact Codex
executable, `codex-cli` version, `Logged in using ChatGPT` status, authenticated
model-catalog entry for `gpt-5.6-sol`, and support for reasoning `high`. Every
worker then runs that executable with explicit `-m gpt-5.6-sol`, API-key and
custom-base-url credentials removed, and the authority hash bound into its
receipt. A backend model field in the Codex JSON stream is optional because the
current OAuth CLI may omit it; if present it must match or the run fails
immediately. The verifier reports backend identity separately as
`REPORTED_MATCH`, `PARTIAL_MATCH`, `UNAVAILABLE`, or `MISMATCH`. An unavailable
backend echo is never described as independently reported identity.

Rejected calls are still paid calls. Their stdout, stderr, final output when
present, prompt, contract, hashes, and token usage are persisted and included
in total exposure. An aborted run reports causal metrics as `null` with outcome
`INCOMPLETE`; it does not invent zero wins or control regressions. `noRetries`
describes the observed attempt schedule independently from run completeness.

After the operator approves that exact hash, the disclosed launch command runs
the canary once and immediately invokes:

```bash
npm run verify:meta-canary -- --home <proof-home> --run <run-id>
```

## Confirmatory Transfer Cohort

`adaptive-transfer-cohort-v1` is the deeper causal test used after individual
v2 canaries have produced ties, no-headroom stops, or benchmark-specific
failures. It does not weaken or replace v2. It tests one frozen mechanism
family across five prospectively sealed tasks and analyzes every task.

Each task receives three proposal arms:

- no-memory baseline;
- evidence-routed mechanism capsule;
- schema-identical irrelevant sham.

Each proposal receives one blinded task-specific evaluation. The cohort
therefore has fifteen proposal calls and fifteen evaluation calls. There is no
qualification stop or conditional continuation. A task cannot be discarded or
replaced after any model sees it.

The deterministic schedule rotates arm order by task and runs sixteen
stage-separated waves with at most two calls in a wave. Each call uses its own
child process and fresh strict Codex capsule. The parent process never mutates
state concurrently: it waits for the wave, verifies each atomically persisted
packet envelope, then records results in frozen slot order. If one slot fails,
its already-launched sibling remains evidence and no later wave launches.

Activation eligibility requires routed target quality to strictly beat paired
baseline on all five tasks, zero sham wins, zero routed control regressions,
and every integrity gate. Five directional wins out of five have a
predeclared one-sided exact sign-test probability of `1/32 = 0.03125` under an
exchangeable paired null. Token difference is secondary and cannot rescue a
quality tie or regression. Promotion remains disabled.

Plan without launching:

```bash
npm run transfer-cohort:plan -- \
  --config <filled-cohort-config.json> \
  --run-id <new-run-id> \
  --home <proof-home>
```

The planner prints the exact 30-call schedule, maximum concurrency `2`, sixteen
waves, strict Sol argv, 160-minute timeout ceiling, non-binding historical
token estimate, missing hard token/USD ceilings, endpoint, and plan SHA-256. It
always exits before execution unless the exact hash is supplied, and even an
approved plan command never launches a worker.

After separate operator approval, the disclosed launch command runs the cohort
once and the independent verifier is:

```bash
npm run verify:transfer-cohort -- --home <proof-home> --run <run-id>
```

The verifier reopens the sealed config, implementation, evidence partitions,
thirty packet envelopes, prompts, schemas, model receipts, measurements, wave
schedule, task routing records, no-retry state, and no-promotion state. A valid
causal `FAIL` exits zero because experiment integrity and treatment outcome are
reported separately.
