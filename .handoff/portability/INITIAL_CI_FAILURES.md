# Initial Hosted CI Failures

## Run

- Pull request: `#2`
- Workflow run: `32019059970`
- Event: `pull_request`
- Result used here: Windows Node 24 failed before the unit suite

## Demonstrated Failure

Bundled-loop verification passed, then source-manifest replay refused:

```text
SOURCE_ARTIFACT_MANIFEST_DRIFT
mismatched: src/native/darwin-fullfsync.c
```

The tracked C source was the only public text extension not covered by the LF
working-tree policy. Git therefore checked it out with CRLF on Windows while the
manifest bound its LF bytes.

## Correction

Add `*.c text eol=lf` to `.gitattributes`, regenerate the public source and
release manifests, and rerun the complete hosted matrix. No expected source hash
was weakened or redefined to accept CRLF.
