# Hybrid Retrieval Design

Status: implemented; offline fixture comparison complete; live utility not yet
measured.

## Pipeline

1. Validate evidence-record bytes and authority metadata.
2. Reject future, duplicate, quarantined, retired, incompatible, or unverified
   records.
3. Rank the eligible pool lexically and, when supplied, semantically.
4. Allow a fresh-context model to rerank eligible IDs only.
5. Fall back deterministically on malformed, hallucinated, or abstaining model
   output.
6. Select the strongest positive, strongest negative, a structurally diverse
   alternative, and one uncertainty item only when preregistered.
7. Freeze the pool, scores, selections, source hashes, and ranking authority.

## Evidence Authority

A hash-shaped caller claim no longer creates eligibility. Records have explicit
`unverified`, `fixture`, or `verifier-owned` authority. Fixture records require
`allowFixtureRecords: true` and production preparation refuses that switch.
Verifier-owned records enter the ledger only after the source recursive run,
lease, preparation proof, completion time, task partition, task-pack hash, and
primary verifier evidence replay from the same local store.

## Chronological Evaluation

`src/retrieval-benchmark.mjs` replays each case using only evidence available at
that historical decision time. It compares deterministic, lexical, semantic,
unfiltered model, hybrid-ranked, and hybrid diversity/negative strategies.

The current eight-case artifact is synthetic and marked `fixtureOnly: true`.
It verifies contracts and leakage resistance, not real downstream superiority.
See `RETRIEVAL_EVAL_RESULTS.json` and `10_RETRIEVAL_BENCHMARK.md`.

## Security Boundary

The reranker cannot restore quarantine, change compatibility, rewrite evidence,
or activate a mechanism. Candidate IDs outside the frozen pool invalidate the
model result. Secret-bearing keys and oversized/cyclic content are rejected
before persistence.
