# Portability Verification Matrix

## Current Evidence

| Environment | Runtime | Suite | Result |
| --- | --- | --- | --- |
| Local macOS | Node 22.14.0 | Full combined suite | PASS: 950 tests, 947 passed, 0 failed, 3 declared platform skips |
| Local macOS | Node 24.19.0 | Full combined suite | PASS: 950 tests, 947 passed, 0 failed, 3 declared platform skips |
| Local macOS | Node 24.19.0 | Demo | PASS: 47/47 |
| Local macOS | Node 24.19.0 | Packed install | PASS: 393 files, 29 tools, state round-trip |
| Local macOS | Node 24.19.0 | Recursive null | PASS with unreachable multi-generation admission kept diagnostic |
| GitHub Ubuntu | Node 22 | Full combined suite | PENDING |
| GitHub Ubuntu | Node 24 | Full combined suite | PENDING |
| GitHub Windows | Node 24 | Full combined suite | PENDING |
| GitHub macOS | Node 24 | Full combined suite | PENDING |
| GitHub macOS | Node 22 | Focused executable-sandbox replay | PENDING |

Node 22 full-test log SHA-256:
`be33e81f27f4c42820f95b377e9de7306c0123569651b59a0f69a3d4ffadf225`

Node 24 full-test log SHA-256:
`4ea391dbfa50db576baa6947f2a90a230890c0bc5595e8f760c969fcfa1c7eac`

## Claim Boundary

The combined VNext tree is locally verified on macOS. It is not yet called
cross-platform verified. That claim requires the pending hosted rows to pass on
fresh GitHub runners. Authenticated third-party provider CLIs are outside this
fixture-only matrix.
