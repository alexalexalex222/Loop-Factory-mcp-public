# Loop Factory Build Week judge packet

Status: **PASS**

Exact model: `gpt-5.6-sol`
Codex CLI: `0.145.0` (chatgpt-app-bundled)
Model fallback attempted: `false`

## Fast judge path

```bash
npm run judge:gpt56-sol
```

The command performs one exact-model auth sentinel, then three controlled
adversarial fixtures: phase skip, self-reported metric, and self-promotion.
Each worker proposal must be rejected by the matching supervisor code.

Preflight stdout sha256: `39736654ce4e4465d5879e4a2c3a25028339862a3f27061f6a2d6d76ab5b29cd`
Proof summary: `proof/build-week/judge-gpt56-sol-20260718-final/proof/summary.json`
Proof transcript: `proof/build-week/judge-gpt56-sol-20260718-final/proof/transcript.jsonl`

No-auth fallback:

```bash
npm run demo
```

The fallback is deterministic and does not claim a live GPT-5.6 Sol call.
