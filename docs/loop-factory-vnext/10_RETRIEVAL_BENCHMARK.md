# Retrieval Benchmark

Artifact: `RETRIEVAL_EVAL_RESULTS.json`

## Authority

This benchmark contains eight synthetic chronological cases. It is explicitly
`fixtureOnly: true`, has no historical-outcome authority, made no model calls,
and cannot support a generalized improvement claim.

## Fixture Results At K=2

| Strategy | Beneficial recall | Negative recall | Harmful rate | NDCG | Utility |
|---|---:|---:|---:|---:|---:|
| Current deterministic | 1.000 | 0.375 | 0.3125 | 0.9300 | 0.7625 |
| Lexical only | 1.000 | 1.000 | 0 | 0.9345 | 1.2000 |
| Semantic only | 1.000 | 1.000 | 0 | 1.0000 | 1.2000 |
| LLM only, unfiltered | 1.000 | 1.000 | 0 | 1.0000 | 1.2000 |
| Hybrid ranked | 1.000 | 1.000 | 0 | 1.0000 | 1.2000 |
| Hybrid diversity + negative | 1.000 | 1.000 | 0 | 1.0000 | 1.2000 |

The hybrid matched the valid frozen reranker and did not outperform it in this
fixture. The useful verified property is that deterministic filtering blocks
future, quarantined, incompatible, malformed, and hallucinated evidence before
reranking.

## Required Real Evaluation

A credible retrieval claim requires time-ordered real decision records with
later measured utility labels, a future-period holdout, matched token/latency
budgets, and downstream candidate outcomes. That dataset does not yet exist in
the isolated worktree.
