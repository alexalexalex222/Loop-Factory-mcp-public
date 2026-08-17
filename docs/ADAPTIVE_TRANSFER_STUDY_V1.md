# Adaptive Transfer Study V1

Status: implementation and scientific contract

This study tests one narrow claim:

> A frozen, evidence-routed mechanism improves fresh GPT-5.6 Sol proposals on
> unseen tasks more often than the same model without memory, while an
> irrelevant sham does not move quality and protected controls do not regress.

It does not assume the mechanism helps. A valid `FAIL`, `NO_HEADROOM`, or
`UNSTABLE_CONTROL` is evidence.

## Design

The study contains 5-12 candidates. Their execution order is derived from the
sealed study seed and candidate IDs, then bound into the plan. Every candidate
has two separate adaptive meta-canary configs:

1. `qualification-only` uses proposal-visible development evidence and five
   evaluator-only qualification shards.
2. `full` starts with a fresh no-memory proposal and uses five different
   evaluator-only confirmation shards.

Qualification and confirmation hold the target, development evidence,
mechanism family, routing evidence, policy epoch, model authority, and
implementation constant. Their hidden paths, bytes, shard IDs, case IDs, and
path-qualified locators must be disjoint. Development and hidden paths, bytes,
IDs, and path-qualified locators are also globally disjoint across every
candidate; the parent rejects any candidate partition that names another
candidate's identity.

The parent selects the first five candidates, in the seeded order, whose
qualification child proves:

- at least four of five target shards still fail under no-memory;
- all five protected control scores equal 1;
- every receipt, prompt, partition, schema, model, isolation, and hash gate
  passes.

New studies must set `qualificationStopRule` to
`first-five-or-impossible-v1`. Screening stops as soon as five tasks qualify
or the number already qualified plus the frozen remaining candidates is less
than five. The independent verifier recomputes that exact stopping position.
Historical studies without the field remain verification-compatible.

Qualification outputs are never reused as confirmatory baselines. Selected
tasks restart with fresh baseline, routed, and sham proposals. This prevents
selection from locking in an unusually weak baseline.

## Endpoint

The confirmatory study passes only when:

- all five child meta-canaries pass;
- each child has routed wins on at least four of five paired shards;
- aggregate sham wins equal zero;
- aggregate routed control regressions equal zero;
- the task-level one-sided exact sign-test is `5/5`, `p = 0.03125`;
- routed mean token overhead is at most 25% versus no-memory;
- all parent and child integrity gates pass;
- promotion remains disabled.

No endpoint changes after plan approval.

## Exposure

Each qualification child can make six calls. Each selected confirmation can
make eighteen calls. For `N` frozen candidates:

```text
maximum calls = (N * 6) + (5 * 18)
```

Five candidates permit at most 120 calls. Twelve candidates permit at most
162 calls. Calls are sequential inside each child, retries are zero, and every
call uses exact `gpt-5.6-sol`, high reasoning, ChatGPT OAuth, strict read-only
isolation, and schema-constrained output.

There is no hard token or USD ceiling in the OAuth harness. The exact call
ceiling is the enforceable exposure limit.

## Provenance Firewall

Every new meta-canary config must set:

```json
{
  "evaluationProcedureNormalization": "development-identifiers-v1"
}
```

Before evaluation, proposal-only development paths, development case IDs, and
development locators are replaced with generic bound labels. The evaluation
procedure hash is computed from those normalized bytes. The independent
verifier rejects a persisted evaluation prompt if any forbidden development
identifier remains.

Historical configs without this field remain verification-only. Their plans
and evidence hashes replay unchanged.

## Failure-Driven Improvement

Confirmation evidence is a vault, not a development set. When a study fails:

1. Keep the failed study immutable.
2. Classify the failure as no headroom, unstable controls, no routed lift, sham
   movement, control regression, excessive cost, or invalid evidence.
3. Invalid experiments receive no causal credit and cannot update routing.
4. Valid negative experiments may create explicitly negative or
   failure-derived mechanism applications.
5. Change one mechanism or policy variable in the discovery partition.
6. Test the new version on discovery tasks.
7. Freeze a new family or policy epoch and use a new untouched confirmation
   pool.

Reusing failed confirmation cases to tune the next version would turn the
study into training, so those cases cannot support another confirmation claim.

## Commands

Plan only:

```bash
npm run transfer-study:plan -- \
  --config <study.json> \
  --run-id <run-id> \
  --home <proof-home>
```

The plan command resolves and seals every child config, prints the maximum
exposure and exact plan SHA-256, and launches no worker.

After explicit approval of that exact plan hash:

```bash
npm run transfer-study -- \
  --config <study.json> \
  --approved-plan <plan-sha256> \
  --run-id <run-id> \
  --home <proof-home>

npm run verify:transfer-study -- \
  --home <proof-home> \
  --run <run-id>
```

The independent verifier reloads the sealed parent config, re-verifies every
child from disk, reconstructs first-five selection, recomputes tokens and the
endpoint, and exits nonzero unless the experiment itself is valid.
