# OpenAI Build Week submission packet

Updated: July 18, 2026

Do not submit bracketed placeholders. The operator owns the external submission,
video upload, category selection, and final `/feedback` action.

## Required fields

| field | value / status |
|---|---|
| Project | Loop Factory |
| Category | Developer Tools - operator to confirm in Devpost |
| Repository | https://github.com/alexalexalex222/Loop-Factory-mcp-public |
| Working judge path | `npm run judge:gpt56-sol` |
| No-auth fallback | `npm run demo` |
| Public video | `[PUBLIC_YOUTUBE_URL]` |
| Codex `/feedback` session ID | `[CODEX_FEEDBACK_SESSION_ID]` |
| Deadline | Tuesday, July 21, 2026 at 5:00 PM PT |

## Description draft

Loop Factory is a zero-dependency local supervisor for agent improvement
campaigns. Worker models propose; the supervisor decides. It streams improvement
procedures one phase at a time, measures results from captured bytes, re-verifies
sealed evidence, and requires operator approval before promotion.

For OpenAI Build Week, the existing Loop Factory was meaningfully extended with
an exact GPT-5.6 Sol route, model-selection receipts, a captured controlled proof,
a sanitized live Campaign Console, and a one-command judge kit. The proof asks a
real `gpt-5.6-sol` worker to emit three prohibited packets - phase skipping,
self-reported metrics, and self-promotion - then records Loop Factory rejecting
each with the expected supervisor code. The prompts are explicitly controlled
regression fixtures, not claims of spontaneous model behavior.

## Judge path

```bash
git clone https://github.com/alexalexalex222/Loop-Factory-mcp-public.git
cd Loop-Factory-mcp-public
npm test
npm run judge:gpt56-sol
```

Prerequisites for the live command:

- Node 18 or newer.
- Authenticated Codex CLI `0.144.0` or newer.
- GPT-5.6 Sol enabled for the judge's Codex account.

If live model access is unavailable:

```bash
npm run demo
```

The fallback is deterministic and must not be described as a live Sol run.

## Evidence index

- Baseline snapshot before extension: commit `19d9138`.
- GPT-5.6 Sol package: commit `cbf2267`.
- Campaign Console package: commit `8aabede`.
- One-command live judge packet:
  `proof/build-week/judge-gpt56-sol-20260718-final/JUDGE.md`.
- Live Sol transcript:
  `proof/build-week/gpt56-sol-live-20260718-final/TRANSCRIPT.md`.
- Live Sol raw JSONL:
  `proof/build-week/gpt56-sol-live-20260718-final/raw/`.
- Console browser QA:
  `proof/build-week/campaign-console-20260718-final/qa-summary.json`.
- Sacred source verification: `npm run verify`.

## Before submission

1. Record and upload the voiced video from `docs/BUILD_WEEK_VIDEO.md`.
2. Replace `[PUBLIC_YOUTUBE_URL]`.
3. Run `/feedback` in the Codex task where the core work was built.
4. Replace `[CODEX_FEEDBACK_SESSION_ID]` with the returned ID.
5. Confirm the repository is public or shared with the required judge accounts.
6. Re-run `npm test`, `npm run demo`, and `npm run verify`.
7. Confirm the final commit history still shows the baseline and package commits.
