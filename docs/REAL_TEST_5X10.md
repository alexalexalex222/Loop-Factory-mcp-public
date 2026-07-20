# Strict real test: 5 findings / 10 improvement attempts

This is the pre-publication run. It is intentionally separate from the Build
Week controlled proof.

## What the counters mean

- A finding counts only when the supervisor accepts a unique candidate with a
  substantial baseline, one or more references into the approved source
  manifest, and exactly two substantive hypotheses that all appear in a mining
  output sealed by the supervisor.
- An improvement attempt counts only when a valid 3-5-run batch reaches
  tool-owned measurement with direct raw and extracted-result artifact links.
- Invalid workers, summary-only output, self-reported metrics, phase skips, and
  failed measurement do not count as progress.
- Each accepted finding receives exactly two valid attempts before its coverage
  is complete. Five findings therefore use the ten-attempt cap; fewer findings
  receive two attempts each without inventing work.
- Reaching the cap is an operator-set checkpoint, not a model claim that the
  campaign is complete.

## Benchmark lock

Strict mode will not launch workers until all of these are true:

1. The task and benchmark contain no unresolved placeholders.
2. The benchmark has at least two real cases.
3. The oracle is `case-results-v2` and scores the supervisor-native `accepted`
   decision, exact code, and evidence bindings. `BLOCKED` and `REJECTED` both
   represent `accepted: false`; unknown or opposite decisions fail.
4. Adversarial controls cannot pass and a known-correct control does pass.
5. Every explicit `evidenceSources` path exists inside the repository; its byte
   count and SHA-256 are sealed into the approved plan.
6. An explicit negative control fails that same oracle.
7. Route independence requires at least three captured runs.
8. No integrity overrides are present.
9. The generated plan SHA-256 is supplied back after operator review.
10. The primary, test, builder, judge, mining, baseline, and challenger routes
   are all locked to the exact `gpt-5.6-sol` model ID.

The supervisor freezes the approved benchmark through the maker path before any
worker runs. Worker benchmark proposals are ignored after that point.

The baseline bar is the mean of the same 3-5 captured routes used by challenger
batches. A single conveniently weak baseline response cannot set the bar.

## Pre-register the one-finding canary

Before spending the full 5x10 budget, freeze one real finding, one real
hypothesis, and a deliberately irrelevant sham edit. The canary uses three
arms: baseline, challenger, and sham. Each arm is pre-registered for five exact
`gpt-5.6-sol` evaluations against 6-10 frozen cases containing both target and
control groups. Promotion is disabled.

Start from:

`examples/real-test-canary.template.json`

Then run the plan-only command:

```bash
npm run real-test:canary-plan -- \
  --config proof/real-test/canary.json
```

The command resolves and hashes the explicit evidence sources, prints the
canary plan SHA-256, and exits blocked. It never launches a worker. After
reviewing the exact target, hypothesis, sham, cases, oracle, evidence locators,
and model routes, the operator may rerun the plan check with:

```bash
npm run real-test:canary-plan -- \
  --config proof/real-test/canary.json \
  --approved-plan <APPROVED_CANARY_PLAN_SHA256>
```

`CANARY_PLAN READY` means only that the pre-registration is internally valid.
It is not a model run and it is not evidence of improvement.

After approving that exact hash, launch the executable canary with a fresh run
ID and proof home:

```bash
SUPER_LOOP_ALLOW_EXEC=1 npm run real-test:canary -- \
  --config proof/real-test/canary.json \
  --approved-plan <APPROVED_CANARY_PLAN_SHA256> \
  --run-id real-test-canary-001 \
  --home proof/real-test/canary-live/state
```

The runner makes one proposal call and fifteen evaluations: five baseline, five
challenger, and five sham. Evaluation order is plan-locked and interleaved. The
worker sees opaque arm labels, not `baseline`, `challenger`, or `sham`.
Promotion is disabled.

Each strict Codex worker runs in a fresh empty capsule directory with user
config and rules ignored, shell/browser/computer/subagent feature surfaces
disabled, read-only sandboxing, and a contract-specific JSON output schema.
The supervisor normalizes that schema output into the persisted wrapper and
hash-links both forms to the raw CLI transcript.

The completed run writes `state.json`, raw/final/evaluation artifacts, and
`canary-report.md` under the run directory. Experiment validity and canary
outcome are separate:

- `experimentValid: true` means all scorer, receipt, isolation,
  schema-identity, measurement-rederivation, schedule, and no-promotion gates
  passed.
- `outcome: PASS` additionally requires challenger target wins in at least four
  of five paired evaluations, zero sham wins, and zero control regressions.
- A valid experiment may honestly return `outcome: FAIL`. That is evidence that
  the proposed improvement did not clear the canary, not a harness failure.

Recompute canary validity directly from the persisted artifacts with:

```bash
npm run verify:canary -- \
  --home proof/real-test/canary-live/state \
  --run real-test-canary-001
```

The command is read-only and exits nonzero unless every canary experiment-
validity gate rederives from disk. A valid experiment can still have
`outcome.status: FAIL`.

## Prepare the config

Start from:

`examples/real-test-5x10.template.json`

Replace every bracketed value with facts from the actual target and actual
failure cases. List every repository-relative source the miner may cite under
`evidenceSources`. The runner reads and hashes those files before printing the
approval plan. The template is deliberately rejected while placeholders remain.

## First command: plan only

```bash
npm run real-test -- \
  --config proof/real-test/campaign.json \
  --run-id real-test-5x10 \
  --stop-file proof/real-test/STOP
```

This exits with `REAL_TEST_CONFIG BLOCKED`, prints the plan hash, and launches no
worker. Review the task, cases, structured oracle, source manifest, negative
control, routes, and hashes.

## Second command: approved live run

Only after the operator approves the printed hash:

```bash
SUPER_LOOP_ALLOW_EXEC=1 npm run real-test -- \
  --config proof/real-test/campaign.json \
  --approved-plan <APPROVED_PLAN_SHA256> \
  --run-id real-test-5x10 \
  --stop-file proof/real-test/STOP \
  --dashboard-port 8787
```

The strict command ignores attempts to raise the valid improvement cap above
ten. `remineOnEmpty` is forced off.

The dashboard is served at:

`http://127.0.0.1:8787/?run=real-test-5x10`

Per-candidate measured runs use `real-test-5x10-t1`, `-t2`, and so on. The run
index at `http://127.0.0.1:8787/` lists them.

The dashboard and report show the exact finding coverage matrix, raw/final
receipt links, CLI-reported total tokens separately from the artifact-output
token estimate, and a machine-owned experiment-validity result. A valid
no-improvement experiment does not require a promotion.

Dashboard and report generation re-run the verifier from disk before rendering;
they do not trust the last persisted eligibility summary. You can also audit a
run without invoking the engine:

```bash
npm run verify:run -- \
  --home proof/real-test/live-5x10/state \
  --run real-test-5x10
```

The command is read-only, prints deterministic JSON plus an evidence SHA-256,
and exits nonzero if any directly linked state, receipt, raw output, normalized
final output, evaluation artifact, model identity, token count, isolation flag,
coverage counter, benchmark lock, or promotion fact fails to rederive.

## Separate-chat kickoff

Paste this into the new Codex task after naming the real target:

```text
Work only in the Loop Factory repository root.
Do not publish, push, deploy, or edit the hash-locked loops.
Use exact model gpt-5.6-sol.

Read docs/REAL_TEST_5X10.md and
examples/real-test-5x10.template.json.

Prepare proof/real-test/campaign.json from the real target and real prior
failures. Use the structured case oracle and explicit repository-relative
evidenceSources. Do not invent benchmark cases, expected dispositions/codes,
baselines, evidence, hypotheses, or success criteria.

Run the plan-only command first. Show me the complete benchmark summary and
the plan SHA-256, then STOP. Do not pass --approved-plan yourself and do not
launch any worker until I explicitly approve that exact hash.

After approval, run the strict real test. Five accepted findings maximum,
exactly two substantive hypotheses and valid attempts per accepted finding,
and ten valid attempts maximum globally. Invalid or fake work must be rejected
and excluded from progress. Do not call queue drain, cap reached, saturation,
a dashboard update, or a pre-reverify movement signal a win. Only report
measured state and experiment validity from the supervisor ledger.
```

## Cost boundary

Three Sol runs are used for each baseline batch and each valid improvement
attempt. A five-finding / ten-attempt run can therefore make dozens of model
calls. Invalid workers are excluded from progress but retries can still consume
calls. The one-finding canary makes sixteen calls when every dispatch is valid:
one proposal plus fifteen blinded evaluations. The operator can create the stop
file for the 5x10 campaign at any time.
