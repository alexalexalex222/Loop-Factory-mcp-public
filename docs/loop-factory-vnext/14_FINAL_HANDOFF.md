# Loop Factory VNext Public Integration Handoff

## Current Status

VNext is integrated into the public Loop Factory source tree. This handoff
describes the code in this repository, not the older August 5 private proof
home. Historical receipts and launch authorizations were deliberately not
copied into the public release.

The combined tree is locally testable without model calls. It is not called
cross-platform verified until the repository's portability workflow passes on
GitHub-hosted Ubuntu, Windows, and macOS runners.

## What Is Implemented

The public core still mines workflows, freezes benchmarks, compares revisions,
reopens saved evidence, and leaves promotion to the operator. VNext adds:

- provenance-bound failure, research, dossier, hypothesis, falsification, and
  candidate stages;
- explicit-authority evidence memory and hybrid retrieval;
- native, reflective-Pareto, bounded-skill, bank-recombination, and
  disabled-by-default code candidate strategies;
- isolated Codex evaluator workers whose observed transcript must prove no
  forbidden context or tool use;
- task-cluster statistics, placebo calibration, untouched confirmation, PACE,
  budgets, leases, and finite campaign series;
- evidence-first, verifier-owned recursive import with an immutable commit
  receipt before catalog routing becomes eligible;
- a durable one-shot campaign launch authorization consumed before the first
  paid dispatch;
- counterbalanced semantic-judge security qualification using neutral item and
  criterion IDs; it is not represented as a causal B1 experiment;
- exact-candidate transfer and relocatable external-custodian planning; and
- deterministic repeated-selection null simulation with a disclosed minimum
  attainable task-sign p-value.

## Portability Boundary

The server, deterministic pipelines, package, state store, fake worker paths,
and narrow Codex command-shim adapter are designed for macOS, Linux, and
Windows. Native executables remain shell-free. Only allowlisted Windows
`.cmd`/`.bat` Codex shims use the dedicated `cmd.exe` adapter, with prompts kept
on stdin.

The experimental code-candidate executor remains macOS-only because its
network-denied boundary uses `sandbox-exec`. Linux and Windows refuse that
feature before touching a worktree. Provider CLI installation, authentication,
and backend availability are separate from core portability and are not claimed
by fixture-only CI.

Paid VNext dispatch uses a stronger file-and-directory power-loss barrier. That
barrier is available on macOS and Linux. Windows refuses before creating a
power-loss store until a native directory-flush adapter is implemented and
verified; normal process-atomic state, server, package, and fixture flows remain
cross-platform.

## Verification

Run from the repository root:

```bash
npm run verify
npm test
npm run verify:recursive-null
npm run demo
npm run package:smoke
npm run generate:hashes
npm run verify:hashes
git diff --check
```

`package:smoke` packs the release, installs it into a clean path containing
spaces, verifies the VNext package surface, handshakes the installed MCP
server, checks every tool and loop hash, and round-trips user state.

`.github/workflows/portability.yml` runs the full combined suite on Node 24 for
Ubuntu, Windows, and macOS, plus the declared Node 22 runtime floor on Ubuntu
and a focused macOS/Node 22 executable-sandbox replay. It contains no provider
secrets and makes no real model calls.

## Launch State

This public integration contains no approval, launch, paid-call, or consumed
study receipt. Every plan created against an earlier implementation hash is
stale by design. A future operator must generate new plans from the final source
bytes, review their exact exposure, and approve each paid child separately.

Do not treat a passing test suite, a generated plan, a semantic evaluator score,
or a routing-only import as promotion authority. None of them can overwrite a
canonical loop or approve a study.

## Scientific Bottom Line

The implementation and its safety contracts can be verified without model
calls. No matched live VNext campaign, generalized performance gain,
exact-candidate transfer result, or final sealed result is claimed here. Those
remain separate, explicitly approved experiments after the combined public
source passes hosted operating-system verification.
