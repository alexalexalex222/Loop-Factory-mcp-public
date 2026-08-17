# VNext Security Review

Review date: `2026-08-05`

## Closed Findings

- Task partition and task-pack hash are sealed into the execution binding;
  import no longer accepts a caller partition.
- Verifier eligibility requires explicit authority and local source replay;
  hash-shaped claims and fixtures cannot enter production memory.
- Research, hypothesis, falsification, feedback, and retrieval chronology is
  monotonic.
- External discovery has a dedicated browser-only tool policy; deterministic
  fetching separately rejects private/IP-literal hosts, private resolved peers,
  redirects, unauthorized TLS, forbidden MIME, invalid UTF-8, and byte-cap
  violations.
- External source receipts use portable relative raw paths and rederive every
  bounded excerpt from exact captured bytes.
- Production semantic evaluation fails closed to strict Codex isolation, uses
  hash-only slots, isolated HOME/TMPDIR, and a temporary auth-only capsule.
- Candidate operations must match exact behavior-map locators and parent hashes.
- Code-level candidates run in detached worktrees under a network-denied macOS
  sandbox. The verifier binds the input packet, sandbox executable/profile,
  literal argv, patch, changed paths, executable hashes, and test logs.
- Replicate pseudoreplication was removed from confidence and sign tests.
- Stale run-mutex release uses nonce compare-and-swap.
- Event output uses bounded allowlists and secret-value redaction.
- Evidence index entries are references unless an actual replayed verifier hash
  marks the exact digest bound.
- Stop and operator-control actions require exact run revisions.
- Sling admin mutations fail closed without an admin token; token bootstrap is
  loopback-only; Loop decision credentials remain server-side.
- Sling response reads have streaming byte ceilings, lists page to completion,
  event failures remain visible, and pending actions bind run/control revisions.

## Preserved Trust Boundaries

Candidate generators cannot edit evaluator, verifier, statistics, hidden tasks,
model identity, source hashes, security policy, or promotion authority. External
research and task artifacts are untrusted bounded inputs. Sealed execution has
no network unless separately preregistered. Promotion remains disabled.

## Residual Risks

- No production live evaluator invocation was performed in this tranche.
- The final benchmark depends on an honest external custodian and untouched task
  pack.
- Local filesystem compromise can rewrite code and evidence together; source
  freeze and external hash custody remain necessary.
- Provider-specific evaluator isolation beyond Codex is not implemented.
- Code-level candidate execution and replay are fixture-proven but disabled and
  not performance-proven in a live benchmark.
- Five-cluster Bonferroni admission is unreachable for two generations; this is
  now disclosed rather than bypassed.
