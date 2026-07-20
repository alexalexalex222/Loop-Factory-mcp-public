# Natural-Run Revision Adjudication Loop

## Freeze and apply the procedures

Freeze the original mined workflow, two substantive revisions, a format-only sham, and the three historical work records. Apply every procedure to every record without exposing comparative roles to workers. Persist each output and its CLI receipt before scoring.

## Compute deterministic quality

For each procedure–record result, run the record-specific four-check rubric implemented by `scoreCase`. Quality is the fraction of checks satisfied, producing values from 0 to 1. For each procedure, compute mean quality across all three records and sum its application-token receipts. Treat receipt validity and the format-only sham guard as experiment-validity checks, not as evidence that a revision improved the workflow.

## Select a revision for adjudication

Rank revision A and revision B by descending mean quality. If their mean qualities tie, select the revision with lower total application-token usage. This comparison chooses which substantive revision proceeds to adjudication; it does not establish a quality or cost-frontier win. Do not include the original or format-only sham in this ranking.

## Gate measurement authority and reverification

Before comparing the selected challenger with the original, require supervisor-owned measurement evidence. If the challenger source is not `tool`, or its quality authority is not `tool-computed`, reject it with `MODEL_REPORTED`; caller-reported and model-reported measurements cannot proceed to frontier adjudication. Next require successful deep reverification of the persisted evidence. If the otherwise valid challenger is not reverified, reject it with `NOT_REVERIFIED`.

These gates change eligibility only. They must not alter the recorded quality, token cost, or their deltas. Only a challenger clearing both gates may reach the quality floor, thresholds, and tradeoff rules below.

## Decide frontier movement

Compare the eligible challenger with the original using the frozen promotion thresholds and comparison rule.

1. Reject with `BELOW_FLOOR` if challenger quality is lower than original quality, regardless of token savings.
2. Accept with `PROMOTE` as a quality-frontier result when the quality gain is at least `minQualityGain` and the token-cost regression is no greater than `costRegressionTolerance`.
3. Accept with `PROMOTE` as a cost-frontier result when token savings are at least `minCostSaving` and quality does not regress.
4. When quality improves but cost exceeds tolerance, or cost falls while quality regresses, apply the predeclared comparison rule. Under `quality-first`, accept a qualifying quality gain; under `cost-first`, accept a qualifying cost saving. Otherwise reject promotion with `STAGED_TRADEOFF` for operator judgment.
5. Reject with `BELOW_THRESHOLD` when neither frontier condition nor a predeclared tradeoff rule authorizes promotion. A quality tie with merely lower tokens is therefore insufficient unless the saving reaches `minCostSaving`; the earlier revision-selection tie-break cannot override this decision.

## Preserve experiment-validity checks

Independently verify that every planned call has a valid receipt, explicit model-selection authority, successful exit, passing isolation, no retry, and positive CLI token usage. Recompute every deterministic score from persisted outputs. The format-only sham guard passes only when the sham mean quality does not exceed the original mean. Neither check supplies measurement authority, reverification, or frontier movement by itself.

## Persist the adjudication

Record the selected role, per-record scores, aggregate quality, token totals, measurement source, quality authority, reverification state, quality and cost deltas, frontier kind, supervisor code, acceptance boolean, sham-guard result, and receipt validity. Keep promotion execution disabled: this procedure records eligibility but does not perform an external promotion action. Preserve the distinction between selection and eligibility—a revision may be selected by the experimental tie-break yet rejected by an authority gate, reverification gate, quality floor, threshold, or unresolved tradeoff.
