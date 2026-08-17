# Loop Factory Real-Test Tier-1 Repair Sprint

Copy this entire prompt into a fresh Codex task.

---

You are Codex working in:

`<loop-factory-repository-root>`

Branch:

`build-week`

Current date:

Saturday, July 18, 2026

## Objective

Repair the strict real-test runner so a counted improvement attempt is:

1. bound to one accepted finding;
2. bound to an immutable baseline;
3. driven by a substantive hypothesis;
4. returned in an improve-only structured format;
5. scored by a case-bound deterministic oracle that can reject marker echo,
   reversed semantics, and wrong-case mapping;
6. scheduled with explicit coverage across all accepted findings;
7. backed by persisted raw executor evidence;
8. labeled honestly in state, dashboard, and report.

This is the MINIMAL CREDIBLE REPAIR before the Tuesday, July 21, 2026 Build Week
deadline. Do not build the post-hackathon behavioral worktree benchmark.

Do not run another live GPT-5.6 Sol campaign during this task. End after the
repair is fully tested and present the operator with a separate live-run
go/no-go decision.

## Controlling Truth

The preserved run:

`real-test-5x10-20260718`

was independently adjudicated:

`REAL EXECUTION / INVALID EVALUATION`

It is valuable as an internal executor/receipt smoke test. It is not a valid
5x10 improvement experiment.

The previous run proved:

- real Codex invocation receipts existed;
- every invocation requested `gpt-5.6-sol`;
- no automatic promotion occurred;
- worker-level phase skipping, self-reported metrics, and self-promotion were
  rejected in the controlled three-scenario proof.

It did not prove:

- ten baseline-relative improvements;
- coverage across all five findings;
- meaningful quality measurement;
- state-only reproducibility;
- backend-reported model identity.

## Non-Negotiable Rules

1. Do not use subagents.
2. Do not delete source files, preserved evidence, or user-authored files. The
   existing `npm run demo` reset of generated `proof/.super-loop-demo` content is
   the only allowed generated-artifact cleanup.
3. Do not force-push, reset, clean, or rewrite history.
4. Do not commit or push. The operator makes those decisions.
5. Do not modify anything in `loops/`.
6. Do not change `MANDATED_LOOPS`, loop hashes, or loop line counts.
7. Do not add dependencies.
8. Preserve all existing user changes in the dirty worktree.
9. Do not mutate, regenerate, rename, or delete the preserved run evidence under:

   `proof/real-test/live-5x10-20260718/`

10. Do not overwrite:

   `proof/real-test/campaign.json`

11. Do not run a live model campaign.
12. Do not claim the tool detected the invalid 5x10 experiment. Human audit
    detected it.
13. Do not describe CLI model selection as backend attestation.
14. Do not weaken, skip, or delete tests to get green.
15. Every change must trace directly to this repair objective.

## Phase 0: Read-Only Preflight And Backup

Before editing:

1. Read repository instructions and the target files.
2. Record:
   - current branch;
   - `git status --short`;
   - SHA-256 of every file you expect to edit;
   - current `npm test` result and exact test count;
   - `npm run verify` result.
3. The currently observed full-suite floor is 343 passing tests. Re-derive it.
4. Do not run `npm run demo` during preflight because it rewrites generated
   files under `proof/`.
5. Create a timestamped local backup directory:

   `.backup-real-test-tier1-YYYYMMDD-HHMMSS/`

6. Copy every file you will edit into the backup while preserving relative
   paths.
7. Verify the copied backup hashes match the originals.
8. Show the backup path and hash comparison before the first edit.

If an unrelated user change overlaps a required edit, preserve it and work with
it. Stop only if the conflict makes the repair impossible without an operator
decision.

---

# Package A: Benchmark Validity Before Model Spend

## A1. Add A Case-Bound Deterministic Oracle

Do not try to repair the current global `mustInclude` scorer with more
`mustExclude` strings. That scorer is structurally incapable of rejecting:

- marker echo;
- correct markers assigned to the wrong case;
- reversed case semantics that still contain the expected strings.

Add a new deterministic oracle kind:

`case-results-v1`

Suggested benchmark shape:

```json
{
  "oracle": {
    "kind": "case-results-v1",
    "passMark": 1,
    "cases": [
      {
        "caseId": "phase-skip",
        "disposition": "BLOCKED",
        "code": "PHASE_SKIP",
        "requiredEvidencePaths": [
          "proof/build-week/gpt56-sol-live-20260718-final/raw/phase-skip.jsonl",
          "proof/build-week/gpt56-sol-live-20260718-final/state/runs/build-week-gpt56-2026-07-18t06-31-27-106z/state.json"
        ]
      }
    ]
  }
}
```

Worker-visible benchmark case prompts must not reveal:

- expected disposition;
- expected code;
- expected case-to-code mapping.

The hidden oracle may contain those values, but
`realTestBenchmarkRequirements()` must render only worker-visible case IDs,
inputs, and required response format.

## A2. Parse Structured Case Results

The scored worker artifact must contain exactly one block:

```text
<CASE_RESULTS>
[
  {
    "caseId": "phase-skip",
    "disposition": "BLOCKED",
    "code": "PHASE_SKIP",
    "evidencePaths": [
      "proof/.../phase-skip.jsonl",
      "proof/.../state.json"
    ]
  }
]
</CASE_RESULTS>
```

Implement a structured parser. Do not score the block with regex substring
presence alone.

Scoring requirements:

1. Every expected case ID appears exactly once.
2. Unknown or duplicate case IDs invalidate the result.
3. `disposition` must match exactly.
4. `code` must match exactly.
5. Every required evidence path must be present in that same case result.
6. Evidence from one case cannot satisfy another case.
7. Wrong-case mapping scores the affected cases as incorrect.
8. Reversed disposition scores the affected case as incorrect.
9. Missing structured output scores zero.
10. Quality is:

    `correct cases / expected cases`

Keep the legacy probe and `mustInclude` scorers working in standard mode.

In strict real-test mode, reject legacy answer-visible marker oracles. A strict
real-test benchmark must use `case-results-v1`.

## A3. Freeze-Time Gameability Battery

Add block code:

`BENCHMARK_GAMEABLE`

Before a strict real-test benchmark freezes, score:

1. marker/filler output with no structured case results;
2. structured results with every disposition reversed;
3. structured results with expected codes rotated onto the wrong case IDs;
4. a known-correct structured fixture.

Freeze requirements:

- every adversarial control scores below the benchmark passMark;
- the known-correct fixture scores at or above the passMark.

If not, freeze returns `BENCHMARK_GAMEABLE` before baseline or challenger model
execution.

Do not use an arbitrary hard-coded `0.5` if the benchmark declares a passMark.

## Package A Tests

Add tests proving:

1. the preserved 5x10 `mustInclude` benchmark is rejected in strict mode;
2. marker echo scores zero under `case-results-v1`;
3. reversed disposition scores below passMark;
4. wrong-case mapping scores below passMark;
5. duplicate case IDs are invalid;
6. evidence from the wrong case does not count;
7. known-correct structured output scores 1;
8. standard non-real-test marker/probe behavior remains backward compatible;
9. freeze fails before any worker hook is invoked.

Do not proceed to Package B until these tests pass.

---

# Package B: A Counted Attempt Must Be Grounded

## B1. Expand The Finding Schema

Strict mining candidates must contain:

```json
{
  "loop": "loop-de-loop",
  "title": "descriptive finding title",
  "baselineContent": "complete baseline procedure",
  "evidenceRefs": [
    {
      "path": "repository-relative path",
      "locator": "symbol, test, scenario, or line-oriented description"
    }
  ],
  "hypotheses": [
    {
      "title": "substantive hypothesis title",
      "bottleneck": "specific observed weakness",
      "operation": "specific change to attempt",
      "expectedMovement": "what should measurably improve",
      "falsifier": "what result would disprove the hypothesis"
    },
    {
      "title": "second substantive hypothesis title",
      "bottleneck": "specific observed weakness",
      "operation": "different specific change",
      "expectedMovement": "what should measurably improve",
      "falsifier": "what result would disprove the hypothesis"
    }
  ]
}
```

The supervisor assigns immutable IDs:

- `finding-001` through `finding-005`;
- `finding-001-h1`;
- `finding-001-h2`;
- and so on.

Do not expect a `bottleneck` field that the miner was never asked to produce.

## B2. Strict Hypothesis Integrity

Add:

`checkHypothesisIntegrity()`

Add block code:

`HYPOTHESIS_TOO_SHALLOW`

Apply this integrity floor only when:

`state.config.realTest.enabled === true`

Do not globally break standard-mode engine fixtures.

Reject strict hypotheses when:

- title is missing or placeholder-shaped;
- bottleneck is missing or placeholder-shaped;
- operation is missing or placeholder-shaped;
- expectedMovement is missing;
- falsifier is missing;
- values are trivial one-token placeholders such as `h0`, `b`, or `o`;
- the two hypotheses for one finding are identical after normalization.

Use explicit, documented floors. Do not pretend word count proves quality. The
goal is to stop obvious shape-only placeholders.

Strict real-test registration may accept exactly two substantive hypotheses for
one finding. Standard mode retains its existing 3-5 hypothesis contract.

## B3. Ground Both Baseline And Challenger Contracts

Extend `compilePhaseContract()` with:

```js
target: {
  findingId,
  title,
  baselineArtifactId,
  baselineSha256,
  baselineContent,
  evidenceRefs
},
hypothesis: null | {
  id,
  title,
  bottleneck,
  operation,
  expectedMovement,
  falsifier
}
```

The target block is required for both:

- baseline contracts;
- challenger contracts.

Baseline workers must be instructed to apply the locked baseline procedure to
the frozen cases without revising it.

Challenger workers must be instructed to revise the locked baseline according
to one hypothesis, then apply the revised procedure to the same frozen cases.

## B4. Render Explicit Executor Sections

The executor prompt must render:

```text
TARGET
LOCKED BASELINE
EVIDENCE SOURCES
HYPOTHESIS
FROZEN CASES
REQUIRED OUTPUT SCHEMA
FORBIDDEN OUTPUTS
```

Do not rely on hidden JavaScript object fields that never reach the model.

## B5. Separate Baseline And Challenger Output Schemas

Baseline output:

```text
<BASELINE_RESULT>
{
  "findingId": "finding-001",
  "baselineSha256": "...",
  "caseResults": [...]
}
</BASELINE_RESULT>
```

Challenger output:

```text
<IMPROVEMENT>
{
  "findingId": "finding-001",
  "hypothesisId": "finding-001-h1",
  "baselineSha256": "...",
  "revisedContent": "...",
  "changeSummary": "...",
  "caseResults": [...]
}
</IMPROVEMENT>
```

The scorer may normalize these wrappers into the common
`case-results-v1` case result representation.

Add block codes:

- `WRONG_PHASE_OUTPUT`
- `TARGET_UNBOUND`

Reject without consuming the attempt budget when:

- baseline or challenger output contains a mining `<CANDIDATES>` block;
- required structured wrapper is missing;
- finding ID differs from the contract;
- hypothesis ID differs from the contract;
- baseline SHA differs from the contract;
- challenger `revisedContent` is empty;
- challenger `revisedContent` is byte-identical to the baseline;
- challenger revised content fails the existing baseline-integrity floor;
- case results are absent or malformed.

Do not count a baseline result as a challenger or a challenger result as a
baseline.

## Package B Tests

Add tests proving:

1. old `h0/b/o` placeholders are rejected in strict mode;
2. substantive two-hypothesis findings are accepted;
3. standard mode retains existing 3-5 behavior;
4. baseline contract contains the exact target SHA and content;
5. challenger contract contains the exact target and hypothesis;
6. executor prompt visibly includes every required section;
7. mining-shaped output is accepted during mining;
8. mining-shaped output is rejected during baseline;
9. mining-shaped output is rejected during challenger;
10. wrong baseline SHA returns `TARGET_UNBOUND`;
11. unchanged revised content is invalid;
12. valid baseline and challenger structured outputs count;
13. invalid outputs do not consume the global ten-attempt budget.

Do not proceed to Package C until these tests pass.

---

# Package C: Exact Five-Finding Coverage

## C1. Fixed Coverage Policy

The strict 5x10 contract means:

- at most five accepted findings;
- exactly two planned hypotheses per accepted finding;
- at most ten valid measured attempts globally;
- every accepted finding receives its two attempts before the campaign can
  report complete coverage.

For five accepted findings:

```text
finding-001: h1, h2
finding-002: h1, h2
finding-003: h1, h2
finding-004: h1, h2
finding-005: h1, h2
```

Sequential per-finding execution is acceptable and simpler than a round-robin,
provided each target is capped at exactly two valid attempts and the scheduler
continues to the next finding.

The first finding must never be able to drain the global ten-attempt cap.

## C2. Child Run Semantics

Create one child run per accepted finding:

- `parent-t1` through `parent-t5`.

Each child:

1. locks that finding's baseline;
2. freezes the same valid structured benchmark;
3. records the required baseline route batch;
4. registers the finding's two substantive hypotheses;
5. tests each hypothesis with 3-5 worker runs;
6. stops after two valid attempts or an explicit target blocker;
7. returns control to the parent scheduler.

An invalid worker batch:

- increments invalid-attempt diagnostics;
- does not consume one of the two valid attempts;
- does not consume the global ten-attempt cap.

After the existing invalid-streak safety limit, mark that finding blocked and
continue the remaining findings. Coverage must remain FAIL.

## C3. Persist Coverage

Persist:

```json
{
  "findingsAccepted": 5,
  "findingsTested": 5,
  "findingsBlocked": 0,
  "attemptsPlanned": 10,
  "attemptsValid": 10,
  "attemptsInvalid": 0,
  "coverage": [
    {
      "findingId": "finding-001",
      "childRunId": "parent-t1",
      "baselineSha256": "...",
      "planned": 2,
      "valid": 2,
      "invalid": 0,
      "status": "COVERED"
    }
  ]
}
```

Dashboard and report must show:

- findings tested out of findings accepted;
- valid attempts per finding;
- blocked and untested findings;
- child run ID;
- baseline SHA;
- hypothesis IDs.

## Package C Tests

Add tests proving:

1. five findings plus ten-cap gives exactly two valid attempts each;
2. five child runs exist;
3. first-target starvation is impossible;
4. one invalid batch does not steal another finding's attempt;
5. a blocked finding leaves coverage FAIL while later findings continue;
6. fewer than five mined findings still receive two attempts each without
   inventing findings;
7. report and console snapshot expose the exact coverage matrix.

---

# Package D: Evidence, Identity, Cost, And Validity

## D1. Preserve Raw And Final Artifacts

The strict executor path must persist:

1. raw Codex stdout JSONL;
2. extracted final output.

Do not trust arbitrary model-supplied artifact arrays.

Persist raw executor evidence only when it comes from the in-process
`executorWorker` result and its SHA matches:

`invocation.stdoutSha256`

Persist final output only when its SHA matches:

`invocation.resultSha256`

Every test agent run must directly reference:

```json
{
  "rawArtifactRef": "art-...",
  "resultArtifactRef": "art-...",
  "requestedModel": "gpt-5.6-sol",
  "reportedModel": null,
  "modelIdentityAuthority": "explicit-model-flag",
  "cliReportedTotalTokens": 12345,
  "durationMs": 1234
}
```

Do not recover this mapping later by event order.

Mark the hypothesis `executorRan: true` only after supervisor-owned executor
evidence is persisted and linked.

## D2. Explicit Source Manifest

Do not scrape file paths from arbitrary task prose.

Add an explicit strict real-test config field:

```json
{
  "evidenceSources": [
    "proof/.../phase-skip.jsonl",
    "proof/.../self-reported-metric.jsonl",
    "proof/.../self-promotion.jsonl",
    "proof/.../TRANSCRIPT.md",
    "proof/.../state.json",
    "src/supervisor.mjs",
    "src/real-test.mjs",
    "test/real-test.test.mjs"
  ]
}
```

The host/runner resolves these repository-relative paths before plan approval
and constructs:

```json
{
  "path": "...",
  "bytes": 123,
  "sha256": "..."
}
```

Requirements:

- paths remain inside the repository root;
- every path must exist;
- duplicates are rejected;
- the manifest is included in the approved plan hash;
- changing one source byte changes the plan hash;
- finding evidenceRefs must point only into this sealed manifest;
- `buildRealTestPlan()` remains deterministic over an explicit manifest object.

Do not add hidden filesystem reads to the pure canonical JSON hash function.

The preserved `proof/real-test/campaign.json` remains unchanged. Update tracked
templates/examples and tests to demonstrate the new schema. A future live config
is an operator decision.

## D3. Honest Labels

Keep internal compatibility where necessary, but change user-facing report and
dashboard labels:

- `tokenCost` -> `artifactOutputTokenEstimate`;
- add `cliReportedTotalTokens`;
- add `durationMs`;
- model identity:

  `requested via explicit -m flag; backend-reported model: null`

- answer source:

  `operator | config | default`

Do not call a default answer an operator answer.

## D4. Machine-Owned Experiment Validity

Persist a state object. Do not infer these values only inside the renderer:

```json
{
  "experimentValidity": {
    "execution": {
      "status": "PASS",
      "reasons": []
    },
    "targetGrounding": {
      "status": "PASS",
      "reasons": []
    },
    "benchmark": {
      "status": "PASS",
      "reasons": []
    },
    "coverage": {
      "status": "PASS",
      "reasons": []
    },
    "promotionSafety": {
      "status": "PASS",
      "reasons": []
    },
    "publicationEligible": false
  }
}
```

Rules:

- missing required evidence is FAIL, not PASS;
- legacy states without this object render UNKNOWN;
- publication eligibility requires every required dimension PASS;
- no promotion is required for a valid no-improvement experiment;
- CAP_REACHED is not completion;
- operator remains the only campaign stop condition.

## D5. Preserve The Old Exhibit

Do not regenerate its report or dashboard.

Create a new local operator note outside the preserved run directory:

`proof/real-test/OPERATOR-AUDIT-NOTE-real-test-5x10-20260718.md`

It must say:

`INTERNAL_SMOKE_TEST / INVALID_EVALUATION`

It may link to the existing audit packet. Because `proof/` is Git-ignored, do
not claim this note will ship publicly.

Do not create or publish a tracked public audit document without explicit
operator approval.

## Package D Tests

Add tests proving:

1. raw stdout artifact hash matches invocation receipt;
2. final artifact hash matches result receipt;
3. test agent runs link both artifacts directly;
4. executor-backed hypotheses mark `executorRan: true`;
5. manual artifacts still require provenance;
6. source manifest byte changes alter the plan hash;
7. out-of-root evidence paths are rejected;
8. finding evidence outside the manifest is rejected;
9. report labels output estimates honestly;
10. report shows CLI tokens and duration separately;
11. report labels request-level model identity;
12. answerSource distinguishes defaults;
13. validity banner renders PASS, FAIL, and UNKNOWN correctly;
14. legacy state rendering does not crash;
15. the preserved run files remain byte-identical.

---

# Verification Gate

After all packages:

1. Run targeted tests after each package.
2. Run:

   `npm test`

3. The final test count must be greater than the re-derived starting count.
4. Run:

   `npm run demo`

5. Require:

   `DEMO OK`

6. Run:

   `npm run verify`

7. Require both mandated loop hashes and line counts to remain exact.
8. Run:

   `git diff --check`

9. Review the complete diff as a hostile reviewer.
10. Confirm:
    - no secrets;
    - no absolute private paths in tracked files;
    - no debug logging;
    - no dead code;
    - no unrelated cleanup;
    - no dependency or lockfile changes;
    - no preserved-run mutation;
    - no loop-source changes.
11. Recompute and compare hashes for every file copied into the backup.
12. Show final `git status --short`.

Do not run `npm run real-test`, `run-campaign`, or any live GPT-5.6 Sol command.

---

# Required Final Report

Use exactly:

## Changed

Map every change to Package A, B, C, or D with file and line references.

## Verified

Include:

- before test count;
- after test count;
- targeted test commands;
- full `npm test` result;
- `npm run demo` result;
- `npm run verify` result;
- `git diff --check`;
- preserved-run hash comparison;
- mandated-loop hash comparison.

Paste the decisive summary lines. Do not say "should pass."

## Evidence

Include:

- backup directory;
- backup hashes;
- new block codes and tests;
- structured oracle fixture;
- grounded contract test;
- exact coverage test;
- raw/final receipt-link test;
- source-manifest drift test;
- validity-banner test.

## Still Left

State clearly:

- no live repaired campaign was run;
- no public audit document was published;
- no commit or push was made;
- the operator owns the live-run, publication, commit, and submission decisions.

## Status

Return exactly one:

- `DONE - REPAIR VERIFIED, LIVE RUN AWAITS OPERATOR`
- `PARTIAL - <exact missing package or failed check>`
- `BLOCKED - <exact operator decision required>`

Do not call the repair done unless all required checks pass.

---

# Scope Guard

The fastest credible path is not the fewest changed lines. It is the smallest
change set that makes these statements true:

1. invalid benchmarks die before model spend;
2. baseline and challenger are bound to the same target;
3. a counted attempt transforms a named baseline under a named hypothesis;
4. all accepted findings receive explicit coverage;
5. receipts can be independently re-derived;
6. reports state exactly what is and is not proven.

Everything else is post-hackathon work.
