# Loop Factory Final Production Run

## Verdict

**PASS.** `production-frontier-20260720-r3` is a real, exact-model,
publication-eligible Loop Factory run. It mined one evidence-backed workflow,
measured the frozen original three times, generated two substantive revisions,
measured each revision three times, deep-reverified both wins, and queued both
for operator review without mutating a champion.

The independently invoked verifier passed execution, grounding, benchmark
integrity, isolation, comparability, coverage, and state consistency:

- `publicationEligible`: `true`
- evidence SHA-256:
  `07866647944a6b291eab0e2c8f8c677728039d94fbb86c6ab3e381bc22b9bd74`

## Measured Results

| Procedure | Quality | Mean CLI tokens | Quality variance | Delta quality | Delta cost | Reverified | State |
|---|---:|---:|---:|---:|---:|---|---|
| Original | `0.6190` | `61,270.3333` | `0.0674` | baseline | baseline | n/a | frozen |
| H1: explicit frontier verdicts | `1.0000` | `60,180` | `0` | `+0.3810` | `-1.78%` | yes | `rev-001` pending |
| H2: authority and reverification gates | `1.0000` | `60,193.3333` | `0` | `+0.3810` | `-1.76%` | yes | `rev-002` pending |

Both challengers got all seven frozen cases correct in all three independent
replicas. H1 is the recommended review because quality is tied, its measured
cost is slightly lower, and it repairs the broader adjudication mechanism.
That recommendation is not an approval; both reviews remain pending for the
operator.

## What Improved

The original loop ranks revisions by mean quality, uses tokens only as a
tie-break, and declares a revision better only when mean quality rises, at
least two records improve, and none regress.

H1 replaces that narrow rule with explicit production frontier adjudication:

- non-tool measurements fail with `MODEL_REPORTED`;
- unreverified evidence fails with `NOT_REVERIFIED`;
- quality regressions fail with `BELOW_FLOOR`;
- thresholded quality and cost wins receive `PROMOTE`;
- unresolved quality-cost trades remain `STAGED_TRADEOFF`;
- subthreshold movement remains `BELOW_THRESHOLD`;
- the sham remains a control rather than a promotion candidate.

The exact extracted procedures are:

- [Original](./original-loop.md)
- [H1 recommended](./improved-loop-h1.md)
- [H2 alternate](./improved-loop-h2.md)

## Execution Proof

- Real model calls: `12`
- Authentication: ChatGPT OAuth subscription
- Per-call API billing: not asserted
- Mining calls: `1`
- Baseline evaluations: `3`
- Proposal calls: `2`
- Challenger evaluations: `6`
- CLI-reported tokens: `724,453`
- Wall time: `401,711 ms` (`6m 41.711s`)
- Retries: `0`
- Unique Codex threads: `12`
- Unique capsule workspaces: `12`
- Requested model on every call: exact `gpt-5.6-sol`
- Reasoning on every call: `high`
- Model selection authority: explicit `-m` flag
- Exit codes: `12/12` were `0`
- Isolation: `12/12` were `PASS`
- Persisted artifact bodies: `34/34` rehashed cleanly
- Backend-reported model: absent on all calls; no conflicting identity was reported

The private run package retains the config, plan-only log, approval, run
states, raw receipts, reports, and live log. This public supplemental packet
contains the privacy-safe procedures, verifier result, bounded summary, and
dashboard frames. `summary.json` records the private package, config, plan,
benchmark, and verifier hashes. The protected canonical source fingerprints
remained unchanged during execution.

## Honest Boundaries

- No promotion was recorded. Both measured wins are waiting for operator review.
- `QUEUE_DRAINED` is a campaign checkpoint, not a claim that an endless factory
  has completed.
- The private child report cannot see the parent mining receipt and therefore
  displays a local validity failure. The parent run and independently invoked
  verifier are the authoritative experiment-level result.
- The earlier paid run remains preserved. It exposed disposition-normalization
  and deterministic-output route-gate defects; those defects were fixed and
  this run re-established the result from scratch.
- Raw provider transcripts and machine-specific capsule paths are deliberately
  excluded from this public packet. The portable transcript-backed judge path
  remains the July 19 causal canary checked by `npm run verify:submission`.

## Evidence

- [Bounded summary](./summary.json)
- [Independent verifier](./verifier.json)
- [Original procedure](./original-loop.md)
- [Recommended H1 procedure](./improved-loop-h1.md)
- [Alternate H2 procedure](./improved-loop-h2.md)
- [Validity frame](./screenshots/experiment-validity-desktop.png)
- [Score frame](./screenshots/score-table-desktop.png)
- [Approval frame](./screenshots/approval-desk-desktop.png)

## Ship Decision

The evidence is strong enough for the submission demo. The remaining product
decision is whether to approve `rev-001`, approve `rev-002`, deny one or both,
or leave them pending. The measured recommendation is `rev-001`.
