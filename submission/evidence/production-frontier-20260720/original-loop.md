# Natural-Run Revision Adjudication Loop

## Freeze and apply the procedures

Freeze the original mined workflow, two substantive revisions, a format-only sham, and the three historical work records. Apply every procedure to every record without exposing comparative roles to workers. Persist each output and its CLI receipt before scoring.

## Compute deterministic quality

For each procedure–record result, run the record-specific four-check rubric implemented by `scoreCase`. Quality is the fraction of checks satisfied, producing values from 0 to 1. For each procedure, compute mean quality across all three records and sum its application-token receipts. Treat receipt validity and the format-only sham guard as experiment-validity checks, not as evidence that a revision improved the workflow.

## Select a revision

Rank revision A and revision B by descending mean quality. If their mean qualities tie, select the revision with lower total application-token usage. This token comparison is only a tie-break between the two revisions; it does not establish an independent cost-frontier win. Do not include the original or format-only sham in this revision-selection ranking.

## Decide whether the selected revision is better

Compare the selected revision with the original on every record. Mark it better only when all three conditions hold: its mean quality is strictly greater than the original mean, it wins at least two of the three records, and it regresses on none. The implemented quality-gain requirement is any strictly positive mean increase; there is no configured minimum gain threshold. A lower token total cannot make a quality-tied revision better, and the selection tie-break does not override the better decision.

## Persist the adjudication

Record the selected role, wins, regressions, better boolean, sham-guard result, aggregate quality, and token totals. Keep promotion disabled. A selected revision may therefore be reported while `better` remains false, as occurred when both revisions, the original, and the sham all scored 0.9167 and revision B was selected only by the revision tie-break.
