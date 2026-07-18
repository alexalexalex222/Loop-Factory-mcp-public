// Local, single-file, zero-asset dashboard + markdown report. The dashboard is
// always on: it is the only human-review surface, while the deterministic lanes
// keep running. It must always show the stop-condition notice.
import { STOP_CONDITION_WARNING } from './constants.mjs';
import { buildScoreMatrix } from './scorecard.mjs';
import { escapeHtml } from './util.mjs';

function pct(n) {
  if (n == null) return '—';
  const v = (n * 100).toFixed(1);
  return `${n > 0 ? '+' : ''}${v}%`;
}
function num(n) {
  return n == null ? '—' : String(n);
}

export function renderDashboard(state) {
  const matrix = buildScoreMatrix(state);
  const b = state.benchmark || {};
  const baseScore = b.baselineScore;
  const loops = Object.entries(state.loops || {}).map(([id, ls]) => ({
    id, phase: ls.phaseCursor, total: ls.totalPhases, evidence: Object.keys(ls.evidence || {}).length
  }));
  const campaign = state.campaign || { lanes: [], transitions: [], activeLaneId: null };
  const lanes = campaign.lanes || [];
  const transitions = campaign.transitions || [];
  const retireMax = (state.config && state.config.branchRetirementBatches) || 30;
  const data = {
    runId: state.runId,
    reviews: state.humanReviews || [],
    generated: state.updatedAt
  };
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const continuation = state.continuation || { required: false };
  const continuationNext = continuation.next || {};
  const continuationPanel = continuation.required
    ? `<div class="continuation required" role="status">
        <div>
          <strong>Continuation required</strong>
          <p>${escapeHtml(continuation.reason || 'A checkpoint was reached; the run must continue into the next runnable lane.')}</p>
        </div>
        <code>${escapeHtml(continuationNext.tool || 'continue_run')}</code>
        <span>${escapeHtml(continuationNext.reason || 'record the next lane and first action')}</span>
      </div>`
    : `<div class="continuation">
        <div>
          <strong>Continuation clear</strong>
          <p>No checkpoint obligation is pending.</p>
        </div>
        <code>${escapeHtml(continuation.clearedBy || 'ready')}</code>
        <span>${escapeHtml(continuationNext.reason || 'keep running the active lane')}</span>
      </div>`;

  const matrixRows = matrix.map((r) => `
    <tr>
      <td class="mono">${escapeHtml(r.hypothesisId)}</td>
      <td>${escapeHtml(r.title)}</td>
      <td class="mono">${escapeHtml(r.route && r.route.model || '—')}</td>
      <td class="${r.measured ? '' : 'muted'}">${r.measured ? num(r.quality) : 'unmeasured'}</td>
      <td>${num(r.tokenCost)}</td>
      <td class="${r.deltaQuality > 0 ? 'good' : r.deltaQuality < 0 ? 'bad' : ''}">${r.deltaQuality == null ? '—' : (r.deltaQuality > 0 ? '+' : '') + r.deltaQuality}</td>
      <td class="${r.deltaCostPct < 0 ? 'good' : r.deltaCostPct > 0 ? 'warn' : ''}">${pct(r.deltaCostPct)}</td>
      <td>${r.reverified ? '<span class="chip ok">reverified</span>' : '<span class="chip">—</span>'}</td>
      <td>${r.qualityAuthority === 'tool-computed' ? '<span class="chip ok">tool</span>' : r.qualityAuthority ? '<span class="chip">caller→dashboard</span>' : '<span class="chip muted">—</span>'}</td>
      <td>${r.verdict === 'MOVED_FRONTIER' ? '<span class="chip good">moved frontier</span>' : r.verdict === 'NO_IMPROVEMENT' ? '<span class="chip bad">no improvement</span>' : `<span class="chip">${escapeHtml(r.verdict)}</span>`}</td>
      <td>${r.promotable ? '<span class="chip good">promotable</span>' : '<span class="chip muted">blocked</span>'}</td>
    </tr>`).join('');

  const reviewCards = (state.humanReviews || []).length
    ? state.humanReviews.map((r) => `
      <article class="review" data-review="${escapeHtml(r.id)}">
        <header>
          <span class="mono small">${escapeHtml(r.id)}</span>
          <span class="chip ${r.status === 'APPROVED' ? 'good' : r.status === 'SLUDGE' ? 'bad' : 'muted'}" data-status>${escapeHtml(r.status)}</span>
        </header>
        <h4>${escapeHtml(r.title)}</h4>
        <p class="muted">${escapeHtml(r.summary || 'No summary provided.')}</p>
        <div class="review-actions">
          <button type="button" class="btn approve" data-act="approve" aria-label="Approve ${escapeHtml(r.id)}">Approve</button>
          <button type="button" class="btn sludge" data-act="sludge" aria-label="Sludge ${escapeHtml(r.id)}">Sludge</button>
        </div>
        <label class="notes-label">Notes before sending
          <textarea class="notes" rows="2" placeholder="optional notes…"></textarea>
        </label>
      </article>`).join('')
    : '<p class="muted">No changes are waiting for review yet. Deterministic lanes promote on measured evidence without this panel.</p>';

  const promotions = (state.promotions || []).length
    ? `<ul class="plain">${state.promotions.map((p) => `<li class="mono small">${escapeHtml(p.id)} — ${escapeHtml(p.hypothesisId)} (${escapeHtml(p.kind)}) Δq ${p.deltas.qualityGain}, Δcost ${pct(p.deltas.costRegressionPct)}</li>`).join('')}</ul>`
    : '<p class="muted">No internal-champion promotions recorded yet.</p>';

  const patience = state.failures || { consecutive: 0, total: 0 };
  const patienceMax = state.config.failurePatience;
  const patiencePctWidth = Math.min(100, Math.round((patience.consecutive / patienceMax) * 100));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>super-loop-mcp · ${escapeHtml(state.runId)}</title>
<style>
  :root{
    --bg:#0a0c10; --panel:#12161d; --panel-2:#171c25; --line:#232a36;
    --ink:#e8edf4; --ink-2:#9aa6b8; --ink-3:#6b7686;
    --good:#39d98a; --bad:#ff6b6b; --warn:#ffcd5e; --accent:#6ea8fe; --accent-2:#b794ff;
    --danger-bg:#2a0f12; --danger-line:#ff3b3b;
    --r-sm:8px; --r-md:14px; --r-lg:20px;
    --sp:4px;
    --fs-body:clamp(14px,0.9vw+10px,16px);
    --fs-h1:clamp(22px,2.2vw+12px,34px);
    --fs-h2:clamp(16px,1vw+11px,20px);
    --ease:cubic-bezier(.2,.7,.2,1);
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:var(--fs-body)/1.55 var(--sans);
    -webkit-font-smoothing:antialiased;padding:0 0 64px}
  a{color:var(--accent)}
  .wrap{max-width:1100px;margin:0 auto;padding:0 24px}
  .mono{font-family:var(--mono)}
  .small{font-size:.82em}
  .muted{color:var(--ink-3)}
  .good{color:var(--good)} .bad{color:var(--bad)} .warn{color:var(--warn)}

  /* Stop-condition banner — the warning the spec requires, verbatim. */
  .stopbar{background:var(--danger-bg);border-bottom:2px solid var(--danger-line);
    padding:14px 24px;text-align:center;position:sticky;top:0;z-index:10;backdrop-filter:blur(6px)}
  .stopbar strong{color:#ff8a8a;letter-spacing:.04em;font-size:clamp(13px,1vw+9px,17px);
    text-shadow:0 0 18px rgba(255,59,59,.45)}

  header.hero{padding:40px 0 22px}
  .eyebrow{color:var(--accent-2);font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:12px}
  h1{font-size:var(--fs-h1);margin:.2em 0 .1em;line-height:1.1}
  .task{color:var(--ink-2);max-width:70ch}
  .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
  .pill{background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--ink-2)}
  .pill b{color:var(--ink)}
  .continuation{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);
    padding:14px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 14px;align-items:center}
  .continuation.required{border-color:rgba(255,205,94,.55);background:rgba(255,205,94,.08)}
  .continuation strong{display:block;color:var(--ink);font-size:13px;text-transform:uppercase;letter-spacing:.08em}
  .continuation p{margin:4px 0 0;color:var(--ink-2)}
  .continuation code{font-family:var(--mono);font-size:12px;color:var(--accent);background:var(--panel-2);
    border:1px solid var(--line);border-radius:var(--r-sm);padding:4px 8px;justify-self:end}
  .continuation span{grid-column:1/-1;color:var(--ink-3);font-size:13px}

  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:8px 0 28px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:18px}
  .panel h3{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3)}
  .stat{font-size:clamp(20px,2vw+8px,28px);font-weight:650;line-height:1.1}
  .panel .sub{color:var(--ink-3);font-size:13px;margin-top:4px}

  .meter{height:8px;border-radius:999px;background:var(--panel-2);overflow:hidden;margin-top:10px;border:1px solid var(--line)}
  .meter>i{display:block;height:100%;background:linear-gradient(90deg,var(--warn),var(--bad))}

  section{margin:34px 0}
  h2{font-size:var(--fs-h2);margin:0 0 14px;display:flex;align-items:center;gap:10px}
  h2::before{content:"";width:8px;height:8px;border-radius:2px;background:var(--accent);display:inline-block}

  table{width:100%;border-collapse:collapse;font-size:14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line)}
  th{color:var(--ink-3);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em;background:var(--panel-2)}
  tr:last-child td{border-bottom:none}
  .scroll{overflow-x:auto}

  .chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--ink-2);background:var(--panel-2)}
  .chip.good{color:#062;background:rgba(57,217,138,.15);border-color:rgba(57,217,138,.4);color:var(--good)}
  .chip.bad{color:var(--bad);background:rgba(255,107,107,.12);border-color:rgba(255,107,107,.35)}
  .chip.ok{color:var(--accent);background:rgba(110,168,254,.12);border-color:rgba(110,168,254,.35)}
  .chip.warn{color:var(--warn);background:rgba(255,205,94,.12);border-color:rgba(255,205,94,.35)}
  .chip.muted{opacity:.7}

  .reviews{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
  .review{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:16px;display:flex;flex-direction:column;gap:8px}
  .review header{display:flex;justify-content:space-between;align-items:center}
  .review h4{margin:2px 0}
  .review-actions{display:flex;gap:8px;margin-top:4px}
  .btn{appearance:none;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);
    padding:9px 14px;border-radius:var(--r-sm);font:inherit;font-weight:600;cursor:pointer;
    min-height:40px;transition:transform .15s var(--ease),background .15s var(--ease),border-color .15s var(--ease)}
  .btn:hover{transform:translateY(-1px)}
  .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .btn:active{transform:translateY(0)}
  .btn.approve[aria-pressed="true"]{background:rgba(57,217,138,.18);border-color:var(--good);color:var(--good)}
  .btn.sludge[aria-pressed="true"]{background:rgba(255,107,107,.16);border-color:var(--bad);color:var(--bad)}
  .notes-label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ink-3)}
  .notes{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-sm);color:var(--ink);padding:8px;font:inherit;resize:vertical}
  .notes:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

  .exportbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:16px}
  .plain{list-style:none;padding:0;margin:0;display:grid;gap:6px}
  footer{color:var(--ink-3);font-size:13px;border-top:1px solid var(--line);padding-top:18px;margin-top:36px}
  .live{position:fixed;left:-9999px}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
  <div class="stopbar" role="alert"><strong>${escapeHtml(STOP_CONDITION_WARNING)}</strong></div>

  <div class="wrap">
    <header class="hero">
      <div class="eyebrow">super-loop-mcp · Loop Factory</div>
      <h1>${escapeHtml(state.task.text || 'Untitled loop campaign')}</h1>
      <p class="task">${escapeHtml(state.task.acceptanceCriteria || 'Phase-gated, benchmark-first improvement. Promotion requires supervisor-computed, reverified frontier movement — never a model self-report.')}</p>
      <div class="meta">
        <span class="pill">run <b class="mono">${escapeHtml(state.runId)}</b></span>
        <span class="pill">state <b>${escapeHtml(state.status)}</b></span>
        <span class="pill">model <b>${escapeHtml(state.config.model.primary)}</b></span>
        ${(() => {
          const mp = state.config.modelPolicy;
          if (!mp) return '';
          return [
            `<span class="pill">builders <b>${escapeHtml((mp.builderRoutes || []).join(' / ') || '—')}</b></span>`,
            `<span class="pill">judge <b>${escapeHtml(mp.judgeRoute || '—')}</b></span>`,
            `<span class="pill">banlist <b>${escapeHtml((mp.banlist && mp.banlist.mode) || 'default')}</b></span>`,
            `<span class="pill">policy <b>${escapeHtml(mp.source || 'defaults')}</b></span>`
          ].join('\n        ');
        })()}
        <span class="pill">mode <b>${escapeHtml(state.task.mode)}</b></span>
        <span class="pill">benchmark <b>${b.frozen ? 'frozen' : 'not frozen'}</b></span>
        <span class="pill">baseline <b>${state.baseline.recorded ? 'hash-locked' : 'unlocked'}</b></span>
      </div>
      ${continuationPanel}
    </header>

    <div class="grid">
      <div class="panel">
        <h3>Baseline (hash-locked)</h3>
        <div class="stat">${state.baseline.recorded ? 'locked' : '— open'}</div>
        <div class="sub mono">${state.baseline.recorded ? escapeHtml(String(state.baseline.sha256).slice(0, 24)) + '…' : 'record artifact_record role=baseline'}</div>
      </div>
      <div class="panel">
        <h3>Frozen benchmark</h3>
        <div class="stat">${b.frozen ? escapeHtml(b.def.name) : '—'}</div>
        <div class="sub">${b.frozen ? `${b.def.taskValueDimensions.length} value · ${b.def.resourceDimensions.length} cost · ${b.def.cases.length} cases` : 'freeze before challengers'}</div>
        <div class="sub">${baseScore ? `bar: quality <b class="good">${baseScore.quality}</b> · cost ${baseScore.tokenCost}` : 'baseline bar not measured'}</div>
      </div>
      <div class="panel">
        <h3>Failure patience</h3>
        <div class="stat">${patience.consecutive} / ${patienceMax}</div>
        <div class="sub">${patience.total} total no-improvement · ${state.failures.exhaustionFlagged ? '<b class="warn">economic-exhaustion advisory</b>' : 'within patience'}</div>
        <div class="meter"><i style="width:${patiencePctWidth}%"></i></div>
      </div>
      <div class="panel">
        <h3>Phase streaming</h3>
        ${loops.length ? loops.map((l) => `<div class="sub"><b>${escapeHtml(l.id)}</b> — phase ${l.phase + 1}/${l.total} · ${l.evidence} evidenced</div>`).join('') : '<div class="sub">no loop streamed yet</div>'}
      </div>
      <div class="panel">
        <h3>Lanes · supervisor target queue</h3>
        ${lanes.length ? lanes.map((l) => `<div class="sub"><b>${escapeHtml(l.loop || l.kind)}</b> <span class="chip ${l.status === 'active' ? 'ok' : l.status === 'saturated' ? 'warn' : 'muted'}">${escapeHtml(l.status)}</span> — ${escapeHtml(l.kind)} · ${l.noImproveBatches || 0}/${retireMax} no-improve</div>`).join('') : '<div class="sub">no lane opened yet</div>'}
        <div class="sub">${transitions.length ? `${transitions.length} auto-transition(s): saturation/retirement pivots, not stops` : 'no auto-transition yet'}</div>
      </div>
    </div>

    <section>
      <h2>Score matrix · tool-measured only</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>id</th><th>hypothesis</th><th>route</th><th>quality</th><th>tokenCost</th><th>Δquality</th><th>Δcost</th><th>reverify</th><th>q-auth</th><th>verdict</th><th>promotion</th></tr></thead>
          <tbody>${matrixRows || '<tr><td colspan="11" class="muted">No hypotheses registered yet (3–5 frontier hypotheses required).</td></tr>'}</tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Internal-champion promotions</h2>
      ${promotions}
    </section>

    <section>
      <h2>Human review · Approve / Sludge</h2>
      <p class="muted">Approve / Sludge is dashboard-only. The model can queue and list these items, but it can never resolve its own human-review gate. Pending review never blocks the campaign — the supervisor keeps running the next valid lane while items wait here. <strong>To apply:</strong> Approve, click Export, and save the file as <code>inbox-decisions.json</code> in this run's folder — the running supervisor auto-applies it with no command. Approving a loop-adoption item installs the improved loop as a new version (rollback kept), enforced next cycle; the campaign never pauses.</p>
      <div class="reviews">${reviewCards}</div>
      <div class="exportbar">
        <button type="button" id="exportBtn" class="btn" disabled>Export inbox-decisions.json</button>
        <button type="button" id="copyBtn" class="btn" disabled>Copy decisions</button>
        <span id="exportNote" class="muted small"></span>
      </div>
    </section>

    <footer>
      <p><strong>You are the stop condition.</strong> This dashboard stays available throughout the run. Deterministic lanes promote only on measured frontier movement, pending review stays pending until the operator acts here, and the campaign never marks itself complete.</p>
      <p class="muted">Generated ${escapeHtml(String(state.updatedAt))} · super-loop-mcp local-first Loop Factory runtime.</p>
    </footer>
  </div>

  <div class="live" aria-live="polite" id="live"></div>
  <script id="run-data" type="application/json">${dataJson}</script>
  <script>
    (function(){
      var decisions = {};
      var live = document.getElementById('live');
      function announce(m){ live.textContent = m; }
      // When this dashboard is SERVED (http), a click applies itself: POST the decision
      // to /apply, which the running campaign adopts on its next tick — no file, no
      // command. Opened as a file (file://) there is no server, so fall back to Export.
      function isFileProtocol(){ return location.protocol === 'file:'; }
      function postDecision(id, act, statusEl){
        if (isFileProtocol()) {
          // file:// cannot apply — keep chip as local draft, never flip to APPROVED.
          if (statusEl) {
            statusEl.textContent = 'local draft — export to apply';
            statusEl.className = 'chip warn';
          }
          announce('local draft — export to apply (file:// has no dashboard server)');
          return;
        }
        try {
          var run = JSON.parse(document.getElementById('run-data').textContent);
          fetch('/apply', { method:'POST', headers:{'content-type':'application/json'},
            body: JSON.stringify({ runId: run.runId, reviewId: id, decision: act }) })
            .then(function(r){
              if (!r.ok) throw new Error('apply failed');
              return r.json();
            })
            .then(function(){
              // Only flip the chip after confirmed POST apply.
              if (statusEl) {
                statusEl.textContent = act === 'approve' ? 'APPROVED' : 'SLUDGE';
                statusEl.className = 'chip ' + (act === 'approve' ? 'good' : 'bad');
              }
              announce(act + ' sent for ' + id + ' — the supervisor adopts it on its next tick. No file needed.');
            })
            .catch(function(){
              if (statusEl) {
                statusEl.textContent = 'PENDING';
                statusEl.className = 'chip';
              }
              announce('Could not reach the dashboard server — use Export instead.');
            });
        } catch(e){
          if (statusEl) {
            statusEl.textContent = 'PENDING';
            statusEl.className = 'chip';
          }
        }
      }
      document.querySelectorAll('.review').forEach(function(card){
        var id = card.getAttribute('data-review');
        var statusEl = card.querySelector('[data-status]');
        var notes = card.querySelector('.notes');
        card.querySelectorAll('[data-act]').forEach(function(btn){
          btn.addEventListener('click', function(){
            var act = btn.getAttribute('data-act');
            card.querySelectorAll('[data-act]').forEach(function(b){ b.setAttribute('aria-pressed', b===btn ? 'true':'false'); });
            decisions[id] = { decision: act, notes: notes.value || null };
            // Do NOT optimistically flip to APPROVED/SLUDGE — only after confirmed apply
            // (http) or label as local draft (file://).
            if (isFileProtocol()) {
              statusEl.textContent = 'local draft — export to apply';
              statusEl.className = 'chip warn';
              announce('local draft — export to apply');
            } else {
              statusEl.textContent = 'SENDING…';
              statusEl.className = 'chip';
              postDecision(id, act, statusEl);
            }
            enableExport();
          });
        });
        if(notes){ notes.addEventListener('input', function(){ if(decisions[id]) decisions[id].notes = notes.value || null; }); }
      });
      var exportBtn = document.getElementById('exportBtn');
      var copyBtn = document.getElementById('copyBtn');
      var note = document.getElementById('exportNote');
      function payload(){
        var run = JSON.parse(document.getElementById('run-data').textContent);
        return JSON.stringify({ runId: run.runId, resolvedAt: new Date().toISOString(), decisions: decisions }, null, 2);
      }
      function enableExport(){ exportBtn.disabled = false; copyBtn.disabled = false; }
      exportBtn.addEventListener('click', function(){
        var blob = new Blob([payload()], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = 'inbox-decisions.json'; a.click();
        URL.revokeObjectURL(url); note.textContent = 'Saved inbox-decisions.json — drop it in this run folder (runs/<runId>/) and the running supervisor auto-applies it. No command; the model cannot approve its own work.';
      });
      copyBtn.addEventListener('click', function(){
        if(navigator.clipboard){ navigator.clipboard.writeText(payload()).then(function(){ note.textContent='Copied to clipboard.'; }); }
        else { note.textContent = payload(); }
      });
    })();
  </script>
</body>
</html>`;
}

export function renderReport(state) {
  const matrix = buildScoreMatrix(state);
  const b = state.benchmark || {};
  const lines = [];
  lines.push(`# super-loop-mcp campaign report`);
  lines.push('');
  lines.push(`- **run**: \`${state.runId}\``);
  lines.push(`- **status**: ${state.status}  (campaign completion requires the operator)`);
  lines.push(`- **task**: ${state.task.text || '(none)'}`);
  lines.push(`- **mode**: ${state.task.mode}`);
  lines.push(`- **model**: ${state.config.model.primary} (${state.config.model.declared ? 'operator-declared' : 'auto-selected default'})`);
  if (state.config.modelPolicy) {
    const mp = state.config.modelPolicy;
    lines.push(`- **modelPolicy**: source=${mp.source || 'defaults'}; primary=${mp.primary}; test=[${(mp.testRoutes || []).join(', ')}]; builders=[${(mp.builderRoutes || []).join(', ')}]; judge=${mp.judgeRoute}; banlist.mode=${(mp.banlist && mp.banlist.mode) || 'default'}`);
  }
  lines.push(`- **failure patience**: ${state.failures.consecutive}/${state.config.failurePatience} consecutive no-improvement (${state.failures.total} total)${state.failures.exhaustionFlagged ? ' - economic-exhaustion advisory' : ''}`);
  const continuation = state.continuation || { required: false };
  const continuationNext = continuation.next || {};
  lines.push(`- **continuation obligation**: ${continuation.required ? 'REQUIRED' : 'clear'}${continuation.reason ? ` — ${continuation.reason}` : ''}`);
  if (continuation.required) lines.push(`- **required next tool/action**: ${continuationNext.tool || 'continue_run'} — ${continuationNext.reason || 'record the next lane and first action'}`);
  lines.push('');
  lines.push(`## Ask-once`);
  lines.push(`- stored user messages: ${state.userMessages.length} (each sha256-hashed locally)`);
  lines.push(`- questions asked: ${state.questions.length}${state.questions.length ? '' : ' (task was specific enough — none)'}`);
  lines.push(`- answers recorded: ${state.answers.length}`);
  lines.push('');
  lines.push(`## Baseline`);
  lines.push(state.baseline.recorded ? `- hash-locked \`${state.baseline.sha256}\` (epoch ${state.baseline.epoch})` : '- not locked');
  lines.push('');
  lines.push(`## Benchmark (frozen scorecard)`);
  if (b.frozen) {
    lines.push(`- **${b.def.name}** — frozen ${b.frozenAt} (epoch ${b.epoch})`);
    lines.push(`- task-value: ${b.def.taskValueDimensions.join(', ')}`);
    lines.push(`- resource/cost: ${b.def.resourceDimensions.join(', ')}`);
    lines.push(`- cases: ${b.def.cases.length} · comparison rule: ${b.def.comparisonRule}`);
    lines.push(b.baselineScore ? `- baseline bar (tool-measured): quality ${b.baselineScore.quality}, tokenCost ${b.baselineScore.tokenCost}` : '- baseline bar: NOT measured');
  } else {
    lines.push('- not frozen');
  }
  lines.push('');
  lines.push(`## Score matrix`);
  lines.push(`_quality authority: \`tool\` = MCP-derived against the frozen oracle (auto-promotable); \`caller→dashboard\` = subjective, human-gated, never auto-promotes._`);
  lines.push('| id | route | quality | tokenCost | Δquality | Δcost% | reverified | q-auth | verdict | promotable |');
  lines.push('|----|-------|---------|-----------|----------|--------|------------|--------|---------|------------|');
  for (const r of matrix) {
    const qauth = r.qualityAuthority === 'tool-computed' ? 'tool' : r.qualityAuthority ? 'caller→dashboard' : '—';
    lines.push(`| ${r.hypothesisId} | ${r.route && r.route.model || '—'} | ${r.measured ? r.quality : 'unmeasured'} | ${r.tokenCost ?? '—'} | ${r.deltaQuality ?? '—'} | ${r.deltaCostPct == null ? '—' : (r.deltaCostPct * 100).toFixed(1) + '%'} | ${r.reverified ? 'yes' : 'no'} | ${qauth} | ${r.verdict} | ${r.promotable ? 'yes' : 'no'} |`);
  }
  if (!matrix.length) lines.push('| (none) | | | | | | | | | |');
  lines.push('');
  lines.push(`## Promotions (internal champion)`);
  if (state.promotions.length) {
    for (const p of state.promotions) lines.push(`- ${p.id}: ${p.hypothesisId} (${p.kind}) — Δquality ${p.deltas.qualityGain}, Δcost ${(p.deltas.costRegressionPct * 100).toFixed(1)}%. ${p.note}`);
  } else lines.push('- none');
  lines.push('');
  lines.push(`## Human review`);
  lines.push(`- pending: ${state.humanReviews.filter((r) => r.status === 'PENDING').length} · approved: ${state.humanReviews.filter((r) => r.status === 'APPROVED').length} · sludge: ${state.humanReviews.filter((r) => r.status === 'SLUDGE').length}`);
  lines.push('');
  lines.push(`---`);
  lines.push(`*Reproducible from \`${state.runId}/state.json\`. This report is a checkpoint; it does not imply campaign completion. The operator is the only stop condition.*`);
  return lines.join('\n') + '\n';
}
