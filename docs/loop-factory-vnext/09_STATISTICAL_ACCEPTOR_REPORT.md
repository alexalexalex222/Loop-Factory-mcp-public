# Statistical Acceptor Report

Status: implemented and verified offline; no generalized live effect claim.

## Decision Layers

1. Objective task and artifact verification.
2. Optional isolated semantic measurement.
3. Replicate averaging within each task cluster.
4. Placebo/sham, regression, and cost gates.
5. PACE-style paired anytime-valid evidence for one fixed candidate.
6. Campaign-level allocation across adaptive candidate proposals.
7. Untouched confirmation before routing admission.

Replicates are never treated as independent scientific observations. Confidence
bounds and sign tests use one mean effect per task cluster. The former 15-block
inference path was removed; five tasks produce a sample size of five.

## Offline Comparison

On predeclared synthetic streams:

- consistent gain: PACE accepted at task 8 with wealth `25.62890625`;
- null effect: PACE did not accept, final wealth `1`;
- alternating noise: greedy acceptance committed at task 1, while PACE did not
  accept and ended at wealth `0.177978515625`.

These are fixture checks of rule behavior, not empirical agent gains. Evidence:
`proof/vnext-offline-evidence/ACCEPTOR_EVAL_RESULTS.json`.

## Important Reachability Limit

With five task clusters, the minimum exact one-sided sign-test p-value is
`0.03125`. A two-generation Bonferroni allocation of `0.025` per generation is
therefore incapable of routing admission under that legacy campaign endpoint.
The system now reports those runs as development advances rather than using 15
replicates to manufacture significance. A future protocol must preregister more
independent task clusters or use a separately justified campaign-level
anytime-valid design. Gates were not weakened to preserve the old claim.
