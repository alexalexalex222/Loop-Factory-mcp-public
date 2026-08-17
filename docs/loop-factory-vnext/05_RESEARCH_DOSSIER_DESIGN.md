# Research Dossier Design

Status: implemented and locally verified on `2026-08-05`.

## Purpose

The dossier is a compact, immutable boundary between evidence collection and
hypothesis generation. It prevents a hypothesizer from receiving the whole
repository, future outcomes, sealed tasks, or an unbounded memory dump.

## Inputs

- one normalized failure artifact;
- verifier-eligible evidence records available at the decision time;
- one frozen hybrid-retrieval receipt;
- one fresh-context internal-research artifact;
- optional primary sources selected by a fresh browser-only discovery worker,
  then fetched and replayed by a separate deterministic worker; disabled in
  sealed mode;
- public architecture constraints;
- explicit item and byte ceilings.

Every input has a schema version, content hash, and availability time. Research,
retrieval, external-source, dossier, feedback, prior-hypothesis, and
falsification artifacts must all predate or equal the contract decision time.
Future artifacts fail closed.

## Output

`vnext-research-dossier-v1` separates facts, counterexamples, contradictions,
uncertainties, and unanswered questions. It includes a bounded source index and
progressive-disclosure summary. Source IDs remain attached to every model fact.

## Authority

The researcher and dossier can recommend context only. They cannot mutate a
candidate, score an arm, admit evidence, activate routing, or deploy anything.
External research is allowlisted to primary HTTPS sources and is always disabled
for sealed evaluation. The discovery model can propose URLs only inside a frozen
host allowlist. It cannot supply source bytes. The fetch worker independently
resolves public addresses, requires authorized TLS, rejects redirects and
forbidden MIME types, enforces per-source and total byte ceilings, and persists
portable raw bytes. The dossier accepts those sources only after replay.

## Replay

- `src/vnext-external-research.mjs` freezes discovery policy and materializes a
  bounded fetch plan.
- `src/vnext-external-research-worker.mjs` captures and replays exact bytes.
- `src/vnext-research.mjs` freezes the verified network evidence into a stage
  artifact and builds the internal synthesis contract.
- `src/research-dossier.mjs` builds and validates the compact dossier.
- `test/vnext-research.test.mjs` rejects future stage artifacts.
- `test/research-dossier.test.mjs` checks chronology, source integrity, sealed
  mode, and hard item/byte ceilings.
- `test/vnext-external-research.test.mjs` checks browser-only discovery and host
  escape refusal.
- `test/vnext-external-research-worker.test.mjs` checks portable raw-byte replay
  and tamper refusal.

No claim is made that research improves task performance. That requires the B2
ablation on matched development and validation tasks.
