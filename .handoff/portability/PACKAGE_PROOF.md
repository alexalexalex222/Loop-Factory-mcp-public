# Packed Installation Proof

## Base Commit

The exact base commit packed and installed successfully on local macOS:

- 134 files
- 602760 packed bytes
- 1684753 unpacked bytes
- 29 MCP tools
- both frozen loop hashes verified
- `hosts/registry.json` and documented examples present
- installed MCP handshake passed
- isolated state write/reload passed
- install path contained spaces
- package-root state was not created

## Combined VNext Tree

The final local combined package smoke passed with:

- 393 files
- 29 MCP tools
- VNext package surface present
- both frozen loop hashes verified
- `super-loop-mcp` and `super-loop-run` installed
- isolated state write/reload passed
- install path contained spaces
- package-root state was not created

Compressed and unpacked byte totals are retained in the local package-smoke
receipt rather than copied here, because the benchmark manifest is part of the
tarball and its hash changes when this public handoff changes.

## Hosted Proof

Ubuntu, Windows, and hosted macOS packed-install results are pending the
portability workflow. Local package proof is not substituted for those rows.
