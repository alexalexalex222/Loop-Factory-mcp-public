# Loop Factory VNext Prior-Art Research

Research frozen: `2026-08-05`

This document records reported mechanisms and limitations from primary papers,
official project pages, and official repositories. Reported benchmark results
were not independently reproduced. No external source code was copied.

## GEPA

Primary paper: https://arxiv.org/abs/2507.19457

Official code: https://github.com/gepa-ai/gepa (MIT)

- Editable artifact: prompt or other textual components, with support for
  program/config text through adapters.
- Proposer: reflection model consumes trajectories and textual feedback, then
  proposes targeted mutations and merges.
- Memory/selection: population ancestry and per-example Pareto selection.
- Useful concept: preserve specialists and full-trajectory diagnoses rather
  than collapsing every candidate to one scalar.
- Limit: validation is repeatedly consumed during search; Pareto retention is
  diversity, not a statistical safety or non-regression guarantee.

## Meta-Harness

Primary paper: https://arxiv.org/abs/2603.28052

Official code: https://github.com/stanford-iris-lab/meta-harness (MIT)

- Editable artifact: complete Python harnesses including prompts, memory,
  retrieval, state, and orchestration.
- Proposer: coding agent searches source, scores, and execution traces.
- Memory/selection: full filesystem history and population/Pareto search over
  task score and context cost.
- Useful concept: provide code-level strategies with actual source, prior
  candidates, and traces in disposable worktrees.
- Limit: expensive joint search makes attribution weak; benchmark reuse and a
  missing formal regression/statistical gate prevent direct admission into Loop
  Factory.

## SkillOpt

Primary paper: https://arxiv.org/abs/2605.23904

Official project/code: https://microsoft.github.io/SkillOpt/ and
https://github.com/microsoft/SkillOpt (MIT)

- Editable artifact: one compact Markdown skill.
- Proposer: separate reflection over successes and failures, followed by
  bounded add/delete/replace operations.
- Memory: best/current skill, rejected edits, slow-update content, and optimizer
  meta-skill.
- Useful concept: compact editable state, bounded textual learning rate,
  rejected-edit memory, and pre-replacement validation.
- Limit: point-score validation has no confidence, minimum effect, or repeated
  search control. Its held-out gate is not an untouched final test if repeatedly
  consulted.

## HarnessBank

Primary paper: https://arxiv.org/abs/2607.13683

Code status: the current paper says code will be public upon acceptance; no
official implementation was available at freeze time.

- Editable artifact: an explicitly partitioned mutable harness surface;
  evaluation/bookkeeping/evolution/interface-critical code remains kernel.
- Roles: separate task agent, evolver, deterministic evaluator, and semantic
  Harness Gene Bank.
- Memory/selection: quality-diversity cells indexed by where a change acts and
  why/pathology; reinvention and compatible cross-cell recombination.
- Screening: protocol validity, deterministic activation beacon, task-level
  paired significance, then full training evaluation and cell competition.
- Useful concept: semantic pathology cells, activation proof, negative cells,
  recombination lineage, and deterministic credit authority.
- Limit: training evidence is repeatedly reused for bank competition; its
  normal approximation and fixed z threshold do not control the adaptive
  candidate stream. The final sealed test design is useful, but the public code
  is unavailable.

## Self-Harness

Primary paper: https://arxiv.org/abs/2606.09498

Official code: not verified at freeze time.

- Editable artifact: broad harness definition over prompts, tools, memory,
  skills, subagents, and runtime policy.
- Loop: weakness mining, minimal harness proposals, and regression validation.
- Useful concept: structured failure signatures and same-model weakness mining.
- Rejected protocol: its named held-out split is evaluated for each candidate
  and used for acceptance. That is adaptive validation, not untouched final
  evidence; no statistical gate is reported.

## Agentic Harness Engineering

Primary paper: https://arxiv.org/abs/2604.25850

Official code: https://github.com/china-qijizhifeng/agentic-harness-engineering
(MIT at freeze time)

- Editable artifact: prompt, tools, middleware, skills, subagent configuration,
  and long-term memory as separately observable components.
- Evidence: layered trajectory compression with drill-down provenance.
- Decision contract: every edit declares evidence, cause, expected effect, and
  a falsifiable prediction.
- Useful concept: component observability, prediction receipts, and separate
  optimization surfaces.
- Limit: best-of-iteration benchmark selection has no formal statistical gate;
  reported regression prediction quality is weak enough that predictions must
  remain hypotheses, not acceptance authority.

## HarnessCompass

Primary paper: https://arxiv.org/abs/2608.01918

Official code: not verified at freeze time.

- Editable artifact: task-agnostic structural and guidance components.
- Evidence: trajectories plus first-person feedback from the task agent.
- Search: optimize components separately, then consolidate.
- Useful concept: task-agnostic change constraint, first-person feedback as
  noisy proposer evidence, and component-wise attribution.
- Limit: one new preprint, no reproduced code, no verified repeated seeds or
  confidence intervals, and consolidation requires an explicit post-merge
  replay before admission.

## Harness Handbook

Primary paper/project: https://arxiv.org/abs/2607.13285 and
https://ruhan-wang.github.io/Harness-Handbook/

Official code: https://github.com/Ruhan-Wang/Harness_Handbook (Apache-2.0)

- Artifact: source-derived behavior map containing stages, source locators,
  state, dependencies, and hashes.
- Useful concept: deterministic source facts plus model-assisted organization,
  progressive disclosure, and stale-locator detection.
- Limit: it improves planning/localization, not task quality or statistical
  admission. Generated prose cannot become runtime evidence.

## PACE

Primary paper: https://arxiv.org/abs/2606.08106

Official code: not verified at freeze time.

- Scope: paired anytime-valid commit evaluation for one fixed candidate.
- Method: candidate and incumbent run on identical instances; discordant paired
  outcomes update a betting e-process and may stop when wealth crosses `1/alpha`.
- Useful concept: optional-stopping-safe evidence inside one candidate decision.
- Limit: no run-level candidate-stream correction, sham/cost/regression gate, or
  protection against correlated replicates. Loop Factory must use task clusters
  as the statistical unit and retain familywise allocation across proposals.

## MOSS

Primary paper: https://arxiv.org/abs/2605.22794

Official code: https://github.com/hkgai-official/Moss (Apache-2.0 additions over
its vendored substrate at freeze time)

- Editable artifact: production harness source, routing, hooks, state, and
  dispatch logic.
- Pipeline: locate, plan, review, implement, code review, evaluate, verdict.
- Useful concept: staged code mutation with disposable execution images and
  explicit rollback health checks.
- Rejected protocol: in-place production rewriting and liveness-only rollback
  cannot satisfy Loop Factory semantic regression authority. Code mutation, if
  enabled, remains disposable, one-component, and disabled by default.

## Cross-Cutting Conclusion

The strongest compatible design is not one imported framework. It is a set of
bounded proposal strategies behind Loop Factory's existing verifier authority:

1. Handbook-style behavior localization.
2. Evidence-bound pre-hypothesis research.
3. Independent post-hypothesis falsification.
4. Deterministic eligibility plus lexical/semantic/model reranking.
5. GEPA-style Pareto diversity and HarnessBank-style pathology cells.
6. SkillOpt-style bounded edits and rejected-edit memory.
7. AHE-style prediction/falsifier receipts.
8. HarnessCompass-style component isolation and noisy first-person feedback.
9. PACE-style task-cluster e-process inside V2's stronger sham, cost,
   regression, confirmation, and familywise gates.
10. Meta-Harness/MOSS-inspired code candidates only in disposable worktrees,
    with protected-surface enforcement and no production self-rewrite.

The scientific threat is adaptive reuse of evaluation evidence until something
appears to pass. Better proposing does not repair a weak acceptor.
