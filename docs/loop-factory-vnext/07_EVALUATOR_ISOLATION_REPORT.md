# Evaluator Isolation Report

Status: implementation and adversarial fixture tests pass. No paid live semantic
evaluation was launched in this tranche.

## Production Boundary

Production semantic evaluation currently supports GPT routes through the strict
Codex executor only. Other provider routes fail with
`EVALUATOR_PROVIDER_ISOLATION_UNSUPPORTED` until provider-specific isolation is
implemented and tested.

Each ordinary invocation receives:

- task specification;
- fixed public rubric;
- one or two anonymous artifacts in a committed, counterbalanced order;
- objective verifier facts;
- bounded task-local evidence.

It does not receive research, hypothesis, lineage, proposer identity, previous
scores, arm names, model identity, admission state, or promotion commands.

## Process Isolation

- one fresh OS process and state directory per task/arm slot;
- hash-only slot and task identities in the directory and worker packet;
- no inherited conversation;
- isolated `HOME` and `TMPDIR`;
- temporary auth-only `CODEX_HOME` capsule, removed after execution;
- strict Codex no-tool argv with the complete disabled-feature list;
- frozen model, reasoning, sampling, rubric, prompt, schema, tool, binary, and
  wrapper hashes;
- persisted stdout, result, process, and worker-packet hashes.

Semantic output is measurement-only. It cannot emit or trigger activation.
Objective verifiers remain authoritative where deterministic checks exist.

## Adversarial Tests

`test/isolated-evaluator.test.mjs` verifies label and prior-score rejection,
unsafe path rejection, deterministic pair randomization, distinct state,
prompt/rubric/tool drift invalidation, no promotion fields, separate-process
fixture execution, disk replay, test-seam refusal, non-Codex fail-closed behavior,
absence of raw arm IDs from the packet and directory name, and refusal when an
otherwise-valid transcript reports isolation failure or any forbidden tool use.

The remaining proof obligation is the two-form live Codex security qualification
under sealed development material, followed by disk replay. It is deliberately
outside this no-paid-run tranche and is not a causal ablation arm.
