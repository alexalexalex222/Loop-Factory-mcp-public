# Executable Causal Canary V4

V4 keeps the V3 full-repair endpoint, hidden cases, three arms, strict model
route, zero retries, and independent disk verifier. It changes the treatment:
the routed prior is compiled from an identity-bound mechanism program instead
of being supplied only as free-form procedure text.

## Why V4 Exists

A valid V3 canary showed that a model could reinterpret a useful procedure in
two damaging ways: invent an undeclared identity equality and flatten an
explicit quality-first exception. More prompt wording would not make either
failure mechanically visible before launch.

V4 therefore separates three things:

1. A mechanism family declares a bounded `mechanism-program-v1`.
2. Each task declares exact semantic-role-to-input-path bindings in an
   `executable-interface-contract-v2`.
3. A pure compiler either emits a closed-world treatment packet or abstains.

The compiler does not claim that a model will obey the packet. Hidden
deterministic cases remain the behavioral authority.

## Compile Gate

Before a plan can be approved or launched, every routed and sham task must:

- normalize the same identity-bound mechanism program;
- map every declared semantic role to one unique visible input path;
- use only output decisions and codes declared by the visible interface;
- emit every ordered rule and explicit exception;
- expose allowed equality bindings as a complete closed-world allowlist;
- expose forbidden path pairs separately;
- reach compile coverage `1` with zero abstentions;
- produce routed and sham packets with the same structural schema.

Missing roles, undeclared outputs, malformed rules, or ambiguous path mappings
fail closed. The compiler never guesses.

## Treatment Control

The routed arm receives the compiled program. The sham arm receives a
deterministically remapped packet with the same arrays, rule kinds, exception
shape, decisions, and value types, but synthetic document roles, paths, IDs,
codes, and literals. The baseline receives no prior mechanism.

The plan binds each task's routed and sham packet hashes. The verifier rebuilds
both packets from the sealed family and interface, rebuilds each prompt, and
checks the persisted treatment hash.

## Pairwise Regression Accounting

V4 retains V3's full-repair win threshold and adds paired movement for every
confirmation task:

```text
routed target quality  versus paired baseline target quality
routed control quality versus paired baseline control quality
```

Each dimension is recorded as `improved`, `matched`, or `regressed`. A causal
pass requires zero paired target regressions and zero paired control
regressions, including tasks where the baseline was already incomplete.

## Unchanged Safety

- Qualification and confirmation mutation pools remain disjoint.
- Hidden expected outputs never enter a model process.
- Exact `gpt-5.6-sol`, high reasoning, ChatGPT OAuth.
- Tools and user configuration remain disabled inside worker calls.
- Promotion remains disabled.
- V1, V2, and V3 retain their historical treatment and outcome behavior.

## Interpretation

`PASS` means the compiled routed prior produced the predeclared full-repair
advantage without paired regression on the sealed population. `NO_CAUSAL_LIFT`
is still valid evidence. V4 does not promote a mechanism, prove universal
transfer, or turn compiler validity into a behavioral success claim.
