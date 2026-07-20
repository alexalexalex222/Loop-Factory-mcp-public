# Judge guide

## Fast path: no account, no paid calls

Requirements: Node.js 18 or newer and a fresh checkout.

```bash
npm run verify:submission
```

Expected result: deterministic JSON with top-level `"status": "PASS"`.

This command checks two complementary public evidence packets from disk.

First, it validates the portable causal-canary input plan, invokes Loop
Factory's existing canary verifier, and independently gates:

- one proposal plus fifteen evaluations;
- exact `gpt-5.6-sol` requests and explicit-model authority;
- zero exit failures and zero retries;
- strict context/tool isolation;
- output schemas and normalization;
- 47 byte-preserved worker artifacts and their internal hashes;
- five baseline, five challenger, and five sham evaluations;
- five paired challenger wins, zero sham wins, and zero control regressions;
- 441,627 re-derived CLI tokens across all sixteen calls;
- disabled/unrecorded promotion; and
- `experimentValid=true`.

The result is deliberately narrower than "the problem was solved." Challenger
target quality reached `0.3333` or `0.6667`, never `1.0`.

Second, the command integrity-checks the privacy-safe July 20 production
frontier packet:

- one real mined workflow and two substantive challengers;
- original quality `0.6190`;
- H1 and H2 quality `1.0000` across three replicas each;
- H1 mean token cost `1.78%` below the original;
- `12` exact `gpt-5.6-sol` high-reasoning calls;
- zero retries, zero exit failures, and `12` isolation passes;
- `724,453` CLI-reported tokens and `34/34` artifact rehashes;
- independent run verifier `PASS`;
- `publicationEligible=true`; and
- two pending reviews with zero promotions recorded.

The supplemental packet omits raw provider transcripts and machine-specific
capsule paths. The first causal-canary packet remains the fully portable,
transcript-backed re-verification path.

## What to inspect

- Production result and public boundary:
  `submission/evidence/production-frontier-20260720/README.md`
- Original and recommended procedures:
  `submission/evidence/production-frontier-20260720/original-loop.md`
  and
  `submission/evidence/production-frontier-20260720/improved-loop-h1.md`
- Production verifier and pinned summary:
  `submission/evidence/production-frontier-20260720/verifier.json`
  and
  `submission/evidence/production-frontier-20260720/summary.json`
- Evidence method and redaction boundary:
  `submission/evidence/context-isolation-canary-20260719/README.md`
- File and source hashes:
  `submission/evidence/context-isolation-canary-20260719/bundle-manifest.json`
- Portable frozen inputs:
  `submission/evidence/context-isolation-canary-20260719/canary-inputs.json`
- Recomputed verifier:
  `scripts/verify-submission.mjs`
- Tamper regression:
  `test/submission-verifier.test.mjs`

## Supporting enforcement proof

The earlier controlled fixtures show three supervisor boundaries:
`PHASE_SKIP`, `MODEL_REPORTED_METRIC`, and `SELF_PROMOTION`. They are
adversarial regression prompts, not claims of spontaneous worker behavior.

## Optional live path

Judges with an authenticated compatible Codex CLI and GPT-5.6 Sol access may
run:

```bash
npm run judge:gpt56-sol
```

That command can make live model calls. It never falls back to another model.
It is optional; the primary judge path above is offline and makes no paid call.

## Operator-owned fields

- Public video: `[PUBLIC_YOUTUBE_URL]`
- Codex feedback session: `[CODEX_FEEDBACK_SESSION_ID]`

Those values must remain unresolved until the operator completes the external
upload and `/feedback` actions.
