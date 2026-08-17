# Portability Verification Matrix

## Current Evidence

| Environment | Runtime | Suite | Result |
| --- | --- | --- | --- |
| Local macOS | Node 22.14.0 | Full combined suite | PASS: 956 tests, 950 passed, 0 failed, 6 declared platform skips |
| Local macOS | Node 24.19.0 | Full combined suite | PASS: 956 tests, 950 passed, 0 failed, 6 declared platform skips |
| Local macOS | Node 24.19.0 | Demo | PASS: 47/47 |
| Local macOS | Node 24.19.0 | Packed install | PASS: 393 files, 29 tools, state round-trip |
| Local macOS | Node 24.19.0 | Recursive null | PASS with unreachable multi-generation admission kept diagnostic |
| GitHub Ubuntu | Node 22 | Full combined suite | FAILED in run `32019507672`; repair rerun pending |
| GitHub Ubuntu | Node 24 | Full combined suite | FAILED in run `32019507672`; repair rerun pending |
| GitHub Windows | Node 24 | Full combined suite | FAILED in run `32019507672`; repair rerun pending |
| GitHub macOS | Node 24 | Full combined suite | PASS in run `32019507672` |
| GitHub macOS | Node 22 | Focused executable-sandbox replay | PASS in run `32019507672` |

Node 22 full-test log SHA-256:
`ec37c0e30eba20bc463702ad400dab1c8043110be6dc3ff887a0c44be1fdb4fb`

Node 24 full-test log SHA-256:
`5c6b3096efabe262c54f4ead8f893aeabb0c8f1e65c81db098c0f71690564a29`

## Claim Boundary

The combined VNext tree is locally verified on macOS. Hosted run `32019507672`
proved both macOS rows and exposed non-macOS path, heartbeat, and fixture-boundary
defects. It is not yet called cross-platform verified; the repaired tree must
pass all fresh hosted rows. Authenticated third-party provider CLIs are outside
this fixture-only matrix.
