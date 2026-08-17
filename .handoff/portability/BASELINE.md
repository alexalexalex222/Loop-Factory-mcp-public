# Portability Baseline

## Source

- Base commit: `db1b5ac25e56a41b8bf96d2c2a820bdcca48b392`
- Commit subject: `Verify Loop Factory on Windows, macOS, and Linux`
- Replay date: `2026-08-17`
- Replay method: temporary detached worktree at the exact base commit
- Git state during replay: clean detached HEAD
- Runtime: Node `24.19.0`, npm `11.18.0`
- Paid or provider model calls: `0`

The baseline was replayed after the VNext integration work began because the
required handoff file was missing. That is a process-order deviation, not a
source ambiguity: the detached worktree used the exact immutable base commit.

## Results

| Check | Result |
| --- | --- |
| `npm test` | 430 tests, 428 passed, 0 failed, 2 declared platform skips |
| `npm run verify` | PASS |
| `npm run demo` | 47/47 checks passed |
| `npm run package:smoke` | PASS |
| `npm pack --dry-run --json` | 134 files, 602760 bytes packed, 1684753 bytes unpacked |
| `git diff --check` | PASS |

Full-test log SHA-256:
`6660af5417580bcb8f721ae6a6dfa0ce87f382b6582e6bb4d84bf0e58ec594de`

Package-smoke log SHA-256:
`d73243d2923315c53002a7dfa20936f13aff1c2ceebb985a378f76618396ff88`

## Frozen Product Identity

- `loops/strip-miner.txt`: 345 lines,
  `5270d691319120758423503e74c5aa6b378409b55f30bc6d2f2f7ca283ed9ec9`
- `loops/loop-de-loop.md`: 75 lines,
  `70090e033e995374710722771372d1afb17b6f0f823b2ce2911d9bfd38022b44`
- MCP tool count: 29
- Package entry points: `super-loop-mcp`, `super-loop-run`

Local raw receipts are under
`proof/public-integration-verification-20260817/` and are intentionally ignored
from publication.
