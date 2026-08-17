# Improvement Memory Contract

Status: additive release contract

## Purpose

Loop Factory may record what happened to a predeclared hypothesis without asking
a model to invent a retrospective explanation. Version 1 adds an append-only
mechanism ledger and an off-by-default shadow router. It does not change the
objective, benchmark, verifier, promotion thresholds, hypotheses, or execution.

## Immutable Boundary

The following remain outside the adaptive layer:

- task objective and acceptance criteria;
- baseline bytes and benchmark definition;
- measurement and quality authority;
- integrity, transfer, reverify, and promotion gates;
- held-out partition rules;
- operator stop authority.

`metaLearning` is optional run configuration. Existing runs without it require
no migration and retain their current behavior.

```json
{
  "metaLearning": {
    "enabled": true,
    "mode": "shadow",
    "policyId": "meta-policy-v1",
    "seed": "operator-or-plan-bound-safe-id"
  }
}
```

Any mode other than `shadow` is outside this release contract.

## Canonical Receipt

The schema is `src/schemas/improvement-mechanism.schema.json`.

The receipt is derived from persisted run state:

- the registered hypothesis supplies the mechanism description;
- the frozen benchmark and baseline supply the target and comparison bar;
- the persisted test supplies the measured outcome;
- reverify state supplies independent confirmation;
- artifact records supply provenance hashes;
- optional canary overlays may supply sham, control, and transfer outcomes.

Canonical JSON recursively sorts object keys and preserves array order.

`mechanismId` is `mech-` plus the first 24 hexadecimal characters of the
SHA-256 of the canonical mechanism identity:

```text
runId + findingId + hypothesisId + title + bottleneck + operation
```

`receiptSha256` is the SHA-256 of the canonical receipt payload before
`receiptId` and `receiptSha256` are attached. `receiptId` is `receipt-` plus the
first 24 hexadecimal characters of `receiptSha256`.

Receipt files live under:

```text
<home>/mechanisms/receipts/<receiptId>.json
```

The append-only index lives at:

```text
<home>/mechanisms/ledger.jsonl
```

An identical existing receipt is idempotent. Existing bytes may never be
overwritten. A conflicting receipt ID is refused.

Gate-partition receipts may be retained as local evidence, but
`eligibleForRouting` must be false. Default routing reads only harvest receipts.

## Ledger Module Interface

`src/improvement-memory.mjs` exports:

```js
buildImprovementMechanismReceipt({
  state,
  hypothesisId,
  testId,
  clock,
  readArtifact,
  evidenceRefs,
  outcomeOverlay
})

persistImprovementMechanismReceipt({ homeDir, receipt })

listImprovementMechanismReceipts({
  homeDir,
  partitions,
  includeIneligible
})

summarizeImprovementMechanisms(receipts)
```

Public functions return structured success or refusal results. Persistence and
parsing errors do not throw through the campaign engine.

## Shadow Router Interface

`src/meta-policy.mjs` exports the frozen `META_POLICY_V1`.

`src/mechanism-router.mjs` exports:

```js
buildShadowMechanismPacket({
  receipts,
  target,
  seed,
  policy
})
```

The packet contains at most:

- two related positive mechanisms;
- one adjacent positive mechanism;
- one seeded wildcard;
- one failure-derived mechanism.

It records the eligible pool, scores, slot reasons, selection probabilities,
receipt hashes, policy hash, seed, packet hash, and abstention reason.

The router must be deterministic for identical inputs. Insufficient eligible
evidence returns an abstention rather than filler.

## Engine Integration

The main integrator owns all existing shared files.

When `metaLearning.enabled !== true`, no receipt or packet is created and
existing decisions remain unchanged.

When enabled:

1. `test_hypothesis` records an observed receipt after the test is persisted.
2. `reverify_run` records a new immutable receipt revision reflecting reverify.
3. `register_hypotheses` may build and persist a shadow packet before storing
   hypotheses, but the packet is never passed into or used to modify them.
4. Any meta-layer error records `META_POLICY_FALLBACK` and execution continues
   under the supplied hypotheses.

No model-callable tool may mutate the mechanism ledger or policy.

## Public Dashboard Contract

The allowlist serializer may expose only:

- enabled flag and `shadow` mode;
- policy ID and SHA-256;
- receipt counts by lifecycle and routing eligibility;
- packet status and SHA-256;
- selected mechanism, receipt, source run, hypothesis, and test IDs;
- slot, numeric score, and selection probability;
- abstention or `META_POLICY_FALLBACK` code;
- `affectedExecution: false`.

Mechanism prose, raw paths, locators, prompts, artifacts, and private task text
must not enter the public console snapshot.

## Release Claim Boundary

Phase 1 supports: "Loop Factory records deterministic, evidence-bound mechanism
receipts for measured attempts."

Phase 2 supports: "Loop Factory can route those receipts in shadow mode without
changing hypotheses."

Neither phase supports a claim of recursive self-improvement or improved
hypothesis quality. That requires an independently verified meta-canary.
