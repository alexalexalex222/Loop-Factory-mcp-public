# Loop Factory VNext Baseline State

Frozen UTC: `2026-08-05T00:37:32Z`

## Repository Provenance

- Canonical evidence checkout: private operator source checkout (not shipped)
- Canonical branch: `build-week`
- Canonical HEAD: `1c4bc25fa58814d68fdf2ffcec41e1eff6294359`
- Isolated VNext checkout: private operator evidence checkout (not shipped)
- Isolated branch: `vnext-controlled-20260805`
- Sling/Hermes checkout: external private checkout (not shipped)
- Sling/Hermes branch and HEAD: `feat/terminal-and-kb-2026-07-07` at `b6d49a02bdfb492ba29e73651dbcf031af62f70c`

The canonical Loop Factory checkout began with 23 modified tracked paths and
136 untracked paths. The current recursive/adaptive implementation is part of
that preserved dirty overlay and is not present in HEAD by itself. The isolated
checkout was cloned from HEAD and overlaid byte-for-byte from canonical source,
excluding only `.git`, `node_modules`, generated `proof/`, backup directories,
timestamped `.bak` files, and `.DS_Store`.

The canonical status SHA-256 before and after isolation was identical:
`be63850fb1449110891757b1460b51ad66219b02949a1f8548a64187d5d45076`.

## Recovery Checkpoint

- Backup archive: private operator recovery archive (not shipped)
- Archive SHA-256: `e065adf09884657009bc3bc98075cc92ebc656ed3e58134b97530a002ad1f2f1`
- Archive entries: `6310`
- Saved canonical status: `status.txt`
- Saved tracked binary patch: `tracked.patch`
- Saved staged patch: `staged.patch`
- Starting source-file manifest SHA-256: `1fb8684dcea1e65d7ac51302af845b7534c24608c5e47df7d754d9de00dd1d69`
- Starting isolated status SHA-256: `7a0fb3178dc91be5730b65c36c105446ba4ca9953d2183c43159c04b10193238`
- Starting tracked patch SHA-256: `682f70ddf9dfe2f4c1107b5011532065d9ee826f3dbb1b94862feee884bab4d4`

Checkpoint artifacts remain in private operator recovery storage and are not
part of the public source release.

## Baseline Verification

Commands were executed from the isolated checkout with Node `26.5.0`:

```bash
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm test
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm run verify
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm run verify:submission
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm run verify:router-scale
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/npm pack --dry-run --json
git diff --check
```

Results:

- Full suite: `662 passed`, `0 failed`, `0 skipped`, `329630.875458 ms`.
- Full-suite log SHA-256: `c77d1a61a96e1211d1f3bdb08be21582f92c548028d13aed75c9d316f8c159b2`.
- Focused router/hypothesis/statistics/admission suite: `29 passed`, `0 failed`.
- Bundled loop source verification: PASS.
- Submission replay verification: PASS with evidence SHA-256
  `975a46c1414159a1e9e71eb31ef4c85fca89a48286a89c1166996cc2afb52e15`.
- `git diff --check`: PASS.
- Package dry run: `230` entries, `898595` tarball bytes,
  `3153444` unpacked bytes, and no test, backup, or `.bak` pollution.
- Live paid VNext calls: none.

## Deterministic Router Baseline

`npm run verify:router-scale` produced
`mechanism-router-scale-gauntlet-v1` with report SHA-256
`101e9505ec6128ccfbf6a57a835258945da4b4a31c9b003e456d5e07691b1d03`.

- Input families: `592`
- Eligible candidate pool: `544`
- Selected mechanisms: `14`
- Candidate-pool bytes: `369182`
- Selected-capsule bytes: `15340`
- Quarantined families excluded: `16`
- Input-order invariance: PASS
- Duplicate-family invariance: PASS
- Partition and quarantine firewall: PASS
- Structural diversity: PASS
- Seeded exploration replay: PASS
- Negative/failure-derived retrieval: PASS

This is an integrity and scale baseline, not a semantic recall or downstream
utility benchmark. VNext must preserve it as the deterministic fallback and
hard eligibility authority.

## Current Artifact Flow

```text
persisted supervisor failure and measurement evidence
  -> improvement-memory receipt construction and append-only ledger
  -> mechanism catalog reconciliation and lifecycle filtering
  -> deterministic active/shadow routing with control allocation
  -> bounded model mutation proposal
  -> supervisor-owned mutation plan and semantic clone check
  -> candidate, parent, sham, and cold replicated execution
  -> adaptive-measurement-v2 records
  -> independent recursive verifier replay
  -> replicated admission record with campaign familywise correction
  -> routing-only ACTIVE family or measured rejection
  -> generation-local learning receipt and context observation
```

Primary source authorities:

- `src/improvement-memory.mjs`: receipt construction, lifecycle classification,
  integrity validation, and append-only persistence.
- `src/mechanism-catalog.mjs`: locked reconciliation, schema/integrity filtering,
  family/application catalog, and adaptive-record persistence.
- `src/mechanism-router.mjs`: deterministic eligibility, ranking, diversity,
  wildcard/control allocation, and active routing decisions.
- `src/mechanism-hypothesizer.mjs` and `src/mechanism-mutation.mjs`: bounded
  schema output, exact cited-item hashes, supervisor-owned plans, and semantic
  clone comparison.
- `src/adaptive-recursive-runner-v2.mjs` and
  `src/adaptive-recursive-campaign.mjs`: replicated execution, dispatch journal,
  finite generations, context policy, stop behavior, and independent replay.
- `src/adaptive-measurement-v2.mjs` and
  `src/mechanism-evolution-admission-v2.mjs`: paired task-cluster measurements
  and replicated activation records.
- `src/run-verifier.mjs`: ordinary persisted run replay.
- `src/app-contract.mjs`, `src/console.mjs`, `src/dashboard.mjs`, and
  `scripts/dashboard-server.mjs`: sanitized read model and local operator stop.

## Existing Mutation Surface

The current recursive path permits bounded edits to executable mechanism
programs and compiled capsules. A proposal is limited to three declared
operations and must cite exact item hashes. ACTIVE families alter routing and
hypothesis context only; they do not modify canonical loops, evaluators,
benchmarks, or promotion authority.

VNext may add feature-flagged candidate strategies and disposable-worktree code
proposals, but every strategy must emit one shared candidate contract and remain
inside a predeclared behavior/component boundary.

## Protected Surface

The following remain outside same-run model mutation:

- evaluator prompts, rubrics, tools, state, and hidden inputs;
- benchmark tasks, answer keys, partitions, sealed manifests, and shams;
- statistical admission and promotion logic;
- verifier source and verifier-owned evidence reconstruction;
- model identity authority and invocation receipts;
- security policy, permissions, source hashes, and credential boundaries;
- quarantine, rollback, and deployment authority;
- canonical loop bytes and public release source.

Any attempted candidate edit to these surfaces is an authority violation, not a
candidate failure that may be retried.

## Known Baseline Gaps

1. Recursive campaigns lack an exclusive per-run lease against concurrent
   supervisors.
2. The plan reports call exposure but hard token and USD ceilings are `null`.
3. Lossless hydration exists but is not integrated into campaign retrieval.
4. Development/failure learning and context policy do not form a first-class
   automatically loaded cross-run ledger.
5. The recursive campaign consumes predeclared finite generations; it does not
   build and seal later waves autonomously.
6. Trustworthy arbitrary-domain task/oracle packs are still manually prepared.
7. There is no first-class replicated memory versus no-memory versus irrelevant
   memory causal study.
8. The recursive dashboard can stop and observe a run but cannot issue a
   restrictive quarantine, denial, or rollback receipt.
9. Exact Codex argv is bound, but backend-reported model identity may be absent.
10. Conceptual clone detection across differently worded learning records is
    weaker than executable-program semantic clone detection.
11. Context adaptation is a bounded heuristic, not a cross-run learned
    allocation policy.
12. Sling/Hermes does not yet consume the Loop Factory VNext API.

## Freeze Rule

No VNext implementation source may be written until the primary-source prior
art provenance and `02_PRIOR_ART_DECISION_MATRIX.md` are frozen. No final sealed
task data may be exposed to an implementation or research model. No public or
paid benchmark campaign is authorized by this baseline.
