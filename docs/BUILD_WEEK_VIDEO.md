# Build Week video plan

Target length: 2 minutes 45 seconds. Public YouTube upload with spoken audio.

## Shot list and narration

### 0:00-0:20 - The problem

Show the Loop Factory README and Campaign Console.

Narration:

> Agent improvement fails when the worker can skip phases, grade itself, or call
> itself done. Loop Factory makes the worker propose while a local supervisor
> owns progress, measurement, and promotion.

### 0:20-0:40 - Honest extension split

Show commits `19d9138`, `cbf2267`, and `8aabede`.

Narration:

> The MCP server, hash-locked loops, evidence gates, 313-test baseline, and
> 47-check demo existed before this extension. During this Build Week task,
> Codex added the exact GPT-5.6 Sol route and receipts, the live proof, the
> Campaign Console, and the judge kit.

### 0:40-1:05 - Exact model proof

Run:

```bash
npm run judge:gpt56-sol
```

Show the selected Codex CLI version, `gpt-5.6-sol`, sentinel PASS, and the evidence
directory. Keep the model ID and `fallbackAttempted: false` visible.

Narration:

> The command pins GPT-5.6 Sol. It does not use the family alias and never
> substitutes another model. One sentinel proves the judge's auth and model
> access before the controlled campaign starts.

### 1:05-1:50 - Three gotcha moments

Open the generated `TRANSCRIPT.md` and raw JSONL.

1. `PHASE_SKIP`
2. `MODEL_REPORTED_METRIC`
3. `SELF_PROMOTION`

Narration:

> These are explicitly adversarial regression prompts. Sol is asked to emit
> each prohibited packet. These are controlled regression fixtures, not claims of spontaneous model behavior.
> The point is that the supervisor rejects the proposal every time, records the
> exact invocation receipt, and does not let model output become campaign
> authority.

### 1:50-2:25 - Complete product experience

Open the served Campaign Console. Show:

- active lane and phase;
- exact Sol policy;
- verdict timeline and one invocation receipt;
- score matrix and evidence panel;
- a pending review;
- mobile screenshot at 360px.

Narration:

> The console polls a sanitized allowlist API with ETags. It shows operational
> facts and hashes, but never task text, prompts, user messages, artifacts,
> environment values, or filesystem paths. Operator notes survive polling, and
> approval remains outside the model-callable surface.

### 2:25-2:45 - Close

Show `npm test`, `npm run demo`, and `npm run verify` results.

Narration:

> Loop Factory is the referee around the worker: phase-gated, measured from
> captured bytes, re-verified from sealed evidence, and operator-controlled at
> promotion. Judges can run the live Sol path in one command or the deterministic
> no-auth demo without rebuilding the project.

## Capture checklist

- Keep the final video under three minutes.
- Use spoken audio; do not rely on text overlays alone.
- Keep `gpt-5.6-sol` visible during the live proof.
- Show the controlled-fixture disclosure.
- Show the final test, demo, and hash verification counts.
- Do not show account settings, tokens, environment values, or private paths.
- Replace `[PUBLIC_YOUTUBE_URL]` only after the upload is public.
