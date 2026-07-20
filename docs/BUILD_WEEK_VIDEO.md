# Build Week video plan

Target length: 2 minutes 40 seconds. Public YouTube upload with spoken audio.
Record the screen first and add voice-over afterward. A five-second face intro
or outro is optional, not required.

## Shot list and narration

### 0:00-0:15 - Product in one sentence

Show the README headline and console image.

Narration:

> Loop Factory makes AI agents prove they got better. It freezes the old
> workflow, tests the challenger against the baseline and an irrelevant sham,
> verifies the receipts from disk, and leaves promotion with the operator.

### 0:15-0:40 - One-command judge proof

Run:

```bash
npm run verify:submission
```

Show the top-level `PASS`, `experimentValid: true`, and the
`productionSupplement: PASS` gate.

Narration:

> This is the no-account judge path. It makes no model call. It re-opens the
> public causal-canary transcripts, re-derives the result, and also checks the
> final production packet against a pinned manifest.

### 0:40-1:25 - Real mined workflow improvement

Open:

- `submission/evidence/production-frontier-20260720/original-loop.md`
- `submission/evidence/production-frontier-20260720/improved-loop-h1.md`
- `submission/evidence/production-frontier-20260720/screenshots/score-table-desktop.png`

Narration:

> This workflow was mined from a real prior failure, not written as a fake weak
> baseline. The original scored point six one nine across three runs. Loop
> Factory generated two challengers. Both scored one point zero across three
> independent replicas. The recommended version also used one point seven
> eight percent fewer mean tokens.

### 1:25-1:55 - Execution and independent validity

Show:

- `submission/evidence/production-frontier-20260720/screenshots/experiment-validity-desktop.png`
- `submission/evidence/production-frontier-20260720/verifier.json`
- `submission/evidence/production-frontier-20260720/summary.json`

Narration:

> The production run used twelve exact GPT-5.6 Sol calls at high reasoning,
> with zero retries, zero exit failures, twelve isolated workspaces, and
> thirty-four clean artifact rehashes. The independent run verifier passed
> every publication gate.

### 1:55-2:20 - Approval remains human

Show:

- `submission/evidence/production-frontier-20260720/screenshots/approval-desk-desktop.png`

Narration:

> Loop Factory still did not self-promote. Both measured wins are pending in
> the approval desk. The system can keep mining and measuring, while adoption
> authority stays with the operator.

### 2:20-2:40 - Causal control and close

Return to the `verify:submission` result and show `pairedTargetWins: 5`,
`shamWins: 0`, and `controlRegressions: 0`.

Narration:

> The portable canary adds the causal control: five paired wins, zero sham
> wins, and zero regressions. Loop Factory is the referee around the worker:
> frozen baseline, negative control, disk-backed evidence, deterministic
> verification, and operator-owned promotion.

## Capture checklist

- Keep the final video under three minutes.
- Use spoken audio.
- Keep `gpt-5.6-sol` visible in the production summary.
- Show the original `0.6190` and improved `1.0000` scores.
- Show `productionSupplement: PASS`.
- Show `targetFullySolved: false`.
- Show both reviews as pending and do not claim a promotion.
- Show the no-paid path before describing the live production run.
- Do not show account settings, tokens, environment values, or private paths.
- Show current verification outputs, not stale test/demo counts.
- Keep `[PUBLIC_YOUTUBE_URL]` unresolved until the upload is public.
- Keep `[CODEX_FEEDBACK_SESSION_ID]` unresolved until `/feedback` returns it.
