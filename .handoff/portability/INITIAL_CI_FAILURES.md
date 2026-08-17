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

## VNext Suite Run

- Workflow run: `32019507672`
- macOS Node 24: passed
- macOS Node 22 sandbox replay: passed
- Ubuntu Node 22/24 and Windows Node 24: failed in the combined unit suite

The fresh non-macOS runners exposed native path separators in one sealed
implementation manifest, Windows-only executable and path assertions, a
signal-only heartbeat shutdown, and test fixtures that tried to create macOS
`sandbox-exec` evidence on other operating systems. The repair keeps sealed
records portable, keeps live evaluator execution host-bound, and preserves the
Windows refusal for power-loss-durable paid dispatch.
