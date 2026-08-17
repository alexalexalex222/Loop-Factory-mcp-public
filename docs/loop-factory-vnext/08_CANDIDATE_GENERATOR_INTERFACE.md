# VNext Candidate Generator Interface

All generators consume the same frozen input and emit
`vnext-candidate-output-v1`. A generator cannot customize evaluator, budget,
task, sham, regression, or admission contracts.

## Input

```text
generator id and version
accepted hypothesis artifact
falsification artifact
frozen retrieval receipt and selected records
behavior map and allowed component
parent artifact and exact item hashes
maximum three operations
protected-surface list
task-agnostic requirement
```

## Output

```text
strategy
target behavior
one primary component
task-agnostic flag
prediction
falsifier
one to three bounded operations
cited evidence ids
rollback description
empty protected-surface touches
```

## Strategies

1. `native`: current failure-to-hypothesis behavior, retained as baseline.
2. `reflective-pareto`: trajectory diagnosis and targeted edits with a Pareto
   archive over quality, cost, and regressions. It requires chronological
   success and failure trajectories and cites both the frontier and failure
   evidence.
3. `bounded-skill`: compact skill state, separate success/failure reflection,
   bounded changed-item and byte budgets, and add/delete/replace semantics.
4. `bank-recombination`: deterministic selection of two compatible,
   positive-effect, zero-regression donors from distinct families, with both
   lineages bound into one recombination operation.
5. `code-level-experimental`: disabled by default, disposable worktree, one
   component, exact source locators, prediction, rollback, and protected-surface
   enforcement. Only replace operations are accepted; required test executable
   paths, hashes, literal argv, timeouts, maximum files, and patch bytes are
   frozen before execution.

## Plugin Contract

A plugin exports:

```js
{
  id,
  version,
  featureFlag,
  createContract(input),
  normalizeOutput(output, contract),
  verifyCandidate(candidate, contract)
}
```

`createContract` is deterministic. `normalizeOutput` validates strict model JSON.
`verifyCandidate` checks citations, exact parent hashes, component ownership,
task-agnostic scope, operation count, and protected surfaces. It cannot score or
admit the candidate. Strategy-plan validation is semantic as well as hash-based,
so an attacker cannot re-seal a malformed plan with a new digest.

Code-level candidates are launched only through `vnext:code-candidate` and are
replayed through `verify:vnext:code-candidate`. The source repository remains
unchanged; only the detached worktree and run-state directory are writable.
