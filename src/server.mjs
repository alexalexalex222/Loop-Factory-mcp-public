#!/usr/bin/env node
// Zero-dependency MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Local-first by design: no network, no SDK, nothing to npm-install that could
// fail. The full loops live inside the server; tools stream + gate them.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStore } from './store.mjs';
import { createEngine } from './engine.mjs';
import { verifyAllLoops, loopSummary } from './loops.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_INFO = { name: 'super-loop', version: '1.0.0' };
const PROTOCOL_FALLBACK = '2025-06-18';

// ---- tool schemas (also drive tools/list for the host) -------------------
export const TOOL_SPECS = [
  {
    name: 'initialize_loop_run',
    description: 'Ask-once gate. Confirms the task before any loop runs. If the task is underspecified, returns one brief explanation plus a few short questions once (goal; PATH — improve / discover / mine; loop or domain; corpus scope + order; what "better" means; hard limit; ONE model-choice question — primary/test/builder/judge, or press enter for defaults, or say "any model" to disable the banlist; and a deeper-explanation offer); call again with { answers } to begin. Current defaults: GPT-5.6 Sol primary/test work, Fable 5 plus GPT-5.6 Sol build/gating, Fable 5 judge. The supervisor still owns measurement, integrity, and promotion. Stores every user message locally with a sha256 hash. After initialization it does not ask again or mark the campaign complete; the operator remains the stop condition and the dashboard stays available.',
    inputSchema: { type: 'object', properties: {
      task: { type: 'string', description: 'what to improve/build' },
      runId: { type: 'string', description: 'reuse to continue a run; omit to create one' },
      userMessages: { type: 'array', items: { type: 'string' }, description: 'verbatim operator messages — stored + hashed for the hook' },
      answers: { type: 'array', items: { type: 'string' }, description: 'answers to the ask-once questions (include the model-choice answer, or "defaults")' },
      model: { type: 'string', description: 'primary route; defaults to gpt-5.6-sol when omitted / "defaults"' },
      modelPreset: { type: 'string', description: 'named operator preset; "gpt-5.6-sol" selects GPT-5.6 Sol primary/test work with Fable 5 as the default independent builder and judge' },
      modelPolicy: { type: 'object', description: 'optional full policy: { primary, testRoutes, builderRoutes, judgeRoute, banlist:{mode,extraDeny,extraAllow}, allowUnknownFrontier }. Omitted → defaults (today\'s historical behavior).' },
      acceptanceCriteria: { type: 'string' },
      config: { type: 'object', description: '{ failurePatience(10-15), comparisonRule, promotion:{...}, mode }' }
    } }
  },
  {
    name: 'loop_start',
    description: 'Begin phase-gated streaming of a bundled or custom local loop. Opens/activates the supervisor lane for that loop. Use "strip-miner" (The Strip Miner Loop / cross-agent source miner, 345 lines), "loop-de-loop" (Loop 2, the improvement loop, 75 lines), or any id registered with loop_register. Returns ONLY section 0; the full loop stays inside the supervisor.',
    inputSchema: { type: 'object', required: ['runId', 'loop'], properties: {
      runId: { type: 'string' }, loop: { type: 'string', description: 'strip-miner, loop-de-loop, or a custom loop id from loop_library' }
    } }
  },
  {
    name: 'request_next_phase',
    description: 'Stream the next loop section. BLOCKED (PHASE_SKIP) unless the current section already has recorded evidence. Prevents 300+ lines collapsing into the model before real decisions.',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, loop: { type: 'string' } } }
  },
  {
    name: 'loop_next',
    description: 'Alias of request_next_phase.',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, loop: { type: 'string' } } }
  },
  {
    name: 'observation_record',
    description: 'Record lightweight evidence for the current phase (what you actually did/observed). Attach { loop, phase } to satisfy the phase gate and unlock the next section.',
    inputSchema: { type: 'object', required: ['runId', 'summary'], properties: {
      runId: { type: 'string' }, summary: { type: 'string' }, loop: { type: 'string' }, phase: { type: 'integer' }, kind: { type: 'string' }, sourceRef: { type: 'string' }
    } }
  },
  {
    name: 'artifact_record',
    description: 'Persist a raw artifact (run log, baseline copy) with a sha256 hash. role:"baseline" hash-locks the baseline (write-once; tampering refused). Pass measurement:{tokenCost,quality} so the artifact can serve as a tool-measured, reverifiable measurementRef. sourcePath reads are disabled; pass explicit content.',
    inputSchema: { type: 'object', required: ['runId'], properties: {
      runId: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' }, sourcePath: { type: 'string', description: 'disabled; pass content instead' },
      role: { type: 'string', description: 'baseline | evidence | runlog' },
      measurement: { type: 'object', properties: { tokenCost: { type: 'number' }, quality: { type: 'number' } } },
      loop: { type: 'string' }, phase: { type: 'integer' }, newEpoch: { type: 'boolean' }, rationale: { type: 'string' }
    } }
  },
  {
    name: 'benchmark_propose',
    description: 'Propose one or more benchmark scorecards built from real prior uses/failures. Each needs ≥1 task-value dimension, ≥1 resource/cost dimension, and ≥1 concrete case, or it is rejected as a hand-waved benchmark.',
    inputSchema: { type: 'object', required: ['runId', 'benchmarks'], properties: {
      runId: { type: 'string' },
      benchmarks: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, taskValueDimensions: { type: 'array', items: { type: 'string' } },
        resourceDimensions: { type: 'array', items: { type: 'string' } }, cases: { type: 'array' },
        oracle: { type: 'string' }, qualityScale: { type: 'string' }, comparisonRule: { type: 'string' }
      } } }
    } }
  },
  {
    name: 'benchmark_select',
    description: 'Freeze ONE proposed benchmark as the immutable scorecard for this cycle. Requires the baseline to be hash-locked first. Changing a frozen benchmark needs a new epoch + rationale.',
    inputSchema: { type: 'object', required: ['runId', 'benchmarkId'], properties: {
      runId: { type: 'string' }, benchmarkId: { type: 'string' }, newEpoch: { type: 'boolean' }, rationale: { type: 'string' }
    } }
  },
  {
    name: 'benchmark_freeze_maker',
    description: 'Bench-maker only: freeze a benchmark directly (benchSource:maker) without worker benchmark_propose. Defaults benchPartition to gate (held-out). Worker benchmark_propose becomes a no-op while this scorecard is frozen.',
    inputSchema: { type: 'object', required: ['runId', 'benchmark'], properties: {
      runId: { type: 'string' },
      benchmark: { type: 'object', description: 'Full scorecard: name, taskValueDimensions, resourceDimensions, cases, oracle, etc.' },
      benchPartition: { type: 'string', description: 'gate (held-out, default) or harvest' },
      newEpoch: { type: 'boolean' }, rationale: { type: 'string' }
    } }
  },
  {
    name: 'benchmark_run',
    description: 'Record a tool-measured run of an arm through the frozen benchmark. arm:"baseline" sets the bar challengers must beat. Requires a measurementRef → a recorded raw artifact; model self-report never sets the bar.',
    inputSchema: { type: 'object', required: ['runId', 'arm', 'measurementRef'], properties: {
      runId: { type: 'string' }, arm: { type: 'string', description: '"baseline" or a hypothesis id' }, measurementRef: { type: 'string' }
    } }
  },
  {
    name: 'register_hypotheses',
    description: 'Register 3–5 challenger hypotheses, each on a route allowed by the run\'s modelPolicy banlist (defaults reject haiku/mini/nano/lite/prior-gen). Requires baseline hash-lock + frozen benchmark + measured baseline bar (benchmark-first). Rejects <3 or >5.',
    inputSchema: { type: 'object', required: ['runId', 'hypotheses'], properties: {
      runId: { type: 'string' },
      hypotheses: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, bottleneck: { type: 'string' }, operation: { type: 'string' },
        expectedMovement: { type: 'string' }, route: { type: 'object', properties: { model: { type: 'string' } } },
        tradeoff: { type: 'string' }, falsifier: { type: 'string' }
      } } }
    } }
  },
  {
    name: 'test_hypothesis',
    description: 'Record ONE full test of a hypothesis = 3–5 frontier agents that actually ran the loop end-to-end. Every agent run must carry a measurementRef (tool-measured). Aggregates vs the frozen baseline bar; a no-improvement run is NO_IMPROVEMENT, never "perfect", and bumps the failure counter.',
    inputSchema: { type: 'object', required: ['runId', 'hypothesisId', 'fullTest'], properties: {
      runId: { type: 'string' }, hypothesisId: { type: 'string' },
      fullTest: { type: 'object', properties: { agentRuns: { type: 'array', items: { type: 'object', properties: {
        model: { type: 'string' }, measurementRef: { type: 'string' }
      } } }, notes: { type: 'string' } } }
    } }
  },
  {
    name: 'execute_full_test',
    description: 'SUPERVISOR-EXECUTED full test (off by default; opt in with env SUPER_LOOP_ALLOW_EXEC=1). Loop Factory itself LAUNCHES 3-5 allowlisted frontier workers (claude/codex/glm/gemini binaries on PATH) via execFile (never a shell), captures each output, and feeds the tool-captured bytes through the same gate as test_hypothesis — so there is no model-supplied run-log to fabricate. A failed/timed-out/non-allowlisted launch is an invalid batch and does not count toward retirement. Without the opt-in this returns BLOCKED (EXEC_DISABLED) and you record run-logs via artifact_record + test_hypothesis instead.',
    inputSchema: { type: 'object', required: ['runId', 'hypothesisId', 'routes', 'prompt'], properties: {
      runId: { type: 'string' }, hypothesisId: { type: 'string' },
      routes: { type: 'array', items: { type: 'string' }, description: '3-5 frontier worker routes to launch (each must map to an allowlisted binary)' },
      prompt: { type: 'string', description: 'the loop + task the launched worker should actually run' },
      timeoutMs: { type: 'integer', description: 'per-worker hard timeout (default 600000)' }
    } }
  },
  {
    name: 'reverify_run',
    description: 'Deep re-verification: re-hash every raw artifact behind a full test and confirm the claimed metrics reproduce. Promotion is blocked until this passes (anti benchmark-gaming / baseline-tampering).',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, testId: { type: 'string' }, hypothesisId: { type: 'string' } } }
  },
  {
    name: 'promotion_request',
    description: 'Request promotion of a hypothesis to internal champion. Requires a tool-measured, reverified full test on the frozen benchmark that moves the quality/cost frontier past threshold. Old green unit tests without a score matrix, model-reported metrics, or below-threshold results are BLOCKED. Never overwrites the operator’s canonical loop file.',
    inputSchema: { type: 'object', required: ['runId', 'hypothesisId'], properties: { runId: { type: 'string' }, hypothesisId: { type: 'string' } } }
  },
  {
    name: 'cycle_decision_request',
    description: 'The supervisor decision hook. A worker proposes a transition packet; only a supervisor-accepted transition counts as progress. Reasoning alone is never proof. Allowed transition intents: promote | advance_phase | change_baseline | change_benchmark | saturate. Completion/stop-style intents are refused (the operator is the only stop condition).',
    inputSchema: { type: 'object', required: ['runId', 'intent'], properties: {
      runId: { type: 'string' }, intent: { type: 'string' }, hypothesisId: { type: 'string' }, loop: { type: 'string' }, newEpoch: { type: 'boolean' }, rationale: { type: 'string' }
    } }
  },
  {
    name: 'run_campaign',
    description: 'AUTONOMOUS SUPERVISOR (opt-in: SUPER_LOOP_ALLOW_EXEC=1). One call drives the target queue (mine → improve), validates every worker, measures/reverifies challengers, and keeps dashboard review nonblocking. When remineOnEmpty is enabled, each changed work epoch gets one mining pass; empty or duplicate mining output enters IDLE_NO_NEW_WORK instead of launching repeated paid calls. The in-call MCP returns that nonterminal idle checkpoint; the standalone `super-loop-run` CLI stays alive with zero inference, drains dashboard decisions, and resumes from its persisted target inbox until the operator stop-file. maxBatches remains a safety cap, not completion. Returns MISSING_FULL_PRIVATE_LOOPS if a full private loop is absent.',
    inputSchema: { type: 'object', required: ['runId', 'config'], properties: {
      runId: { type: 'string' },
      config: { type: 'object', description: '{ task, routes:[3-5 frontier], benchmark:{name,taskValueDimensions,resourceDimensions,cases,oracle}, targets:[{kind:"mine"|"improve", loop?, baselineContent?, benchmark?, routes?}], noImprovePolicy?(default 30), remineOnEmpty?, idlePollMs?(CLI only, default 1000), realTest?:{enabled,maxFindings:5,maxImprovementAttempts:10,planSha256,approvedPlanSha256,planApproved} }' },
      maxBatches: { type: 'integer', description: 'safety cap on valid FullTestBatches for this in-call run (default 3); not a completion state' },
      stopFile: { type: 'string', description: 'path whose existence stops the campaign — the operator stop signal' }
    } }
  },
  {
    name: 'report_saturation',
    description: 'Tell the supervisor the current lane (e.g. the Strip Miner) has reached evidence-backed saturation. The supervisor AUTO-TRANSITIONS to the next lane (Strip Miner → Loop-de-loop, or the next improvement branch). It never pauses, awaits the operator, or treats "no re-mining warranted" as terminal — saturation is a pivot. The operator is the only stop condition.',
    inputSchema: { type: 'object', required: ['runId'], properties: {
      runId: { type: 'string' }, evidence: { type: 'string', description: 'the saturation evidence (batches that changed nothing material)' }
    } }
  },
  {
    name: 'campaign_status',
    description: 'Read-only supervisor status: the lane/target queue, auto-transitions, branch-retirement accounting (30 valid no-improvement batches), the 10-15 risk advisory band, and how many dashboard review items are pending. Pending review never blocks the campaign.',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } }
  },
  {
    name: 'continue_run',
    description: 'Record the next runnable improvement lane and first concrete action after reports, dashboards, saturation findings, no-improvement advisories, or refused terminal/checkpoint intents. This never asks the user and never marks the campaign complete. It does not clear the continuation obligation by itself; a real progress tool must run next.',
    inputSchema: { type: 'object', required: ['runId', 'lane', 'firstAction'], properties: {
      runId: { type: 'string' },
      lane: { type: 'string', description: 'the next runnable lane/bottleneck being pursued now' },
      firstAction: { type: 'string', description: 'the concrete next tool/action the model is about to perform' },
      rationale: { type: 'string' }
    } }
  },
  {
    name: 'human_review_request',
    description: 'Queue a change for the operator’s Approve/Sludge dashboard or list pending items. This tool CANNOT resolve human review; approval/sludge is dashboard-only. Never blocks deterministic lanes — the loop keeps running.',
    inputSchema: { type: 'object', required: ['runId'], properties: {
      runId: { type: 'string' }, action: { type: 'string', description: 'add | list (resolve is refused: dashboard-only)' },
      item: { type: 'object', properties: { title: { type: 'string' }, kind: { type: 'string' }, summary: { type: 'string' }, hypothesisId: { type: 'string' }, evidenceRef: { type: 'string' } } },
      reviewId: { type: 'string', description: 'accepted only for rejected legacy resolve attempts' },
      decision: { type: 'string', description: 'ignored/refused; human decisions are dashboard-only' },
      notes: { type: 'string', description: 'ignored/refused; human decisions are dashboard-only' }
    } }
  },
  {
    name: 'update_dashboard',
    description: 'Render the always-available local dashboard.html (score matrix, phase progress, failure patience, Approve/Sludge, and the stop-condition notice). Human review happens only here; deterministic lanes do not wait on it.',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } }
  },
  {
    name: 'report_export',
    description: 'Write a reproducible markdown report (baseline lock, frozen benchmark, score matrix, promotions, failure patience, campaign state) to the run dir.',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, format: { type: 'string' } } }
  },
  {
    name: 'export_trajectories',
    description: 'Export a run\'s recorded tool trajectory as Hermes-format JSONL (one assistant/tool_call line per action, with supervisor verdict labels from recorded gate results). Read-only over the store. Refuses gate-partitioned (held-out) runs.',
    inputSchema: { type: 'object', required: ['runId', 'outPath'], properties: {
      runId: { type: 'string' },
      outPath: { type: 'string', description: 'Relative path inside the run dir, or absolute path under SUPER_LOOP_HOME/exports/' }
    } }
  },
  {
    name: 'loop_register',
    description: 'Add YOUR OWN loop to this machine\'s local MCP, or register a skill (retrievable knowledge file) with role:"skill". Pass the full text as `content`; loops are hashed, phase-gated, and streamed; skills are section-addressable with provenance-enforced frontmatter. Cannot overwrite the hash-locked Strip Miner / Loop-de-loop. Nothing leaves your machine.',
    inputSchema: { type: 'object', required: ['id', 'content'], properties: {
      id: { type: 'string', description: 'safe lowercase id (no slashes/spaces); must not collide with a mandated loop' },
      content: { type: 'string', description: 'the full loop or skill markdown (loops: headers/paragraphs become phases; skills: frontmatter + body with _synthesis section)' },
      title: { type: 'string' },
      trigger: { type: 'string', description: 'e.g. "/loop my-loop" (loops only)' },
      role: { type: 'string', description: 'artifact type — "custom" (phase-streamed loop) or "skill" (retrievable knowledge file). Default custom.' },
      license: { type: 'string', description: 'SPDX id or LicenseRef-… (required when role is "skill")' },
      source: { type: 'string', description: 'provenance URI or path description (required when role is "skill")' },
      tags: { type: 'array', items: { type: 'string' }, description: 'free-form labels for skill keyword pre-filter' },
      stack: { type: 'array', items: { type: 'string' }, description: 'tech stack tokens for skill routing' },
      supports_tasks: { type: 'array', items: { type: 'string' }, description: 'task intents this skill helps with' },
      anti_patterns: { type: 'array', items: { type: 'string' }, description: 'outputs the model must not reproduce from the skill' },
      synthesis_guidance: { type: 'string', description: 'how to apply fetched skill knowledge to the current task without copying' },
      token_budget_hint: { type: 'integer', description: 'expected total skill size hint for Router 1 planning' },
      skillPartition: { type: 'string', description: 'partition — "working" (retrievable in normal runs) or "reference" (held-out, opt-in only). Default working.' },
      source_paths: { type: 'array', items: { type: 'string' }, description: 'optional auxiliary reference file paths for multi-file skills' },
      overwrite: { type: 'boolean', description: 'replace an existing custom loop or skill of the same id with a new local version' },
      runId: { type: 'string', description: 'optional; only used to journal the registration' }
    } }
  },
  {
    name: 'loop_library',
    description: 'List every loop and skill available to this local MCP: mandated hash-locked loops, custom loops you registered, and skills (metadata only — id, title, provenance, partition, section count). No full bodies.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'optional; only used to journal' } } }
  },
  {
    name: 'skill_fetch',
    description: 'Retrieve skill knowledge for the current task. Two modes: \'plan\' returns the index (titles, purposes, token estimates) of skills matching your query — read these to decide which sections to fetch; never loads full skill bodies. \'section\' fetches ONE section body by (skill_id, section_id) so you pull only the knowledge you need. Default partition is \'working\'; \'reference\' is opt-in only (held-out skills). Pass runId to pin the exact skill version this run used.',
    inputSchema: { type: 'object', properties: {
      mode: { type: 'string', description: 'plan (Router 1 index) or section (Router 2 body fetch). Default plan.' },
      query: { type: 'string', description: 'for plan mode — what you are working on' },
      skill_id: { type: 'string', description: 'for section mode — skill to fetch from' },
      section_id: { type: 'string', description: 'for section mode — one section to return' },
      topK: { type: 'integer', description: 'plan mode: max skills to return (default 5)' },
      partition: { type: 'string', description: 'working (default, retrievable in normal runs) or reference (held-out, opt-in only)' },
      runId: { type: 'string', description: 'optional — pins the fetched skill version to this run for reproducibility' }
    } }
  },
  {
    name: 'host_capability_preflight',
    description: 'Local capability report: which known frontier-agent CLIs (claude, codex, gemini, opencode, optional glm) are installed on PATH, PLUS the resolved host profile (driverFamily, tier, setupHint, and the host matrix when SUPER_LOOP_HOST is unknown). Filesystem stat only — NEVER executes a command, NEVER probes arbitrary binaries, and is NOT web/SOTA research. Presence on PATH is not proof of working auth.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'optional; only used to journal' } } }
  },
  {
    name: 'host_runtime_detect',
    description: 'Advisory guess of which host runtime the agent is in, from which MCP config files exist on disk (per the host registry). READ-ONLY existence check — never reads file contents, never mutates config. SUPER_LOOP_HOST, if set, is authoritative. Returns a guess, the candidate hosts with evidence, and the CLI fallback; nothing is auto-applied.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'optional; only used to journal' } } }
  }
];

// ---- wiring --------------------------------------------------------------
export function buildServer({ home } = {}) {
  const homeDir = home || process.env.SUPER_LOOP_HOME || join(PKG_ROOT, '.super-loop');
  const store = createStore(homeDir);
  const engine = createEngine(store);
  return { store, engine, homeDir };
}

function toolResult(obj) {
  const isError = false; // BLOCKED is a valid business state, not a protocol error
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError };
}

export function handleMessage(engine, msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message, data } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Loop Factory is the local-first supervisor for evidence-gated agent loops. It owns campaign state, the work queue, benchmark math, receipts, the dashboard, and stop policy. A worker model only proposes work; only a supervisor-accepted transition counts as progress. Start with initialize_loop_run. Current defaults use GPT-5.6 Sol for primary/test work, Fable 5 plus GPT-5.6 Sol for build/gating, and Fable 5 for independent judgment. The operator may replace that policy at init. Measurements are tool-computed, re-opened from disk, and reverified before a winner reaches review. Pending reviews never stop the factory. The dashboard is the only human-review resolver, and the operator is the only stop condition.'
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOL_SPECS });
    case 'prompts/list':
      return reply({ prompts: [] });
    case 'resources/list':
      return reply({ resources: [] });
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });
    case 'logging/setLevel':
      return reply({});
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const handler = engine[name];
      if (typeof handler !== 'function') return fail(-32601, `unknown tool: ${name}`);
      try {
        return reply(toolResult(handler(args)));
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `tool ${name} threw: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

// ---- stdio loop ----------------------------------------------------------
export function startStdioServer() {
  const { engine } = buildServer();
  // Fail fast if the bundled loops were swapped/corrupted.
  try {
    verifyAllLoops();
  } catch (e) {
    process.stderr.write(`[super-loop-mcp] FATAL: ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`[super-loop-mcp] ready · loops: ${verifyAllLoops().map((l) => `${l.id}(${l.sections}p)`).join(', ')}\n`);

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
        continue;
      }
      const out = handleMessage(engine, msg);
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// Only run the stdio loop when executed directly (never on import / under tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startStdioServer();
}

export { loopSummary };
