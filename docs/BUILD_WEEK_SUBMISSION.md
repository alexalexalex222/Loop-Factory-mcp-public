# OpenAI Build Week submission packet

Updated: July 20, 2026

The operator owns the external submission, category confirmation, public video
upload, and final Codex `/feedback` action. Keep the bracketed fields visible
until those actions are complete.

## Required fields

| Field | Value / status |
|---|---|
| Project | Loop Factory |
| Tagline | Make AI agents prove they got better. |
| Category | Developer Tools - operator to confirm in Devpost |
| Repository | https://github.com/alexalexalex222/Loop-Factory-mcp-public |
| Primary judge path | `npm run verify:submission` |
| Optional live path | `npm run judge:gpt56-sol` |
| Public video | `[PUBLIC_YOUTUBE_URL]` |
| Codex `/feedback` session ID | `[CODEX_FEEDBACK_SESSION_ID]` |
| Deadline | Monday, July 20, 2026 at 11:30 PM PT |

## Submission description

Loop Factory makes AI agents prove they got better.

When an agent claims it improved a workflow, Loop Factory freezes the old
version, evaluates the challenger against both the baseline and an irrelevant
sham, verifies model routing, execution receipts, schemas, token usage, and
artifact hashes from disk, and keeps promotion under operator control.

The final production run mined a real adjudication workflow, measured its
frozen original three times, generated two substantive challengers, measured
each challenger three times, and independently reverified both wins. Original
quality was `0.6190`. Both challengers scored `1.0000`; the recommended H1 used
`1.78%` fewer mean CLI tokens than the original. All `12` calls used exact
`gpt-5.6-sol` at high reasoning through authenticated ChatGPT OAuth, with zero
retries, zero exit failures, clean isolation, and `34/34` artifact rehashes.
Both promotion reviews remain pending.

The portable causal canary remains the no-account judge path. Its tracked
verifier re-derives one proposal plus fifteen evaluations: five baseline, five
challenger, and five sham. It proves exact model routing, five paired
challenger wins, zero sham wins, zero control regressions, 441,627 CLI tokens,
disabled promotion, and `experimentValid=true`.

The canary result is intentionally bounded. Challenger target quality moved
from `0` to `0.3333` or `0.6667`, but never reached `1.0`. Together, the two
runs show both causal isolation and an end-to-end mined workflow improvement
without pretending every target was solved.

Three earlier controlled fixtures support the product boundary: a requested
phase skip, a requested model-reported metric, and requested self-promotion.
Loop Factory records `PHASE_SKIP`, `MODEL_REPORTED_METRIC`, and
`SELF_PROMOTION` as blocked. These are adversarial regression prompts, not
claims of spontaneous worker behavior.

## Primary judge path: offline and no paid calls

Requirements: Node.js 18 or newer.

```bash
git clone https://github.com/alexalexalex222/Loop-Factory-mcp-public.git
cd Loop-Factory-mcp-public
npm run verify:submission
```

Expected result: deterministic JSON with top-level `"status": "PASS"`.

The command:

1. checks the exact causal-canary file set and pinned manifest hash;
2. validates the portable frozen canary inputs and plan;
3. invokes the existing independent canary verifier;
4. re-derives call count, model authority, exit codes, retries, isolation,
   schemas, artifact hashes, arms, outcomes, token receipts, promotion state,
   and experiment validity;
5. integrity-checks the privacy-safe production frontier packet, its independent
   verifier result, measured summary, procedures, screenshots, and pinned
   manifest; and
6. exits nonzero on any failed gate.

## Optional live judge path

Prerequisites: a compatible authenticated Codex CLI with GPT-5.6 Sol access.

```bash
npm run judge:gpt56-sol
```

This path can make live model calls. It pins the exact model and refuses
fallback. It is supporting proof, not a requirement for judging the tracked
submission.

## Evidence index

- Public evidence packet:
  `submission/evidence/context-isolation-canary-20260719/`
- Bundle manifest:
  `submission/evidence/context-isolation-canary-20260719/bundle-manifest.json`
- Production frontier packet:
  `submission/evidence/production-frontier-20260720/`
- Production manifest:
  `submission/evidence/production-frontier-20260720/bundle-manifest.json`
- Submission verifier: `scripts/verify-submission.mjs`
- Tamper test: `test/submission-verifier.test.mjs`
- Judge guide: `docs/JUDGE_GUIDE.md`
- Controlled gotcha transcript:
  `proof/build-week/gpt56-sol-live-20260718-final/TRANSCRIPT.md`
- Campaign Console QA:
  `proof/build-week/campaign-console-20260718-final/qa-summary.json`

## Before external submission

1. Record the sub-three-minute video from `docs/BUILD_WEEK_VIDEO.md`.
2. Upload it publicly and replace `[PUBLIC_YOUTUBE_URL]`.
3. Run `/feedback` in the operator-selected Codex task.
4. Replace `[CODEX_FEEDBACK_SESSION_ID]` with the returned session ID.
5. Confirm Developer Tools as the category.
6. Confirm the repository is public or shared with the required judges.
7. Re-run `npm test`, `npm run verify`, and `npm run verify:submission`.
8. Verify the packed artifact from a fresh temporary directory.
9. Commit and push only the reviewed submission boundary.
