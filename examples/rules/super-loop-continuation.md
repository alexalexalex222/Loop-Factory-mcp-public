# Super Loop — continuation rules (Tier 2 hosts)

Paste this into your host's rules file for hosts that have **no continuous goal command** —
`mcp_reactive` / `auto_continue` hosts such as **Cursor** (`.cursor/rules`), **Kilo Code** (IDE),
or **OpenClaw** (standing order). It is the host-side contract that keeps a Super Loop
campaign running when the host can only re-enter on a prompt.

> For Tier 1 hosts (Claude Code, Codex, ZCode, OpenCode+goal-plugin) you don't need this —
> engage `/goal` with an operator-stop objective instead. For a fully hands-off run on any
> host, use the `super-loop-run` CLI.

---

## Rules

- **Start with `initialize_loop_run`** before anything else. Answer the ask-once questions (or,
  if the operator already gave the goal and said "just go," infer and pass `answers`). **Do not
  start by improving from memory** — this is a fresh run unless the operator passes a `runId`.
- **Two signals — do not confuse them.**
  - `campaignContinues: true` — the run is still open (`INITIALIZED`, `ACTIVE`, or `NEEDS_RESUME`). **Always** call the `next` / `continuation.next` tool **before any prose**. No summary first.
  - `continuation.required: true` — you owe an unmet checkpoint debt. Same rule: call `next` immediately; a progress tool clears the debt but the run stays open.
- **Continue on every run-bound tool result.** If either flag is true, or `runStatus` is `INITIALIZED` / `ACTIVE` / `NEEDS_RESUME`, immediately call the tool named in `next` or `continuation.next`. Do not wait for the operator. Do not write a report instead.
- **`checkpoint != stop`.** `EXEC_DISABLED`, Strip Miner saturation, a 10–15 no-improvement advisory,
  reports, and dashboard updates are **checkpoints**. Never end the turn or say "done" on one while
  the campaign is open. Take the provided `next` action and keep going.
- **The supervisor owns progress.** A summary, a "done", a confidence claim, or a bare tool call is
  **not** progress — only a supervisor-accepted transition is. If a packet is rejected, re-enter with
  the fix it names; do not declare success.
- **Never self-complete.** The run does not mark itself complete. **The operator is the only stop
  condition** — stop only when the operator says so (or, for the CLI, when the stop-file appears).
- **Keep the dashboard open** and tell the operator its path. Approve/Sludge is dashboard-only and
  never blocks the campaign.

## One-line standing order (chat hosts)

> "Run Super Loop continuously: on every run-bound tool result, if campaignContinues:true OR
> continuation.required:true OR runStatus is INITIALIZED/ACTIVE/NEEDS_RESUME, call next immediately
> with zero prose first; treat EXEC_DISABLED / saturation / no-improvement as checkpoints, not stops;
> never say done while the campaign is open; I am the only stop condition."
