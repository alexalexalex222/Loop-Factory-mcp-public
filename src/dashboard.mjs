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

function displayValue(value, fallback = '--') {
  return value == null || value === '' ? fallback : escapeHtml(String(value));
}

function displayPercent(value) {
  return value == null ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
}

function displayInteger(value) {
  return value == null ? '--' : Math.round(Number(value)).toLocaleString('en-US');
}

function displayDuration(value) {
  if (value == null) return '--';
  const ms = Number(value);
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function displayDelta(value, percent = false) {
  if (value == null) return '--';
  const number = Number(value);
  const rendered = percent ? `${(number * 100).toFixed(1)}%` : number.toFixed(4);
  return `${number > 0 ? '+' : ''}${rendered}`;
}

function shortHash(value) {
  return value ? `${escapeHtml(String(value).slice(0, 12))}...` : '--';
}

function canaryTone(value) {
  const status = String(value || '').toUpperCase();
  if (['PASS', 'VALID', 'QUEUE_DRAINED', 'SUCCESS'].includes(status)) return 'success';
  if (['FAIL', 'FAILED', 'BLOCKED', 'ERROR', 'FAILURE'].includes(status)) return 'failure';
  if (['INCOMPLETE', 'UNKNOWN', 'MISSING', 'RECONNECTING', 'STALE'].includes(status)) return 'warning';
  return 'neutral';
}

function renderCanaryDashboard(view) {
  const canary = view.canary;
  const blocked = canary.blocked || {
    active: false,
    code: null,
    reasons: [],
    failureEvidenceAvailable: false,
    diagnosticsAvailable: false,
    failures: []
  };
  const dataJson = JSON.stringify(view).replace(/</g, '\\u003c');
  const armRoles = ['baseline', 'challenger', 'sham'];
  const armsByRole = Object.fromEntries(canary.arms.map((arm) => [arm.role, arm]));
  const expectedReplicates = Number(canary.contract.replicatesPerArm) || 0;
  const maxTokens = Math.max(
    1,
    ...canary.arms.flatMap((arm) => arm.replicates.map((replicate) => Number(replicate.tokenCost) || 0))
  );
  const hasReplicates = canary.arms.some((arm) => arm.replicates.length > 0);
  const causalArmHeadings = armRoles.map((role) => {
    const arm = armsByRole[role] || { label: role, targetMean: null, controlMean: null, tokenMean: null };
    return `<th scope="col" data-causal-arm="${escapeHtml(role)}">
      <span>${escapeHtml(arm.label)}</span>
      <strong>${displayPercent(arm.targetMean)}</strong>
      <small>target mean</small>
    </th>`;
  }).join('');
  const causalRows = hasReplicates
    ? Array.from({ length: expectedReplicates }, (_, index) => {
        const replicateNumber = index + 1;
        const cells = armRoles.map((role) => {
          const arm = armsByRole[role];
          const replicate = arm?.replicates.find((entry) => Number(entry.replicate) === replicateNumber)
            || arm?.replicates[index]
            || null;
          if (!replicate) {
            return `<td class="matrix-cell is-empty" data-causal-arm-cell="${escapeHtml(role)}">
              <span class="empty-reading">No measurement</span>
            </td>`;
          }
          const targetWidth = Math.max(0, Math.min(100, (Number(replicate.targetQuality) || 0) * 100));
          const controlWidth = Math.max(0, Math.min(100, (Number(replicate.controlQuality) || 0) * 100));
          const tokenWidth = Math.max(0, Math.min(100, ((Number(replicate.tokenCost) || 0) / maxTokens) * 100));
          return `<td class="matrix-cell" data-causal-arm-cell="${escapeHtml(role)}">
            <span class="matrix-reading">
              <span><small>Target</small><strong>${displayPercent(replicate.targetQuality)}</strong></span>
              <span class="meter target-meter" aria-label="${escapeHtml(arm.label)} replicate ${replicateNumber} target quality ${displayPercent(replicate.targetQuality)}"><i style="--meter:${targetWidth}%"></i></span>
            </span>
            <span class="matrix-reading secondary">
              <span><small>Control</small><strong>${displayPercent(replicate.controlQuality)}</strong></span>
              <span class="meter control-meter" aria-label="${escapeHtml(arm.label)} replicate ${replicateNumber} control quality ${displayPercent(replicate.controlQuality)}"><i style="--meter:${controlWidth}%"></i></span>
            </span>
            <span class="matrix-token"><small>Tokens</small><strong>${displayInteger(replicate.tokenCost)}</strong><i style="--meter:${tokenWidth}%"></i></span>
          </td>`;
        }).join('');
        return `<tr data-causal-row>
          <th class="matrix-replicate" scope="row"><span>Replicate</span><strong class="mono">${String(replicateNumber).padStart(2, '0')}</strong></th>
          ${cells}
        </tr>`;
      }).join('')
    : '<tr><td class="empty-state" colspan="4">No replicate measurements are available.</td></tr>';

  const finiteControlMeans = canary.arms
    .map((arm) => Number(arm.controlMean))
    .filter((value) => Number.isFinite(value));
  const protectedControlMean = finiteControlMeans.length ? Math.min(...finiteControlMeans) : null;
  const gatePassCount = canary.gates.filter((gate) => String(gate.status).toUpperCase() === 'PASS').length;
  const laneItems = [
    ['Baseline', armsByRole.baseline?.targetMean, 'baseline'],
    ['Challenger', armsByRole.challenger?.targetMean, 'challenger'],
    ['Sham', armsByRole.sham?.targetMean, 'sham'],
    ['Protected controls', protectedControlMean, 'control']
  ].map(([label, value, role]) => {
    const width = Math.max(0, Math.min(100, (Number(value) || 0) * 100));
    return `<div class="lane-reading lane-${role}">
      <span>${escapeHtml(label)}</span>
      <strong>${displayPercent(value)}</strong>
      <span class="lane-meter" aria-label="${escapeHtml(label)} ${displayPercent(value)}"><i style="--meter:${width}%"></i></span>
    </div>`;
  }).join('');

  const proofRegisterMarkup = [
    ['Paired target', `${canary.proof.pairedTargetWins}/${expectedReplicates}`, blocked.active ? 'failure' : (canary.proof.pairedTargetWins >= Math.max(0, expectedReplicates - 1) ? 'success' : 'failure')],
    ['Sham wins', blocked.active ? 'NOT TESTED' : String(canary.proof.shamWins), blocked.active ? 'neutral' : (canary.proof.shamWins === 0 ? 'success' : 'failure')],
    ['Control regressions', blocked.active ? 'NOT TESTED' : String(canary.proof.controlRegressions), blocked.active ? 'neutral' : (canary.proof.controlRegressions === 0 ? 'success' : 'failure')],
    ['Receipts', String(canary.proof.validReceipts), canary.proof.callCount > 0 && canary.proof.validReceipts === canary.proof.callCount ? 'success' : 'warning'],
    ['Retries', String(canary.proof.retryCount), canary.proof.retryCount === 0 ? 'success' : 'warning'],
    ['Isolation', canary.proof.isolationStatus, canaryTone(canary.proof.isolationStatus)],
    ['Verifier', canary.proof.verifierStatus, canaryTone(canary.proof.verifierStatus)],
    ['Promotion', canary.proof.promotionRecorded ? 'RECORDED' : 'DISABLED', canary.proof.promotionRecorded ? 'failure' : 'neutral']
  ].map(([label, value, tone]) => `<div class="proof-reading state-${tone}">
    <span>${escapeHtml(label)}</span>
    <strong class="mono">${escapeHtml(value)}</strong>
  </div>`).join('');

  const breakdownTargetRows = canary.arms.map((arm) => {
    const width = Math.max(0, Math.min(100, (Number(arm.targetMean) || 0) * 100));
    return `<div class="breakdown-row">
      <span>${escapeHtml(arm.label)}</span>
      <span class="breakdown-meter target-meter" aria-label="${escapeHtml(arm.label)} target mean ${displayPercent(arm.targetMean)}"><i style="--meter:${width}%"></i></span>
      <strong class="mono">${displayPercent(arm.targetMean)}</strong>
      <small class="mono">${displayDelta(arm.targetDeltaVsBaseline)} vs baseline</small>
    </div>`;
  }).join('');
  const breakdownControlRows = canary.arms.map((arm) => {
    const width = Math.max(0, Math.min(100, (Number(arm.controlMean) || 0) * 100));
    return `<div class="breakdown-row">
      <span>${escapeHtml(arm.label)}</span>
      <span class="breakdown-meter control-meter" aria-label="${escapeHtml(arm.label)} control mean ${displayPercent(arm.controlMean)}"><i style="--meter:${width}%"></i></span>
      <strong class="mono">${displayPercent(arm.controlMean)}</strong>
      <small class="mono">${displayDelta(arm.controlDeltaVsBaseline)} vs baseline</small>
    </div>`;
  }).join('');
  const breakdownTokenRows = canary.arms.map((arm) => `<div>
    <span>${escapeHtml(arm.label)}</span>
    <strong class="mono">${displayInteger(arm.tokenMean)}</strong>
    <small class="mono">${displayDelta(arm.tokenDeltaPctVsBaseline, true)} vs baseline</small>
  </div>`).join('');

  const gatesMarkup = canary.gates.map((gate, index) => `<li class="gate state-${canaryTone(gate.status)}">
    <span class="gate-index mono">${String(index + 1).padStart(2, '0')}</span>
    <span class="state-mark" aria-hidden="true"></span>
    <span class="gate-copy"><small>${escapeHtml(gate.label)}</small><strong>${escapeHtml(gate.status)}</strong></span>
  </li>`).join('');

  const hashesMarkup = canary.hashes.length
    ? canary.hashes.map((entry, index) => `<div class="hash-row">
        <span class="hash-index mono">${String(index + 1).padStart(2, '0')}</span>
        <span class="hash-label"><strong>${escapeHtml(entry.label)}</strong>${entry.bytes == null ? '' : `<small>${displayInteger(entry.bytes)} bytes</small>`}</span>
        <code title="${escapeHtml(entry.sha256)}">${escapeHtml(entry.sha256)}</code>
        <button class="copy-button" type="button" data-copy-hash="${escapeHtml(entry.sha256)}" aria-label="Copy ${escapeHtml(entry.label)} SHA-256">Copy</button>
      </div>`).join('')
    : '<p class="empty-state">No public evidence hashes are available.</p>';

  const receiptMarkup = canary.receipts.length
    ? canary.receipts.map((entry, index) => {
        const receipt = entry.receipt;
        const armLabel = entry.arm
          ? `${entry.arm[0].toUpperCase()}${entry.arm.slice(1)}`
          : 'Proposal';
        const title = entry.kind === 'proposal'
          ? 'Proposal call'
          : `${armLabel} replicate ${entry.replicate}`;
        return `<details class="ledger-item state-${canaryTone(receipt.status)}" name="receipt-ledger" data-ledger-arm="${escapeHtml(entry.arm || 'proposal')}" data-ledger-replicate="${entry.replicate == null ? 'proposal' : entry.replicate}"${index === 0 ? ' open' : ''}>
          <summary>
            <span class="receipt-index mono">${String(index + 1).padStart(2, '0')}</span>
            <span class="ledger-title"><span class="state-mark" aria-hidden="true"></span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(entry.evaluationId || entry.id)}</small></span>
            <span class="ledger-reading"><small>Target</small><strong class="mono">${entry.kind === 'proposal' ? '--' : displayPercent(entry.targetQuality)}</strong></span>
            <span class="ledger-reading"><small>Control</small><strong class="mono">${entry.kind === 'proposal' ? '--' : displayPercent(entry.controlQuality)}</strong></span>
            <span class="ledger-reading"><small>Tokens</small><strong class="mono">${displayInteger(entry.tokenCost)}</strong></span>
            <span class="ledger-reading"><small>Duration</small><strong class="mono">${displayDuration(receipt.durationMs)}</strong></span>
            <span class="ledger-status"><small>Receipt</small><strong>${escapeHtml(receipt.status)}</strong></span>
          </summary>
          <dl class="receipt-grid">
            <div><dt>Requested model</dt><dd class="mono">${displayValue(receipt.requestedModel)}</dd></div>
            <div><dt>Selection authority</dt><dd>${displayValue(receipt.modelSelectionAuthority)}</dd></div>
            <div><dt>Identity authority</dt><dd>${displayValue(receipt.modelIdentityAuthority)}</dd></div>
            <div><dt>Strict isolation</dt><dd>${receipt.strictIsolation === true ? 'YES' : (receipt.strictIsolation === false ? 'NO' : '--')}</dd></div>
            <div><dt>Isolation status</dt><dd>${displayValue(receipt.isolationStatus)}</dd></div>
            <div><dt>Exit code</dt><dd class="mono">${displayValue(receipt.exitCode)}</dd></div>
            <div><dt>Duration</dt><dd class="mono">${displayDuration(receipt.durationMs)}</dd></div>
            <div><dt>CLI total tokens</dt><dd class="mono">${displayInteger(receipt.cliReportedTotalTokens)}</dd></div>
            <div class="wide"><dt>Procedure sha256</dt><dd><code>${displayValue(entry.procedureSha256)}</code></dd></div>
            <div class="wide"><dt>Stdout sha256</dt><dd><code>${displayValue(receipt.stdoutSha256)}</code></dd></div>
            <div class="wide"><dt>Result sha256</dt><dd><code>${displayValue(receipt.resultSha256)}</code></dd></div>
            <div class="wide"><dt>Raw result sha256</dt><dd><code>${displayValue(receipt.rawResultSha256)}</code></dd></div>
            <div class="wide"><dt>Output schema sha256</dt><dd><code>${displayValue(receipt.outputSchemaSha256)}</code></dd></div>
          </dl>
        </details>`;
      }).join('')
    : '<p class="empty-state">No persisted receipts are available.</p>';

  const blockerReasonMarkup = blocked.reasons.length
    ? blocked.reasons.map((reason) => `<code>${escapeHtml(reason)}</code>`).join('')
    : '<span>No safe supervisor reason codes were preserved.</span>';
  const blockerMarkup = blocked.active ? `<section class="blocker-record" data-blocked-launch aria-label="Launch blocker">
    <header>
      <span>Launch blocker</span>
      <strong class="mono">${displayValue(blocked.code, 'BLOCKED')}</strong>
    </header>
    <div class="blocker-reasons"><span>Safe supervisor reason codes</span><div>${blockerReasonMarkup}</div></div>
    <footer>
      <strong>${blocked.failureEvidenceAvailable ? 'Failure evidence available' : 'Failure evidence unavailable'}</strong>
      <span>${blocked.diagnosticsAvailable
        ? 'Allowlisted launch diagnostics are available below; raw stdout and stderr remain private.'
        : 'Diagnostics unavailable for this historical failure.'}</span>
    </footer>
  </section>` : '';
  const failureRecordsMarkup = blocked.failures.length
    ? blocked.failures.map((failure, index) => {
        const armLabel = failure.arm
          ? `${failure.arm[0].toUpperCase()}${failure.arm.slice(1)}`
          : 'Proposal';
        const positionLabel = failure.kind === 'evaluation'
          ? `${armLabel} / Replicate ${displayValue(failure.replicate)} / Position ${displayValue(failure.position)}`
          : 'Proposal launch';
        const invocation = failure.invocation || {};
        const streamMarkup = (label, stream) => stream ? `<div class="failure-stream">
          <dt>${escapeHtml(label)}</dt>
          <dd>
            <code>${displayValue(stream.sha256)}</code>
            <span>${displayInteger(stream.bytes)} bytes</span>
            <span>Receipt match ${stream.matchesReceipt === true ? 'YES' : (stream.matchesReceipt === false ? 'NO' : '--')}</span>
            ${stream.artifactId ? `<span class="mono">Artifact ${displayValue(stream.artifactId)}</span>` : ''}
          </dd>
        </div>` : `<div class="failure-stream"><dt>${escapeHtml(label)}</dt><dd><span>Not preserved</span></dd></div>`;
        return `<article class="failure-record">
          <header>
            <span class="failure-index mono">${String(index + 1).padStart(2, '0')}</span>
            <span><small>${escapeHtml(failure.kind)}</small><strong>${escapeHtml(positionLabel)}</strong></span>
            <strong class="mono">${displayValue(failure.execReason, 'UNKNOWN')}</strong>
          </header>
          <dl class="failure-meta">
            <div><dt>Exit code</dt><dd class="mono">${displayValue(invocation.exitCode)}</dd></div>
            <div><dt>Requested model</dt><dd class="mono">${displayValue(invocation.requestedModel)}</dd></div>
            <div><dt>Reported model</dt><dd class="mono">${displayValue(invocation.reportedModel)}</dd></div>
            <div><dt>Selection authority</dt><dd>${displayValue(invocation.modelSelectionAuthority)}</dd></div>
            <div><dt>Identity authority</dt><dd>${displayValue(invocation.modelIdentityAuthority)}</dd></div>
            <div><dt>Receipt model match</dt><dd>${invocation.reportedModelMatchesRequest === true ? 'YES' : (invocation.reportedModelMatchesRequest === false ? 'NO' : '--')}</dd></div>
            ${failure.blindArmId ? `<div><dt>Blind arm ID</dt><dd class="mono">${displayValue(failure.blindArmId)}</dd></div>` : ''}
            ${failure.rawArtifactId ? `<div><dt>Raw artifact ID</dt><dd class="mono">${displayValue(failure.rawArtifactId)}</dd></div>` : ''}
            ${failure.resultArtifactId ? `<div><dt>Result artifact ID</dt><dd class="mono">${displayValue(failure.resultArtifactId)}</dd></div>` : ''}
          </dl>
          <dl class="failure-streams">
            ${streamMarkup('Stdout', failure.stdout)}
            ${streamMarkup('Stderr', failure.stderr)}
          </dl>
          <div class="failure-reasons"><span>Supervisor reasons</span>${failure.reasons.map((reason) => `<code>${escapeHtml(reason)}</code>`).join('') || '<span>None preserved</span>'}</div>
        </article>`;
      }).join('')
    : '<div class="diagnostic-empty"><strong>Diagnostics unavailable for this historical failure.</strong><span>No preserved launch receipt, stdout hash, stderr hash, byte count, or receipt-match result exists in this state.</span></div>';
  const failureSectionMarkup = blocked.active ? `<section class="failure-band" aria-labelledby="failure-title" data-failure-evidence="${blocked.failureEvidenceAvailable ? 'available' : 'unavailable'}">
    <div class="band-inner">
      <header class="section-head">
        <div><span class="eyebrow">Blocked launch</span><h2 id="failure-title">Failure evidence</h2></div>
        <p>Only safe reason codes, model authority, exit status, hashes, byte counts, receipt matching, arm position, and safe artifact IDs are public.</p>
      </header>
      <div class="failure-sheet">${failureRecordsMarkup}</div>
    </div>
  </section>` : '';

  const verdictTone = canaryTone(canary.verdict.status);
  const causalAnswer = blocked.active
    ? 'Blocked before proof'
    : (canary.verdict.causalMovement ? 'Challenger beat baseline' : 'Not established');
  const validityAnswer = blocked.active
    ? 'Launch not valid'
    : (canary.verdict.experimentValid ? 'Experiment valid' : 'Validity failed');
  const shamAnswer = blocked.active || canary.proof.pairedComparisons === 0
    ? 'Not evaluated'
    : (canary.verdict.shamMoved ? 'Sham moved' : 'Sham stayed flat');
  const controlAnswer = blocked.active || canary.proof.pairedComparisons === 0
    ? 'Not evaluated'
    : (canary.verdict.controlsRegressed ? 'Controls regressed' : 'Controls held');
  const promotionAnswer = canary.verdict.promoted
    ? 'Promotion recorded'
    : (canary.proof.promotionEnabled ? 'Promotion not recorded' : 'Promotion disabled');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>Loop Factory Canary Console - ${escapeHtml(view.run.id)}</title>
<style>
  :root{
    --neutral-0:#ffffff;
    --neutral-50:#f5f6f2;
    --neutral-100:#eceee9;
    --neutral-200:#d8ddd7;
    --neutral-300:#b7c0b9;
    --neutral-500:#68736d;
    --neutral-700:#3f4944;
    --neutral-900:#121815;
    --charcoal:#171d1a;
    --charcoal-2:#222a26;
    --emerald:#146247;
    --emerald-soft:#dcefe5;
    --emerald-line:#9bcbb2;
    --cobalt:#255ec4;
    --cobalt-soft:#e4ebfa;
    --cobalt-line:#aac0ed;
    --amber:#875b08;
    --amber-soft:#f7ebca;
    --amber-line:#dec47d;
    --red:#963930;
    --red-soft:#f6dfdc;
    --red-line:#e2afa9;
    --surface-bg:var(--neutral-50);
    --surface-primary:var(--neutral-0);
    --surface-muted:var(--neutral-100);
    --surface-inverse:var(--charcoal);
    --surface-inverse-raised:var(--charcoal-2);
    --text-primary:var(--neutral-900);
    --text-secondary:var(--neutral-700);
    --text-muted:var(--neutral-500);
    --text-inverse:var(--neutral-0);
    --text-inverse-muted:var(--neutral-300);
    --border-subtle:var(--neutral-200);
    --border-strong:var(--neutral-300);
    --focus:var(--cobalt);
    --state-success:var(--emerald);
    --state-success-soft:var(--emerald-soft);
    --state-success-line:var(--emerald-line);
    --state-warning:var(--amber);
    --state-warning-soft:var(--amber-soft);
    --state-warning-line:var(--amber-line);
    --state-failure:var(--red);
    --state-failure-soft:var(--red-soft);
    --state-failure-line:var(--red-line);
    --signal:var(--cobalt);
    --signal-soft:var(--cobalt-soft);
    --signal-line:var(--cobalt-line);
    --font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    --font-display:Georgia,"Times New Roman",serif;
    --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --text-xs:.75rem;
    --text-sm:.875rem;
    --text-base:1rem;
    --text-md:1.125rem;
    --text-lg:1.375rem;
    --text-xl:1.75rem;
    --text-2xl:2.25rem;
    --text-display:6.5rem;
    --space-1:4px;
    --space-2:8px;
    --space-3:12px;
    --space-4:16px;
    --space-5:24px;
    --space-6:32px;
    --space-7:40px;
    --space-8:48px;
    --radius-xs:2px;
    --radius-sm:4px;
    --radius-md:6px;
    --duration-fast:150ms;
    --duration-base:220ms;
    --ease-standard:cubic-bezier(.4,0,.2,1);
    --shadow-1:0 1px 2px rgb(18 24 21 / 8%);
    --container:1480px;
  }
  *{box-sizing:border-box;letter-spacing:0}
  html{background:var(--surface-bg);color:var(--text-primary);scroll-behavior:smooth}
  body{margin:0;min-width:320px;overflow-x:clip;background:var(--surface-bg);font:400 var(--text-base)/1.5 var(--font-ui);-webkit-font-smoothing:antialiased}
  button,input,select{font:inherit}
  button{letter-spacing:0}
  a{color:var(--signal)}
  code,.mono,.num{font-family:var(--font-mono);font-feature-settings:"tnum"}
  .num{text-align:right}
  .skip-link{position:fixed;z-index:1000;top:-80px;left:var(--space-4);min-height:44px;padding:var(--space-3) var(--space-4);border:2px solid var(--focus);border-radius:var(--radius-sm);background:var(--surface-primary);color:var(--text-primary)}
  .skip-link:focus{top:var(--space-4)}
  :focus-visible{outline:3px solid var(--focus);outline-offset:3px}
  .topbar{position:sticky;z-index:100;top:0;display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:64px;padding:var(--space-2) max(var(--space-4),calc((100vw - var(--container))/2 + var(--space-5)));border-top:3px solid var(--signal);border-bottom:1px solid var(--charcoal-2);background:var(--surface-inverse);color:var(--text-inverse)}
  .product,.run-meta,.run-facts{display:flex;align-items:center;min-width:0}
  .product{gap:var(--space-3)}
  .product-mark{display:grid;width:36px;height:36px;place-items:center;border:1px solid var(--emerald-line);border-radius:var(--radius-sm);background:var(--emerald);font-weight:700}
  .product-copy{display:grid;line-height:1.2}
  .product-copy strong{font-size:var(--text-base)}
  .product-copy span{color:var(--text-inverse-muted);font-size:var(--text-xs)}
  .run-meta{gap:var(--space-4)}
  .run-facts{gap:var(--space-4);color:var(--text-inverse-muted);font-size:var(--text-xs)}
  .run-fact{display:grid;min-width:0}
  .run-fact span{color:var(--text-inverse-muted)}
  .run-fact strong{max-width:28ch;overflow:hidden;color:var(--text-inverse);text-overflow:ellipsis;white-space:nowrap}
  .connection{display:inline-flex;align-items:center;gap:var(--space-2);min-height:44px;padding:0 var(--space-3);border:1px solid var(--neutral-500);border-radius:var(--radius-sm);color:var(--text-inverse);font-size:var(--text-xs);font-weight:700;text-transform:uppercase}
  .connection::before{width:8px;height:8px;border-radius:var(--radius-xs);background:var(--neutral-500);content:""}
  .connection.live::before{background:var(--emerald-line)}
  .connection.reconnecting::before,.connection.stale::before{background:var(--amber-line)}
  .connection.failure::before{background:var(--red-line)}
  .poll-alert{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-3) max(var(--space-4),calc((100vw - var(--container))/2 + var(--space-5)));border-bottom:1px solid var(--state-warning-line);background:var(--state-warning-soft);color:var(--state-warning)}
  .poll-alert[hidden]{display:none}
  .button{min-height:44px;padding:0 var(--space-4);border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface-primary);color:var(--text-primary);font-weight:700;cursor:pointer;transition:border-color var(--duration-fast) var(--ease-standard),background var(--duration-fast) var(--ease-standard)}
  .button:hover{border-color:var(--signal);background:var(--signal-soft)}
  .button:active{background:var(--surface-muted)}
  .button:disabled{border-color:var(--border-subtle);background:var(--surface-muted);color:var(--text-muted);cursor:not-allowed}
  main{display:block}
  .band-inner{width:min(var(--container),100%);margin:0 auto;padding-inline:var(--space-5)}
  .eyebrow{display:block;color:var(--text-muted);font-size:var(--text-xs);font-weight:700;text-transform:uppercase}
  .evidence-stage{border-bottom:1px solid var(--charcoal);background:var(--surface-primary)}
  .stage-shell{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.58fr);padding-inline:0;border-inline:1px solid var(--charcoal)}
  .stage-main{min-width:0;padding:var(--space-6);border-right:1px solid var(--charcoal)}
  .stage-header{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--space-6);align-items:center}
  .paired-score{min-width:174px;padding-right:var(--space-6);border-right:4px solid var(--state-success)}
  .paired-score strong{display:block;font:700 var(--text-display)/.78 var(--font-display);font-feature-settings:"tnum";white-space:nowrap}
  .paired-score strong span{color:var(--text-muted);font-size:.34em;font-family:var(--font-ui)}
  .paired-score small{display:block;margin-top:var(--space-3);color:var(--state-success);font-size:var(--text-sm);font-weight:700;text-transform:uppercase}
  .verdict-copy{min-width:0}
  .verdict-copy .eyebrow{color:var(--state-success)}
  .verdict-copy h1{max-width:25ch;margin:var(--space-2) 0 var(--space-2);font:700 var(--text-2xl)/1.05 var(--font-display);text-wrap:balance}
  .verdict-copy>p{max-width:66ch;margin:0;color:var(--text-secondary);font-size:var(--text-md);text-wrap:pretty}
  .causal-lane{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:var(--space-6);border-block:1px solid var(--charcoal);background:var(--surface-bg)}
  .lane-reading{min-width:0;padding:var(--space-3) var(--space-4);border-right:1px solid var(--border-strong)}
  .lane-reading:last-child{border-right:0}
  .lane-reading>span:first-child{display:block;overflow:hidden;color:var(--text-muted);font-size:var(--text-xs);font-weight:700;text-overflow:ellipsis;white-space:nowrap}
  .lane-reading strong{display:block;margin-top:var(--space-1);font:700 var(--text-lg)/1 var(--font-display);font-feature-settings:"tnum"}
  .lane-meter{display:block;height:5px;margin-top:var(--space-3);background:var(--neutral-200)}
  .lane-meter i{display:block;width:var(--meter);height:100%;background:var(--state-success)}
  .lane-baseline .lane-meter i,.lane-sham .lane-meter i{background:var(--neutral-700)}
  .lane-control .lane-meter i{background:var(--signal)}
  .decision-register{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--charcoal)}
  .decision-item{min-width:0;min-height:78px;padding:var(--space-3) var(--space-4);border-right:1px solid var(--border-strong)}
  .decision-item:last-child{border-right:0}
  .decision-item span{display:block;color:var(--text-muted);font-size:var(--text-xs);font-weight:700}
  .decision-item strong{display:block;margin-top:var(--space-2);font-size:var(--text-sm);line-height:1.25}
  .decision-item.state-success strong{color:var(--state-success)}
  .decision-item.state-failure strong{color:var(--state-failure)}
  .decision-item.state-warning strong{color:var(--state-warning)}
  .limitation{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--space-4);align-items:start;margin-top:var(--space-4);padding:var(--space-3) var(--space-4);border-left:4px solid var(--state-warning);background:var(--state-warning-soft)}
  .limitation strong{color:var(--state-warning);font-size:var(--text-sm)}
  .limitation span{color:var(--text-secondary);font-size:var(--text-sm)}
  .canary-decision-boundary{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);margin-top:var(--space-3);padding:var(--space-3) var(--space-4);border:1px solid var(--border-strong);background:var(--surface-primary)}
  .canary-decision-boundary span{display:grid;gap:var(--space-1)}
  .canary-decision-boundary strong{font-size:var(--text-sm)}
  .canary-decision-boundary small{color:var(--text-muted);font-size:var(--text-xs)}
  .stage-main.is-blocked .paired-score{border-right-color:var(--state-failure)}
  .stage-main.is-blocked .paired-score small,.stage-main.is-blocked .verdict-copy .eyebrow{color:var(--state-failure)}
  .blocker-record{margin-top:var(--space-4);border:1px solid var(--state-failure);background:var(--state-failure-soft)}
  .blocker-record>header{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:48px;padding:var(--space-2) var(--space-4);border-bottom:1px solid var(--state-failure-line)}
  .blocker-record>header span{color:var(--state-failure);font-size:var(--text-xs);font-weight:700;text-transform:uppercase}
  .blocker-record>header strong{color:var(--state-failure)}
  .blocker-reasons{display:grid;grid-template-columns:180px minmax(0,1fr);gap:var(--space-3);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--state-failure-line)}
  .blocker-reasons>span{color:var(--text-secondary);font-size:var(--text-xs);font-weight:700}
  .blocker-reasons>div{display:flex;flex-wrap:wrap;gap:var(--space-2)}
  .blocker-reasons code{padding:var(--space-1) var(--space-2);border:1px solid var(--state-failure-line);background:var(--surface-primary);color:var(--state-failure);font-size:.6875rem}
  .blocker-record>footer{display:grid;grid-template-columns:180px minmax(0,1fr);gap:var(--space-3);padding:var(--space-3) var(--space-4)}
  .blocker-record>footer strong{font-size:var(--text-sm)}
  .blocker-record>footer span{color:var(--text-secondary);font-size:var(--text-sm)}
  .verification-spine{display:flex;min-width:0;flex-direction:column;padding:var(--space-5);background:var(--surface-inverse);color:var(--text-inverse)}
  .spine-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-3)}
  .spine-head .eyebrow{color:var(--text-inverse-muted)}
  .spine-head h2{margin:var(--space-1) 0 0;font:700 var(--text-lg)/1.05 var(--font-display)}
  .gate-score{display:grid;justify-items:end;white-space:nowrap}
  .gate-score strong{font:700 var(--text-xl)/1 var(--font-display)}
  .gate-score small{color:var(--text-inverse-muted);font-size:var(--text-xs)}
  .gate-list{display:grid;list-style:none;margin:var(--space-4) 0 0;padding:0;border-top:1px solid var(--neutral-700)}
  .gate{display:grid;grid-template-columns:28px 10px minmax(0,1fr);gap:var(--space-2);align-items:center;min-height:48px;border-bottom:1px solid var(--neutral-700)}
  .gate-index{color:var(--text-inverse-muted);font-size:var(--text-xs)}
  .gate-copy{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-width:0}
  .gate-copy small{overflow:hidden;color:var(--text-inverse-muted);font-size:var(--text-xs);text-overflow:ellipsis;white-space:nowrap}
  .gate-copy strong{font-family:var(--font-mono);font-size:var(--text-xs)}
  .state-mark{width:10px;height:10px;border:2px solid var(--border-strong);border-radius:var(--radius-xs);background:transparent}
  .state-success .state-mark{border-color:var(--emerald-line);background:var(--emerald-line)}
  .state-failure .state-mark{border-color:var(--red-line);background:var(--red-line)}
  .state-warning .state-mark{border-color:var(--amber-line);background:var(--amber-line)}
  .proof-register{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin-top:var(--space-4);border:1px solid var(--neutral-700)}
  .proof-reading{min-width:0;padding:var(--space-2) var(--space-3);border-right:1px solid var(--neutral-700);border-bottom:1px solid var(--neutral-700)}
  .proof-reading:nth-child(2n){border-right:0}
  .proof-reading:nth-last-child(-n+2){border-bottom:0}
  .proof-reading span{display:block;color:var(--text-inverse-muted);font-size:var(--text-xs)}
  .proof-reading strong{display:block;margin-top:var(--space-1);overflow:hidden;color:var(--text-inverse);font-size:var(--text-sm);text-overflow:ellipsis;white-space:nowrap}
  .proof-reading.state-success strong{color:var(--emerald-line)}
  .proof-reading.state-failure strong{color:var(--red-line)}
  .proof-reading.state-warning strong{color:var(--amber-line)}
  .spine-note{margin:auto 0 0;padding-top:var(--space-4);color:var(--text-inverse-muted);font-size:var(--text-xs)}
  .comparison-band{border-bottom:1px solid var(--border-subtle);background:var(--surface-primary)}
  .section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-5);padding:var(--space-5) 0 var(--space-4)}
  .section-head h2{margin:var(--space-1) 0 0;font-size:var(--text-lg);line-height:1.2}
  .section-head p{max-width:66ch;margin:0;color:var(--text-secondary);font-size:var(--text-sm)}
  dt{color:var(--text-muted);font-size:var(--text-xs);font-weight:700;text-transform:uppercase}
  dd{margin:var(--space-1) 0 0;overflow-wrap:anywhere}
  .matrix-shell{border:1px solid var(--charcoal);border-bottom:0}
  .causal-matrix{width:100%;table-layout:fixed;border-collapse:collapse}
  .causal-matrix th,.causal-matrix td{white-space:normal}
  .causal-matrix thead th{padding:var(--space-3) var(--space-4);border-right:1px solid var(--border-strong);border-bottom:1px solid var(--charcoal);background:var(--surface-bg);text-align:left}
  .causal-matrix thead th:last-child{border-right:0}
  .causal-matrix thead th:first-child{width:76px;color:var(--text-muted);font-size:var(--text-xs)}
  .causal-matrix thead span,.causal-matrix thead small{display:block;color:var(--text-muted);font-size:var(--text-xs)}
  .causal-matrix thead strong{display:block;margin-top:var(--space-1);font:700 var(--text-lg)/1 var(--font-display)}
  .causal-matrix tbody tr{border-bottom:1px solid var(--border-strong)}
  .causal-matrix tbody tr:hover{background:var(--signal-soft)}
  .matrix-replicate{padding:var(--space-3);border-right:1px solid var(--charcoal);background:var(--surface-bg);text-align:center}
  .matrix-replicate span{display:block;color:var(--text-muted);font-size:.625rem}
  .matrix-replicate strong{display:block;margin-top:var(--space-1);font-size:var(--text-md)}
  .matrix-cell{padding:var(--space-3) var(--space-4);border-right:1px solid var(--border-strong);vertical-align:top}
  .matrix-cell:last-child{border-right:0}
  .matrix-cell.is-empty{vertical-align:middle}
  .matrix-reading{display:grid;gap:var(--space-1)}
  .matrix-reading+.matrix-reading{margin-top:var(--space-2)}
  .matrix-reading>span:first-child{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2)}
  .matrix-reading small,.matrix-token small{color:var(--text-muted);font-size:var(--text-xs)}
  .matrix-reading strong,.matrix-token strong{font-family:var(--font-mono);font-size:var(--text-xs)}
  .meter{display:block;height:5px;background:var(--neutral-200)}
  .meter i{display:block;width:var(--meter);height:100%;background:var(--state-success)}
  .control-meter i{background:var(--signal)}
  .matrix-token{position:relative;display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2);margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--border-subtle);overflow:hidden}
  .matrix-token i{position:absolute;right:0;bottom:0;left:0;width:var(--meter);height:2px;background:var(--state-warning)}
  .empty-reading{color:var(--text-muted);font-size:var(--text-sm)}
  .empty-state{margin:0;padding:var(--space-5);color:var(--text-muted);font-size:var(--text-sm)}
  .failure-band{border-bottom:1px solid var(--border-subtle);background:var(--surface-bg)}
  .failure-sheet{margin-bottom:var(--space-6);border:1px solid var(--state-failure);background:var(--surface-primary)}
  .failure-record{border-bottom:1px solid var(--border-strong)}
  .failure-record:last-child{border-bottom:0}
  .failure-record>header{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:var(--space-3);align-items:center;min-height:64px;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--border-subtle);background:var(--state-failure-soft)}
  .failure-record>header span{display:grid}
  .failure-record>header small{color:var(--state-failure);font-size:var(--text-xs);text-transform:uppercase}
  .failure-record>header strong{font-size:var(--text-sm)}
  .failure-index{color:var(--state-failure)}
  .failure-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3);margin:0;padding:var(--space-4);border-bottom:1px solid var(--border-subtle)}
  .failure-meta div{min-width:0}
  .failure-meta dd{font-size:var(--text-sm)}
  .failure-streams{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0;border-bottom:1px solid var(--border-subtle)}
  .failure-stream{min-width:0;padding:var(--space-4);border-right:1px solid var(--border-subtle)}
  .failure-stream:last-child{border-right:0}
  .failure-stream dd{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:var(--space-3);align-items:center}
  .failure-stream code{overflow-wrap:anywhere;font-size:var(--text-xs)}
  .failure-stream span{color:var(--text-muted);font-size:var(--text-xs);white-space:nowrap}
  .failure-stream .mono{grid-column:1/-1;white-space:normal}
  .failure-reasons{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;padding:var(--space-3) var(--space-4)}
  .failure-reasons>span:first-child{margin-right:var(--space-2);color:var(--text-muted);font-size:var(--text-xs);font-weight:700}
  .failure-reasons code{padding:var(--space-1) var(--space-2);border:1px solid var(--state-failure-line);color:var(--state-failure);font-size:.6875rem}
  .diagnostic-empty{display:grid;gap:var(--space-2);padding:var(--space-5)}
  .diagnostic-empty strong{color:var(--state-failure)}
  .diagnostic-empty span{color:var(--text-secondary)}
  .content-band{border-bottom:1px solid var(--border-subtle)}
  .breakdown-sheet{margin-bottom:var(--space-6);border:1px solid var(--charcoal);background:var(--surface-primary)}
  .breakdown-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
  .breakdown-panel{min-width:0;padding:var(--space-4)}
  .breakdown-panel:first-child{border-right:1px solid var(--charcoal)}
  .breakdown-panel header{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-3);padding-bottom:var(--space-3);border-bottom:1px solid var(--border-strong)}
  .breakdown-panel h3{margin:0;font:700 var(--text-md)/1.1 var(--font-display)}
  .breakdown-panel header span{color:var(--text-muted);font-size:var(--text-xs)}
  .breakdown-row{display:grid;grid-template-columns:90px minmax(80px,1fr) 68px 126px;gap:var(--space-3);align-items:center;min-height:54px;border-bottom:1px solid var(--border-subtle)}
  .breakdown-row:last-child{border-bottom:0}
  .breakdown-row>span:first-child{font-weight:700}
  .breakdown-row strong{text-align:right}
  .breakdown-row small{color:var(--text-muted);text-align:right}
  .breakdown-meter{display:block;height:7px;background:var(--neutral-200)}
  .breakdown-meter i{display:block;width:var(--meter);height:100%;background:var(--state-success)}
  .breakdown-meter.control-meter i{background:var(--signal)}
  .token-register{display:grid;grid-template-columns:180px repeat(3,minmax(0,1fr));border-top:1px solid var(--charcoal);background:var(--surface-bg)}
  .token-register>header{padding:var(--space-4);border-right:1px solid var(--border-strong)}
  .token-register h3{margin:0;font-size:var(--text-sm)}
  .token-register p{margin:var(--space-1) 0 0;color:var(--text-muted);font-size:var(--text-xs)}
  .token-register>div{display:grid;align-content:center;min-width:0;padding:var(--space-3) var(--space-4);border-right:1px solid var(--border-strong)}
  .token-register>div:last-child{border-right:0}
  .token-register span,.token-register small{color:var(--text-muted);font-size:var(--text-xs)}
  .token-register strong{margin-top:var(--space-1);font-size:var(--text-md)}
  .audit-sheet{margin-bottom:var(--space-6);border:1px solid var(--charcoal);background:var(--surface-primary)}
  .audit-head{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-5);padding:var(--space-4);border-bottom:1px solid var(--charcoal)}
  .audit-head h2{margin:0;font-size:var(--text-md)}
  .audit-head p{max-width:62ch;margin:0;color:var(--text-muted);font-size:var(--text-sm)}
  .audit-gates{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));list-style:none;margin:0;padding:0;border-bottom:1px solid var(--charcoal)}
  .audit-gates .gate{grid-template-columns:24px 10px minmax(0,1fr);min-height:70px;padding:var(--space-3);border-right:1px solid var(--border-strong);border-bottom:0}
  .audit-gates .gate:last-child{border-right:0}
  .audit-gates .gate-index,.audit-gates .gate-copy small{color:var(--text-muted)}
  .audit-gates .gate-copy{align-items:flex-start;flex-direction:column;justify-content:center}
  .audit-gates .gate-copy strong{color:var(--text-primary)}
  .audit-gates .state-success .state-mark{border-color:var(--state-success);background:var(--state-success)}
  .audit-gates .state-failure .state-mark{border-color:var(--state-failure);background:var(--state-failure)}
  .audit-gates .state-warning .state-mark{border-color:var(--state-warning);background:var(--state-warning)}
  .hash-register-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-4);padding:var(--space-4);border-bottom:1px solid var(--border-strong)}
  .hash-register-head h3{margin:0;font:700 var(--text-md)/1.1 var(--font-display)}
  .hash-register-head span{color:var(--text-muted);font-size:var(--text-xs)}
  .hash-list{display:grid}
  .hash-row{display:grid;grid-template-columns:32px minmax(150px,.32fr) minmax(0,1fr) 64px;gap:var(--space-3);align-items:center;min-height:58px;padding:var(--space-2) var(--space-4);border-bottom:1px solid var(--border-subtle)}
  .hash-row:last-child{border-bottom:0}
  .hash-index{color:var(--text-muted);font-size:var(--text-xs)}
  .hash-label{display:grid}
  .hash-label small{color:var(--text-muted)}
  .hash-row code{overflow-wrap:anywhere;color:var(--text-secondary);font-size:var(--text-xs)}
  .copy-button{min-width:44px;min-height:44px;padding:0 var(--space-2);border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface-primary);color:var(--signal);font-size:var(--text-xs);font-weight:700;cursor:pointer}
  .copy-button:hover{border-color:var(--signal);background:var(--signal-soft)}
  .copy-button:active{background:var(--surface-muted)}
  .contract-disclosure{border-top:1px solid var(--charcoal)}
  .contract-disclosure summary{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:56px;padding:var(--space-2) var(--space-4);cursor:pointer;font-weight:700;list-style:none}
  .contract-disclosure summary::-webkit-details-marker{display:none}
  .contract-disclosure summary span{color:var(--text-muted);font-size:var(--text-xs);font-weight:400}
  .contract-disclosure[open] summary{background:var(--surface-bg)}
  .ledger-band{padding-block:var(--space-5) var(--space-7)}
  .ledger-toolbar{display:flex;align-items:end;justify-content:space-between;gap:var(--space-4);padding:var(--space-4);border:1px solid var(--border-strong);border-bottom:0;background:var(--surface-bg)}
  .filter-group{display:flex;flex-wrap:wrap;gap:var(--space-3)}
  .field{display:grid;gap:var(--space-1);color:var(--text-secondary);font-size:var(--text-xs);font-weight:700}
  select{min-width:160px;min-height:44px;padding:0 38px 0 var(--space-3);border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface-primary);color:var(--text-primary)}
  .ledger-count{color:var(--text-muted);font-size:var(--text-sm)}
  .ledger-list{border:1px solid var(--border-strong);background:var(--surface-primary)}
  .ledger-columns,.ledger-item summary{display:grid;grid-template-columns:32px minmax(240px,1.25fr) 82px 82px 92px 82px 82px;gap:var(--space-3);align-items:center}
  .ledger-columns{min-height:38px;padding:0 var(--space-4);border-bottom:1px solid var(--charcoal);background:var(--charcoal);color:var(--text-inverse-muted);font-size:var(--text-xs);font-weight:700}
  .ledger-columns span:nth-child(n+3){text-align:right}
  .ledger-item{margin:0;border-bottom:1px solid var(--border-subtle)}
  .ledger-item:last-of-type{border-bottom:0}
  .ledger-item[hidden]{display:none}
  .ledger-item summary{min-height:62px;padding:var(--space-2) var(--space-4);cursor:pointer;list-style:none}
  .ledger-item summary::-webkit-details-marker{display:none}
  .ledger-item summary:hover{background:var(--signal-soft)}
  .ledger-item[open] summary{box-shadow:inset 4px 0 0 var(--signal);background:var(--signal-soft)}
  .receipt-index{color:var(--text-muted);font-size:var(--text-xs)}
  .ledger-title{display:grid;grid-template-columns:12px minmax(0,1fr);column-gap:var(--space-3);min-width:0}
  .ledger-title .state-mark{grid-row:1/3}
  .ledger-title strong{overflow-wrap:anywhere}
  .ledger-title small{color:var(--text-muted);font-family:var(--font-mono);font-size:var(--text-xs);overflow-wrap:anywhere}
  .ledger-reading,.ledger-status{display:grid;justify-items:end;min-width:0}
  .ledger-reading small,.ledger-status small{display:none;color:var(--text-muted);font-size:.625rem}
  .ledger-reading strong,.ledger-status strong{overflow:hidden;font-size:var(--text-xs);text-overflow:ellipsis;white-space:nowrap}
  .ledger-status strong{color:var(--text-primary)}
  .receipt-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3);margin:0;padding:var(--space-4);border-top:1px solid var(--border-subtle);background:var(--surface-bg)}
  .receipt-grid div{min-width:0}
  .receipt-grid .wide{grid-column:span 2}
  .receipt-grid code{display:block;overflow-wrap:anywhere;font-size:var(--text-xs)}
  .promotion-lock{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);margin-top:var(--space-5);padding:var(--space-4);border:1px solid var(--border-strong);background:var(--surface-primary)}
  .promotion-lock strong{display:block}
  .promotion-lock span{color:var(--text-muted);font-size:var(--text-sm)}
  footer{padding:var(--space-5);border-top:1px solid var(--border-strong);background:var(--surface-inverse);color:var(--text-inverse-muted);font-size:var(--text-sm)}
  footer .band-inner{display:flex;justify-content:space-between;gap:var(--space-4);padding-inline:0}
  .sr-live{position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden}
  @media (max-width:1180px){
    .stage-main{padding:var(--space-5)}
    .paired-score{min-width:150px;padding-right:var(--space-5)}
    .paired-score strong{font-size:5.5rem}
    .breakdown-row{grid-template-columns:82px minmax(64px,1fr) 64px 110px;gap:var(--space-2)}
    .ledger-columns,.ledger-item summary{grid-template-columns:28px minmax(200px,1.1fr) 72px 72px 84px 72px 78px;gap:var(--space-2)}
  }
  @media (max-width:900px){
    .stage-shell{grid-template-columns:1fr}
    .stage-main{border-right:0;border-bottom:1px solid var(--charcoal)}
    .verification-spine{padding:var(--space-4)}
    .verification-spine .gate-list{grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--neutral-700)}
    .verification-spine .gate{grid-template-columns:10px minmax(0,1fr);align-content:center;min-height:68px;padding:var(--space-2);border-right:1px solid var(--neutral-700);border-bottom:0}
    .verification-spine .gate:last-child{border-right:0}
    .verification-spine .gate-index{display:none}
    .verification-spine .gate-copy{display:grid;align-content:center;justify-content:stretch}
    .verification-spine .gate-copy small{white-space:normal}
    .proof-register{grid-template-columns:repeat(4,minmax(0,1fr))}
    .proof-reading:nth-child(2n){border-right:1px solid var(--neutral-700)}
    .proof-reading:nth-child(4n){border-right:0}
    .proof-reading:nth-last-child(-n+4){border-bottom:0}
    .spine-note{margin-top:var(--space-3)}
    .breakdown-columns{grid-template-columns:1fr}
    .breakdown-panel:first-child{border-right:0;border-bottom:1px solid var(--charcoal)}
    .audit-gates{grid-template-columns:repeat(2,minmax(0,1fr))}
    .audit-gates .gate{border-bottom:1px solid var(--border-strong)}
    .audit-gates .gate:nth-child(2n){border-right:0}
    .audit-gates .gate:last-child{grid-column:1/-1;border-bottom:0}
    .ledger-columns{display:none}
  }
  @media (max-width:760px){
    .topbar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;padding-inline:var(--space-4)}
    .run-meta{display:contents}
    .run-facts{grid-column:1/-1;grid-row:2;display:grid;grid-template-columns:minmax(0,1fr) auto auto;width:100%;gap:var(--space-3);padding-top:var(--space-2);border-top:1px solid var(--neutral-700)}
    .connection{grid-column:2;grid-row:1}
    .band-inner{padding-inline:var(--space-4)}
    .stage-shell{padding-inline:0}
    .stage-main{padding:var(--space-4)}
    .stage-header{grid-template-columns:88px minmax(0,1fr);gap:var(--space-4)}
    .paired-score{min-width:0;padding-right:var(--space-3);border-right-width:3px}
    .paired-score strong{font-size:4.5rem}
    .paired-score small{margin-top:var(--space-2);font-size:.6875rem}
    .verdict-copy h1{font-size:1.5rem}
    .verdict-copy>p{font-size:var(--text-base)}
    .causal-lane{margin-top:var(--space-4)}
    .lane-reading{padding:var(--space-2)}
    .lane-reading>span:first-child{font-size:.625rem;white-space:normal}
    .lane-reading strong{font-size:var(--text-md)}
    .lane-meter{margin-top:var(--space-2)}
    .decision-item{min-height:68px;padding:var(--space-2)}
    .decision-item span{font-size:.625rem}
    .decision-item strong{margin-top:var(--space-1);font-size:.75rem}
    .limitation{gap:var(--space-2);margin-top:var(--space-3);padding:var(--space-2) var(--space-3)}
    .blocker-reasons,.blocker-record>footer{grid-template-columns:1fr;gap:var(--space-2)}
    .blocker-record>header{align-items:flex-start;flex-direction:column}
    .verification-spine{padding:var(--space-3) var(--space-4) var(--space-4)}
    .spine-head h2{font-size:var(--text-md)}
    .gate-score strong{font-size:var(--text-lg)}
    .verification-spine .gate-list{margin-top:var(--space-3)}
    .verification-spine .gate{min-height:62px;padding:var(--space-2) var(--space-1)}
    .verification-spine .gate-copy small,.verification-spine .gate-copy strong{font-size:.625rem}
    .proof-register{margin-top:var(--space-3)}
    .proof-reading{padding:var(--space-2)}
    .proof-reading span{font-size:.625rem}
    .proof-reading strong{font-size:.75rem}
    .spine-note{display:none}
    .section-head{align-items:flex-start;flex-direction:column}
    .section-head p{font-size:var(--text-base)}
    .causal-matrix thead th{padding:var(--space-2)}
    .causal-matrix thead th:first-child{width:42px}
    .causal-matrix thead strong{font-size:var(--text-md)}
    .causal-matrix thead span,.causal-matrix thead small{font-size:.625rem}
    .matrix-replicate{padding:var(--space-2) var(--space-1)}
    .matrix-replicate span{display:none}
    .matrix-replicate strong{font-size:var(--text-sm)}
    .matrix-cell{padding:var(--space-2)}
    .matrix-reading small,.matrix-token small{font-size:.625rem}
    .matrix-reading strong,.matrix-token strong{font-size:.6875rem}
    .failure-meta{grid-template-columns:1fr 1fr}
    .failure-streams{grid-template-columns:1fr}
    .failure-stream{border-right:0;border-bottom:1px solid var(--border-subtle)}
    .failure-stream:last-child{border-bottom:0}
    .failure-stream dd{grid-template-columns:1fr auto}
    .failure-stream code{grid-column:1/-1}
    .breakdown-row{grid-template-columns:72px minmax(52px,1fr) 60px;min-height:52px}
    .breakdown-row small{display:none}
    .token-register{grid-template-columns:1fr}
    .token-register>header{border-right:0;border-bottom:1px solid var(--border-strong)}
    .token-register>div{grid-template-columns:1fr auto auto;gap:var(--space-3);border-right:0;border-bottom:1px solid var(--border-strong)}
    .token-register>div:last-child{border-bottom:0}
    .audit-head{align-items:flex-start;flex-direction:column}
    .audit-gates{grid-template-columns:1fr}
    .audit-gates .gate,.audit-gates .gate:nth-child(2n),.audit-gates .gate:last-child{grid-column:auto;border-right:0;border-bottom:1px solid var(--border-strong)}
    .audit-gates .gate:last-child{border-bottom:0}
    .hash-row{grid-template-columns:28px minmax(0,1fr) 56px;gap:var(--space-2)}
    .hash-row code{grid-column:2/4}
    .copy-button{grid-column:3;grid-row:1}
    .ledger-toolbar{align-items:stretch;flex-direction:column}
    .filter-group{display:grid;grid-template-columns:1fr 1fr}
    select{width:100%;min-width:0}
    .ledger-item summary{grid-template-columns:28px repeat(4,minmax(0,1fr));gap:var(--space-2);align-items:start;padding:var(--space-3)}
    .receipt-index{grid-column:1;grid-row:1/3}
    .ledger-title{grid-column:2/5;grid-row:1}
    .ledger-status{grid-column:5;grid-row:1}
    .ledger-reading{grid-row:2;justify-items:start}
    .ledger-reading small,.ledger-status small{display:block}
    .ledger-reading strong,.ledger-status strong{max-width:100%}
    .receipt-grid{grid-template-columns:1fr 1fr}
    .receipt-grid .wide{grid-column:1/-1}
    .promotion-lock{align-items:flex-start;flex-direction:column}
    .promotion-lock .button{width:100%}
    .canary-decision-boundary{align-items:flex-start;flex-direction:column}
    footer .band-inner{flex-direction:column}
  }
  @media (max-width:390px){
    .product-copy span{display:none}
    .run-fact:first-child strong{max-width:16ch}
    .connection{padding-inline:var(--space-2)}
    .stage-main{padding:var(--space-3)}
    .stage-header{grid-template-columns:78px minmax(0,1fr);gap:var(--space-3)}
    .paired-score strong{font-size:3.9rem}
    .verdict-copy h1{font-size:1.35rem}
    .decision-item{min-height:64px}
    .limitation{grid-template-columns:1fr}
    .failure-record>header{grid-template-columns:24px minmax(0,1fr)}
    .failure-record>header>strong:last-child{grid-column:2}
    .failure-meta{grid-template-columns:1fr}
    .failure-stream dd{grid-template-columns:1fr}
    .failure-stream span{white-space:normal}
    .causal-matrix thead strong{font-size:var(--text-base)}
    .matrix-cell{padding-inline:var(--space-1)}
    .filter-group{grid-template-columns:1fr 1fr}
    .receipt-grid{grid-template-columns:1fr}
  }
  @media (prefers-reduced-motion:reduce){
    html{scroll-behavior:auto}
    *,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}
  }
</style>
</head>
<body data-canary-console aria-busy="true">
  <a class="skip-link" href="#main">Skip to experiment verdict</a>
  <header class="topbar">
    <div class="product">
      <span class="product-mark" aria-hidden="true">LF</span>
      <span class="product-copy"><strong>Loop Factory</strong><span>Campaign Console</span></span>
    </div>
    <div class="run-meta">
      <div class="run-facts">
        <span class="run-fact"><span>Run</span><strong class="mono" title="${escapeHtml(view.run.id)}">${escapeHtml(view.run.id)}</strong></span>
        <span class="run-fact"><span>Model</span><strong class="mono">${displayValue(view.run.model)}</strong></span>
        <span class="run-fact"><span>Status</span><strong>${displayValue(view.run.status)}</strong></span>
      </div>
      <span id="connection" class="connection">loading</span>
    </div>
  </header>
  <div id="pollAlert" class="poll-alert" role="alert" hidden>
    <span id="pollMessage">Live state is reconnecting. The last verified snapshot remains visible.</span>
    <button id="retryPoll" class="button" type="button">Retry</button>
  </div>

  <main id="main">
    <section class="evidence-stage state-${verdictTone}" aria-labelledby="verdict-title" data-evidence-stage>
      <div class="band-inner stage-shell">
        <div class="stage-main${blocked.active ? ' is-blocked' : ''}">
          <div class="stage-header">
            <div class="paired-score" aria-label="${canary.proof.pairedTargetWins}/${expectedReplicates} paired wins">
              <strong>${canary.proof.pairedTargetWins}<span>/${expectedReplicates}</span></strong>
              <small>${canary.proof.pairedTargetWins} of ${expectedReplicates} paired wins</small>
            </div>
            <div class="verdict-copy">
              <span class="eyebrow">Independent canary verdict</span>
              <h1 id="verdict-title">${escapeHtml(canary.verdict.headline)}</h1>
              <p>${escapeHtml(canary.verdict.qualifier)}</p>
            </div>
          </div>
          <div class="causal-lane" aria-label="Causal lane">${laneItems}</div>
          <div class="decision-register" aria-label="Decisive experiment answers">
            <div class="decision-item state-${canary.verdict.causalMovement ? 'success' : 'failure'}"><span>Causal result</span><strong>${escapeHtml(causalAnswer)}</strong></div>
            <div class="decision-item state-${canary.verdict.experimentValid ? 'success' : 'failure'}"><span>Independent validity</span><strong>${escapeHtml(validityAnswer)}</strong></div>
            <div class="decision-item state-${canary.verdict.shamMoved ? 'failure' : 'success'}"><span>Sham behavior</span><strong>${escapeHtml(shamAnswer)}</strong></div>
            <div class="decision-item state-${canary.verdict.controlsRegressed ? 'failure' : 'success'}"><span>Protected controls</span><strong>${escapeHtml(controlAnswer)}</strong></div>
            <div class="decision-item state-${canary.verdict.promoted ? 'failure' : 'neutral'}"><span>Promotion state</span><strong>${escapeHtml(promotionAnswer)}</strong></div>
          </div>
          <div class="limitation">
            <strong>Honest limitation</strong>
            <span>${escapeHtml(canary.verdict.limitation)}</span>
          </div>
          <div class="canary-decision-boundary" data-decision-boundary>
            <span>
              <strong>No approval action is available for this canary.</strong>
              <small>Promotion is disabled by the sealed experiment contract. This surface reports evidence; it cannot approve, deny, publish, or modify a loop.</small>
            </span>
            <span class="status neutral">Evidence only</span>
          </div>
          ${blockerMarkup}
        </div>
        <aside class="verification-spine" aria-labelledby="spine-title" data-verification-spine>
          <div class="spine-head">
            <div><span class="eyebrow">Machine proof</span><h2 id="spine-title">Verification spine</h2></div>
            <span class="gate-score"><strong>${escapeHtml(canary.proof.reportedOutcomeStatus)}</strong><small>${gatePassCount}/${canary.gates.length} gates</small></span>
          </div>
          <ol class="gate-list">${gatesMarkup}</ol>
          <div class="proof-register">${proofRegisterMarkup}</div>
          <p class="spine-note">${canary.proof.validReceipts} valid receipts / ${canary.proof.retryCount} retries. Promotion is ${canary.proof.promotionRecorded ? 'recorded' : 'disabled'}.</p>
        </aside>
      </div>
    </section>

    ${failureSectionMarkup}

    <section class="comparison-band" aria-labelledby="comparison-title">
      <div class="band-inner">
        <header class="section-head">
          <div><span class="eyebrow">Paired evidence</span><h2 id="comparison-title">Five replicates, read across</h2></div>
          <p>Each row keeps baseline, challenger, and sham together. Every bar is directly proportional to persisted target quality, protected-control quality, or relative token cost.</p>
        </header>
        <div class="matrix-shell" data-causal-matrix>
          <table class="causal-matrix">
            <thead><tr><th scope="col">Pair</th>${causalArmHeadings}</tr></thead>
            <tbody>${causalRows}</tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="content-band">
      <div class="band-inner">
        <header class="section-head">
          <div><span class="eyebrow">Signal separation</span><h2 id="breakdown-title">Target versus control</h2></div>
          <p>Target movement and control preservation are shown on separate scales. Means, deltas, and token costs are re-derived from public replicate measurements.</p>
        </header>
        <section class="breakdown-sheet" aria-labelledby="breakdown-title">
          <div class="breakdown-columns">
            <div class="breakdown-panel">
              <header><h3>Target quality</h3><span>Causal movement</span></header>
              ${breakdownTargetRows}
            </div>
            <div class="breakdown-panel">
              <header><h3>Protected-control quality</h3><span>Regression check</span></header>
              ${breakdownControlRows}
            </div>
          </div>
          <div class="token-register">
            <header><h3>Mean token cost</h3><p>No efficiency claim is inferred.</p></header>
            ${breakdownTokenRows}
          </div>
        </section>
      </div>
    </section>

    <section class="content-band">
      <div class="band-inner">
        <header class="section-head">
          <div><span class="eyebrow">Audit trail</span><h2 id="gates-title">Machine verification gates</h2></div>
          <p>Independent validity is true only when every required gate passes. Public hashes identify evidence without exposing source paths or artifact bodies.</p>
        </header>
        <section class="audit-sheet" aria-labelledby="gates-title">
          <div class="audit-head">
            <h2>${gatePassCount}/${canary.gates.length} gates passed</h2>
            <p>Verifier ${displayValue(canary.proof.verifierStatus)} / isolation ${displayValue(canary.proof.isolationStatus)} / ${canary.proof.validReceipts} of ${canary.proof.callCount} receipts valid.</p>
          </div>
          <ol class="audit-gates">${gatesMarkup}</ol>
          <div class="hash-register-head">
            <h3 id="hashes-title">Evidence hashes</h3>
            <span>Copyable public SHA-256 identities</span>
          </div>
          <div class="hash-list">${hashesMarkup}</div>
          <details class="contract-disclosure">
            <summary id="contract-title">Experiment contract <span>Execution boundary and promotion lock</span></summary>
            <dl class="receipt-grid">
              <div><dt>Mode</dt><dd>real-test canary</dd></div>
              <div><dt>Concealment</dt><dd>${displayValue(canary.contract.concealment)}</dd></div>
              <div><dt>Replicates per arm</dt><dd class="mono">${canary.contract.replicatesPerArm}</dd></div>
              <div><dt>Planned evaluations</dt><dd class="mono">${canary.contract.plannedEvaluations}</dd></div>
              <div><dt>Retries per dispatch</dt><dd class="mono">${canary.contract.retriesPerDispatch}</dd></div>
              <div><dt>Valid receipts</dt><dd class="mono">${canary.proof.validReceipts}/${canary.proof.callCount}</dd></div>
              <div><dt>Promotion enabled</dt><dd>${canary.proof.promotionEnabled ? 'YES' : 'NO'}</dd></div>
              <div><dt>Promotion recorded</dt><dd>${canary.proof.promotionRecorded ? 'YES' : 'NO'}</dd></div>
            </dl>
          </details>
        </section>
      </div>
    </section>

    <section class="band-inner ledger-band" aria-labelledby="ledger-title" data-receipt-explorer>
      <header class="section-head">
        <div><span class="eyebrow">Receipt explorer</span><h2 id="ledger-title">Receipt ledger</h2></div>
        <p>Filter the compact ledger by arm or replicate. Open a row for safe model authority, isolation, token, duration, schema identity, and hash evidence.</p>
      </header>
      <div class="ledger-toolbar">
        <div class="filter-group">
          <label class="field" for="armFilter">Arm
            <select id="armFilter">
              <option value="all">All calls</option>
              <option value="baseline">Baseline</option>
              <option value="challenger">Challenger</option>
              <option value="sham">Sham</option>
              <option value="proposal">Proposal</option>
            </select>
          </label>
          <label class="field" for="replicateFilter">Replicate
            <select id="replicateFilter">
              <option value="all">All replicates</option>
              ${Array.from({ length: canary.contract.replicatesPerArm }, (_, index) => `<option value="${index + 1}">Replicate ${index + 1}</option>`).join('')}
            </select>
          </label>
        </div>
        <span id="ledgerCount" class="ledger-count">${canary.receipts.length} receipt(s)</span>
      </div>
      <div id="ledgerList" class="ledger-list">
        <div class="ledger-columns" data-ledger-column-headings aria-hidden="true">
          <span>No.</span><span>Call</span><span>Target</span><span>Control</span><span>Tokens</span><span>Duration</span><span>Receipt</span>
        </div>
        ${receiptMarkup}
        <p id="ledgerEmpty" class="empty-state" hidden>No evaluation receipts match this filter.</p>
      </div>
      <div class="promotion-lock">
        <span><strong>Promotion disabled</strong><span>This canary can measure and verify; it cannot publish, promote, or modify a loop.</span></span>
        <button type="button" class="button" disabled>Promotion disabled by contract</button>
      </div>
    </section>
  </main>

  <footer>
    <div class="band-inner">
      <span>Snapshot updated <time>${displayValue(view.run.updatedAt)}</time>.</span>
      <span>File-snapshot and live-server modes use the same allowlisted public data.</span>
    </div>
  </footer>
  <div id="live" class="sr-live" aria-live="polite"></div>
  <script id="run-data" type="application/json">${dataJson}</script>
  <script>
    (function(){
      'use strict';
      var snapshot=JSON.parse(document.getElementById('run-data').textContent);
      var snapshotSignature=JSON.stringify(snapshot);
      var runId=snapshot.run.id;
      var connection=document.getElementById('connection');
      var pollAlert=document.getElementById('pollAlert');
      var pollMessage=document.getElementById('pollMessage');
      var live=document.getElementById('live');
      var armFilter=document.getElementById('armFilter');
      var replicateFilter=document.getElementById('replicateFilter');
      var ledgerEmpty=document.getElementById('ledgerEmpty');
      var ledgerCount=document.getElementById('ledgerCount');
      var ledgerItems=Array.prototype.slice.call(document.querySelectorAll('.ledger-item'));
      var etag=null;
      var polling=false;
      var timer=null;
      var lastSuccess=Date.now();

      function isFileProtocol(){return location.protocol==='file:';}
      function announce(message){live.textContent=message;}
      function setConnection(label,mode){
        connection.textContent=label;
        connection.className='connection '+(mode||'');
        document.body.setAttribute('aria-busy',label==='loading'?'true':'false');
      }
      function filterLedger(){
        var arm=armFilter.value;
        var replicate=replicateFilter.value;
        var visibleItems=[];
        ledgerItems.forEach(function(item){
          var armMatches=arm==='all'||item.getAttribute('data-ledger-arm')===arm;
          var replicateMatches=replicate==='all'||item.getAttribute('data-ledger-replicate')===replicate;
          var visible=armMatches&&replicateMatches;
          item.hidden=!visible;
          if(visible) visibleItems.push(item);
        });
        if(visibleItems.length&&!visibleItems.some(function(item){return item.open;})) visibleItems[0].open=true;
        ledgerEmpty.hidden=visibleItems.length!==0;
        ledgerCount.textContent=visibleItems.length+' receipt(s)';
        announce(visibleItems.length+' receipts match the selected filters');
      }
      function finishCopy(button){
        var previous=button.textContent;
        button.textContent='Copied';
        announce('Evidence hash copied');
        window.setTimeout(function(){button.textContent=previous;},1200);
      }
      function fallbackCopy(value,button){
        var input=document.createElement('textarea');
        input.value=value;
        input.setAttribute('readonly','');
        input.style.position='fixed';
        input.style.left='-9999px';
        document.body.appendChild(input);
        input.select();
        try{document.execCommand('copy');finishCopy(button);}catch(error){announce('Hash copy failed');}
        document.body.removeChild(input);
      }
      function copyHash(button){
        var value=button.getAttribute('data-copy-hash')||'';
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(value).then(function(){finishCopy(button);}).catch(function(){fallbackCopy(value,button);});
        }else{
          fallbackCopy(value,button);
        }
      }
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
            lastSuccess=Date.now();
            pollAlert.hidden=true;
            setConnection('live','live');
            if(data&&JSON.stringify(data)!==snapshotSignature) location.reload();
          })
          .catch(function(){
            var stale=Date.now()-lastSuccess>5000;
            pollAlert.hidden=false;
            pollMessage.textContent=stale
              ? 'Stale snapshot: live state is unavailable. The last verified data remains visible.'
              : 'Live state is reconnecting. The last verified snapshot remains visible.';
            setConnection(stale?'stale snapshot':'reconnecting',stale?'stale':'reconnecting');
          })
          .then(function(){polling=false;});
      }
      armFilter.addEventListener('change',filterLedger);
      replicateFilter.addEventListener('change',filterLedger);
      ledgerItems.forEach(function(item){
        item.addEventListener('toggle',function(){
          if(!item.open) return;
          ledgerItems.forEach(function(other){if(other!==item) other.open=false;});
        });
      });
      document.querySelectorAll('[data-copy-hash]').forEach(function(button){
        button.addEventListener('click',function(){copyHash(button);});
      });
      document.getElementById('retryPoll').addEventListener('click',pollRun);
      document.addEventListener('visibilitychange',function(){if(!document.hidden) pollRun();});
      window.addEventListener('online',pollRun);
      filterLedger();
      if(isFileProtocol()){
        setConnection('file snapshot','');
      }else{
        setConnection('loading','reconnecting');
        pollRun();
        timer=setInterval(pollRun,1000);
      }
      window.addEventListener('beforeunload',function(){if(timer) clearInterval(timer);});
    })();
  </script>
</body>
</html>`;
}

export function renderRunSelector(snapshots = []) {
  const runs = [...snapshots]
    .filter((snapshot) => snapshot && snapshot.run && snapshot.run.id)
    .sort((a, b) => String(b.run.updatedAt || '').localeCompare(String(a.run.updatedAt || '')));
  const canaryRuns = runs.filter((snapshot) => snapshot.canary && snapshot.canary.enabled);
  const passingCanaries = canaryRuns.filter((snapshot) => String(snapshot.canary.verdict.status).toUpperCase() === 'PASS');
  const decisionRuns = runs.filter((snapshot) => Number(snapshot.reviews?.pending || 0) > 0);
  const pendingDecisionCount = decisionRuns.reduce((sum, snapshot) => sum + Number(snapshot.reviews.pending || 0), 0);
  const rows = runs.length
    ? runs.map((snapshot, index) => {
        const canary = snapshot.canary && snapshot.canary.enabled ? snapshot.canary : null;
        const pendingDecisions = Number(snapshot.reviews?.pending || 0);
        const approvedDecisions = Number(snapshot.reviews?.approved || 0);
        const deniedDecisions = Number(snapshot.reviews?.sludge || 0);
        const mode = canary ? 'Canary' : (snapshot.realTest && snapshot.realTest.enabled ? 'Strict campaign' : 'Campaign');
        const verdict = canary
          ? canary.verdict.headline
          : (snapshot.realTest && snapshot.realTest.enabled ? snapshot.realTest.status : snapshot.run.status);
        const tone = !canary && pendingDecisions > 0
          ? 'warning'
          : canaryTone(canary ? canary.verdict.status : snapshot.run.status);
        const model = snapshot.run.model || snapshot.policy?.primary;
        const challenger = canary?.arms.find((arm) => arm.role === 'challenger');
        const isBlockedCanary = canary?.blocked?.active === true;
        const pairedProof = canary
          ? (isBlockedCanary
              ? (canary.blocked.code || 'BLOCKED')
              : `${canary.proof.pairedTargetWins}/${canary.contract.replicatesPerArm} paired wins`)
          : (pendingDecisions > 0 ? `${pendingDecisions} pending` : displayValue(snapshot.run.status));
        const secondaryProof = canary
          ? (isBlockedCanary
              ? (canary.blocked.failureEvidenceAvailable ? 'Failure evidence available' : 'Diagnostics unavailable')
              : displayPercent(challenger?.targetMean))
          : (pendingDecisions > 0
              ? 'Decision required'
              : `${approvedDecisions} approved / ${deniedDecisions} denied`);
        const boundaryProof = canary
          ? (canary.proof.promotionRecorded ? 'Promotion recorded' : 'Promotion disabled')
          : (pendingDecisions > 0 ? 'Operator action' : escapeHtml(mode));
        const search = [
          snapshot.run.id,
          mode,
          model,
          snapshot.run.status,
          verdict,
          pairedProof,
          secondaryProof,
          boundaryProof
        ].filter(Boolean).join(' ').toLowerCase();
        return `<a class="run-docket state-${tone}" href="/?run=${encodeURIComponent(snapshot.run.id)}" data-run-row data-search="${escapeHtml(search)}">
          <span class="run-sequence mono">${String(index + 1).padStart(2, '0')}</span>
          <span class="run-primary">
            <span class="run-mode"><span class="state-mark" aria-hidden="true"></span>${escapeHtml(mode)}</span>
            <strong class="mono">${escapeHtml(snapshot.run.id)}</strong>
            <small>${displayValue(verdict)}</small>
          </span>
          <span class="run-model">
            <small>Exact model</small>
            <strong class="mono">${displayValue(model)}</strong>
            <span>${displayValue(snapshot.run.status)}</span>
          </span>
          <span class="run-proof" data-run-proof>
            <span><small>${canary ? (isBlockedCanary ? 'Blocker' : 'Effect') : 'State'}</small><strong>${pairedProof}</strong></span>
            <span><small>${canary ? (isBlockedCanary ? 'Diagnostics' : 'Challenger target') : 'Verdict'}</small><strong>${secondaryProof}</strong></span>
            <span><small>Boundary</small><strong>${boundaryProof}</strong></span>
          </span>
          <span class="run-time"><small>Updated</small><time class="mono">${displayValue(snapshot.run.updatedAt)}</time></span>
          <span class="open-run" aria-hidden="true">Open run</span>
        </a>`;
      }).join('')
    : '<div class="selector-empty"><span class="empty-index mono">00</span><strong>No runs available</strong><span>A public snapshot appears here after its state.json is persisted.</span></div>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loop Factory Campaign Runs</title>
<style>
  :root{
    --neutral-0:#ffffff;
    --neutral-50:#f3f4f0;
    --neutral-100:#e9ebe6;
    --neutral-200:#d5d9d3;
    --neutral-300:#b4bcb5;
    --neutral-500:#65706a;
    --neutral-700:#3c4540;
    --neutral-900:#111713;
    --charcoal:#161c18;
    --emerald:#146247;
    --emerald-soft:#dcefe5;
    --cobalt:#255ec4;
    --cobalt-soft:#e4ebfa;
    --amber:#875b08;
    --red:#963930;
    --bg:var(--neutral-50);
    --surface:var(--neutral-0);
    --surface-muted:var(--neutral-100);
    --ink:var(--neutral-900);
    --ink-soft:var(--neutral-700);
    --muted:var(--neutral-500);
    --line:var(--neutral-200);
    --line-strong:var(--neutral-300);
    --focus:var(--cobalt);
    --font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    --font-display:Georgia,"Times New Roman",serif;
    --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --space-1:4px;
    --space-2:8px;
    --space-3:12px;
    --space-4:16px;
    --space-5:24px;
    --space-6:32px;
    --space-7:40px;
    --radius-sm:4px;
    --container:1360px;
    --duration-fast:150ms;
    --ease-standard:cubic-bezier(.4,0,.2,1);
  }
  *{box-sizing:border-box;letter-spacing:0}
  html{background:var(--bg);color:var(--ink)}
  body{display:flex;min-width:320px;min-height:100vh;flex-direction:column;margin:0;overflow-x:clip;background:var(--bg);font:400 16px/1.5 var(--font-ui)}
  .mono{font-family:var(--font-mono);font-feature-settings:"tnum"}
  .skip-link{position:fixed;z-index:1000;top:-80px;left:var(--space-4);min-height:44px;padding:var(--space-3) var(--space-4);border:2px solid var(--focus);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink)}
  .skip-link:focus{top:var(--space-4)}
  :focus-visible{outline:3px solid var(--focus);outline-offset:3px}
  .selector-top{border-top:3px solid var(--cobalt);border-bottom:1px solid var(--neutral-700);background:var(--charcoal);color:var(--surface)}
  .selector-top>div{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);width:min(var(--container),100%);min-height:64px;margin:0 auto;padding:var(--space-2) var(--space-5)}
  .selector-brand{display:flex;align-items:center;gap:var(--space-3)}
  .selector-mark{display:grid;width:36px;height:36px;place-items:center;border:1px solid var(--emerald-soft);border-radius:var(--radius-sm);background:var(--emerald);font-weight:700}
  .selector-brand span{display:grid;line-height:1.2}
  .selector-brand small{color:var(--line-strong)}
  .local-state{font-size:.875rem;color:var(--line-strong)}
  main{width:min(var(--container),100%);flex:1;margin:0 auto;padding:0 var(--space-5) var(--space-7)}
  .selector-intro{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-6);align-items:end;padding:var(--space-7) 0 var(--space-5);border-bottom:1px solid var(--charcoal)}
  .selector-kicker{display:block;color:var(--emerald);font-size:.75rem;font-weight:700;text-transform:uppercase}
  .selector-intro h1{max-width:18ch;margin:var(--space-2) 0 0;font:700 2.5rem/1.05 var(--font-display);text-wrap:balance}
  .selector-intro p{max-width:62ch;margin:var(--space-3) 0 0;color:var(--ink-soft)}
  .selector-count{display:grid;justify-items:end;min-width:180px}
  .selector-count strong{font:700 4rem/.9 var(--font-display);font-feature-settings:"tnum"}
  .selector-count span{margin-top:var(--space-2);color:var(--muted);font-size:.75rem;font-weight:700;text-transform:uppercase}
  .selector-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-inline:1px solid var(--charcoal);border-bottom:1px solid var(--charcoal);background:var(--surface)}
  .overview-reading{min-width:0;padding:var(--space-3) var(--space-4);border-right:1px solid var(--line-strong)}
  .overview-reading:last-child{border-right:0}
  .overview-reading span{display:block;color:var(--muted);font-size:.75rem}
  .overview-reading strong{display:block;margin-top:var(--space-1);overflow:hidden;font-size:1.125rem;text-overflow:ellipsis;white-space:nowrap}
  .selector-controls{display:flex;align-items:end;justify-content:space-between;gap:var(--space-5);padding:var(--space-5) 0 var(--space-3)}
  .selector-controls h2{margin:0;font-size:1rem}
  .selector-controls p{margin:var(--space-1) 0 0;color:var(--muted);font-size:.875rem}
  .search-field{display:grid;gap:var(--space-1);min-width:340px;color:var(--muted);font-size:.75rem;font-weight:700;text-transform:uppercase}
  .search-field input{min-height:44px;padding:0 var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink);font:inherit;text-transform:none}
  .search-field input:hover{border-color:var(--cobalt)}
  .run-list{border:1px solid var(--charcoal);background:var(--surface)}
  .run-docket{display:grid;grid-template-columns:42px minmax(250px,1fr) minmax(150px,.55fr) minmax(360px,1.35fr) minmax(150px,.5fr) 88px;gap:var(--space-4);align-items:center;min-height:112px;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line-strong);box-shadow:inset 4px 0 0 var(--line-strong);color:var(--ink);text-decoration:none;transition:background var(--duration-fast) var(--ease-standard)}
  .run-docket:last-child{border-bottom:0}
  .run-docket:hover{background:var(--cobalt-soft)}
  .run-docket.state-success{box-shadow:inset 4px 0 0 var(--emerald)}
  .run-docket.state-failure{box-shadow:inset 4px 0 0 var(--red)}
  .run-docket.state-warning{box-shadow:inset 4px 0 0 var(--amber)}
  .run-sequence{color:var(--muted);font-size:.75rem}
  .state-mark{width:10px;height:10px;border:2px solid var(--line-strong);border-radius:2px;background:var(--surface)}
  .state-success .state-mark{border-color:var(--emerald);background:var(--emerald)}
  .state-failure .state-mark{border-color:var(--red);background:var(--red)}
  .state-warning .state-mark{border-color:var(--amber);background:var(--amber)}
  .run-primary,.run-model,.run-time{display:grid;min-width:0}
  .run-mode{display:flex;align-items:center;gap:var(--space-2);color:var(--muted);font-size:.75rem;font-weight:700;text-transform:uppercase}
  .run-primary>strong{margin-top:var(--space-1);overflow:hidden;font-size:1rem;text-overflow:ellipsis;white-space:nowrap}
  .run-primary>small{margin-top:var(--space-1);overflow:hidden;color:var(--ink-soft);font-size:.875rem;text-overflow:ellipsis;white-space:nowrap}
  .run-model small,.run-time small,.run-proof small{color:var(--muted);font-size:.6875rem;text-transform:uppercase}
  .run-model strong,.run-time time{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .run-model span{margin-top:var(--space-1);color:var(--ink-soft);font-size:.75rem;font-weight:700}
  .run-proof{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));min-width:0;border-inline:1px solid var(--line)}
  .run-proof>span{display:grid;align-content:center;min-width:0;min-height:58px;padding:0 var(--space-3);border-right:1px solid var(--line)}
  .run-proof>span:last-child{border-right:0}
  .run-proof strong{margin-top:var(--space-1);overflow:hidden;font-size:.8125rem;text-overflow:ellipsis;white-space:nowrap}
  .run-time time{font-size:.75rem}
  .open-run{justify-self:end;color:var(--cobalt);font-weight:700}
  .selector-empty{display:grid;justify-items:center;gap:var(--space-2);padding:var(--space-7);color:var(--muted);text-align:center}
  .empty-index{font:700 3rem/1 var(--font-display)}
  .selector-empty strong{color:var(--ink)}
  .no-match{padding:var(--space-5);border:1px solid var(--line-strong);border-top:0;background:var(--surface);color:var(--muted)}
  .no-match[hidden]{display:none}
  footer{width:min(var(--container),100%);margin:0 auto;padding:var(--space-5);border-top:1px solid var(--line);color:var(--muted);font-size:.875rem}
  @media(max-width:1120px){
    .run-docket{grid-template-columns:36px minmax(220px,1fr) minmax(320px,1.2fr) 80px}
    .run-model,.run-time{display:none}
  }
  @media(max-width:720px){
    .selector-top>div,main,footer{padding-inline:var(--space-4)}
    .selector-intro{grid-template-columns:1fr;padding-block:var(--space-5)}
    .selector-intro h1{font-size:2rem}
    .selector-count{justify-items:start;min-width:0}
    .selector-count strong{font-size:3rem}
    .selector-overview{grid-template-columns:repeat(2,minmax(0,1fr))}
    .overview-reading:nth-child(2){border-right:0}
    .overview-reading:nth-child(-n+2){border-bottom:1px solid var(--line-strong)}
    .selector-controls{align-items:stretch;flex-direction:column}
    .search-field{min-width:0}
    .run-docket{grid-template-columns:28px minmax(0,1fr) 72px;gap:var(--space-3);min-height:154px;padding:var(--space-3)}
    .run-sequence{grid-row:1/3}
    .run-primary{grid-column:2}
    .run-proof{grid-column:2/4;grid-row:2}
    .run-proof>span{min-height:52px;padding-inline:var(--space-2)}
    .run-proof strong{font-size:.75rem}
    .open-run{grid-column:3;grid-row:1}
    .local-state{font-size:.75rem}
  }
  @media(max-width:390px){
    .selector-brand small{display:none}
    .selector-overview{grid-template-columns:1fr}
    .overview-reading,.overview-reading:nth-child(2){border-right:0;border-bottom:1px solid var(--line-strong)}
    .overview-reading:last-child{border-bottom:0}
    .run-proof{grid-template-columns:1fr}
    .run-proof>span{min-height:44px;border-right:0;border-bottom:1px solid var(--line)}
    .run-proof>span:last-child{border-bottom:0}
    .run-docket{min-height:246px}
  }
  @media(prefers-reduced-motion:reduce){
    *,*::before,*::after{transition-duration:.01ms!important}
  }
</style>
</head>
<body data-run-selector>
  <a class="skip-link" href="#run-index">Skip to campaign runs</a>
  <header class="selector-top">
    <div>
      <span class="selector-brand"><span class="selector-mark" aria-hidden="true">LF</span><span><strong>Loop Factory</strong><small>Campaign Console</small></span></span>
      <span class="local-state">${runs.length} local run(s)</span>
    </div>
  </header>
  <main id="run-index" data-run-index>
    <header class="selector-intro">
      <div>
        <span class="selector-kicker">Public snapshot index</span>
        <h1>Campaign runs</h1>
        <p>Select a persisted run to inspect its current allowlisted evidence surface. The index exposes operational facts, never private prompts, paths, or artifact bodies.</p>
      </div>
      <div class="selector-count"><strong class="mono">${String(runs.length).padStart(2, '0')}</strong><span>persisted run${runs.length === 1 ? '' : 's'}</span></div>
    </header>
    <section class="selector-overview" aria-label="Run index summary">
      <div class="overview-reading"><span>Persisted runs</span><strong class="mono">${runs.length}</strong></div>
      <div class="overview-reading"><span>Canary runs</span><strong class="mono">${canaryRuns.length}</strong></div>
      <div class="overview-reading"><span>Passing canaries</span><strong class="mono">${passingCanaries.length}</strong></div>
      <div class="overview-reading"><span>Awaiting decisions</span><strong class="mono">${pendingDecisionCount}</strong></div>
    </section>
    <section class="selector-controls" aria-labelledby="run-list-title">
      <div><h2 id="run-list-title">Operational docket</h2><p>Newest public snapshot first.</p></div>
      <label class="search-field" for="runSearch">Filter runs
        <input id="runSearch" type="search" placeholder="Run, model, status, verdict, or blocker" autocomplete="off" />
      </label>
    </section>
    <div id="runList" class="run-list">${rows}</div>
    <p id="noMatch" class="no-match" hidden>No runs match this filter.</p>
  </main>
  <footer>Run selection is generated from allowlisted state only. Private prompts, paths, and artifact bodies are never embedded.</footer>
  <script>
    (function(){
      'use strict';
      var input=document.getElementById('runSearch');
      var noMatch=document.getElementById('noMatch');
      if(!input) return;
      input.addEventListener('input',function(){
        var query=input.value.trim().toLowerCase();
        var shown=0;
        document.querySelectorAll('[data-run-row]').forEach(function(row){
          var visible=!query||row.getAttribute('data-search').indexOf(query)>=0;
          row.hidden=!visible;
          if(visible) shown+=1;
        });
        noMatch.hidden=shown!==0;
      });
    })();
  </script>
</body>
</html>`;
}

export function renderDashboard(state, options = {}) {
  const view = options.snapshot || buildConsoleSnapshot(state);
  if (view.canary && view.canary.enabled) return renderCanaryDashboard(view);
  return renderCampaignDashboard(view, options);
}

function renderCampaignDashboard(view, options = {}) {
  const dataJson = JSON.stringify(view).replace(/</g, '\\u003c');
  const decisionToken = typeof options.decisionToken === 'string' ? options.decisionToken : '';
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
  const realTest = view.realTest || { enabled: false };
  const findingsPercent = realTest.enabled && realTest.maxFindings > 0
    ? Math.max(0, Math.min(100, Math.round((realTest.findingsAccepted / realTest.maxFindings) * 100)))
    : 0;
  const attemptsPercent = realTest.enabled && realTest.maxImprovementAttempts > 0
    ? Math.max(0, Math.min(100, Math.round((realTest.improvementAttempts / realTest.maxImprovementAttempts) * 100)))
    : 0;

  const chipClass = (value) => {
    const v = String(value || '').toUpperCase();
    if (['ACTIVE', 'APPROVED', 'MOVED_FRONTIER', 'PROMOTE', 'REVERIFIED', 'PASS', 'COVERED'].includes(v)) return 'success';
    if (['SLUDGE', 'REJECTED', 'NO_IMPROVEMENT', 'SELF_PROMOTION', 'PHASE_SKIP', 'MODEL_REPORTED_METRIC', 'FAIL', 'BLOCKED'].includes(v)) return 'danger';
    if (['PENDING', 'REQUIRED', 'SENDING', 'APPROVAL QUEUED', 'DENIAL QUEUED', 'DECISION STALE', 'SATURATED'].includes(v)) return 'warning';
    return 'neutral';
  };
  const value = (v, fallback = '--') => v == null || v === '' ? fallback : escapeHtml(String(v));
  const shortHash = (v) => v ? `${escapeHtml(String(v).slice(0, 12))}...` : '--';
  const modelRequestLabel = (v) => v === 'explicit-model-flag' ? 'explicit -m flag' : (v || 'unknown request');
  const detailText = (detail) => Object.entries(detail || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
    .join('  ');
  const reviewQueued = (review) => review.status === 'PENDING'
    && ['approve', 'sludge'].includes(review.queuedDecision)
    && review.queueBindingValid === true;
  const reviewStale = (review) => review.status === 'PENDING'
    && ['approve', 'sludge'].includes(review.queuedDecision)
    && review.queueBindingValid === false;
  const reviewStatusLabel = (review) => {
    if (reviewQueued(review)) return review.queuedDecision === 'approve' ? 'APPROVAL QUEUED' : 'DENIAL QUEUED';
    if (reviewStale(review)) return 'DECISION STALE';
    return String(review.status || '').toUpperCase() === 'SLUDGE'
      ? 'DENIED'
      : String(review.status || 'UNKNOWN').toUpperCase();
  };
  const reviewFilterStatus = (review) => reviewQueued(review)
    ? 'QUEUED'
    : (String(review.status || '').toUpperCase() === 'SLUDGE' ? 'DENIED' : String(review.status || 'UNKNOWN').toUpperCase());
  const reviewImpact = (review) => {
    if (review.kind === 'promotion') {
      return 'Approve banks this measured candidate as the run\'s internal champion after the supervisor rechecks the unchanged promotion gate.';
    }
    if (review.hasLoopContent && review.loopId) {
      return 'Approve installs a new version of the named custom loop. Mandated canonical loops remain immutable.';
    }
    return 'Approve records this operator disposition. Deny closes it without adoption or promotion.';
  };
  const reviewScore = (review) => view.scoreMatrix.find((row) => row.hypothesisId === review.hypothesisId) || null;
  const reviewProofMarkup = (review) => {
    const row = reviewScore(review);
    const facts = row
      ? [
          ['quality', row.measured ? value(row.quality) : 'unmeasured'],
          ['delta quality', row.deltaQuality == null ? '--' : value(`${row.deltaQuality > 0 ? '+' : ''}${row.deltaQuality}`)],
          ['delta cost', row.deltaCostPct == null ? '--' : escapeHtml(pct(row.deltaCostPct))],
          ['reverified', row.reverified ? 'yes' : 'no'],
          ['verdict', value(row.verdict)]
        ]
      : [
          ['evidence link', value(review.evidenceRef)],
          ['loop payload', review.hasLoopContent ? 'present' : 'none'],
          ['authority', 'operator only']
        ];
    return `<div class="review-proof" data-review-proof aria-label="Measured evidence">
      ${facts.map(([label, fact]) => `<span><small>${escapeHtml(label)}</small><strong>${fact}</strong></span>`).join('')}
    </div>`;
  };
  const reviewStateText = (review) => {
    const status = reviewStatusLabel(review);
    if (status === 'APPROVAL QUEUED' || status === 'DENIAL QUEUED') {
      return 'Queued locally. Waiting for the supervisor to revalidate and apply persisted state.';
    }
    if (status === 'DECISION STALE') {
      return 'The queued decision no longer matches current evidence. Review the updated binding and decide again.';
    }
    if (status === 'APPROVED') return 'Applied by the supervisor.';
    if (status === 'DENIED') return 'Denied by the operator.';
    if (review.decisionError) return `Last queued decision rejected: ${review.decisionError}. Review and decide again.`;
    return 'Awaiting operator decision.';
  };
  const trustState = (ok, pending = false) => pending ? 'pending' : (ok ? 'verified' : 'blocked');
  const trustItems = [
    {
      id: 'trustPlan',
      label: 'Plan lock',
      value: realTest.enabled ? (realTest.planApproved ? 'verified' : 'not approved') : 'standard mode',
      state: realTest.enabled ? trustState(realTest.planApproved) : 'neutral'
    },
    {
      id: 'trustBenchmark',
      label: 'Benchmark authority',
      value: view.evidence.benchmarkSource || realTest.benchmarkAuthority || 'not frozen',
      state: trustState(view.evidence.benchmarkSource === 'maker', !view.evidence.benchmarkFrozen)
    },
    {
      id: 'trustBaseline',
      label: 'Baseline sampling',
      value: view.evidence.baselineSamples > 0 ? `${view.evidence.baselineSamples} captured run(s)` : 'not measured',
      state: trustState(view.evidence.baselineSamples >= (realTest.enabled ? 3 : 1), view.evidence.baselineSamples === 0)
    },
    {
      id: 'trustQuality',
      label: 'Quality authority',
      value: view.evidence.baselineQualityAuthority || 'not measured',
      state: trustState(view.evidence.baselineQualityAuthority === 'tool-computed', !view.evidence.baselineQualityAuthority)
    },
    {
      id: 'trustNegative',
      label: 'Negative control',
      value: view.evidence.negativeControl ? view.evidence.negativeControl.status.replaceAll('_', ' ').toLowerCase() : 'not recorded',
      state: trustState(view.evidence.negativeControl && view.evidence.negativeControl.status === 'FAILED_AS_EXPECTED', !view.evidence.negativeControl)
    },
    {
      id: 'trustOverrides',
      label: 'Fixture overrides',
      value: view.evidence.integrityOverrideCount === 0 ? 'none' : String(view.evidence.integrityOverrideCount),
      state: trustState(view.evidence.integrityOverrideCount === 0)
    }
  ];
  const trustMarkup = trustItems.map((item) => `<div class="trust-item ${item.state}">
      <span class="trust-mark" aria-hidden="true"></span>
      <span><small>${escapeHtml(item.label)}</small><strong id="${item.id}">${escapeHtml(item.value)}</strong></span>
    </div>`).join('');

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
                <div class="wide"><dt>model identity</dt><dd>requested via ${escapeHtml(modelRequestLabel(receipt.modelSelectionAuthority))}; backend-reported model: ${value(receipt.reportedModel, 'null')}</dd></div>
                <div><dt>duration</dt><dd>${receipt.durationMs == null ? '--' : `${receipt.durationMs} ms`}</dd></div>
                <div><dt>CLI reported total tokens</dt><dd>${value(receipt.cliReportedTotalTokens)}</dd></div>
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
        <td class="num">${value(row.artifactOutputTokenEstimate)}</td>
        <td class="num">${value(row.cliReceiptTokenCost)}</td>
        <td class="num">${row.deltaQuality == null ? '--' : `${row.deltaQuality > 0 ? '+' : ''}${row.deltaQuality}`}</td>
        <td class="num">${row.deltaCostPct == null ? '--' : pct(row.deltaCostPct)}</td>
        <td><span class="status ${row.reverified ? 'success' : 'neutral'}">${row.reverified ? 'reverified' : '--'}</span></td>
        <td><span class="status ${chipClass(row.verdict)}">${value(row.verdict)}</span></td>
        <td><span class="status ${row.promotable ? 'success' : 'neutral'}">${row.promotable ? 'promotable' : 'blocked'}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="10" class="empty-cell">No measured hypotheses.</td></tr>';
  const coverageRows = realTest.enabled && realTest.coverage.length
    ? realTest.coverage.map((entry) => `<tr data-finding="${escapeHtml(entry.findingId)}">
        <td class="mono">${escapeHtml(entry.findingId)}</td>
        <td class="mono">${value(entry.childRunId)}</td>
        <td class="mono" title="${value(entry.baselineSha256)}">${shortHash(entry.baselineSha256)}</td>
        <td class="mono">${escapeHtml(entry.hypothesisIds.join(', '))}</td>
        <td class="num">${entry.valid}/${entry.planned}</td>
        <td class="num">${entry.invalid}</td>
        <td><span class="status ${chipClass(entry.status)}">${escapeHtml(entry.status)}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty-cell">No accepted finding coverage recorded.</td></tr>';
  const validity = realTest.experimentValidity || { status: 'UNKNOWN' };
  const validityDimensions = [
    'execution', 'targetGrounding', 'benchmark', 'isolation',
    'comparability', 'coverage', 'promotionSafety', 'stateConsistency'
  ]
    .map((key) => {
      const dimension = validity[key] || { status: 'UNKNOWN', reasons: [] };
      return `<div class="trust-item ${dimension.status === 'PASS' ? 'verified' : (dimension.status === 'FAIL' ? 'blocked' : 'pending')}">
        <span class="trust-mark" aria-hidden="true"></span>
        <span><small>${escapeHtml(key.replace(/([A-Z])/g, ' $1'))}</small><strong>${escapeHtml(dimension.status)}</strong></span>
      </div>`;
    }).join('');

  const activityRows = view.activity.length
    ? [...view.activity].reverse().map((entry) => `<li class="activity-item">
        <time>${value(entry.ts)}</time>
        <strong>${escapeHtml(entry.event)}</strong>
        <span class="mono">${detailText(entry.detail)}</span>
      </li>`).join('')
    : '<li class="empty">No activity has been recorded.</li>';

  const reviewAwaiting = Number.isFinite(view.reviews.awaiting) ? view.reviews.awaiting : view.reviews.pending;
  const reviewQueuedCount = Number.isFinite(view.reviews.queued) ? view.reviews.queued : 0;
  const initialReviewFilter = reviewAwaiting > 0 ? 'PENDING' : (reviewQueuedCount > 0 ? 'QUEUED' : 'ALL');
  const orderedReviews = [...view.reviews.items].sort((a, b) => {
    const priority = (review) => reviewFilterStatus(review) === 'PENDING' ? 0 : (reviewFilterStatus(review) === 'QUEUED' ? 1 : 2);
    return priority(a) - priority(b) || String(b.ts || '').localeCompare(String(a.ts || ''));
  });
  const reviewCards = orderedReviews.length
    ? orderedReviews.map((review) => {
        const resolved = review.status !== 'PENDING';
        const queued = reviewQueued(review);
        const locked = resolved || queued;
        const statusLabel = reviewStatusLabel(review);
        const filterStatus = reviewFilterStatus(review);
        const notesId = `notes-${review.id}`;
        return `<article class="review" data-review="${escapeHtml(review.id)}" data-review-status="${escapeHtml(filterStatus)}" data-review-sha="${escapeHtml(review.decisionBindingSha256)}" data-submitted="${queued ? 'true' : 'false'}">
        <div class="review-evidence">
          <header class="review-head">
            <div>
              <span class="review-sequence">Decision ${escapeHtml(review.id)}</span>
              <strong>${value(review.kind, 'candidate change')}</strong>
            </div>
            <span class="status ${chipClass(statusLabel)}" data-status>${escapeHtml(statusLabel)}</span>
          </header>
          <p class="review-impact"><strong>Effect of approval</strong><span>${escapeHtml(reviewImpact(review))}</span></p>
          <dl class="review-meta">
            <div><dt>hypothesis</dt><dd class="mono">${value(review.hypothesisId)}</dd></div>
            <div><dt>evidence</dt><dd class="mono">${value(review.evidenceRef)}</dd></div>
            <div><dt>loop</dt><dd class="mono">${value(review.loopId)}</dd></div>
            <div><dt>decision hash</dt><dd class="mono" data-review-binding title="${value(review.decisionBindingSha256)}">${shortHash(review.decisionBindingSha256)}</dd></div>
          </dl>
          ${reviewProofMarkup(review)}
        </div>
        <div class="review-decision">
          <div class="authority-lock">
            <span class="authority-mark" aria-hidden="true"></span>
            <span><strong>Session-authorized operator action</strong><small>The MCP tool surface cannot resolve reviews. This local browser session queues a hash-bound decision for supervisor revalidation.</small></span>
          </div>
          <div class="review-actions" role="group" aria-label="Choose a decision for ${escapeHtml(review.id)}">
            <button type="button" class="button approve" data-act="approve" aria-pressed="false"${locked ? ' disabled' : ''}>Approve</button>
            <button type="button" class="button sludge" data-act="sludge" aria-pressed="false"${locked ? ' disabled' : ''}>Deny</button>
          </div>
          <label class="notes-label" for="${escapeHtml(notesId)}">Decision rationale <span>optional</span></label>
          <textarea id="${escapeHtml(notesId)}" class="notes" rows="3" placeholder="Record why this evidence is or is not sufficient."${locked ? ' disabled' : ''}></textarea>
          <button type="button" class="button decision-submit" data-submit disabled>${resolved ? 'Decision applied' : (queued ? 'Decision queued' : 'Choose approve or deny')}</button>
          <p class="decision-state" data-decision-state>${escapeHtml(reviewStateText(review))}</p>
        </div>
      </article>`;
      }).join('')
    : '<div class="decision-empty"><strong>Decision queue clear</strong><span>No candidate currently requires operator approval or denial.</span></div>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${decisionToken ? `<meta name="super-loop-decision-token" content="${escapeHtml(decisionToken)}" />` : ''}
<title>Loop Factory Campaign Console - ${escapeHtml(view.run.id)}</title>
<style>
  :root{
    --canvas:#f1f2ee;
    --surface:#ffffff;
    --surface-muted:#f6f7f4;
    --surface-sunken:#e8ebe6;
    --surface-strong:#111815;
    --surface-strong-2:#1b2420;
    --ink:#111815;
    --ink-soft:#414b46;
    --ink-muted:#68736d;
    --ink-on-strong:#f6f8f5;
    --ink-on-strong-muted:#aebbb4;
    --ink-on-strong-soft:#dce4df;
    --line:#d5dad5;
    --line-strong:#aeb7b1;
    --line-on-strong:#47564e;
    --brand:#156047;
    --brand-strong:#0d4734;
    --brand-soft:#dcece5;
    --signal:#2d5fc4;
    --signal-soft:#e4ebfa;
    --info:#245c8e;
    --info-soft:#e1edf7;
    --info-line:#b8d2e7;
    --success:#17653f;
    --success-soft:#dcefe4;
    --success-line:#a9d5bb;
    --warning:#875704;
    --warning-soft:#f7ebcb;
    --warning-line:#dfc47f;
    --danger:#97372f;
    --danger-soft:#f6dfdc;
    --danger-line:#e4b3ad;
    --connection-idle:#8a9890;
    --connection-live:#5bd18c;
    --connection-warning:#f0b84b;
    --focus:#0c67b1;
    --shadow:0 1px 1px #15211b0f;
    --radius:6px;
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
  html{background:var(--canvas);color:var(--ink);scroll-behavior:smooth}
  body{margin:0;min-width:320px;background:var(--canvas);font:400 16px/1.5 var(--font);-webkit-font-smoothing:antialiased}
  button,textarea{font:inherit}
  button{letter-spacing:0}
  a{color:var(--info)}
  .skip{position:fixed;left:var(--space-4);top:-80px;z-index:1000;background:var(--surface);color:var(--ink);padding:var(--space-3) var(--space-4);border:2px solid var(--focus);border-radius:var(--radius)}
  .skip:focus{top:var(--space-4)}
  :focus-visible{outline:3px solid var(--focus);outline-offset:2px}
  .mono{font-family:var(--mono);font-feature-settings:"tnum"}
  .num{text-align:right;font-family:var(--mono);font-feature-settings:"tnum"}
  .appbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:68px;padding:var(--space-3) var(--space-5);background:var(--surface-strong);color:var(--ink-on-strong);border-top:3px solid var(--signal);border-bottom:1px solid var(--line-on-strong)}
  .brand-lockup,.app-meta{display:flex;align-items:center;gap:var(--space-3);min-width:0}
  .brand-mark{display:grid;place-items:center;width:36px;height:36px;flex:0 0 36px;border:1px solid #75a893;border-radius:5px;background:var(--brand);font-weight:700}
  .brand-copy{display:grid;min-width:0}
  .brand-copy strong{font-size:1rem}
  .brand-copy span{color:var(--ink-on-strong-muted);font-size:.8125rem}
  .run-id{max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-on-strong-soft);font-size:.8125rem}
  .connection{display:inline-flex;align-items:center;gap:var(--space-2);min-height:36px;padding:0 var(--space-3);border:1px solid var(--line-on-strong);border-radius:999px;color:var(--ink-on-strong);font-size:.8125rem;font-weight:700}
  .connection::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--connection-idle)}
  .connection.live::before{background:var(--connection-live)}
  .connection.reconnecting::before{background:var(--connection-warning)}
  .stopbar{padding:10px var(--space-5);background:var(--danger-soft);color:var(--danger);border-bottom:1px solid var(--danger-line);text-align:left;font-size:.875rem;font-weight:700}
  .shell{width:min(1520px,100%);margin:0 auto;padding:var(--space-5)}
  .console-head{display:flex;justify-content:space-between;gap:var(--space-5);align-items:flex-end;margin-bottom:var(--space-4)}
  .console-head h1{margin:0;font-size:1.75rem;line-height:1.2}
  .console-head p{margin:var(--space-1) 0 0;color:var(--ink-soft);max-width:68ch}
  .updated{color:var(--ink-muted);font-size:.8125rem;text-align:right}
  .poll-error{display:flex;justify-content:space-between;align-items:center;gap:var(--space-4);margin-bottom:var(--space-4);padding:var(--space-3) var(--space-4);border:1px solid var(--danger-line);border-radius:var(--radius);background:var(--danger-soft);color:var(--danger)}
  .poll-error[hidden]{display:none}
  .section-nav{display:flex;gap:var(--space-1);margin:0 0 var(--space-4);padding:var(--space-1);overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
  .section-nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 var(--space-4);border-radius:4px;color:var(--ink-soft);font-size:.875rem;font-weight:700;text-decoration:none;white-space:nowrap}
  .section-nav a:hover,.section-nav a:focus-visible{background:var(--signal-soft);color:var(--signal)}
  #run-control,#work-queue,#measured-frontier,#supervisor-verdicts,#operator-review{scroll-margin-top:84px}
  .control-deck{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(420px,.9fr);margin-bottom:var(--space-4);overflow:hidden;border:1px solid var(--surface-strong);border-radius:var(--radius);background:var(--surface-strong);color:var(--ink-on-strong)}
  .contract{padding:var(--space-5);border-right:1px solid var(--line-on-strong)}
  .contract-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-4);margin-bottom:var(--space-5)}
  .contract-head h2{margin:0;font-size:1.125rem}
  .contract-head p{margin:var(--space-1) 0 0;color:var(--ink-on-strong-muted);font-size:.875rem}
  .contract-hash{display:grid;justify-items:end;min-width:0;color:var(--ink-on-strong-muted);font-size:.75rem}
  .contract-hash strong{max-width:24ch;overflow:hidden;text-overflow:ellipsis;color:var(--ink-on-strong);font-family:var(--mono);white-space:nowrap}
  .budget-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
  .budget-item{display:grid;gap:var(--space-2);padding:var(--space-4);border:1px solid var(--line-on-strong);border-radius:5px;background:var(--surface-strong-2)}
  .budget-copy{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-4)}
  .budget-copy small{display:block;color:var(--ink-on-strong-muted);font-size:.75rem;font-weight:700;text-transform:uppercase}
  .budget-copy strong{font-size:1.4rem;font-feature-settings:"tnum"}
  .budget-copy span{color:var(--ink-on-strong-muted);font-size:.8125rem;text-align:right}
  .budget-track{height:8px;overflow:hidden;border:1px solid var(--line-on-strong);border-radius:999px;background:#0d120f}
  .budget-track i{display:block;height:100%;background:var(--signal);transition:width var(--base) var(--ease)}
  .budget-item.attempts .budget-track i{background:#d6a445}
  .trust-board{padding:var(--space-5);background:#18221d}
  .trust-board h2{margin:0 0 var(--space-4);font-size:1rem}
  .trust-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;border:1px solid var(--line-on-strong);background:var(--line-on-strong)}
  .trust-item{display:grid;grid-template-columns:10px minmax(0,1fr);gap:var(--space-3);align-items:start;min-height:72px;padding:var(--space-3);background:var(--surface-strong-2)}
  .trust-item small{display:block;color:var(--ink-on-strong-muted);font-size:.7rem;font-weight:700;text-transform:uppercase}
  .trust-item strong{display:block;margin-top:2px;color:var(--ink-on-strong);font-size:.8125rem;overflow-wrap:anywhere}
  .trust-mark{width:9px;height:9px;margin-top:4px;border:2px solid var(--line-on-strong);border-radius:50%;background:transparent}
  .trust-item.verified .trust-mark{border-color:var(--connection-live);background:var(--connection-live)}
  .trust-item.pending .trust-mark{border-color:var(--connection-warning);background:var(--connection-warning)}
  .trust-item.blocked .trust-mark{border-color:#ef7669;background:#ef7669}
  .status-rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin-bottom:var(--space-4);overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
  .status-card{min-height:118px;padding:var(--space-4);background:var(--surface);border:0;border-right:1px solid var(--line);border-radius:0;box-shadow:none}
  .status-card:last-child{border-right:0}
  .status-card h2{margin:0 0 var(--space-3);font-size:.8125rem;color:var(--ink-muted);font-weight:700;text-transform:uppercase}
  .status-value{display:block;font-size:1.25rem;font-weight:700;overflow-wrap:anywhere}
  .status-detail{display:block;margin-top:var(--space-1);color:var(--ink-soft);font-size:.875rem}
  .workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,430px);gap:var(--space-4);align-items:start}
  .column{display:grid;gap:var(--space-4);min-width:0}
  .panel{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:none}
  .panel-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);padding:var(--space-4);border-bottom:1px solid var(--line)}
  .panel-head h2{margin:0;font-size:1.0625rem}
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
  th{background:var(--surface-sunken);color:var(--ink-soft);font-size:.72rem;font-weight:700;text-transform:uppercase}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:#f0f4fb}
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
  .review-panel{margin-bottom:var(--space-4);overflow:hidden;border-color:var(--line-strong);box-shadow:inset 0 4px 0 var(--brand)}
  .review-panel.needs-decision{box-shadow:inset 0 4px 0 var(--warning)}
  .decision-panel-head{align-items:stretch;padding:0}
  .decision-title{display:grid;align-content:center;min-width:0;padding:var(--space-4) var(--space-5)}
  .decision-title span{color:var(--brand);font-size:.72rem;font-weight:700;text-transform:uppercase}
  .decision-title h2{margin:var(--space-1) 0 0;font-size:1.25rem}
  .decision-title p{max-width:68ch;margin:var(--space-1) 0 0;color:var(--ink-muted);font-size:.875rem}
  .decision-counts{display:grid;grid-template-columns:repeat(4,minmax(82px,1fr));min-width:410px;border-left:1px solid var(--line)}
  .decision-counts span{display:grid;align-content:center;justify-items:center;min-height:92px;padding:var(--space-3);border-right:1px solid var(--line)}
  .decision-counts span:last-child{border-right:0}
  .decision-counts small{color:var(--ink-muted);font-size:.6875rem;text-transform:uppercase}
  .decision-counts strong{margin-top:var(--space-1);font-size:1.5rem}
  .decision-toolbar{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-3) var(--space-5);border-bottom:1px solid var(--line);background:var(--surface-muted)}
  .decision-filters{display:inline-flex;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface)}
  .decision-filter{min-height:44px;padding:0 var(--space-3);border:0;border-right:1px solid var(--line);background:transparent;color:var(--ink-soft);font-weight:700;cursor:pointer}
  .decision-filter:last-child{border-right:0}
  .decision-filter:hover{background:var(--signal-soft);color:var(--ink)}
  .decision-filter[aria-pressed="true"]{background:var(--surface-strong);color:var(--ink-on-strong)}
  .decision-filter:disabled{cursor:not-allowed;color:var(--ink-muted);background:var(--surface-sunken)}
  .decision-boundary{display:flex;align-items:center;gap:var(--space-2);color:var(--ink-muted);font-size:.8125rem;text-align:right}
  .decision-boundary::before{width:9px;height:9px;border:2px solid var(--brand);border-radius:2px;background:var(--brand-soft);content:""}
  .reviews{display:grid;gap:var(--space-3)}
  .review{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,.55fr);min-width:0;border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface)}
  .review-evidence{min-width:0;padding:var(--space-4);border-right:1px solid var(--line)}
  .review-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-3)}
  .review-head>div{display:grid;gap:var(--space-1)}
  .review-head>div>strong{font-size:1rem;text-transform:capitalize}
  .review-sequence{color:var(--ink-muted);font-family:var(--mono);font-size:.72rem}
  .review-impact{display:grid;grid-template-columns:132px minmax(0,1fr);gap:var(--space-3);margin:var(--space-4) 0 0;padding:var(--space-3) 0;border-block:1px solid var(--line)}
  .review-impact strong{font-size:.75rem;text-transform:uppercase}
  .review-impact span{color:var(--ink-soft);font-size:.875rem}
  .review-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-2);margin:var(--space-3) 0}
  .review-meta div{min-width:0}
  .review-meta dd{text-align:left;font-size:.75rem}
  .review-proof{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);background:var(--surface-muted)}
  .review-proof span{display:grid;min-width:0;padding:var(--space-2) var(--space-3);border-right:1px solid var(--line)}
  .review-proof span:last-child{border-right:0}
  .review-proof small{color:var(--ink-muted);font-size:.65rem;text-transform:uppercase}
  .review-proof strong{margin-top:2px;overflow:hidden;font-size:.8125rem;text-overflow:ellipsis;white-space:nowrap}
  .review-decision{display:grid;align-content:start;gap:var(--space-3);min-width:0;padding:var(--space-4);background:var(--surface-muted)}
  .authority-lock{display:grid;grid-template-columns:12px minmax(0,1fr);gap:var(--space-2);align-items:start}
  .authority-lock>span:last-child{display:grid;gap:2px}
  .authority-lock strong{font-size:.8125rem}
  .authority-lock small{color:var(--ink-muted);font-size:.75rem}
  .authority-mark{width:10px;height:10px;margin-top:4px;border:2px solid var(--brand);border-radius:2px;background:var(--brand-soft)}
  .review-actions,.exportbar{display:flex;flex-wrap:wrap;gap:var(--space-2)}
  .review-actions .button{flex:1 1 120px}
  .button{appearance:none;min-height:44px;padding:0 var(--space-4);border:1px solid var(--line-strong);border-radius:6px;background:var(--surface);color:var(--ink);font-weight:700;cursor:pointer;transition:background var(--fast) var(--ease),border-color var(--fast) var(--ease),color var(--fast) var(--ease)}
  .button:hover{background:var(--surface-muted)}
  .button:active{background:var(--line)}
  .button:disabled{cursor:not-allowed;color:var(--ink-muted);background:var(--surface-muted);border-color:var(--line)}
  .button.approve{border-color:var(--success-line);background:var(--success-soft);color:var(--success)}
  .button.approve:hover:not(:disabled){border-color:var(--success);background:#cbe7d7}
  .button.sludge{border-color:var(--danger-line);background:var(--danger-soft);color:var(--danger)}
  .button.sludge:hover:not(:disabled){border-color:var(--danger);background:#f3d5d0}
  .button.approve[aria-pressed="true"]{border-color:var(--success);background:var(--success-soft);color:var(--success)}
  .button.sludge[aria-pressed="true"]{border-color:var(--danger);background:var(--danger-soft);color:var(--danger)}
  .button.approve[aria-pressed="true"],.button.sludge[aria-pressed="true"]{box-shadow:inset 0 0 0 2px currentColor}
  .notes-label{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);color:var(--ink-soft);font-size:.8125rem;font-weight:700}
  .notes-label span{color:var(--ink-muted);font-size:.72rem;font-weight:400}
  .notes{width:100%;min-height:72px;padding:var(--space-3);resize:vertical;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface-muted);color:var(--ink)}
  .notes:hover{border-color:var(--signal)}
  .notes:disabled{cursor:not-allowed;background:var(--surface-sunken);color:var(--ink-muted)}
  .decision-submit{width:100%;border-color:var(--surface-strong);background:var(--surface-strong);color:var(--ink-on-strong)}
  .decision-submit:hover:not(:disabled){border-color:var(--signal);background:var(--signal)}
  .decision-state{min-height:20px;margin:0;color:var(--ink-muted);font-size:.75rem}
  .exportbar{align-items:center;margin-top:var(--space-4)}
  .export-note{flex:1 1 100%;color:var(--ink-muted);font-size:.8125rem}
  .decision-empty{display:grid;justify-items:center;gap:var(--space-1);padding:var(--space-6);border:1px dashed var(--line-strong);background:var(--surface-muted);color:var(--ink-muted);text-align:center}
  .decision-empty strong{color:var(--ink)}
  .empty,.empty-cell{margin:0;color:var(--ink-muted);font-style:normal}
  .empty-cell{text-align:center;padding:var(--space-6)}
  footer{margin-top:var(--space-6);padding:var(--space-4) 0;color:var(--ink-muted);font-size:.8125rem;border-top:1px solid var(--line)}
  .sr-live{position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden}
  @media (max-width:1050px){
    .control-deck{grid-template-columns:1fr}
    .contract{border-right:0;border-bottom:1px solid var(--line-on-strong)}
    .status-rail{grid-template-columns:repeat(2,minmax(0,1fr))}
    .workspace{grid-template-columns:1fr}
    .side{grid-template-columns:repeat(2,minmax(0,1fr))}
    .decision-panel-head{display:grid;grid-template-columns:1fr}
    .decision-counts{min-width:0;border-top:1px solid var(--line);border-left:0}
    .review{grid-template-columns:1fr}
    .review-evidence{border-right:0;border-bottom:1px solid var(--line)}
  }
  @media (max-width:700px){
    .appbar{align-items:flex-start;padding:var(--space-3) var(--space-4)}
    .app-meta{align-items:flex-end;flex-direction:column;gap:var(--space-2)}
    .run-id{max-width:20ch}
    .shell{padding:var(--space-4)}
    .console-head{align-items:flex-start;flex-direction:column}
    .updated{text-align:left}
    .contract-head{align-items:flex-start;flex-direction:column}
    .contract-hash{justify-items:start}
    .budget-grid,.trust-grid{grid-template-columns:1fr}
    .budget-copy{align-items:flex-start;flex-direction:column}
    .budget-copy span{text-align:left}
    .status-rail,.side{grid-template-columns:1fr}
    .status-card{border-right:0;border-bottom:1px solid var(--line)}
    .status-card:last-child{border-bottom:0}
    .activity-item{grid-template-columns:1fr;gap:var(--space-1)}
    .progress-copy{align-items:flex-start;flex-direction:column;gap:var(--space-1)}
    .progress-copy span{text-align:left}
    .receipt{grid-template-columns:1fr}
    .receipt .wide{grid-column:auto}
    .review-meta{grid-template-columns:1fr}
    .review-impact{grid-template-columns:1fr}
    .review-proof{grid-template-columns:repeat(2,minmax(0,1fr))}
    .review-proof span{border-bottom:1px solid var(--line)}
    .review-proof span:nth-child(2n){border-right:0}
    .review-proof span:last-child{grid-column:1/-1;border-bottom:0}
    .decision-toolbar{align-items:stretch;flex-direction:column;padding:var(--space-3) var(--space-4)}
    .decision-boundary{text-align:left}
    .decision-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;border-color:var(--line);background:var(--line)}
    .decision-filter{border:0;background:var(--surface)}
    .decision-filter{padding-inline:var(--space-2)}
    .review-actions .button,.exportbar .button{flex:1 1 140px}
    th,td{padding:var(--space-3)}
    .empty-cell{position:sticky;left:0;min-width:280px;text-align:left;background:var(--surface)}
  }
  @media (max-width:390px){
    .brand-copy span{display:none}
    .appbar{gap:var(--space-2)}
    .run-id{max-width:16ch}
    .status-card{min-height:112px}
    .control-deck{margin-inline:calc(var(--space-4) * -1);border-left:0;border-right:0;border-radius:0}
    .panel-head{align-items:flex-start;flex-direction:column}
    .row-head{align-items:flex-start;flex-direction:column}
    .decision-counts{grid-template-columns:1fr}
    .decision-counts span{min-height:64px;border-right:0;border-bottom:1px solid var(--line)}
    .decision-counts span:last-child{border-bottom:0}
    .decision-filters{grid-template-columns:repeat(2,minmax(0,1fr))}
    .decision-filter:last-child{grid-column:1/-1}
    .review-proof{grid-template-columns:1fr}
    .review-proof span,.review-proof span:nth-child(2n),.review-proof span:last-child{grid-column:auto;border-right:0;border-bottom:1px solid var(--line)}
    .review-proof span:last-child{border-bottom:0}
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
        <h1>Campaign operations</h1>
        <p>Accepted work, measured movement, and operator authority.</p>
      </div>
      <div class="updated">Updated <time id="updatedAt">${value(view.run.updatedAt)}</time></div>
    </div>

    <div id="pollError" class="poll-error" role="alert" hidden>
      <span>Live state is unavailable. The last verified snapshot remains visible.</span>
      <button id="retryPoll" type="button" class="button">Retry</button>
    </div>

    <nav class="section-nav" aria-label="Campaign sections">
      <a href="#run-control">Run contract</a>
      <a href="#work-queue">Work queue</a>
      <a href="#measured-frontier">Measured frontier</a>
      <a href="#supervisor-verdicts">Verdicts</a>
      <a href="#operator-review">Decisions</a>
    </nav>

    <section id="operator-review" class="panel review-panel ${view.reviews.pending ? 'needs-decision' : 'is-clear'}" aria-labelledby="review-title">
      <div class="panel-head decision-panel-head">
        <div class="decision-title">
          <span>Operator gate</span>
          <h2 id="review-title">Approval desk</h2>
          <p>Review the allowlisted evidence, choose Approve or Deny, then explicitly queue the decision. A queued choice is not shown as applied until the supervisor confirms it in persisted state.</p>
        </div>
        <div class="decision-counts" aria-label="Decision totals">
          <span><small>Awaiting</small><strong id="reviewCount" class="mono">${reviewAwaiting}</strong></span>
          <span><small>Queued</small><strong id="reviewQueued" class="mono">${reviewQueuedCount}</strong></span>
          <span><small>Approved</small><strong id="reviewApproved" class="mono">${view.reviews.approved}</strong></span>
          <span><small>Denied</small><strong id="reviewDenied" class="mono">${view.reviews.sludge}</strong></span>
        </div>
      </div>
      <div class="decision-toolbar">
        <div class="decision-filters" role="group" aria-label="Filter operator decisions">
          <button type="button" class="decision-filter" data-review-filter="PENDING" aria-pressed="${initialReviewFilter === 'PENDING' ? 'true' : 'false'}">Awaiting <span id="filterPending">${reviewAwaiting}</span></button>
          <button type="button" class="decision-filter" data-review-filter="QUEUED" aria-pressed="${initialReviewFilter === 'QUEUED' ? 'true' : 'false'}">Queued <span id="filterQueued">${reviewQueuedCount}</span></button>
          <button type="button" class="decision-filter" data-review-filter="APPROVED" aria-pressed="false">Approved <span id="filterApproved">${view.reviews.approved}</span></button>
          <button type="button" class="decision-filter" data-review-filter="DENIED" aria-pressed="false">Denied <span id="filterDenied">${view.reviews.sludge}</span></button>
          <button type="button" class="decision-filter" data-review-filter="ALL" aria-pressed="${initialReviewFilter === 'ALL' ? 'true' : 'false'}">All <span id="filterAll">${view.reviews.items.length}</span></button>
        </div>
        <span class="decision-boundary">Session token plus evidence hash required. MCP tools can propose, but cannot resolve reviews.</span>
      </div>
      <div class="panel-body">
        <div id="reviews" class="reviews">${reviewCards}</div>
        <p id="reviewFilterEmpty" class="empty" hidden>No decisions match this filter.</p>
        <div class="exportbar">
          <button type="button" id="exportBtn" class="button" disabled>Export decisions</button>
          <button type="button" id="copyBtn" class="button" disabled>Copy decisions</button>
          <span id="exportNote" class="export-note"></span>
        </div>
      </div>
    </section>

    <section id="run-control" class="control-deck" aria-labelledby="run-control-title">
      <div class="contract">
        <div class="contract-head">
          <div>
            <h2 id="run-control-title">${realTest.enabled ? 'Strict real-test contract' : 'Campaign contract'}</h2>
            <p id="realTestStatus">${realTest.enabled ? value(realTest.status) : 'standard campaign mode'}</p>
          </div>
          <div class="contract-hash">
            <span>plan sha256</span>
            <strong id="planHash" title="${value(realTest.planSha256)}">${shortHash(realTest.planSha256)}</strong>
          </div>
        </div>
        <div class="budget-grid">
          <article class="budget-item">
            <div class="budget-copy">
              <div><small>Accepted findings</small><strong><span id="findingsDone">${realTest.enabled ? realTest.findingsAccepted : '--'}</span>/<span id="findingsCap">${realTest.enabled ? realTest.maxFindings : '--'}</span></strong></div>
              <span><b id="findingsRejected">${realTest.enabled ? realTest.findingsRejected : 0}</b> rejected<br />do not count</span>
            </div>
            <div class="budget-track" aria-label="Accepted findings budget"><i id="findingsBar" style="width:${findingsPercent}%"></i></div>
          </article>
          <article class="budget-item attempts">
            <div class="budget-copy">
              <div><small>Valid improvement attempts</small><strong><span id="attemptsDone">${realTest.enabled ? realTest.improvementAttempts : '--'}</span>/<span id="attemptsCap">${realTest.enabled ? realTest.maxImprovementAttempts : '--'}</span></strong></div>
              <span><b id="invalidAttempts">${realTest.enabled ? realTest.invalidAttempts : 0}</b> invalid<br />excluded</span>
            </div>
            <div class="budget-track" aria-label="Valid improvement attempts budget"><i id="attemptsBar" style="width:${attemptsPercent}%"></i></div>
          </article>
        </div>
      </div>
      <div class="trust-board">
        <h2>Evidence trust</h2>
        <div id="trustGrid" class="trust-grid">${trustMarkup}</div>
      </div>
    </section>

    <section id="experiment-validity" class="panel" aria-labelledby="validity-title">
      <div class="panel-head">
        <div><h2 id="validity-title">Experiment validity</h2><p>Machine-owned publication gate</p></div>
        <span id="validityStatus" class="status ${chipClass(validity.status)}">${escapeHtml(validity.status || 'UNKNOWN')}</span>
      </div>
      <div id="validityGrid" class="trust-grid">${validityDimensions}</div>
    </section>

    <section id="finding-coverage" class="panel" aria-labelledby="coverage-title">
      <div class="panel-head">
        <div><h2 id="coverage-title">Finding coverage</h2><p><span id="findingsTested">${realTest.findingsTested || 0}</span>/<span id="findingsAcceptedCoverage">${realTest.findingsAccepted || 0}</span> tested; blocked and untested findings remain visible</p></div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>finding</th><th>child run</th><th>baseline</th><th>hypotheses</th><th>valid</th><th>invalid</th><th>status</th></tr></thead>
          <tbody id="coverageRows">${coverageRows}</tbody>
        </table>
      </div>
    </section>

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
        <span id="policySource" class="status-detail">${value(view.policy.source)} · answers ${Object.entries(view.intake.answerSources).filter(([, count]) => count > 0).map(([source]) => source).join(', ') || 'none'}</span>
      </article>
      <article class="status-card">
        <h2>Continuation</h2>
        <span id="continuationState" class="status-value">${view.continuation.required ? 'Continuation required' : 'Continuation clear'}</span>
        <span id="nextTool" class="status-detail mono">${value(view.continuation.nextTool, 'ready')}</span>
      </article>
    </section>

    <div class="workspace">
      <div class="column main-column">
        <section id="work-queue" class="panel" aria-labelledby="phase-title">
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

        <section id="supervisor-verdicts" class="panel" aria-labelledby="verdict-title">
          <div class="panel-head">
            <div><h2 id="verdict-title">Supervisor verdict timeline</h2><p>Immutable worker decisions and receipts</p></div>
            <span id="verdictCount" class="status neutral">${view.verdicts.length} event(s)</span>
          </div>
          <ol id="verdictRows" class="verdict-list">${verdictRows}</ol>
        </section>

        <section id="measured-frontier" class="panel" aria-labelledby="score-title">
          <div class="panel-head">
            <div><h2 id="score-title">Score matrix</h2><p>Tool-measured frontier movement</p></div>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>id</th><th>route</th><th>quality</th><th>artifact output token estimate</th><th>CLI receipt token cost</th><th>delta q</th><th>delta cost</th><th>verify</th><th>verdict</th><th>promotion</th></tr></thead>
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

      <aside class="column side" aria-label="Policy and evidence">
        <section id="benchmark-integrity" class="panel">
          <div class="panel-head"><div><h2>Benchmark integrity</h2><p>Frozen authority and baseline bar</p></div></div>
          <div class="panel-body">
            <dl class="kv">
              <div><dt>baseline</dt><dd id="baselineState">${view.evidence.baselineLocked ? 'locked' : 'open'}</dd></div>
              <div><dt>baseline hash</dt><dd id="baselineHash" class="mono hash">${shortHash(view.evidence.baselineSha256)}</dd></div>
              <div><dt>baseline samples</dt><dd id="baselineSamples">${view.evidence.baselineSamples}</dd></div>
              <div><dt>benchmark</dt><dd id="benchmarkState">${view.evidence.benchmarkFrozen ? 'frozen' : 'open'}</dd></div>
              <div><dt>benchmark source</dt><dd id="benchmarkSource">${value(view.evidence.benchmarkSource)}</dd></div>
              <div><dt>cases</dt><dd id="benchmarkCases">${view.evidence.benchmarkCases}</dd></div>
              <div><dt>baseline quality</dt><dd id="baselineQuality">${value(view.evidence.baselineQuality)}</dd></div>
              <div><dt>quality authority</dt><dd id="baselineAuthority">${value(view.evidence.baselineQualityAuthority)}</dd></div>
              <div><dt>baseline artifact output token estimate</dt><dd id="baselineArtifactTokens">${value(view.evidence.baselineArtifactOutputTokenEstimate)}</dd></div>
              <div><dt>baseline CLI receipt token cost</dt><dd id="baselineCliTokens">${value(view.evidence.baselineCliReceiptTokenCost)}</dd></div>
              <div><dt>negative control</dt><dd id="negativeControl">${view.evidence.negativeControl ? value(view.evidence.negativeControl.status) : '--'}</dd></div>
              <div><dt>fixture overrides</dt><dd id="integrityOverrides">${view.evidence.integrityOverrideCount}</dd></div>
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
      var decisionTokenMeta = document.querySelector('meta[name="super-loop-decision-token"]');
      var decisionToken = decisionTokenMeta ? decisionTokenMeta.content : '';
      var reviewFilter = snapshot.reviews.awaiting > 0 ? 'PENDING' : (snapshot.reviews.queued > 0 ? 'QUEUED' : 'ALL');

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
        if(['ACTIVE','APPROVED','MOVED_FRONTIER','PROMOTE','REVERIFIED','PASS','COVERED'].indexOf(v)>=0) return 'success';
        if(['SLUDGE','DENIED','REJECTED','NO_IMPROVEMENT','SELF_PROMOTION','PHASE_SKIP','MODEL_REPORTED_METRIC','FAIL','BLOCKED'].indexOf(v)>=0) return 'danger';
        if(['PENDING','REQUIRED','SENDING','APPROVAL QUEUED','DENIAL QUEUED','DECISION STALE','SATURATED'].indexOf(v)>=0) return 'warning';
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
      function setTrust(id,value,state){
        var el=document.getElementById(id);
        if(!el) return;
        el.textContent=value||'--';
        var item=el.closest('.trust-item');
        if(item) item.className='trust-item '+(state||'neutral');
      }
      function renderRealTest(data){
        var rt=data.realTest||{enabled:false};
        text('realTestStatus',rt.enabled?(rt.status||'PREPARING'):'standard campaign mode');
        text('planHash',shortHash(rt.planSha256));
        var planHash=document.getElementById('planHash');
        if(planHash) planHash.title=rt.planSha256||'--';
        text('findingsDone',rt.enabled?rt.findingsAccepted:'--');
        text('findingsCap',rt.enabled?rt.maxFindings:'--');
        text('findingsRejected',rt.enabled?rt.findingsRejected:0);
        text('attemptsDone',rt.enabled?rt.improvementAttempts:'--');
        text('attemptsCap',rt.enabled?rt.maxImprovementAttempts:'--');
        text('invalidAttempts',rt.enabled?rt.invalidAttempts:0);
        document.getElementById('findingsBar').style.width=(rt.enabled&&rt.maxFindings>0?Math.min(100,Math.round((rt.findingsAccepted/rt.maxFindings)*100)):0)+'%';
        document.getElementById('attemptsBar').style.width=(rt.enabled&&rt.maxImprovementAttempts>0?Math.min(100,Math.round((rt.improvementAttempts/rt.maxImprovementAttempts)*100)):0)+'%';
        setTrust('trustPlan',rt.enabled?(rt.planApproved?'verified':'not approved'):'standard mode',rt.enabled?(rt.planApproved?'verified':'blocked'):'neutral');
        setTrust('trustBenchmark',data.evidence.benchmarkSource||rt.benchmarkAuthority||'not frozen',data.evidence.benchmarkFrozen?(data.evidence.benchmarkSource==='maker'?'verified':'blocked'):'pending');
        setTrust('trustBaseline',data.evidence.baselineSamples>0?data.evidence.baselineSamples+' captured run(s)':'not measured',data.evidence.baselineSamples>=(rt.enabled?3:1)?'verified':(data.evidence.baselineSamples===0?'pending':'blocked'));
        setTrust('trustQuality',data.evidence.baselineQualityAuthority||'not measured',data.evidence.baselineQualityAuthority==='tool-computed'?'verified':(data.evidence.baselineQualityAuthority?'blocked':'pending'));
        var nc=data.evidence.negativeControl;
        setTrust('trustNegative',nc?String(nc.status||'--').replace(/_/g,' ').toLowerCase():'not recorded',nc&&nc.status==='FAILED_AS_EXPECTED'?'verified':(nc?'blocked':'pending'));
        setTrust('trustOverrides',data.evidence.integrityOverrideCount===0?'none':String(data.evidence.integrityOverrideCount),data.evidence.integrityOverrideCount===0?'verified':'blocked');
        text('findingsTested',rt.findingsTested||0);
        text('findingsAcceptedCoverage',rt.findingsAccepted||0);
        var coverageRows=document.getElementById('coverageRows');
        if(coverageRows){
          coverageRows.innerHTML=rt.coverage&&rt.coverage.length?rt.coverage.map(function(entry){
            return '<tr data-finding="'+esc(entry.findingId)+'"><td class="mono">'+esc(entry.findingId)+'</td><td class="mono">'+esc(entry.childRunId||'--')+'</td><td class="mono" title="'+esc(entry.baselineSha256||'--')+'">'+esc(shortHash(entry.baselineSha256))+'</td><td class="mono">'+esc((entry.hypothesisIds||[]).join(', '))+'</td><td class="num">'+entry.valid+'/'+entry.planned+'</td><td class="num">'+entry.invalid+'</td><td><span class="status '+tone(entry.status)+'">'+esc(entry.status||'UNTESTED')+'</span></td></tr>';
          }).join(''):'<tr><td colspan="7" class="empty-cell">No accepted finding coverage recorded.</td></tr>';
        }
        var validity=rt.experimentValidity||{status:'UNKNOWN'};
        setStatus(document.getElementById('validityStatus'),validity.status||'UNKNOWN');
        var validityGrid=document.getElementById('validityGrid');
        if(validityGrid){
          validityGrid.innerHTML=['execution','targetGrounding','benchmark','isolation','comparability','coverage','promotionSafety','stateConsistency'].map(function(key){
            var dimension=validity[key]||{status:'UNKNOWN'};
            var state=dimension.status==='PASS'?'verified':(dimension.status==='FAIL'?'blocked':'pending');
            return '<div class="trust-item '+state+'"><span class="trust-mark" aria-hidden="true"></span><span><small>'+esc(key.replace(/([A-Z])/g,' $1'))+'</small><strong>'+esc(dimension.status||'UNKNOWN')+'</strong></span></div>';
          }).join('');
        }
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
          var requestLabel=receipt.modelSelectionAuthority==='explicit-model-flag'?'explicit -m flag':(receipt.modelSelectionAuthority||'unknown request');
          return '<li class="verdict" data-verdict="'+esc(event.id)+'"><div class="verdict-mark '+(event.accepted?'accepted':'blocked')+'" aria-hidden="true"></div><div class="verdict-main"><div class="row-head"><strong>'+esc(event.scenario||event.type||event.id)+'</strong><span class="status '+tone(outcome)+'">'+esc(outcome)+'</span></div><div class="meta-line"><span class="mono">'+esc(event.route||'--')+'</span><span>phase '+(event.phase==null?'--':event.phase)+'</span><span>'+esc(event.ts||'--')+'</span></div><details><summary>Invocation receipt</summary><dl class="receipt"><div class="wide"><dt>model identity</dt><dd>requested via '+esc(requestLabel)+'; backend-reported model: '+esc(receipt.reportedModel||'null')+'</dd></div><div><dt>duration</dt><dd>'+(receipt.durationMs==null?'--':receipt.durationMs+' ms')+'</dd></div><div><dt>CLI reported total tokens</dt><dd>'+(receipt.cliReportedTotalTokens==null?'--':receipt.cliReportedTotalTokens)+'</dd></div><div class="wide"><dt>stdout</dt><dd class="mono">'+esc(shortHash(receipt.stdoutSha256))+'</dd></div><div class="wide"><dt>argv</dt><dd class="mono command">'+esc((receipt.argv||[]).join(' '))+'</dd></div></dl></details></div></li>';
        }).join('');
      }
      function renderScore(data){
        var rows=document.getElementById('scoreRows');
        if(!data.scoreMatrix.length){rows.innerHTML='<tr><td colspan="10" class="empty-cell">No measured hypotheses.</td></tr>';return;}
        rows.innerHTML=data.scoreMatrix.map(function(row){
          return '<tr data-hypothesis="'+esc(row.hypothesisId)+'"><td class="mono">'+esc(row.hypothesisId)+'</td><td class="mono">'+esc(row.route||'--')+'</td><td class="num">'+(row.measured?esc(row.quality):'unmeasured')+'</td><td class="num">'+(row.artifactOutputTokenEstimate==null?'--':row.artifactOutputTokenEstimate)+'</td><td class="num">'+(row.cliReceiptTokenCost==null?'--':row.cliReceiptTokenCost)+'</td><td class="num">'+(row.deltaQuality==null?'--':(row.deltaQuality>0?'+':'')+row.deltaQuality)+'</td><td class="num">'+esc(pctValue(row.deltaCostPct))+'</td><td><span class="status '+(row.reverified?'success':'neutral')+'">'+(row.reverified?'reverified':'--')+'</span></td><td><span class="status '+tone(row.verdict)+'">'+esc(row.verdict||'--')+'</span></td><td><span class="status '+(row.promotable?'success':'neutral')+'">'+(row.promotable?'promotable':'blocked')+'</span></td></tr>';
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
      function reviewIsQueued(review){
        return review.status==='PENDING'
          && ['approve','sludge'].indexOf(review.queuedDecision)>=0
          && review.queueBindingValid===true;
      }
      function reviewIsStale(review){
        return review.status==='PENDING'
          && ['approve','sludge'].indexOf(review.queuedDecision)>=0
          && review.queueBindingValid===false;
      }
      function reviewStatusLabel(review){
        if(reviewIsQueued(review)) return review.queuedDecision==='approve'?'APPROVAL QUEUED':'DENIAL QUEUED';
        if(reviewIsStale(review)) return 'DECISION STALE';
        return String(review.status||'').toUpperCase()==='SLUDGE'?'DENIED':String(review.status||'UNKNOWN').toUpperCase();
      }
      function reviewFilterStatus(review){
        if(reviewIsQueued(review)) return 'QUEUED';
        return String(review.status||'').toUpperCase()==='SLUDGE'?'DENIED':String(review.status||'UNKNOWN').toUpperCase();
      }
      function reviewImpact(review){
        if(review.kind==='promotion') return "Approve banks this measured candidate as the run's internal champion after the supervisor rechecks the unchanged promotion gate.";
        if(review.hasLoopContent&&review.loopId) return 'Approve installs a new version of the named custom loop. Mandated canonical loops remain immutable.';
        return 'Approve records this operator disposition. Deny closes it without adoption or promotion.';
      }
      function reviewScore(review,data){
        return (data.scoreMatrix||[]).find(function(row){return row.hypothesisId===review.hypothesisId;})||null;
      }
      function reviewProofMarkup(review,data){
        var row=reviewScore(review,data);
        var facts=row?[
          ['quality',row.measured?row.quality:'unmeasured'],
          ['delta quality',row.deltaQuality==null?'--':(row.deltaQuality>0?'+':'')+row.deltaQuality],
          ['delta cost',pctValue(row.deltaCostPct)],
          ['reverified',row.reverified?'yes':'no'],
          ['verdict',row.verdict||'--']
        ]:[
          ['evidence link',review.evidenceRef||'--'],
          ['loop payload',review.hasLoopContent?'present':'none'],
          ['authority','operator only']
        ];
        return facts.map(function(fact){
          return '<span><small>'+esc(fact[0])+'</small><strong>'+esc(fact[1])+'</strong></span>';
        }).join('');
      }
      function reviewStateText(review){
        var status=reviewStatusLabel(review);
        if(status==='APPROVAL QUEUED'||status==='DENIAL QUEUED') return 'Queued locally. Waiting for the supervisor to revalidate and apply persisted state.';
        if(status==='DECISION STALE') return 'The queued decision no longer matches current evidence. Review the updated binding and decide again.';
        if(status==='APPROVED') return 'Applied by the supervisor.';
        if(status==='DENIED') return 'Denied by the operator.';
        if(review.decisionError) return 'Last queued decision rejected: '+review.decisionError+'. Review and decide again.';
        return 'Awaiting operator decision.';
      }
      function reviewMarkup(review,data){
        var resolved=review.status!=='PENDING';
        var queued=reviewIsQueued(review);
        var locked=resolved||queued;
        var disabled=locked?' disabled':'';
        var status=reviewStatusLabel(review);
        var filterStatus=reviewFilterStatus(review);
        var notesId='notes-'+review.id;
        return '<article class="review" data-review="'+esc(review.id)+'" data-review-status="'+esc(filterStatus)+'" data-review-sha="'+esc(review.decisionBindingSha256||'')+'" data-submitted="'+(queued?'true':'false')+'"><div class="review-evidence"><header class="review-head"><div><span class="review-sequence">Decision '+esc(review.id)+'</span><strong>'+esc(review.kind||'candidate change')+'</strong></div><span class="status '+tone(status)+'" data-status>'+esc(status)+'</span></header><p class="review-impact"><strong>Effect of approval</strong><span>'+esc(reviewImpact(review))+'</span></p><dl class="review-meta"><div><dt>hypothesis</dt><dd class="mono">'+esc(review.hypothesisId||'--')+'</dd></div><div><dt>evidence</dt><dd class="mono">'+esc(review.evidenceRef||'--')+'</dd></div><div><dt>loop</dt><dd class="mono">'+esc(review.loopId||'--')+'</dd></div><div><dt>decision hash</dt><dd class="mono" data-review-binding title="'+esc(review.decisionBindingSha256||'')+'">'+esc(shortHash(review.decisionBindingSha256))+'</dd></div></dl><div class="review-proof" data-review-proof aria-label="Measured evidence">'+reviewProofMarkup(review,data)+'</div></div><div class="review-decision"><div class="authority-lock"><span class="authority-mark" aria-hidden="true"></span><span><strong>Session-authorized operator action</strong><small>The MCP tool surface cannot resolve reviews. This local browser session queues a hash-bound decision for supervisor revalidation.</small></span></div><div class="review-actions" role="group" aria-label="Choose a decision for '+esc(review.id)+'"><button type="button" class="button approve" data-act="approve" aria-pressed="false"'+disabled+'>Approve</button><button type="button" class="button sludge" data-act="sludge" aria-pressed="false"'+disabled+'>Deny</button></div><label class="notes-label" for="'+esc(notesId)+'">Decision rationale <span>optional</span></label><textarea id="'+esc(notesId)+'" class="notes" rows="3" placeholder="Record why this evidence is or is not sufficient."'+disabled+'></textarea><button type="button" class="button decision-submit" data-submit disabled>'+(resolved?'Decision applied':(queued?'Decision queued':'Choose approve or deny'))+'</button><p class="decision-state" data-decision-state>'+esc(reviewStateText(review))+'</p></div></article>';
      }
      function applyReviewFilter(){
        var visible=0;
        document.querySelectorAll('[data-review]').forEach(function(card){
          var status=card.getAttribute('data-review-status')||'UNKNOWN';
          var show=reviewFilter==='ALL'||status===reviewFilter;
          card.hidden=!show;
          if(show) visible+=1;
        });
        document.querySelectorAll('[data-review-filter]').forEach(function(button){
          button.setAttribute('aria-pressed',button.getAttribute('data-review-filter')===reviewFilter?'true':'false');
        });
        var empty=document.getElementById('reviewFilterEmpty');
        if(empty) empty.hidden=visible!==0||snapshot.reviews.items.length===0;
      }
      function renderReviews(data){
        var awaiting=Number.isFinite(data.reviews.awaiting)?data.reviews.awaiting:data.reviews.pending;
        var queuedCount=Number.isFinite(data.reviews.queued)?data.reviews.queued:0;
        text('reviewCount',awaiting);
        text('reviewQueued',queuedCount);
        text('reviewApproved',data.reviews.approved);
        text('reviewDenied',data.reviews.sludge);
        text('filterPending',awaiting);
        text('filterQueued',queuedCount);
        text('filterApproved',data.reviews.approved);
        text('filterDenied',data.reviews.sludge);
        text('filterAll',data.reviews.items.length);
        var panel=document.getElementById('operator-review');
        panel.className='panel review-panel '+(data.reviews.pending?'needs-decision':'is-clear');
        var holder=document.getElementById('reviews');
        var seen={};
        var ordered=data.reviews.items.slice().sort(function(a,b){
          var priority=function(review){
            var filterStatus=reviewFilterStatus(review);
            return filterStatus==='PENDING'?0:(filterStatus==='QUEUED'?1:2);
          };
          return priority(a)-priority(b)||String(b.ts||'').localeCompare(String(a.ts||''));
        });
        if(ordered.length){
          var empty=holder.querySelector('.decision-empty');
          if(empty) empty.remove();
        }
        ordered.forEach(function(review){
          seen[review.id]=true;
          var card=holder.querySelector('[data-review="'+review.id+'"]');
          if(!card){
            holder.insertAdjacentHTML('beforeend',reviewMarkup(review,data));
            card=holder.querySelector('[data-review="'+review.id+'"]');
          }
          var previousBinding=card.getAttribute('data-review-sha')||'';
          var currentBinding=review.decisionBindingSha256||'';
          var draft=decisions[review.id]||null;
          if(draft&&draft.reviewSha256!==currentBinding){
            delete decisions[review.id];
            draft=null;
          }
          card.setAttribute('data-review-sha',currentBinding);
          var bindingEl=card.querySelector('[data-review-binding]');
          if(bindingEl){
            bindingEl.textContent=shortHash(currentBinding);
            bindingEl.title=currentBinding;
          }
          var status=reviewStatusLabel(review);
          var filterStatus=reviewFilterStatus(review);
          var queued=reviewIsQueued(review);
          var stale=reviewIsStale(review);
          var submitted=card.getAttribute('data-submitted')==='true';
          var sending=card.getAttribute('data-sending')==='true';
          card.setAttribute('data-review-status',filterStatus);
          var proof=card.querySelector('[data-review-proof]');
          if(proof) proof.innerHTML=reviewProofMarkup(review,data);
          if(review.status!=='PENDING'){
            delete decisions[review.id];
            card.setAttribute('data-submitted','false');
            card.setAttribute('data-sending','false');
            submitted=false;
            sending=false;
            setStatus(card.querySelector('[data-status]'),status);
            card.querySelector('[data-decision-state]').textContent=reviewStateText(review);
          }else if(queued){
            delete decisions[review.id];
            draft=null;
            card.setAttribute('data-submitted','true');
            card.setAttribute('data-sending','false');
            submitted=true;
            sending=false;
            setStatus(card.querySelector('[data-status]'),status);
            card.querySelector('[data-decision-state]').textContent=reviewStateText(review);
          }else{
            if(submitted){
              card.setAttribute('data-submitted','false');
              submitted=false;
            }
            if(!sending) setStatus(card.querySelector('[data-status]'),status);
          }
          draft=decisions[review.id]||null;
          var locked=review.status!=='PENDING'||queued||sending;
          card.querySelectorAll('[data-act]').forEach(function(button){
            button.disabled=locked;
            button.setAttribute('aria-pressed',draft&&draft.decision===button.getAttribute('data-act')?'true':'false');
          });
          card.querySelector('.notes').disabled=locked;
          var submit=card.querySelector('[data-submit]');
          submit.disabled=locked||!draft;
          if(review.status!=='PENDING') submit.textContent='Decision applied';
          else if(sending) submit.textContent='Sending decision';
          else if(queued) submit.textContent='Decision queued';
          else if(draft) submit.textContent=draft.decision==='approve'?'Queue approval':'Queue denial';
          else submit.textContent='Choose approve or deny';
          if(review.status==='PENDING'&&!sending&&!queued){
            var stateText=reviewStateText(review);
            if(previousBinding&&previousBinding!==currentBinding&&!stale&&!review.decisionError){
              stateText='Evidence changed. Review the new decision hash before choosing again.';
            }else if(draft){
              stateText=draft.decision==='approve'?'Approval selected. Queue to confirm.':'Denial selected. Queue to confirm.';
            }
            card.querySelector('[data-decision-state]').textContent=stateText;
          }
        });
        holder.querySelectorAll('[data-review]').forEach(function(card){
          if(!seen[card.getAttribute('data-review')]&&card.getAttribute('data-sending')!=='true') card.remove();
        });
        if(!ordered.length){
          holder.innerHTML='<div class="decision-empty"><strong>Decision queue clear</strong><span>No candidate currently requires operator approval or denial.</span></div>';
          reviewFilter='ALL';
        }else if(reviewFilter==='PENDING'&&awaiting===0){
          reviewFilter=queuedCount>0?'QUEUED':'ALL';
        }else if(reviewFilter==='QUEUED'&&queuedCount===0){
          reviewFilter=awaiting>0?'PENDING':'ALL';
        }
        snapshot=data;
        enableExport();
        applyReviewFilter();
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
        text('baselineSamples',data.evidence.baselineSamples);
        text('benchmarkState',data.evidence.benchmarkFrozen?'frozen':'open');
        text('benchmarkSource',data.evidence.benchmarkSource);
        text('benchmarkCases',data.evidence.benchmarkCases);
        text('baselineQuality',data.evidence.baselineQuality);
        text('baselineAuthority',data.evidence.baselineQualityAuthority);
        text('baselineArtifactTokens',data.evidence.baselineArtifactOutputTokenEstimate);
        text('baselineCliTokens',data.evidence.baselineCliReceiptTokenCost);
        text('negativeControl',data.evidence.negativeControl&&data.evidence.negativeControl.status);
        text('integrityOverrides',data.evidence.integrityOverrideCount);
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
        renderRealTest(data);renderLoops(data);renderLanes(data);renderVerdicts(data);renderScore(data);renderActivity(data);renderReviews(data);markTableOverflow();
      }
      function postDecision(id,act,card){
        var statusEl=card.querySelector('[data-status]');
        var stateEl=card.querySelector('[data-decision-state]');
        var submit=card.querySelector('[data-submit]');
        if(isFileProtocol()){
          statusEl.textContent='local draft - export to apply';
          statusEl.className='status warning';
          stateEl.textContent='Local draft ready. Use Export decisions below to apply it through the run inbox.';
          submit.textContent='Use export below';
          submit.disabled=true;
          announce('local draft - export to apply');
          return;
        }
        card.setAttribute('data-sending','true');
        statusEl.textContent='SENDING';
        statusEl.className='status warning';
        stateEl.textContent='Sending the decision to the local run inbox.';
        submit.textContent='Sending decision';
        submit.disabled=true;
        card.querySelectorAll('[data-act]').forEach(function(button){button.disabled=true;});
        card.querySelector('.notes').disabled=true;
        fetch('/apply',{method:'POST',headers:{'content-type':'application/json','x-super-loop-decision-token':decisionToken},body:JSON.stringify({runId:runId,reviewId:id,decision:act,notes:decisions[id].notes,reviewSha256:decisions[id].reviewSha256})})
          .then(function(response){
            return response.json().catch(function(){return {error:'decision queue failed'};}).then(function(result){
              if(!response.ok) throw new Error(result.error||'decision queue failed');
              return result;
            });
          })
          .then(function(result){
            statusEl.textContent=act==='approve'?'APPROVAL QUEUED':'DENIAL QUEUED';
            statusEl.className='status warning';
            card.setAttribute('data-sending','false');
            card.setAttribute('data-submitted','true');
            card.setAttribute('data-review-status','QUEUED');
            submit.textContent='Decision queued';
            card.querySelectorAll('[data-act]').forEach(function(button){button.disabled=true;});
            card.querySelector('.notes').disabled=true;
            delete decisions[id];
            enableExport();
            stateEl.textContent='Queued locally. Waiting for the supervisor to revalidate and apply persisted state.';
            announce((result.state||act+' queued')+' for '+id);
            pollRun();
          })
          .catch(function(error){
            statusEl.textContent='PENDING';
            statusEl.className='status warning';
            card.setAttribute('data-sending','false');
            card.setAttribute('data-submitted','false');
            card.querySelectorAll('[data-act]').forEach(function(button){button.disabled=false;});
            card.querySelector('.notes').disabled=false;
            submit.disabled=false;
            submit.textContent='Retry queue';
            stateEl.textContent='Decision was not queued: '+(error&&error.message?error.message:'review the connection')+'. Reload evidence and retry, or export the draft.';
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
        var button=event.target.closest('[data-act],[data-submit]');
        if(!button||button.disabled) return;
        var card=button.closest('[data-review]');
        var id=card.getAttribute('data-review');
        if(button.hasAttribute('data-submit')){
          var draft=decisions[id];
          if(draft) postDecision(id,draft.decision,card);
          return;
        }
        var act=button.getAttribute('data-act');
        card.querySelectorAll('[data-act]').forEach(function(item){item.setAttribute('aria-pressed',item===button?'true':'false');});
        decisions[id]={decision:act,notes:(card.querySelector('.notes').value||null),reviewSha256:card.getAttribute('data-review-sha')||null};
        var submit=card.querySelector('[data-submit]');
        submit.disabled=false;
        submit.textContent=act==='approve'?'Queue approval':'Queue denial';
        card.querySelector('[data-decision-state]').textContent=act==='approve'
          ? 'Approval selected. Queue to confirm.'
          : 'Denial selected. Queue to confirm.';
        if(isFileProtocol()){
          var statusEl=card.querySelector('[data-status]');
          statusEl.textContent='local draft - export to apply';
          statusEl.className='status warning';
        }
        enableExport();
      });
      document.getElementById('reviews').addEventListener('input',function(event){
        if(!event.target.classList.contains('notes')) return;
        var card=event.target.closest('[data-review]');
        var id=card.getAttribute('data-review');
        if(decisions[id]) decisions[id].notes=event.target.value||null;
      });
      document.querySelectorAll('[data-review-filter]').forEach(function(button){
        button.addEventListener('click',function(){
          reviewFilter=button.getAttribute('data-review-filter')||'ALL';
          applyReviewFilter();
          announce('Showing '+reviewFilter.toLowerCase()+' decisions');
        });
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
  lines.push(`- **status**: ${state.realTest && state.realTest.enabled ? state.realTest.status : state.status}  (campaign completion requires the operator)`);
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
  const answerSources = (state.answers || []).reduce((counts, answer) => {
    const source = ['operator', 'config', 'default'].includes(answer && answer.source) ? answer.source : 'operator';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, { operator: 0, config: 0, default: 0 });
  lines.push(`- answerSource: operator=${answerSources.operator}; config=${answerSources.config}; default=${answerSources.default}`);
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
    lines.push(b.baselineScore
      ? `- baseline bar: quality ${b.baselineScore.quality}, artifactOutputTokenEstimate ${b.baselineScore.artifactOutputTokenEstimate ?? b.baselineScore.tokenCost}, cliReceiptTokenCost ${b.baselineScore.cliReceiptTokenCost ?? '—'}`
      : '- baseline bar: NOT measured');
  } else {
    lines.push('- not frozen');
  }
  lines.push('');
  const realTest = state.realTest && state.realTest.enabled ? state.realTest : null;
  if (realTest) {
    lines.push('## Finding coverage');
    lines.push(`- findings tested: ${realTest.findingsTested || 0}/${realTest.findingsAccepted || 0}`);
    lines.push(`- attempts: planned ${realTest.attemptsPlanned || 0}; valid ${realTest.attemptsValid || 0}; invalid ${realTest.attemptsInvalid || 0}`);
    lines.push('| finding | child run | baseline sha256 | hypotheses | valid | invalid | status |');
    lines.push('|---------|-----------|-----------------|------------|-------|---------|--------|');
    for (const item of realTest.coverage || []) {
      lines.push(`| ${item.findingId} | ${item.childRunId || '—'} | ${item.baselineSha256 || '—'} | ${(item.hypothesisIds || []).join(', ')} | ${item.valid}/${item.planned} | ${item.invalid} | ${item.status} |`);
    }
    if (!(realTest.coverage || []).length) lines.push('| (none) | | | | | | UNTESTED |');
    lines.push('');
    const validity = realTest.experimentValidity || null;
    lines.push('## Experiment validity');
    for (const key of [
      'execution', 'targetGrounding', 'benchmark', 'isolation',
      'comparability', 'coverage', 'promotionSafety', 'stateConsistency'
    ]) {
      const dimension = validity && validity[key];
      lines.push(`- ${key}: ${dimension && dimension.status || 'UNKNOWN'}${dimension && dimension.reasons && dimension.reasons.length ? ` — ${dimension.reasons.join('; ')}` : ''}`);
    }
    lines.push(`- publicationEligible: ${validity ? validity.publicationEligible === true : false}`);
    lines.push('');
  }
  lines.push(`## Score matrix`);
  lines.push(`_quality authority: \`tool\` = MCP-derived against the frozen oracle (auto-promotable); \`caller→dashboard\` = subjective, human-gated, never auto-promotes._`);
  lines.push('| id | route | quality | artifactOutputTokenEstimate | cliReceiptTokenCost | Δquality | Δcost% | reverified | q-auth | verdict | promotable |');
  lines.push('|----|-------|---------|-----------------------------|---------------------|----------|--------|------------|--------|---------|------------|');
  for (const r of matrix) {
    const qauth = r.qualityAuthority === 'tool-computed' ? 'tool' : r.qualityAuthority ? 'caller→dashboard' : '—';
    lines.push(`| ${r.hypothesisId} | ${r.route && r.route.model || '—'} | ${r.measured ? r.quality : 'unmeasured'} | ${r.artifactOutputTokenEstimate ?? '—'} | ${r.cliReceiptTokenCost ?? '—'} | ${r.deltaQuality ?? '—'} | ${r.deltaCostPct == null ? '—' : (r.deltaCostPct * 100).toFixed(1) + '%'} | ${r.reverified ? 'yes' : 'no'} | ${qauth} | ${r.verdict} | ${r.promotable ? 'yes' : 'no'} |`);
  }
  if (!matrix.length) lines.push('| (none) | | | | | | | | | | |');
  lines.push('');
  lines.push('## Execution evidence');
  let executionRows = 0;
  for (const test of state.tests || []) {
    for (const run of test.agentRuns || []) {
      if (!run.rawArtifactRef && !run.resultArtifactRef) continue;
      executionRows++;
      const requestLabel = run.modelSelectionAuthority === 'explicit-model-flag' ? 'explicit -m flag' : (run.modelSelectionAuthority || 'unknown request');
      lines.push(`- ${test.id}/${run.model}: raw=${run.rawArtifactRef || '—'}; final=${run.resultArtifactRef || '—'}; evaluation=${run.evaluationArtifactRef || '—'}; artifactOutputTokenEstimate=${run.artifactOutputTokenEstimate ?? 'unavailable'}; cliReceiptTokenCost=${run.cliReceiptTokenCost ?? 'unavailable'}; cliReportedTotalTokens=${run.cliReportedTotalTokens ?? 'unavailable'}; durationMs=${run.durationMs ?? 'unavailable'}; isolation=${run.isolation && run.isolation.status || 'UNKNOWN'}; requested via ${requestLabel}; backend-reported model: ${run.reportedModel ?? 'null'}`);
    }
  }
  if (!executionRows) lines.push('- none recorded');
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
