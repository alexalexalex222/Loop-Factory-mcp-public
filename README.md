# super-loop-mcp — Loop Factory

**A referee for self-improving AI agent loops.** Loop Factory mines your past agent sessions for the workflows that actually worked, tries to improve them, and refuses to call anything "better" or "done" without measured proof — and it never stops until *you* stop it.

`local-first` · `zero dependencies` · `Node ≥18` · `MCP over stdio`

---

## In one minute (no jargon)

When you put an AI agent on a repetitive improvement task — *"make this prompt/workflow better, and keep going"* — three things tend to go wrong:

- it says **"done"** when it isn't,
- it **skips steps** it was told to follow,
- it **stops early** because it "thought hard" and felt finished.

**Loop Factory is the supervisor that doesn't allow that.** It sits between you and the AI and acts like a strict lab referee:

- It holds the improvement procedure (a **"loop"**) and hands the agent **one step at a time** — the next step only unlocks once the current one has left real evidence on disk.
- It keeps a **sealed scorecard**. The agent can't grade its own work; Loop Factory measures the result itself and **re-checks it from the sealed record** before accepting any "this is better."
- It **never declares victory.** The run keeps going until *you* say stop — and it says so, plainly, the whole time:

  > **WARNING: You are the stop condition. This loop does not stop until you stop it.**

Everything runs **on your machine**. Nothing is uploaded.

### What it does for you

- **Mines your history** — reads back through your past agent sessions to surface the loops/workflows that genuinely worked (the **Strip Miner**).
- **Improves a loop** — takes a loop and tries to make it better, generation after generation (**Loop-de-loop**).
- **Only promotes real wins** — a change is "promoted" only if it is *measurably* better on a frozen test and re-verified from sealed bytes; otherwise it is blocked.
- **Keeps your authorship** — your loops never leave your machine, and it never overwrites your canonical loop without you.

---

## Quickstart

```bash
cd super-loop-mcp
npm test       # full node:test suite (219 checks) — no install, zero deps
npm run demo   # spawns the real server and drives a whole campaign over stdio (38/38 checks)
npm run verify # prove the bundled loop hashes against the mandated contract
```

Then point your MCP host (e.g. **Claude Code**) at it:

```json
{
  "mcpServers": {
    "super-loop": {
      "command": "node",
      "args": ["/path/to/super-loop-mcp/src/server.mjs"],
      "env": { "SUPER_LOOP_HOST": "claude" }
    }
  }
}
```

Set `SUPER_LOOP_HOST` in the server `env` so the run hands the agent a host-correct setup checklist at start. The value is any host id or alias from the [host registry](hosts/registry.json) — e.g. `"claude"`, `"codex"`, `"zcode"`, `"cursor"`, `"opencode"`. Ready-made config snippets per host live in [`examples/mcp/`](examples/mcp/). State lives under `SUPER_LOOP_HOME` (default `<package>/.super-loop`). Nothing leaves your machine.

### Use it — just say this

In your MCP host, tell the agent:

> **"Use super loop on this. Mine my sessions for a better loop, then keep improving it until I stop you."**

`initialize_loop_run` returns a `hostSetup` block — a numbered, host-correct checklist the agent runs to put itself into continuous mode and start the phase gate:

- **Claude Code** → run **`/goal`** with an operator-stop objective (progress-driven: the next turn starts automatically when the previous finishes; [docs](https://code.claude.com/docs/en/goal)). `/loop` is for interval polling or self-paced wake-ups, not a convergence campaign.
- **Codex** → create a **`/goal`** and keep it active across turns.
- **Other hosts** → see the [host compatibility matrix](#host-compatibility) for the per-host driver, or use the `super-loop-run` CLI fallback.

The run then streams the loop one phase at a time, measures every result itself, and **never marks itself done** — `EXEC_DISABLED`, saturation, and no-improvement advisories are checkpoints, not stops. **You are the only stop condition.**

**Infinite or bounded — your call.** By default a run is *infinite*: it never self-stops; `campaignContinues` stays `true` until you stop it. Give it a limit at init (`config.maxCycles`, e.g. `5`) and it flips to *bounded* mode — when it reaches the limit (or the no-improvement/exhaustion advisory), it returns `campaignContinues: false` + `boundedComplete: true` and tells the agent it **may stop the /loop** and report the final state, instead of spinning forever. Either way nothing auto-promotes, any pending dashboard reviews still wait for you, and the run resumes by `runId` if you raise the limit. The limit is tool-enforced and set once at init — the model can't talk its way to "done."

If your first message already says the goal and "just go," the agent can skip the ask-once questions and start with surfaced default assumptions (mine → improve, whole history, best-first).

### Run it autonomously (hands-off, no chat)

For a campaign that drives itself until you drop a stop-file — no host turns:

```bash
SUPER_LOOP_ALLOW_EXEC=1 super-loop-run \
  --config examples/campaign.json \
  --stop-file ./STOP
```

This launches real frontier workers itself (opt-in via `SUPER_LOOP_ALLOW_EXEC=1`), serves the click-and-done dashboard at `http://127.0.0.1:8787`, and stops only when you create `./STOP` (or Ctrl-C). Copy [`examples/campaign.json`](examples/campaign.json) (or the improve-only [`examples/campaign-improve-only.json`](examples/campaign-improve-only.json)) and edit `task`, `routes`, the `benchmark`, and the improve target's `baselineContent`. The autonomous CLI runs the **supervisor** (mine → improve → re-mine) — it does not resume a reactive MCP run mid-phase.

### Host compatibility

Super Loop is **MCP-first** (the portable layer), with the continuous driver chosen per host from the [host registry](hosts/registry.json), and the `super-loop-run` CLI as the universal fallback. The driver families collapse ~every agent into a few mechanisms, so you don't ship a bespoke string per host:

| Host | Driver family | Tier | Continuous driver | Verified |
|------|---------------|------|-------------------|----------|
| Claude Code | `goal_progress` | 1 | `/goal` (operator-stop objective) | ✅ |
| Codex | `goal_progress` | 1 | `/goal` | ✅ |
| ZCode | `goal_progress` | 1 | `/goal` (mirrors Codex — confirm) | ⚠︎ |
| OpenCode | `plugin_goal` | 1 | `/goal` **(requires a goal plugin)** | ⚠︎ |
| Cursor | `mcp_reactive` | 2 | none — continuation rules snippet | ⚠︎ |
| Kilo Code | `mcp_reactive` | 2 | none — rules snippet (CLI fork = tier 1 with a goal plugin) | ⚠︎ |
| OpenClaw | `auto_continue` | 2 | config (`autoContinue` / heartbeat) | ⚠︎ |
| Hermes | `internal_loop` | 3 | its own loop — call tools each turn | ⚠︎ |
| Factory Droid | `orchestrator` | 2 | Super Loop runs **inside** a Mission worker | ⚠︎ |
| MiniMax Mini-Agent | `internal_loop` | 3 | its own loop, or the CLI fallback | ⚠︎ |
| _anything else_ | `cli_autonomous` | 3 | **`super-loop-run`** (universal fallback) | — |

**Three tiers:**

1. **Native goal** (Claude/Codex/ZCode, OpenCode+plugin) — engage `/goal` with an operator-stop objective.
2. **MCP + continuation contract** (Cursor, Kilo IDE, OpenClaw, Hermes) — no reliable continuous slash command, so ship the [continuation rules snippet](examples/rules/super-loop-continuation.md): continue on every tool result, `checkpoint != stop`, cold-start fresh.
3. **CLI owns the loop** (`super-loop-run`) — for any headless/host-less run; same referee, no host babysitting.

`⚠︎ verified:false` entries are modeled from the design and link their docs in the registry — confirm the exact command in your build before relying on it. `host_capability_preflight` returns the resolved host profile (`tier`, `driverFamily`, `setupHint`) and, when the host is unknown, the full matrix.

---

# For developers

Everything below is the engineering detail behind the one-minute summary.

## Why this exists

Drop a 300+ line loop into a model's context and it may ingest the whole thing, skip the structure, and treat an unverified argument as a test. Loop Factory fixes that with hard mechanics:

1. **Ask-once** — starts with a brief explanation plus a few short questions *once*:
   - the **goal**;
   - the **path** — **improve** a loop you already run, **discover/find** a loop (optionally scouting a public loop library), or **mine** your whole history (deep);
   - the **loop or domain** to start from;
   - **corpus scope** — your whole session history or a set number of loops, and best-first vs in-order (asked with an up-front warning that *a run can take hours, days, or weeks depending on how deep it mines*);
   - what **"better"** means (this becomes the frozen benchmark);
   - any **task-specific limit**;
   - and a final **deeper-explanation** offer, honored in the same response.

   It never asks you to choose the model, promotion mode, or benchmark policy — the supervisor decides those from the task — and afterward it does not ask again or mark the campaign complete by itself. A fresh run also carries a **cold-start notice**: don't resume a prior campaign or assume a path from memory — infer only from this message and the answers (pass a `runId` to resume on purpose).
2. **Phase-gated streaming** — holds the loop inside the MCP and hands you the next section only after the current one has recorded evidence. No 1k-line dump.
3. **Benchmark-first** — the baseline is hash-locked and the scorecard is frozen *before* any challenger. Model self-reported metrics never count.
4. **Frontier hypothesis engine** — full tests need 3–5 hypotheses on frontier routes (haiku/mini/nano/lite/prior-gen rejected); one no-improvement run is never "perfect".
5. **Promotion gate** — promotion requires a tool-measured, deep-**reverified** result that moves the quality/cost frontier past threshold. Otherwise: `BLOCKED`.

Two surfaces share one engine: the **reactive MCP** (a host calls its tools — the in-conversation hook) and the **autonomous driver** (`super-loop-run` CLI / `run_campaign` tool) that drives the whole campaign itself and only stops on the operator stop-file. The whole point: a model **cannot** promote, upgrade, or call a loop "perfect" from reasoning alone — every decision is hooked through a tool that demands **tool-measured artifacts on disk**, and **the operator is the only stop condition**.

> Built fresh, zero dependencies, runs on plain Node ≥18. The full private 345-line Strip Miner and the full private 75-line Loop-de-loop (Loop 2) live **inside** the supervisor, byte-identical to source and hash-locked, streamed one section at a time.

---

## The bundled loops (hash-locked)

| id | file | lines | sha256 | trigger |
|----|------|-------|--------|---------|
| `strip-miner` | `loops/strip-miner.txt` | 345 | `5270d691…ed9ec9` | `/loop strip-miner` (The Strip Miner Loop / cross-agent source miner) |
| `loop-de-loop` | `loops/loop-de-loop.md` | 75 | `70090e03…022b44` | `/loop loop-de-loop` (Loop 2 / improve an approved loop) |

These are the **local big** sources — the operator's full private cross-agent Strip Miner (with the old pause/complete language patched into checkpoint/continue semantics), not the short public miner. The server refuses to start, and the test suite fails, if either file's hash or line count drifts — so the short public miner can never be silently substituted.

### Add your own loops (local loop library)

Users add their own loops through a **tool**, not by hand-editing source:

```
loop_register { id:"my-loop", title:"My Loop", content:"<full loop text>" }   → hash-locked, sectionized, persisted locally
loop_library                                                                   → lists mandated (hash-locked) + your custom loops
loop_start  { loop:"my-loop" }                                                 → streams it phase-gated, exactly like the mandated loops
```

Custom loops are sha256 hash-locked (write-once per version; `overwrite:true` makes a new version), get a safe id (no path traversal), persist under `SUPER_LOOP_HOME/custom-loops/`, and **cannot collide with or overwrite** the mandated Strip Miner / Loop-de-loop. They stream through the same phase gate. Nothing leaves your machine.

---

## Tools (27)

| tool | what it enforces |
|------|------------------|
| `run_campaign` | **autonomous supervisor (opt-in `SUPER_LOOP_ALLOW_EXEC=1`)** — one call drives the whole campaign (intake → target queue mine→improve → FullTestBatches → reverify → promote/bank Stone → advance/retire → re-mine) until the operator stop-file. Every worker output is **validated** (summary-only/early-stop/fake-metric/self-promote/phase-skip/copied-public rejected + re-entered); invalid batches don't count. `maxBatches` is a safety cap, not completion. Unbounded via the `super-loop-run` CLI. Returns `MISSING_FULL_PRIVATE_LOOPS` if a full loop is absent. |
| `initialize_loop_run` | ask-once (brief + a few short Qs: goal, **path picker** (improve / discover / mine + library scout), the loop/domain, **corpus scope + order**, what "better" means, a hard limit, deeper-explanation; no model/promotion/policy questions — the supervisor decides those); stores every user message with a sha256 hash; picks a frontier model; surfaces the stop-condition notice, the **cold-start notice** (fresh run), and the **native-continuation notice** (Claude/Codex `/goal`; `/loop` = Claude's polling alternate) up front; returns a **host-aware `hostSetup`** with a path-aware step 3; honors the "deeper explanation" answer in the same response |
| `loop_register` | **add your own loop** to the local MCP: hash-lock, safe id, sectionize, persist locally; never overwrites a mandated loop |
| `loop_library` | list mandated (hash-locked) + custom local loops |
| `loop_start` | begin phase-gated streaming of any loop (mandated or custom); returns section 0 only |
| `request_next_phase` / `loop_next` | next section **iff** the current one has evidence, else `PHASE_SKIP` |
| `observation_record` | lightweight phase evidence |
| `artifact_record` | persist a raw artifact + sha256; `role:"baseline"` hash-locks (write-once); `measurement` makes the MCP **derive** a tool-computed measurement from the bytes; pass explicit `content` (`sourcePath` reads refused) |
| `benchmark_propose` / `benchmark_select` | propose scorecards (≥1 value dim, ≥1 cost dim, ≥1 case, optional deterministic `oracle`) and **freeze** one; worker proposals carry `benchSource:"worker"` (default) and `benchPartition:"harvest"` |
| `benchmark_freeze_maker` | **bench-maker only** — freeze a scorecard directly with `benchSource:"maker"` (bypasses worker `benchmark_propose`); defaults `benchPartition:"gate"` for held-out eval |
| `export_trajectories` | read-only export of recorded tool actions as Hermes JSONL with supervisor verdict labels; **refuses gate-partition runs** |
| `benchmark_run` | set the tool-**computed** baseline bar; a caller-reported measurement is rejected |
| `register_hypotheses` | 3–5 frontier hypotheses; benchmark-first; rejects banned routes |
| `test_hypothesis` | one full test = 3–5 frontier agents, each tool-computed; aggregates vs the bar; reports quality authority |
| `execute_full_test` | **opt-in (`SUPER_LOOP_ALLOW_EXEC=1`)** — the supervisor itself launches 3–5 allowlisted workers (`execFile`, no shell, prompt via stdin), captures output, parses real token usage, and gates on the tool-captured bytes; off by default → `EXEC_DISABLED` |
| `reverify_run` | **re-derive** metrics from the sealed raw bytes and confirm they reproduce (a tampered number cannot survive) |
| `promotion_request` | promote only on measured + reverified frontier movement; a quality win the MCP can't tool-verify routes to the dashboard (`QUALITY_UNVERIFIED`) |
| `cycle_decision_request` | **the supervisor hook** — a worker proposes a transition packet (promote/advance_phase/change_baseline/change_benchmark/saturate); only a supervisor-accepted transition is progress; completion/stop intents refused |
| `report_saturation` | mark a lane saturated → supervisor **auto-transitions** to the next lane (Strip Miner → Loop-de-loop); never pauses/stops |
| `campaign_status` | read-only lane/target queue, auto-transitions, 30-batch retirement + 10–15 advisory accounting, pending dashboard review (never blocks) |
| `continue_run` | records the next lane + first concrete action; it does **not** clear the obligation until a real progress tool runs |
| `human_review_request` | queue/list Approve/Sludge items only; model-callable resolve is blocked |
| `update_dashboard` | render the polished always-on local dashboard with the stop-condition notice |
| `report_export` | reproducible markdown campaign report |
| `host_capability_preflight` | local report of which frontier-agent CLIs are installed on PATH (filesystem stat only, never executes, not SOTA/web research) **plus the resolved host profile** — `driverFamily`, `tier`, `setupHint`, and the full host matrix when `SUPER_LOOP_HOST` is unknown |

### Block codes you will see
`NOT_INITIALIZED · PHASE_SKIP · BASELINE_FIRST · BASELINE_LOCKED · BENCHMARK_FIRST · BENCHMARK_FROZEN · WEAK_BENCHMARK · BASELINE_BAR_FIRST · HYPOTHESIS_COUNT · BANNED_ROUTE · BUILDER_ROUTE · FULLTEST_AGENTS · MODEL_REPORTED · MEASUREMENT_AUTHORITY · QUALITY_UNVERIFIED · NO_SCORE_MATRIX · NOT_REVERIFIED · BELOW_THRESHOLD · BELOW_FLOOR · STAGED_TRADEOFF · OPERATOR_IS_STOP · DASHBOARD_ONLY · NO_ACTIVE_LANE · EXEC_DISABLED · EXEC_FAILED · LOOP_EXISTS · LOOP_SOURCE`

### Live execution + autonomous harness (opt-in)
By default the server **never executes commands** (audited posture). Set `SUPER_LOOP_ALLOW_EXEC=1` to let Loop Factory own benchmark execution end-to-end: `execute_full_test` launches the frontier workers itself (allowlisted `claude`/`codex`/`glm`/`gemini` only, via `execFile` with no shell, prompt passed on **stdin** so untrusted text never reaches argv), captures each output, parses real token usage when the CLI reports it, enforces a hard timeout, and feeds the **tool-captured** bytes through the same gate. This closes the last self-report hole — when the supervisor launches the worker, there is no model-supplied run-log to fabricate. A failed/timed-out/non-allowlisted launch is an invalid batch and does not count toward retirement.

The **autonomous driver** sits on top of that — the difference between "a supervisor you call" and "a harness that drives itself":

```bash
SUPER_LOOP_ALLOW_EXEC=1 node scripts/run-campaign.mjs --config campaign.json --stop-file ./STOP
```

It runs the whole loop unattended (intake → mine → improve targets → validate every worker → bank Stones → advance/retire → re-mine) and **only stops when you create the stop-file**. The same logic is the `run_campaign` MCP tool, bounded by `maxBatches` for the in-call version. An MCP alone is reactive (a host calls it); the supervisor is what makes Loop Factory self-driving.

Workers run on the real CLIs via **stdin** (`claude -p --output-format json`, `codex exec --json`) — the prompt never touches argv (no injection), and the real answer text + token usage are extracted for benchmarking. **Benchmark modes:** `oracle` (deterministic → auto-promote on a measured win) and `judge` (an independent Opus/GLM judge scores baseline-vs-challenger *real outputs* under a rubric → subjective → queues to the dashboard, never auto-promotes; the challenger never scores itself).

---

## A full campaign, in order

```
initialize_loop_run            → brief + ask-once (a few Qs) → answer → INITIALIZED
loop_start strip-miner         → section 0
  observation_record (phase 0) → request_next_phase → section 1 → … (gated)
artifact_record role=baseline  → hash-locked
benchmark_propose → benchmark_select        → scorecard frozen
artifact_record measurement → benchmark_run arm=baseline   → bar set (tool-measured)
register_hypotheses (3–5 frontier)
test_hypothesis (3–5 agents, tool-measured) → MOVED_FRONTIER | NO_IMPROVEMENT
reverify_run → promotion_request            → PROMOTE | BLOCKED
update_dashboard / report_export            → checkpoint; lanes keep running
```

Two distinct thresholds, neither of which stops the campaign:
- **Risk advisory (10–15, configurable):** after ~12 consecutive valid no-improvement full tests the supervisor raises an **economic-exhaustion risk advisory** and opens dashboard review — it only **reports risk**, it does not stop.
- **Branch retirement (30 valid batches):** a branch retires only after **30 valid full real test batches** (3–5 frontier workers each) with no qualifying improvement, then the supervisor **auto-pivots to the next lane**. Invalid / fake-metric / early-stopped / summary-only batches are blocked upstream and never count.

If the Strip Miner saturates, the supervisor **auto-transitions** (Strip Miner → Loop-de-loop, or the next improvement lane) via `report_saturation` — never a pause/await/stop. Checkpoint/report/dashboard/refused-terminal/saturation/retirement events persist a machine-readable continuation obligation until a real progress tool runs. `continue_run` records the model's next-lane commitment but deliberately cannot clear the obligation by itself. **Only the operator stops the campaign.**

---

## Design notes

- **Zero dependencies on purpose.** No SDK, nothing to `npm install` that can fail or time out, nothing phoning home. The MCP transport is ~90 lines of newline-delimited JSON-RPC in `src/server.mjs`. There is nothing to install.
- **Tool-computed measurement authority.** The MCP **derives** every metric from the recorded raw bytes — `tokenCost` always (a deterministic token estimate), `quality` via the frozen benchmark's deterministic oracle when one exists. A number the model types is `caller-reported` and is refused by the benchmark/test gates (`MEASUREMENT_AUTHORITY`). `reverify_run` re-derives from the sealed bytes, so a tampered number cannot survive. **The honest boundary, stated plainly:** the MCP cannot prove the recorded bytes came from a real frontier-agent run unless *it* launched the worker (the opt-in live executor), and it cannot judge subjective quality without an oracle. Subjective quality routes to the dashboard for a human and **never auto-promotes** (`QUALITY_UNVERIFIED`); deterministic, oracle-scored quality promotes autonomously. In short: deterministic → tool-measured, subjective → dashboard.
- **Host capability preflight, no execution.** `host_capability_preflight` resolves known frontier-agent CLI names against `PATH` with a filesystem stat — it never spawns a command, never probes a model-supplied binary, and is not SOTA/web research. Presence on PATH ≠ working auth, and it says so.
- **Anti-tampering.** Baseline and benchmark are write-once within a cycle; changing either needs an explicit new epoch + rationale.
- **Path hardening.** `runId` and artifact ids are validated before touching disk, and `sourcePath` reads are refused so a model cannot turn the MCP into a local-file reader. Submit artifact bytes through `content`.
- **Dashboard-only human review, with a real apply path.** The model can queue/list Approve/Sludge items (and may *propose* a loop adoption by queuing a review that carries the improved loop text), but `human_review_request { action:"resolve" }` returns `DASHBOARD_ONLY` — the model can never approve its own work. **Click-and-done:** the autonomous campaign serves the dashboard (or run `node scripts/dashboard-server.mjs`); open it and just click **Approve/Sludge**. The click POSTs to the local server (127.0.0.1 only, cross-origin refused), which queues it to the run inbox, and the running campaign **adopts it on its next tick — no file, no command, model-independent, non-blocking.** (Headless fallbacks: save the dashboard's Export to `runs/<runId>/inbox-decisions.json` for the supervisor to auto-apply, or `node scripts/apply-decisions.mjs --file <export>`.) Approving a loop-adoption review **installs the improved loop as a new versioned custom loop** (the prior version is archived for rollback via `operator.rollbackLoop`), which `loop_start` then streams next cycle. The mandated canonical loops are immutable and never touched. Applying is **non-blocking** — the campaign never pauses for it, and adoption is never a model-callable tool (it lives under `api.operator`, off the `tools/call` surface). This is how a proven improvement actually becomes the loop Loop Factory runs.
- **Continuation is a host obligation, stated honestly.** An MCP cannot force the host agent loop to keep running — only the host can (which is why the agent is told its native continuous command — Claude Code / Codex `/goal`, with `/loop` as Claude's polling alternate, or the per-host driver from the registry — on start). What the MCP *can* do, and does: every report / dashboard / saturation / no-improvement / refused-terminal event persists a machine-readable **continuation obligation** with a concrete next tool+lane, and `continue_run` records intent without clearing it (only a real progress tool clears it). The MCP makes stopping early visibly incomplete; it does not pretend to be the host scheduler. The operator is the only stop condition.
- **Never overwrites your canonical loop.** Promotion records an *internal champion*; changing the canonical loop file is HUMAN-GATED and left to you.
- Standalone by design.

## Run-trajectory export

Bench-maker sessions are **out-of-lineage**: a separate operator-controlled MCP invocation freezes held-out scorecards; the worker being measured never proposes them.

### Protocol (ephemeral bench-maker)

1. **Spin up** a dedicated MCP host pointed at the same `SUPER_LOOP_HOME` (or a copy) with a fresh `runId` for the held-out worker run.
2. **Hash-lock baseline** on that run: `artifact_record { role:"baseline", content:"..." }`.
3. **Freeze held-out benchmark** via `benchmark_freeze_maker` (not `benchmark_propose`):
   ```json
   {
     "runId": "<eval-run>",
     "benchmark": { "name": "...", "taskValueDimensions": ["..."], "resourceDimensions": ["..."], "cases": [{ "id": "..." }], "oracle": "..." },
     "benchPartition": "gate"
   }
   ```
   This sets `benchSource:"maker"` and `benchPartition:"gate"`. Worker `benchmark_propose` on that run becomes a no-op while the maker scorecard is frozen.
4. **Run the worker** through the normal phase gate / hypotheses / full tests on the gate benchmark.
5. **Do not export** gate runs for reuse — `export_trajectories` refuses `benchPartition:"gate"` runs (hard firewall against exam-set leakage).
6. **Harvest runs** (worker-frozen benchmarks with default `benchPartition:"harvest"`) export via:
   ```json
   { "runId": "<harvest-run>", "outPath": "trajectory.jsonl" }
   ```
   Output is Hermes-format JSONL: one line per recorded tool call with `label.verdict` / `label.code` / `label.reason` from the sealed gate results already stored on the run (never re-run gates).
7. **Terminate** the bench-maker host session when done — no persistent bench-maker process is required; access is operational (separate host invocation), not a background daemon.

## Layout

```
loops/            bundled hash-locked loop sources (+ MANIFEST in constants)
src/
  server.mjs      MCP stdio JSON-RPC transport + tool schemas
  engine.mjs      Loop Factory core — every tool handler + gate
  loops.mjs       registry, hash-lock, sectionizer (mandated + custom loaders)
  measure.mjs     tool-computed measurement (derive cost/quality from bytes) + honest boundary
  executor.mjs    opt-in live worker execution (allowlist, execFile, stdin) — off by default
  supervisor.mjs  autonomous campaign driver (validate → accept/re-enter boundary)
  host.mjs        host capability preflight (PATH presence only, no execution)
  models.mjs      frontier-route policy (banlist/allowlist)
  scorecard.mjs   promotion frontier rule + score matrix
  store.mjs       local atomic JSON persistence (runs + custom-loops)
  dashboard.mjs   polished dashboard.html + markdown report
  constants/util  shared facts + helpers
scripts/          demo.mjs (live proof), run-campaign.mjs (autonomous CLI, serves the dashboard),
                  dashboard-server.mjs (zero-dep served dashboard: click Approve/Sludge → adopt),
                  apply-decisions.mjs (operator-only headless fallback), verify-sources.mjs
test/             node:test suites (sources, ask-once, phase gate, benchmark,
                  hypotheses, promotion, hook, dashboard, transport, security,
                  loop library, measurement authority, host preflight, executor,
                  supervisor, adoption, dashboard-server)
```
