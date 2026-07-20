# Natural-Run Frontier Adjudication Loop

## Freeze and apply the procedures

Freeze the original mined workflow, each substantive challenger, the format-only sham, the historical work records, and the promotion configuration before execution. The configuration must declare the minimum quality gain, cost-regression tolerance, minimum cost saving, and comparison rule. Apply every procedure to every record without exposing comparative roles to workers, then persist each output and its CLI receipt before scoring.

## Compute authoritative measurements

For each procedure–record result, run the record-specific four-check rubric implemented by `scoreCase`. Quality is the fraction of checks satisfied. For each procedure, compute mean quality across all records and sum its application-token receipts.

Treat receipt validity and the format-only sham guard as experiment-validity checks, not frontier movement. A challenger is eligible for production adjudication only when its measurements are tool-derived and its evidence has passed deep re-verification. Preserve the original procedure's aggregate quality and token total as the frozen baseline.

## Adjudicate every substantive challenger

Evaluate each substantive challenger independently against the frozen original by invoking the policy implemented by `evaluatePromotion` in `src/scorecard.mjs`. Pass the frozen baseline aggregate, the challenger aggregate with `source: "tool"` only for tool-derived measurements, its re-verification status, the frozen thresholds, and the predeclared comparison rule.

Do not rank challengers by mean quality followed by token usage, and do not use cost merely to break a quality tie. Cost can establish an independent frontier win only when it satisfies the configured minimum saving while quality is held. Exclude the format-only sham from substantive promotion even though it remains a required control.

## Preserve the policy verdict

Apply the production policy in its fail-closed order and persist both its verdict kind and supervisor code:

1. Reject non-tool measurements with `MODEL_REPORTED`.
2. Reject evidence that has not been deeply reverified with `NOT_REVERIFIED`.
3. Reject any challenger below the baseline quality floor with `BELOW_FLOOR`, regardless of its cost saving.
4. Accept a challenger as `QUALITY_FRONTIER` with code `PROMOTE` when its quality gain meets the minimum and its cost regression stays within tolerance.
5. Accept a challenger as `COST_FRONTIER` with code `PROMOTE` when its cost saving meets the minimum and quality does not regress.
6. When quality improves but cost exceeds tolerance, or cost improves while quality falls, apply only an explicitly predeclared `quality-first` or `cost-first` rule that authorizes that tradeoff. Under `pareto` or without such authorization, reject promotion with `STAGED_TRADEOFF`; staging is not a third acceptance disposition.
7. Reject all remaining movements with `BELOW_THRESHOLD`, including quality ties whose savings do not meet the minimum cost-saving threshold and positive quality changes below the minimum quality gain.

A lower token total therefore cannot rescue a threshold miss or quality-floor failure. A selected or staged result cannot override the policy verdict.

## Persist the adjudication

For every challenger, record its aggregate quality and token total, measurement authority, re-verification status, deltas from the frozen original, comparison rule, verdict kind, supervisor code, and accepted-for-promotion boolean. Also record receipt validity and the sham-guard result separately as experiment-validity evidence.

If multiple challengers receive `PROMOTE`, retain each frontier verdict unless the frozen comparison rule supplies an additional deterministic choice; do not manufacture a scalar winner. Keep external promotion execution disabled in this adjudication run: the procedure records promotion eligibility but performs no promotion mutation.
