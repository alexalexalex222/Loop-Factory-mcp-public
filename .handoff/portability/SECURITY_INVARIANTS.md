# Portability Security Invariants

## Preserved

- Bundled loop bytes, hashes, line counts, identities, and aliases are unchanged.
- `SUPER_LOOP_ALLOW_EXEC` remains opt-in and disabled by default.
- Worker routes and executable families remain controller allowlisted.
- Prompts remain stdin data and never enter a shell command or model argv.
- Native executables remain shell-free.
- Windows `.cmd` and `.bat` support is isolated to the fixed command-shim
  adapter; percent expansion and descendant-timeout behavior have native tests.
- No model can supply an arbitrary executable, command line, or shell fragment.
- Timeouts, nonzero exits, malformed output, and ambiguous paid dispatches fail
  closed and do not become valid evidence.
- Promotion remains operator controlled; routing memory has no promotion or
  activation authority.
- Exact source, schema, evaluator, plan, receipt, and artifact hashes are replayed.
- No real provider call, evaluator call, fallback, retry, or promotion occurred
  during local CI preparation.

## Platform-Specific Boundaries

- Normal process-atomic state, server, package, dashboard, and fixture flows are
  intended for macOS, Linux, and Windows.
- Paid VNext dispatch requires file-and-directory power-loss durability. macOS
  and Linux implement that contract; Windows refuses before state mutation.
- Task-pack structure and sealed evaluator authority records are portable. The
  executable baseline creation and replay step remains macOS-only and must pass
  a fresh live evaluator-authority check before execution.
- The disabled code-candidate executor requires macOS `sandbox-exec`. Linux and
  Windows refuse before worktree access.

Hosted operating-system execution is still required before the intended
cross-platform paths become a verified public claim.
