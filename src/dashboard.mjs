// Local, single-file, zero-asset dashboard + markdown report. The dashboard is
// always on: it is the only human-review surface, while the deterministic lanes
// keep running. It must always show the stop-condition notice.
import { STOP_CONDITION_WARNING } from './constants.mjs';
import { buildScoreMatrix } from './scorecard.mjs';
import { escapeHtml } from './util.mjs';
import { buildConsoleSnapshot } from './console.mjs';

function pct(n) {
  if (n == null) return '—';
  const v = (n * 100).toFixed(1);
  return `${n > 0 ? '+' : ''}${v}%`;
}
export function renderDashboard(state) {
  const view = buildConsoleSnapshot(state);
  const dataJson = JSON.stringify(view).replace(/</g, '\\u003c');
  const activeLane = view.campaign.lanes.find((lane) => lane.id === view.campaign.activeLaneId)
    || view.campaign.lanes[0]
    || null;
  const activeLoop = view.loops.find((loop) => loop.id === view.run.activeLoop)
    || view.loops[0]
    || null;
  const phasePercent = activeLoop && activeLoop.totalPhases > 0
    ? Math.max(0, Math.min(100, Math.round(((activeLoop.phase + 1) / activeLoop.totalPhases) * 100)))
    : 0;
  const failurePercent = view.failures.patience > 0
    ? Math.max(0, Math.min(100, Math.round((view.failures.consecutive / view.failures.patience) * 100)))
    : 0;

  const chipClass = (value) => {
    const v = String(value || '').toUpperCase();
    if (['ACTIVE', 'APPROVED', 'MOVED_FRONTIER', 'PROMOTE', 'REVERIFIED'].includes(v)) return 'success';
    if (['SLUDGE', 'REJECTED', 'NO_IMPROVEMENT', 'SELF_PROMOTION', 'PHASE_SKIP', 'MODEL_REPORTED_METRIC'].includes(v)) return 'danger';
    if (['PENDING', 'REQUIRED', 'SENDING', 'SATURATED'].includes(v)) return 'warning';
    return 'neutral';
  };
  const value = (v, fallback = '--') => v == null || v === '' ? fallback : escapeHtml(String(v));
  const shortHash = (v) => v ? `${escapeHtml(String(v).slice(0, 12))}...` : '--';
  const detailText = (detail) => Object.entries(detail || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
    .join('  ');

  const loopRows = view.loops.length
    ? view.loops.map((loop) => {
        const percent = loop.totalPhases > 0 ? Math.round(((loop.phase + 1) / loop.totalPhases) * 100) : 0;
        return `<div class="progress-row" data-loop="${escapeHtml(loop.id)}">
          <div class="progress-copy">
            <strong class="mono">${escapeHtml(loop.id)}</strong>
            <span>phase ${loop.phase + 1}/${loop.totalPhases} - ${loop.evidenceItems} evidence item(s)</span>
          </div>
          <div class="track" aria-label="${escapeHtml(loop.id)} phase progress"><i style="width:${percent}%"></i></div>
        </div>`;
      }).join('')
    : '<p class="empty">No loop has started.</p>';

  const laneRows = view.campaign.lanes.length
    ? view.campaign.lanes.map((lane) => `<tr data-lane="${escapeHtml(lane.id)}">
        <td class="mono">${escapeHtml(lane.id)}</td>
        <td>${value(lane.loop || lane.kind)}</td>
        <td>${value(lane.kind)}</td>
        <td><span class="status ${chipClass(lane.status)}">${value(lane.status)}</span></td>
        <td class="num">${lane.noImproveBatches}/${view.failures.retirementBatches || '--'}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty-cell">No lane is open.</td></tr>';

  const verdictRows = view.verdicts.length
    ? [...view.verdicts].reverse().map((event) => {
        const receipt = event.invocation || {};
        const outcome = event.accepted ? 'ACCEPTED' : (event.code || 'BLOCKED');
        return `<li class="verdict" data-verdict="${escapeHtml(event.id)}">
          <div class="verdict-mark ${event.accepted ? 'accepted' : 'blocked'}" aria-hidden="true"></div>
          <div class="verdict-main">
            <div class="row-head">
              <strong>${escapeHtml(event.scenario || event.type || event.id)}</strong>
              <span class="status ${chipClass(outcome)}">${escapeHtml(outcome)}</span>
            </div>
            <div class="meta-line">
              <span class="mono">${value(event.route)}</span>
              <span>phase ${event.phase == null ? '--' : event.phase}</span>
              <span>${value(event.ts)}</span>
            </div>
            <details>
              <summary>Invocation receipt</summary>
              <dl class="receipt">
                <div><dt>requested</dt><dd class="mono">${value(receipt.requestedModel)}</dd></div>
                <div><dt>authority</dt><dd>${value(receipt.modelIdentityAuthority)}</dd></div>
                <div><dt>duration</dt><dd>${receipt.durationMs == null ? '--' : `${receipt.durationMs} ms`}</dd></div>
                <div><dt>tokens</dt><dd>${value(receipt.tokenUsage)}</dd></div>
                <div class="wide"><dt>stdout</dt><dd class="mono">${shortHash(receipt.stdoutSha256)}</dd></div>
                <div class="wide"><dt>argv</dt><dd class="mono command">${escapeHtml((receipt.argv || []).join(' ')) || '--'}</dd></div>
              </dl>
            </details>
          </div>
        </li>`;
      }).join('')
    : '<li class="empty">No supervisor verdict has been recorded.</li>';

  const scoreRows = view.scoreMatrix.length
    ? view.scoreMatrix.map((row) => `<tr data-hypothesis="${escapeHtml(row.hypothesisId)}">
        <td class="mono">${escapeHtml(row.hypothesisId)}</td>
        <td class="mono">${value(row.route)}</td>
        <td class="num">${row.measured ? value(row.quality) : 'unmeasured'}</td>
        <td class="num">${value(row.tokenCost)}</td>
        <td class="num">${row.deltaQuality == null ? '--' : `${row.deltaQuality > 0 ? '+' : ''}${row.deltaQuality}`}</td>
        <td class="num">${row.deltaCostPct == null ? '--' : pct(row.deltaCostPct)}</td>
        <td><span class="status ${row.reverified ? 'success' : 'neutral'}">${row.reverified ? 'reverified' : '--'}</span></td>
        <td><span class="status ${chipClass(row.verdict)}">${value(row.verdict)}</span></td>
        <td><span class="status ${row.promotable ? 'success' : 'neutral'}">${row.promotable ? 'promotable' : 'blocked'}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="empty-cell">No measured hypotheses.</td></tr>';

  const activityRows = view.activity.length
    ? [...view.activity].reverse().map((entry) => `<li class="activity-item">
        <time>${value(entry.ts)}</time>
        <strong>${escapeHtml(entry.event)}</strong>
        <span class="mono">${detailText(entry.detail)}</span>
      </li>`).join('')
    : '<li class="empty">No activity has been recorded.</li>';

  const reviewCards = view.reviews.items.length
    ? view.reviews.items.map((review) => {
        const resolved = review.status !== 'PENDING';
        return `<article class="review" data-review="${escapeHtml(review.id)}">
        <header>
          <div>
            <strong class="mono">${escapeHtml(review.id)}</strong>
            <span class="review-kind">${value(review.kind)}</span>
          </div>
          <span class="status ${chipClass(review.status)}" data-status>${value(review.status)}</span>
        </header>
        <dl class="review-meta">
          <div><dt>hypothesis</dt><dd class="mono">${value(review.hypothesisId)}</dd></div>
          <div><dt>evidence</dt><dd class="mono">${value(review.evidenceRef)}</dd></div>
          <div><dt>loop</dt><dd class="mono">${value(review.loopId)}</dd></div>
        </dl>
        <div class="review-actions">
          <button type="button" class="button approve" data-act="approve" aria-label="Approve ${escapeHtml(review.id)}"${resolved ? ' disabled' : ''}>Approve</button>
          <button type="button" class="button sludge" data-act="sludge" aria-label="Sludge ${escapeHtml(review.id)}"${resolved ? ' disabled' : ''}>Sludge</button>
        </div>
        <label class="notes-label">Operator notes
          <textarea class="notes" rows="2" placeholder="Optional"${resolved ? ' disabled' : ''}></textarea>
        </label>
      </article>`;
      }).join('')
    : '<p class="empty">No operator decision is pending.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loop Factory Campaign Console - ${escapeHtml(view.run.id)}</title>
<style>
  :root{
    --canvas:#eef1ed;
    --surface:#ffffff;
    --surface-muted:#f6f7f4;
    --surface-strong:#18211d;
    --ink:#17201c;
    --ink-soft:#4f5b54;
    --ink-muted:#707b74;
    --ink-on-strong:#f5f7f4;
    --ink-on-strong-muted:#bbc8c0;
    --ink-on-strong-soft:#d5ded8;
    --line:#d8ddd8;
    --line-strong:#adb7b0;
    --line-on-strong:#53635a;
    --brand:#175f49;
    --brand-soft:#dcece5;
    --info:#245c8e;
    --info-soft:#e1edf7;
    --info-line:#b8d2e7;
    --success:#17653f;
    --success-soft:#dcefe4;
    --success-line:#a9d5bb;
    --warning:#8a5a09;
    --warning-soft:#f7ebcb;
    --warning-line:#e2cb91;
    --danger:#9b342f;
    --danger-soft:#f7dfdc;
    --danger-line:#e8bbb6;
    --connection-idle:#8a9890;
    --connection-live:#5bd18c;
    --connection-warning:#f0b84b;
    --focus:#0c67b1;
    --shadow:0 1px 2px #15211b14;
    --radius:8px;
    --space-1:4px;
    --space-2:8px;
    --space-3:12px;
    --space-4:16px;
    --space-5:24px;
    --space-6:32px;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --fast:150ms;
    --base:220ms;
    --ease:cubic-bezier(.4,0,.2,1);
  }
  *{box-sizing:border-box;letter-spacing:0}
  html{background:var(--canvas);color:var(--ink)}
  body{margin:0;min-width:320px;background:var(--canvas);font:400 16px/1.5 var(--font);-webkit-font-smoothing:antialiased}
  button,textarea{font:inherit}
  button{letter-spacing:0}
  a{color:var(--info)}
  .skip{position:fixed;left:var(--space-4);top:-80px;z-index:1000;background:var(--surface);color:var(--ink);padding:var(--space-3) var(--space-4);border:2px solid var(--focus);border-radius:var(--radius)}
  .skip:focus{top:var(--space-4)}
  :focus-visible{outline:3px solid var(--focus);outline-offset:2px}
  .mono{font-family:var(--mono);font-feature-settings:"tnum"}
  .num{text-align:right;font-family:var(--mono);font-feature-settings:"tnum"}
  .appbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:64px;padding:var(--space-3) var(--space-5);background:var(--surface-strong);color:var(--ink-on-strong);border-bottom:1px solid var(--surface-strong)}
  .brand-lockup,.app-meta{display:flex;align-items:center;gap:var(--space-3);min-width:0}
  .brand-mark{display:grid;place-items:center;width:36px;height:36px;flex:0 0 36px;border:1px solid var(--brand-soft);border-radius:6px;background:var(--brand);font-weight:700}
  .brand-copy{display:grid;min-width:0}
  .brand-copy strong{font-size:1rem}
  .brand-copy span{color:var(--ink-on-strong-muted);font-size:.8125rem}
  .run-id{max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-on-strong-soft);font-size:.8125rem}
  .connection{display:inline-flex;align-items:center;gap:var(--space-2);min-height:32px;padding:0 var(--space-3);border:1px solid var(--line-on-strong);border-radius:999px;color:var(--ink-on-strong);font-size:.8125rem;font-weight:700}
  .connection::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--connection-idle)}
  .connection.live::before{background:var(--connection-live)}
  .connection.reconnecting::before{background:var(--connection-warning)}
  .stopbar{padding:var(--space-2) var(--space-5);background:var(--danger-soft);color:var(--danger);border-bottom:1px solid var(--danger-line);text-align:center;font-size:.875rem;font-weight:700}
  .shell{width:min(1440px,100%);margin:0 auto;padding:var(--space-5)}
  .console-head{display:flex;justify-content:space-between;gap:var(--space-5);align-items:flex-end;margin-bottom:var(--space-5)}
  .console-head h1{margin:0;font-size:1.625rem;line-height:1.2}
  .console-head p{margin:var(--space-1) 0 0;color:var(--ink-soft);max-width:68ch}
  .updated{color:var(--ink-muted);font-size:.8125rem;text-align:right}
  .poll-error{display:flex;justify-content:space-between;align-items:center;gap:var(--space-4);margin-bottom:var(--space-4);padding:var(--space-3) var(--space-4);border:1px solid var(--danger-line);border-radius:var(--radius);background:var(--danger-soft);color:var(--danger)}
  .poll-error[hidden]{display:none}
  .status-rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3);margin-bottom:var(--space-5)}
  .status-card{min-height:126px;padding:var(--space-4);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
  .status-card h2{margin:0 0 var(--space-3);font-size:.8125rem;color:var(--ink-muted);font-weight:700;text-transform:uppercase}
  .status-value{display:block;font-size:1.25rem;font-weight:700;overflow-wrap:anywhere}
  .status-detail{display:block;margin-top:var(--space-1);color:var(--ink-soft);font-size:.875rem}
  .workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:var(--space-5);align-items:start}
  .column{display:grid;gap:var(--space-5);min-width:0}
  .panel{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
  .panel-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);padding:var(--space-4);border-bottom:1px solid var(--line)}
  .panel-head h2{margin:0;font-size:1rem}
  .panel-head p{margin:0;color:var(--ink-muted);font-size:.8125rem}
  .panel-body{padding:var(--space-4)}
  .progress-stack{display:grid;gap:var(--space-4)}
  .progress-row{display:grid;gap:var(--space-2)}
  .progress-copy{display:flex;justify-content:space-between;gap:var(--space-4);font-size:.875rem}
  .progress-copy span{color:var(--ink-soft);text-align:right}
  .track{height:8px;background:var(--surface-muted);border:1px solid var(--line);border-radius:999px;overflow:hidden}
  .track i{display:block;height:100%;background:var(--brand);transition:transform var(--base) var(--ease),opacity var(--base) var(--ease)}
  .failure-track i{background:var(--warning)}
  .table-scroll{position:relative;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--line-strong) var(--surface-muted)}
  .table-scroll.is-overflowing{border-right:4px solid var(--info-line)}
  table{width:100%;border-collapse:collapse;font-size:.875rem}
  th,td{padding:var(--space-3) var(--space-4);text-align:left;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}
  th{background:var(--surface-muted);color:var(--ink-muted);font-size:.75rem;font-weight:700;text-transform:uppercase}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:var(--surface-muted)}
  .status{display:inline-flex;align-items:center;min-height:26px;padding:0 var(--space-2);border:1px solid var(--line);border-radius:999px;background:var(--surface-muted);color:var(--ink-soft);font-size:.75rem;font-weight:700;white-space:nowrap}
  .status.success{border-color:var(--success-line);background:var(--success-soft);color:var(--success)}
  .status.warning{border-color:var(--warning-line);background:var(--warning-soft);color:var(--warning)}
  .status.danger{border-color:var(--danger-line);background:var(--danger-soft);color:var(--danger)}
  .status.info{border-color:var(--info-line);background:var(--info-soft);color:var(--info)}
  .verdict-list,.activity-list{list-style:none;margin:0;padding:0}
  .verdict{display:grid;grid-template-columns:12px minmax(0,1fr);gap:var(--space-3);padding:var(--space-4);border-bottom:1px solid var(--line)}
  .verdict:last-child{border-bottom:0}
  .verdict-mark{width:10px;height:10px;margin-top:7px;border-radius:2px;background:var(--line-strong)}
  .verdict-mark.accepted{background:var(--success)}
  .verdict-mark.blocked{background:var(--danger)}
  .row-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3)}
  .row-head strong{overflow-wrap:anywhere}
  .meta-line{display:flex;flex-wrap:wrap;gap:var(--space-3);margin-top:var(--space-1);color:var(--ink-muted);font-size:.8125rem}
  details{margin-top:var(--space-3)}
  summary{cursor:pointer;color:var(--info);font-weight:600}
  .receipt{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);margin:var(--space-3) 0 0;padding:var(--space-3);background:var(--surface-muted);border-radius:6px}
  .receipt div{min-width:0}
  .receipt .wide{grid-column:1/-1}
  dt{color:var(--ink-muted);font-size:.75rem;text-transform:uppercase}
  dd{margin:var(--space-1) 0 0;overflow-wrap:anywhere}
  .command{display:block;padding:var(--space-2);background:var(--surface-strong);color:var(--ink-on-strong);border-radius:4px;font-size:.75rem;white-space:normal}
  .activity-item{display:grid;grid-template-columns:168px 170px minmax(0,1fr);gap:var(--space-3);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line);font-size:.8125rem}
  .activity-item:last-child{border-bottom:0}
  .activity-item time{color:var(--ink-muted)}
  .activity-item span{color:var(--ink-soft);overflow-wrap:anywhere}
  .kv{margin:0}
  .kv div{display:grid;grid-template-columns:minmax(110px,1fr) minmax(0,1.4fr);gap:var(--space-3);padding:var(--space-2) 0;border-bottom:1px solid var(--line)}
  .kv div:last-child{border-bottom:0}
  .kv dd{text-align:right}
  .hash{font-size:.75rem}
  .reviews{display:grid;gap:var(--space-3)}
  .review{padding:var(--space-4);border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
  .review header{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-3)}
  .review-kind{display:block;color:var(--ink-muted);font-size:.8125rem}
  .review-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-2);margin:var(--space-3) 0}
  .review-meta div{min-width:0}
  .review-meta dd{text-align:left;font-size:.75rem}
  .review-actions,.exportbar{display:flex;flex-wrap:wrap;gap:var(--space-2)}
  .button{appearance:none;min-height:44px;padding:0 var(--space-4);border:1px solid var(--line-strong);border-radius:6px;background:var(--surface);color:var(--ink);font-weight:700;cursor:pointer;transition:background var(--fast) var(--ease),border-color var(--fast) var(--ease),color var(--fast) var(--ease)}
  .button:hover{background:var(--surface-muted)}
  .button:active{background:var(--line)}
  .button:disabled{cursor:not-allowed;color:var(--ink-muted);background:var(--surface-muted);border-color:var(--line)}
  .button.approve[aria-pressed="true"]{border-color:var(--success);background:var(--success-soft);color:var(--success)}
  .button.sludge[aria-pressed="true"]{border-color:var(--danger);background:var(--danger-soft);color:var(--danger)}
  .notes-label{display:grid;gap:var(--space-2);margin-top:var(--space-3);color:var(--ink-soft);font-size:.8125rem}
  .notes{width:100%;min-height:72px;padding:var(--space-3);resize:vertical;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface-muted);color:var(--ink)}
  .exportbar{align-items:center;margin-top:var(--space-4)}
  .export-note{flex:1 1 100%;color:var(--ink-muted);font-size:.8125rem}
  .empty,.empty-cell{margin:0;color:var(--ink-muted);font-style:normal}
  .empty-cell{text-align:center;padding:var(--space-6)}
  footer{margin-top:var(--space-6);padding:var(--space-4) 0;color:var(--ink-muted);font-size:.8125rem;border-top:1px solid var(--line)}
  .sr-live{position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden}
  @media (max-width:1050px){
    .status-rail{grid-template-columns:repeat(2,minmax(0,1fr))}
    .workspace{grid-template-columns:1fr}
    .side{grid-template-columns:repeat(2,minmax(0,1fr))}
    .side .review-panel{grid-column:1/-1}
  }
  @media (max-width:700px){
    .appbar{align-items:flex-start;padding:var(--space-3) var(--space-4)}
    .app-meta{align-items:flex-end;flex-direction:column;gap:var(--space-2)}
    .run-id{max-width:20ch}
    .shell{padding:var(--space-4)}
    .console-head{align-items:flex-start;flex-direction:column}
    .updated{text-align:left}
    .status-rail,.side{grid-template-columns:1fr}
    .side .review-panel{grid-column:auto}
    .activity-item{grid-template-columns:1fr;gap:var(--space-1)}
    .progress-copy{align-items:flex-start;flex-direction:column;gap:var(--space-1)}
    .progress-copy span{text-align:left}
    .receipt{grid-template-columns:1fr}
    .receipt .wide{grid-column:auto}
    .review-meta{grid-template-columns:1fr}
    .review-actions .button,.exportbar .button{flex:1 1 140px}
    th,td{padding:var(--space-3)}
    .empty-cell{position:sticky;left:0;min-width:280px;text-align:left;background:var(--surface)}
  }
  @media (max-width:390px){
    .brand-copy span{display:none}
    .appbar{gap:var(--space-2)}
    .run-id{max-width:16ch}
    .status-card{min-height:112px}
    .panel-head{align-items:flex-start;flex-direction:column}
    .row-head{align-items:flex-start;flex-direction:column}
  }
  @media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body data-console-root>
  <a class="skip" href="#main">Skip to campaign state</a>
  <header class="appbar">
    <div class="brand-lockup">
      <div class="brand-mark" aria-hidden="true">LF</div>
      <div class="brand-copy"><strong>Loop Factory</strong><span>Campaign Console</span></div>
    </div>
    <div class="app-meta">
      <span class="run-id mono" title="${escapeHtml(view.run.id)}">${escapeHtml(view.run.id)}</span>
      <span id="connection" class="connection">snapshot</span>
    </div>
  </header>
  <div class="stopbar" role="alert">${escapeHtml(STOP_CONDITION_WARNING)}</div>

  <main id="main" class="shell">
    <div class="console-head">
      <div>
        <h1>Campaign state</h1>
        <p>Supervisor-owned progress, measured evidence, and operator decisions.</p>
      </div>
      <div class="updated">Updated <time id="updatedAt">${value(view.run.updatedAt)}</time></div>
    </div>

    <div id="pollError" class="poll-error" role="alert" hidden>
      <span>Live state is unavailable. The last verified snapshot remains visible.</span>
      <button id="retryPoll" type="button" class="button">Retry</button>
    </div>

    <section class="status-rail" aria-label="Run summary">
      <article class="status-card">
        <h2>Run status</h2>
        <span id="runStatus" class="status-value">${value(view.run.status)}</span>
        <span id="runMode" class="status-detail">${value(view.run.runMode)} mode</span>
      </article>
      <article class="status-card">
        <h2>Active lane</h2>
        <span id="activeLane" class="status-value mono">${value(activeLane && (activeLane.loop || activeLane.id))}</span>
        <span id="activePhase" class="status-detail">${activeLoop ? `phase ${activeLoop.phase + 1}/${activeLoop.totalPhases}` : 'no active phase'}</span>
        <div class="track" aria-label="Active phase progress"><i id="phaseBar" style="width:${phasePercent}%"></i></div>
      </article>
      <article class="status-card">
        <h2>Primary model</h2>
        <span id="primaryModel" class="status-value mono">${value(view.policy.primary)}</span>
        <span id="policySource" class="status-detail">${value(view.policy.source)}</span>
      </article>
      <article class="status-card">
        <h2>Continuation</h2>
        <span id="continuationState" class="status-value">${view.continuation.required ? 'Continuation required' : 'Continuation clear'}</span>
        <span id="nextTool" class="status-detail mono">${value(view.continuation.nextTool, 'ready')}</span>
      </article>
    </section>

    <div class="workspace">
      <div class="column main-column">
        <section class="panel" aria-labelledby="phase-title">
          <div class="panel-head">
            <div><h2 id="phase-title">Lane and phase progress</h2><p>Supervisor target queue</p></div>
            <span id="transitionCount" class="status info">${view.campaign.transitions.length} transition(s)</span>
          </div>
          <div class="panel-body progress-stack" id="loopProgress">${loopRows}</div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>lane</th><th>loop</th><th>kind</th><th>status</th><th>no-improve</th></tr></thead>
              <tbody id="laneRows">${laneRows}</tbody>
            </table>
          </div>
        </section>

        <section class="panel" aria-labelledby="verdict-title">
          <div class="panel-head">
            <div><h2 id="verdict-title">Supervisor verdict timeline</h2><p>Immutable worker decisions and receipts</p></div>
            <span id="verdictCount" class="status neutral">${view.verdicts.length} event(s)</span>
          </div>
          <ol id="verdictRows" class="verdict-list">${verdictRows}</ol>
        </section>

        <section class="panel" aria-labelledby="score-title">
          <div class="panel-head">
            <div><h2 id="score-title">Score matrix</h2><p>Tool-measured frontier movement</p></div>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>id</th><th>route</th><th>quality</th><th>tokens</th><th>delta q</th><th>delta cost</th><th>verify</th><th>verdict</th><th>promotion</th></tr></thead>
              <tbody id="scoreRows">${scoreRows}</tbody>
            </table>
          </div>
        </section>

        <section class="panel" aria-labelledby="activity-title">
          <div class="panel-head">
            <div><h2 id="activity-title">Activity</h2><p>Sanitized operational events</p></div>
            <span id="activityCount" class="status neutral">${view.activity.length} event(s)</span>
          </div>
          <ol id="activityRows" class="activity-list">${activityRows}</ol>
        </section>
      </div>

      <aside class="column side" aria-label="Policy, evidence, and operator review">
        <section class="panel">
          <div class="panel-head"><div><h2>Evidence</h2><p>Sealed and measured state</p></div></div>
          <div class="panel-body">
            <dl class="kv">
              <div><dt>baseline</dt><dd id="baselineState">${view.evidence.baselineLocked ? 'locked' : 'open'}</dd></div>
              <div><dt>baseline hash</dt><dd id="baselineHash" class="mono hash">${shortHash(view.evidence.baselineSha256)}</dd></div>
              <div><dt>benchmark</dt><dd id="benchmarkState">${view.evidence.benchmarkFrozen ? 'frozen' : 'open'}</dd></div>
              <div><dt>cases</dt><dd id="benchmarkCases">${view.evidence.benchmarkCases}</dd></div>
              <div><dt>baseline quality</dt><dd id="baselineQuality">${value(view.evidence.baselineQuality)}</dd></div>
              <div><dt>baseline tokens</dt><dd id="baselineTokens">${value(view.evidence.baselineTokenCost)}</dd></div>
              <div><dt>artifacts</dt><dd id="artifactCount">${view.evidence.artifacts}</dd></div>
              <div><dt>evidenced phases</dt><dd id="evidencedPhases">${view.evidence.evidencedPhases}</dd></div>
            </dl>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Model policy</h2><p>Operator-selected routing</p></div></div>
          <div class="panel-body">
            <dl class="kv">
              <div><dt>primary</dt><dd id="policyPrimary" class="mono">${value(view.policy.primary)}</dd></div>
              <div><dt>tests</dt><dd id="policyTests" class="mono">${escapeHtml(view.policy.testRoutes.join(', ')) || '--'}</dd></div>
              <div><dt>builders</dt><dd id="policyBuilders" class="mono">${escapeHtml(view.policy.builderRoutes.join(', ')) || '--'}</dd></div>
              <div><dt>judge</dt><dd id="policyJudge" class="mono">${value(view.policy.judgeRoute)}</dd></div>
              <div><dt>banlist</dt><dd id="policyBanlist">${value(view.policy.banlist.mode)}</dd></div>
            </dl>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Failure budget</h2><p>Advisory only</p></div></div>
          <div class="panel-body">
            <div class="progress-copy">
              <strong id="failureValue">${view.failures.consecutive}/${view.failures.patience}</strong>
              <span id="failureDetail">${view.failures.total} total</span>
            </div>
            <div class="track failure-track" aria-label="Failure patience"><i id="failureBar" style="width:${failurePercent}%"></i></div>
          </div>
        </section>

        <section class="panel review-panel" aria-labelledby="review-title">
          <div class="panel-head">
            <div><h2 id="review-title">Human review</h2><p>Operator-only authority</p></div>
            <span id="reviewCount" class="status ${view.reviews.pending ? 'warning' : 'neutral'}">${view.reviews.pending} pending</span>
          </div>
          <div class="panel-body">
            <div id="reviews" class="reviews">${reviewCards}</div>
            <div class="exportbar">
              <button type="button" id="exportBtn" class="button" disabled>Export decisions</button>
              <button type="button" id="copyBtn" class="button" disabled>Copy decisions</button>
              <span id="exportNote" class="export-note"></span>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <footer>
      <strong>You are the stop condition.</strong>
      <span> Local snapshot generated <time id="footerUpdated">${value(view.generatedAt)}</time>.</span>
    </footer>
  </main>

  <div class="sr-live" aria-live="polite" id="live"></div>
  <script id="run-data" type="application/json">${dataJson}</script>
  <script>
    (function(){
      'use strict';
      var snapshot = JSON.parse(document.getElementById('run-data').textContent);
      var runId = snapshot.run.id;
      var decisions = {};
      var etag = null;
      var polling = false;
      var timer = null;
      var live = document.getElementById('live');
      var connection = document.getElementById('connection');
      var pollError = document.getElementById('pollError');
      var exportBtn = document.getElementById('exportBtn');
      var copyBtn = document.getElementById('copyBtn');
      var exportNote = document.getElementById('exportNote');

      function esc(value){
        return String(value == null ? '' : value).replace(/[&<>"']/g,function(ch){
          return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
        });
      }
      function text(id,value){ var el=document.getElementById(id); if(el) el.textContent=value == null || value === '' ? '--' : String(value); }
      function announce(message){ live.textContent=message; }
      function isFileProtocol(){ return location.protocol === 'file:'; }
      function tone(value){
        var v=String(value||'').toUpperCase();
        if(['ACTIVE','APPROVED','MOVED_FRONTIER','PROMOTE','REVERIFIED'].indexOf(v)>=0) return 'success';
        if(['SLUDGE','REJECTED','NO_IMPROVEMENT','SELF_PROMOTION','PHASE_SKIP','MODEL_REPORTED_METRIC'].indexOf(v)>=0) return 'danger';
        if(['PENDING','REQUIRED','SENDING','SATURATED'].indexOf(v)>=0) return 'warning';
        return 'neutral';
      }
      function setConnection(label,mode){
        connection.textContent=label;
        connection.className='connection '+(mode||'');
      }
      function shortHash(value){ return value ? String(value).slice(0,12)+'...' : '--'; }
      function pctValue(value){ return value == null ? '--' : ((value>0?'+':'')+(value*100).toFixed(1)+'%'); }
      function detailLine(detail){
        return Object.keys(detail||{}).filter(function(k){return detail[k]!=null&&detail[k]!=='';})
          .map(function(k){return esc(k)+'='+esc(detail[k]);}).join('  ');
      }
      function setStatus(el,value){
        if(!el) return;
        el.textContent=value||'--';
        el.className='status '+tone(value);
      }
      function renderLoops(data){
        var holder=document.getElementById('loopProgress');
        if(!data.loops.length){holder.innerHTML='<p class="empty">No loop has started.</p>';return;}
        holder.innerHTML=data.loops.map(function(loop){
          var percent=loop.totalPhases>0?Math.round(((loop.phase+1)/loop.totalPhases)*100):0;
          return '<div class="progress-row" data-loop="'+esc(loop.id)+'"><div class="progress-copy"><strong class="mono">'+esc(loop.id)+'</strong><span>phase '+(loop.phase+1)+'/'+loop.totalPhases+' - '+loop.evidenceItems+' evidence item(s)</span></div><div class="track" aria-label="'+esc(loop.id)+' phase progress"><i style="width:'+percent+'%"></i></div></div>';
        }).join('');
      }
      function renderLanes(data){
        var rows=document.getElementById('laneRows');
        if(!data.campaign.lanes.length){rows.innerHTML='<tr><td colspan="5" class="empty-cell">No lane is open.</td></tr>';return;}
        rows.innerHTML=data.campaign.lanes.map(function(lane){
          return '<tr data-lane="'+esc(lane.id)+'"><td class="mono">'+esc(lane.id)+'</td><td>'+esc(lane.loop||lane.kind||'--')+'</td><td>'+esc(lane.kind||'--')+'</td><td><span class="status '+tone(lane.status)+'">'+esc(lane.status||'--')+'</span></td><td class="num">'+lane.noImproveBatches+'/'+((data.failures&&data.failures.retirementBatches)||'--')+'</td></tr>';
        }).join('');
      }
      function renderVerdicts(data){
        text('verdictCount',data.verdicts.length+' event(s)');
        var rows=document.getElementById('verdictRows');
        if(!data.verdicts.length){rows.innerHTML='<li class="empty">No supervisor verdict has been recorded.</li>';return;}
        rows.innerHTML=data.verdicts.slice().reverse().map(function(event){
          var receipt=event.invocation||{};
          var outcome=event.accepted?'ACCEPTED':(event.code||'BLOCKED');
          return '<li class="verdict" data-verdict="'+esc(event.id)+'"><div class="verdict-mark '+(event.accepted?'accepted':'blocked')+'" aria-hidden="true"></div><div class="verdict-main"><div class="row-head"><strong>'+esc(event.scenario||event.type||event.id)+'</strong><span class="status '+tone(outcome)+'">'+esc(outcome)+'</span></div><div class="meta-line"><span class="mono">'+esc(event.route||'--')+'</span><span>phase '+(event.phase==null?'--':event.phase)+'</span><span>'+esc(event.ts||'--')+'</span></div><details><summary>Invocation receipt</summary><dl class="receipt"><div><dt>requested</dt><dd class="mono">'+esc(receipt.requestedModel||'--')+'</dd></div><div><dt>authority</dt><dd>'+esc(receipt.modelIdentityAuthority||'--')+'</dd></div><div><dt>duration</dt><dd>'+(receipt.durationMs==null?'--':receipt.durationMs+' ms')+'</dd></div><div><dt>tokens</dt><dd>'+(receipt.tokenUsage==null?'--':receipt.tokenUsage)+'</dd></div><div class="wide"><dt>stdout</dt><dd class="mono">'+esc(shortHash(receipt.stdoutSha256))+'</dd></div><div class="wide"><dt>argv</dt><dd class="mono command">'+esc((receipt.argv||[]).join(' '))+'</dd></div></dl></details></div></li>';
        }).join('');
      }
      function renderScore(data){
        var rows=document.getElementById('scoreRows');
        if(!data.scoreMatrix.length){rows.innerHTML='<tr><td colspan="9" class="empty-cell">No measured hypotheses.</td></tr>';return;}
        rows.innerHTML=data.scoreMatrix.map(function(row){
          return '<tr data-hypothesis="'+esc(row.hypothesisId)+'"><td class="mono">'+esc(row.hypothesisId)+'</td><td class="mono">'+esc(row.route||'--')+'</td><td class="num">'+(row.measured?esc(row.quality):'unmeasured')+'</td><td class="num">'+(row.tokenCost==null?'--':row.tokenCost)+'</td><td class="num">'+(row.deltaQuality==null?'--':(row.deltaQuality>0?'+':'')+row.deltaQuality)+'</td><td class="num">'+esc(pctValue(row.deltaCostPct))+'</td><td><span class="status '+(row.reverified?'success':'neutral')+'">'+(row.reverified?'reverified':'--')+'</span></td><td><span class="status '+tone(row.verdict)+'">'+esc(row.verdict||'--')+'</span></td><td><span class="status '+(row.promotable?'success':'neutral')+'">'+(row.promotable?'promotable':'blocked')+'</span></td></tr>';
        }).join('');
      }
      function renderActivity(data){
        text('activityCount',data.activity.length+' event(s)');
        var rows=document.getElementById('activityRows');
        if(!data.activity.length){rows.innerHTML='<li class="empty">No activity has been recorded.</li>';return;}
        rows.innerHTML=data.activity.slice().reverse().map(function(entry){
          return '<li class="activity-item"><time>'+esc(entry.ts||'--')+'</time><strong>'+esc(entry.event)+'</strong><span class="mono">'+detailLine(entry.detail)+'</span></li>';
        }).join('');
      }
      function reviewMarkup(review){
        var disabled=review.status!=='PENDING'?' disabled':'';
        return '<article class="review" data-review="'+esc(review.id)+'"><header><div><strong class="mono">'+esc(review.id)+'</strong><span class="review-kind">'+esc(review.kind||'--')+'</span></div><span class="status '+tone(review.status)+'" data-status>'+esc(review.status||'--')+'</span></header><dl class="review-meta"><div><dt>hypothesis</dt><dd class="mono">'+esc(review.hypothesisId||'--')+'</dd></div><div><dt>evidence</dt><dd class="mono">'+esc(review.evidenceRef||'--')+'</dd></div><div><dt>loop</dt><dd class="mono">'+esc(review.loopId||'--')+'</dd></div></dl><div class="review-actions"><button type="button" class="button approve" data-act="approve" aria-label="Approve '+esc(review.id)+'"'+disabled+'>Approve</button><button type="button" class="button sludge" data-act="sludge" aria-label="Sludge '+esc(review.id)+'"'+disabled+'>Sludge</button></div><label class="notes-label">Operator notes<textarea class="notes" rows="2" placeholder="Optional"'+disabled+'></textarea></label></article>';
      }
      function renderReviews(data){
        text('reviewCount',data.reviews.pending+' pending');
        var count=document.getElementById('reviewCount');
        count.className='status '+(data.reviews.pending?'warning':'neutral');
        var holder=document.getElementById('reviews');
        var seen={};
        if(data.reviews.items.length){
          var empty=holder.querySelector('.empty');
          if(empty) empty.remove();
        }
        data.reviews.items.forEach(function(review){
          seen[review.id]=true;
          var card=holder.querySelector('[data-review="'+review.id+'"]');
          if(!card){holder.insertAdjacentHTML('beforeend',reviewMarkup(review));card=holder.querySelector('[data-review="'+review.id+'"]');}
          var submitted=card.getAttribute('data-submitted')==='true';
          var sending=card.getAttribute('data-sending')==='true';
          if(review.status!=='PENDING'){
            card.setAttribute('data-submitted','false');
            submitted=false;
            setStatus(card.querySelector('[data-status]'),review.status);
          }else if(!sending&&!submitted){
            setStatus(card.querySelector('[data-status]'),review.status);
          }
          var locked=review.status!=='PENDING'||submitted;
          card.querySelectorAll('[data-act]').forEach(function(button){button.disabled=locked;});
          card.querySelector('.notes').disabled=locked;
        });
        holder.querySelectorAll('[data-review]').forEach(function(card){
          if(!seen[card.getAttribute('data-review')] && card.getAttribute('data-sending')!=='true') card.remove();
        });
        if(!data.reviews.items.length) holder.innerHTML='<p class="empty">No operator decision is pending.</p>';
      }
      function markTableOverflow(){
        document.querySelectorAll('.table-scroll').forEach(function(holder){
          holder.classList.toggle('is-overflowing',holder.scrollWidth>holder.clientWidth+1);
        });
      }
      function renderSnapshot(data){
        snapshot=data;
        text('updatedAt',data.run.updatedAt);
        text('footerUpdated',data.generatedAt);
        text('runStatus',data.run.status);
        text('runMode',(data.run.runMode||'--')+' mode');
        var lane=data.campaign.lanes.find(function(item){return item.id===data.campaign.activeLaneId;})||data.campaign.lanes[0]||null;
        var loop=data.loops.find(function(item){return item.id===data.run.activeLoop;})||data.loops[0]||null;
        text('activeLane',lane&&(lane.loop||lane.id));
        text('activePhase',loop?'phase '+(loop.phase+1)+'/'+loop.totalPhases:'no active phase');
        document.getElementById('phaseBar').style.width=(loop&&loop.totalPhases>0?Math.round(((loop.phase+1)/loop.totalPhases)*100):0)+'%';
        text('primaryModel',data.policy.primary);
        text('policySource',data.policy.source);
        text('continuationState',data.continuation.required?'Continuation required':'Continuation clear');
        text('nextTool',data.continuation.nextTool||'ready');
        text('transitionCount',data.campaign.transitions.length+' transition(s)');
        text('baselineState',data.evidence.baselineLocked?'locked':'open');
        text('baselineHash',shortHash(data.evidence.baselineSha256));
        text('benchmarkState',data.evidence.benchmarkFrozen?'frozen':'open');
        text('benchmarkCases',data.evidence.benchmarkCases);
        text('baselineQuality',data.evidence.baselineQuality);
        text('baselineTokens',data.evidence.baselineTokenCost);
        text('artifactCount',data.evidence.artifacts);
        text('evidencedPhases',data.evidence.evidencedPhases);
        text('policyPrimary',data.policy.primary);
        text('policyTests',data.policy.testRoutes.join(', ')||'--');
        text('policyBuilders',data.policy.builderRoutes.join(', ')||'--');
        text('policyJudge',data.policy.judgeRoute);
        text('policyBanlist',data.policy.banlist.mode);
        text('failureValue',data.failures.consecutive+'/'+data.failures.patience);
        text('failureDetail',data.failures.total+' total');
        document.getElementById('failureBar').style.width=(data.failures.patience>0?Math.min(100,Math.round((data.failures.consecutive/data.failures.patience)*100)):0)+'%';
        renderLoops(data);renderLanes(data);renderVerdicts(data);renderScore(data);renderActivity(data);renderReviews(data);markTableOverflow();
      }
      function postDecision(id,act,card){
        var statusEl=card.querySelector('[data-status]');
        if(isFileProtocol()){
          statusEl.textContent='local draft - export to apply';
          statusEl.className='status warning';
          announce('local draft - export to apply');
          return;
        }
        card.setAttribute('data-sending','true');
        fetch('/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:runId,reviewId:id,decision:act,notes:decisions[id].notes})})
          .then(function(response){if(!response.ok) throw new Error('apply failed');return response.json();})
          .then(function(){
            statusEl.textContent=act==='approve'?'APPROVED':'SLUDGE';
            statusEl.className='status '+(act==='approve'?'success':'danger');
            card.setAttribute('data-sending','false');
            card.setAttribute('data-submitted','true');
            card.querySelectorAll('[data-act]').forEach(function(button){button.disabled=true;});
            card.querySelector('.notes').disabled=true;
            announce(act+' queued for '+id);
            pollRun();
          })
          .catch(function(){
            statusEl.textContent='PENDING';
            statusEl.className='status warning';
            card.setAttribute('data-sending','false');
            announce('Decision was not queued. Export remains available.');
          });
      }
      function enableExport(){
        var enabled=Object.keys(decisions).length>0;
        exportBtn.disabled=!enabled;copyBtn.disabled=!enabled;
      }
      function payload(){return JSON.stringify({runId:runId,resolvedAt:new Date().toISOString(),decisions:decisions},null,2);}
      function pollRun(){
        if(isFileProtocol()||polling) return;
        polling=true;
        var headers={};
        if(etag) headers['If-None-Match']=etag;
        fetch('/api/run?run='+encodeURIComponent(runId),{headers:headers,cache:'no-store'})
          .then(function(response){
            if(response.status===304) return null;
            if(!response.ok) throw new Error('poll failed');
            etag=response.headers.get('etag')||etag;
            return response.json();
          })
          .then(function(data){
            if(data) renderSnapshot(data);
            pollError.hidden=true;
            setConnection('live','live');
          })
          .catch(function(){
            pollError.hidden=false;
            setConnection('reconnecting','reconnecting');
          })
          .then(function(){polling=false;});
      }
      document.getElementById('reviews').addEventListener('click',function(event){
        var button=event.target.closest('[data-act]');
        if(!button) return;
        var card=button.closest('[data-review]');
        var id=card.getAttribute('data-review');
        var act=button.getAttribute('data-act');
        card.querySelectorAll('[data-act]').forEach(function(item){item.setAttribute('aria-pressed',item===button?'true':'false');});
        decisions[id]={decision:act,notes:(card.querySelector('.notes').value||null)};
        if(isFileProtocol()){
          var statusEl=card.querySelector('[data-status]');
          statusEl.textContent='local draft - export to apply';
          statusEl.className='status warning';
        }else{
          var sending=card.querySelector('[data-status]');
          sending.textContent='SENDING';
          sending.className='status warning';
        }
        enableExport();
        postDecision(id,act,card);
      });
      document.getElementById('reviews').addEventListener('input',function(event){
        if(!event.target.classList.contains('notes')) return;
        var card=event.target.closest('[data-review]');
        var id=card.getAttribute('data-review');
        if(decisions[id]) decisions[id].notes=event.target.value||null;
      });
      exportBtn.addEventListener('click',function(){
        var blob=new Blob([payload()],{type:'application/json'});
        var url=URL.createObjectURL(blob);
        var a=document.createElement('a');a.href=url;a.download='inbox-decisions.json';a.click();
        URL.revokeObjectURL(url);exportNote.textContent='Decision file created.';
      });
      copyBtn.addEventListener('click',function(){
        if(navigator.clipboard){navigator.clipboard.writeText(payload()).then(function(){exportNote.textContent='Decisions copied.';});}
        else{exportNote.textContent=payload();}
      });
      document.getElementById('retryPoll').addEventListener('click',pollRun);
      document.addEventListener('visibilitychange',function(){if(!document.hidden) pollRun();});
      window.addEventListener('resize',markTableOverflow);
      renderSnapshot(snapshot);
      if(isFileProtocol()){
        setConnection('file snapshot','');
      }else{
        setConnection('connecting','reconnecting');
        pollRun();
        timer=setInterval(pollRun,1000);
      }
      window.addEventListener('beforeunload',function(){if(timer) clearInterval(timer);});
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
