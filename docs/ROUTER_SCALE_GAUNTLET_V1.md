# Router Scale Gauntlet V1

`npm run verify:router-scale` is a deterministic adversarial verification of
the adaptive mechanism router. It is not a model benchmark and does not claim
that a synthetic corpus improved a task.

The gauntlet constructs 592 schema-valid mechanism families:

- 512 positive harvest families, arranged as near-clone structural cohorts;
- 32 failed families retained only for failure-derived inversion;
- 16 gate families and 16 reference families that must not route;
- 16 contradicted harvest families that may teach avoidance, never positive
  transfer;
- 16 explicitly quarantined positive families that must not route.

It verifies that:

1. Input order cannot change the candidate pool, capsule, or routing decision.
2. Repeated family records are deduplicated before ranking and hashing.
3. Gate, reference, and quarantined evidence cannot enter the candidate pool.
4. Structurally distinct mechanisms are preferred before near-clone fallback.
5. Failure-derived selections remain explicit inversions.
6. The raw policy seed is withheld while seeded exploration remains replayable.
7. Every selected capsule contains the complete authoritative causal
   fingerprint and matching family hash.
8. No authoritative mechanism is compacted or deleted.

The JSON report includes candidate-pool and selected-capsule byte counts. These
are observations for future allocation policy, not automatic compression
triggers. Context policy must continue to optimize verified useful work rather
than raw token minimization.
