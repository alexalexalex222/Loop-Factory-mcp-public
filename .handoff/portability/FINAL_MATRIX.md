# Portability Verification Matrix

## Current Evidence

| Environment | Runtime | Suite | Result |
| --- | --- | --- | --- |
| Local macOS | Node 22.14.0 | Full combined suite | PASS: 956 tests, 951 passed, 0 failed, 5 declared platform skips |
| Local macOS | Node 24.19.0 | Full combined suite | PASS: 956 tests, 951 passed, 0 failed, 5 declared platform skips |
| Local macOS | Node 24.19.0 | Demo | PASS: 47/47 |
| Local macOS | Node 24.19.0 | Packed install | PASS: 393 files, 29 tools, state round-trip |
| Local macOS | Node 24.19.0 | Recursive null | PASS with unreachable multi-generation admission kept diagnostic |
| GitHub Ubuntu | Node 22 | Full combined suite | PASS in run `32029397722` |
| GitHub Ubuntu | Node 24 | Full combined suite | PASS in run `32029397722` |
| GitHub Windows | Node 24 | Full combined suite | PASS in run `32029397722` |
| GitHub macOS | Node 24 | Full combined suite | PASS in run `32029397722` |
| GitHub macOS | Node 22 | Focused executable-sandbox replay | PASS in run `32029397722` |

Node 22 full-test log SHA-256:
`e002146c31d12d381436c1b67db2de706cf59d729154d47b0b0b50f462360a43`

Node 24 full-test log SHA-256:
`7f3e39a60cd32e302fa2f4893ba9c2a4c372d9cfd51637366e4dbed4a5eb6bb9`

## Claim Boundary

The combined public core and its declared portability matrix are verified on
fresh Ubuntu, Windows, and macOS runners in
[workflow run `32029397722`](https://github.com/alexalexalex222/Loop-Factory-mcp-public/actions/runs/32029397722),
for commit `0c9b7b3d69e99f1c2a87234a2626966939cb1572`. This does not claim
authenticated third-party provider CLI behavior, Windows power-loss durability,
or Linux/Windows execution of the intentionally macOS-only evaluator sandboxes.
