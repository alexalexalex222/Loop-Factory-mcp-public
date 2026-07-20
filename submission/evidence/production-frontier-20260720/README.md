# Production frontier run

This supplemental packet records the final July 20, 2026 end-to-end Loop
Factory run. It complements the portable causal canary used by
`npm run verify:submission`.

The run mined a real workflow, froze and measured the original three times,
generated two substantive challengers, measured each challenger three times,
deep-reverified both wins, and queued both for operator review without
recording a promotion.

## Measured result

| Procedure | Quality | Mean CLI tokens | Quality delta | Cost delta | Review |
|---|---:|---:|---:|---:|---|
| Original | `0.6190` | `61,270.3333` | baseline | baseline | frozen |
| H1: explicit frontier verdicts | `1.0000` | `60,180` | `+0.3810` | `-1.78%` | `rev-001` pending |
| H2: authority and reverification gates | `1.0000` | `60,193.3333` | `+0.3810` | `-1.76%` | `rev-002` pending |

H1 is the measured recommendation because quality is tied, its mean CLI token
cost is slightly lower, and it repairs the broader adjudication mechanism.
That recommendation is not an approval.

## Execution boundary

- `12` real Codex model calls through authenticated ChatGPT OAuth
- exact `gpt-5.6-sol` with high reasoning on every call
- zero retries and zero exit failures
- `12` unique threads and isolated capsule workspaces
- `724,453` CLI-reported tokens
- `34/34` persisted artifact bodies rehashed
- independently invoked run verifier: `PASS`
- `publicationEligible=true`
- promotions recorded: `0`

The backend did not emit a separate reported-model field. Model identity is
therefore established by the explicit Codex `-m gpt-5.6-sol` launch argument
and the absence of a conflicting report.

## Public evidence boundary

This packet intentionally excludes raw provider transcripts and
machine-specific capsule paths. The included verifier result is the persisted
output of the independently invoked run verifier, while
`npm run verify:submission` remains the fully portable, transcript-backed
judge path that re-derives the July 19 causal canary from public files.

The submission verifier integrity-checks every file in this supplemental
packet, validates the declared production metrics and privacy boundary, and
fails closed on tampering.

## Files

- [`summary.json`](./summary.json): bounded machine-readable result
- [`verifier.json`](./verifier.json): independent verifier output
- [`FINAL_PRODUCTION_REPORT.md`](./FINAL_PRODUCTION_REPORT.md): human report
- [`original-loop.md`](./original-loop.md): measured original
- [`improved-loop-h1.md`](./improved-loop-h1.md): recommended challenger
- [`improved-loop-h2.md`](./improved-loop-h2.md): alternate challenger
- [`screenshots/experiment-validity-desktop.png`](./screenshots/experiment-validity-desktop.png)
- [`screenshots/score-table-desktop.png`](./screenshots/score-table-desktop.png)
- [`screenshots/approval-desk-desktop.png`](./screenshots/approval-desk-desktop.png)
