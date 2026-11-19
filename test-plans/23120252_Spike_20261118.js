import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  parseCsv,
  runEshopWorkflow,
  validateWorkflowData,
} from './lib/eshop-workflow.js';

// DESIGN ONLY: execution requires explicit human approval and a new RUN_ID.
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RUN_ID = __ENV.RUN_ID;
const OUTPUT_DIR = __ENV.OUTPUT_DIR || 'results';
const MAX_VUS = 40;
const BASELINE_SECONDS = 90;
const SPIKE_RAMP_SECONDS = 5;
const SPIKE_HOLD_SECONDS = 90;
const RECOVERY_DROP_SECONDS = 5;
const RECOVERY_HOLD_SECONDS = 120;

if (!RUN_ID) {
  throw new Error('RUN_ID is required before execution so Spike outputs cannot overwrite prior evidence.');
}

const accounts = new SharedArray('spike accounts', () => parseCsv(open('../test-data/stress_accounts.local.csv')));
const products = new SharedArray('spike products', () => parseCsv(open('../test-data/products.csv')));
validateWorkflowData(accounts, products, MAX_VUS);

export const options = {
  scenarios: {
    spike_workflow: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '90s', target: 10 },
        { duration: '5s', target: 40 },
        { duration: '90s', target: 40 },
        { duration: '5s', target: 10 },
        { duration: '120s', target: 10 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
      exec: 'spikeWorkflow',
      tags: { test_type: 'spike', workflow: 'purchase-confirmation' },
    },
  },
  thresholds: {
    // Safety aborts only. They are intentionally not capacity or recovery claims.
    http_req_duration: [{ threshold: 'p(95)<5000', abortOnFail: true, delayAbortEval: '20s' }],
    http_req_failed: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '15s' }],
    business_checks_pass: [{ threshold: 'rate>=0.90', abortOnFail: true, delayAbortEval: '15s' }],
    workflow_success: [{ threshold: 'rate>=0.90', abortOnFail: true, delayAbortEval: '15s' }],
    authentication_failures: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '1s' }],
    overload_failures: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '15s' }],
  },
};

const phaseMetrics = Object.fromEntries([
  'baseline',
  'spike_transition',
  'spike_peak',
  'recovery_transition',
  'recovery_hold',
].map((phase) => [
  phase,
  {
    duration: new Trend(`spike_${phase}_http_duration_ms`, true),
    failed: new Rate(`spike_${phase}_http_failed`),
    checks: new Rate(`spike_${phase}_business_checks_pass`),
    requests: new Counter(`spike_${phase}_http_requests`),
    workflows: new Rate(`spike_${phase}_workflow_success`),
  },
]));

const recoveryFirstSuccessfulWorkflowMs = new Trend('spike_recovery_first_successful_workflow_ms', true);

function phaseForElapsed(elapsedMs) {
  if (elapsedMs < BASELINE_SECONDS * 1000) return { name: 'baseline', target: 10 };
  if (elapsedMs < (BASELINE_SECONDS + SPIKE_RAMP_SECONDS) * 1000) return { name: 'spike_transition', target: 40 };
  if (elapsedMs < (BASELINE_SECONDS + SPIKE_RAMP_SECONDS + SPIKE_HOLD_SECONDS) * 1000) return { name: 'spike_peak', target: 40 };
  if (elapsedMs < (BASELINE_SECONDS + SPIKE_RAMP_SECONDS + SPIKE_HOLD_SECONDS + RECOVERY_DROP_SECONDS) * 1000) {
    return { name: 'recovery_transition', target: 10 };
  }
  if (elapsedMs < (BASELINE_SECONDS + SPIKE_RAMP_SECONDS + SPIKE_HOLD_SECONDS + RECOVERY_DROP_SECONDS + RECOVERY_HOLD_SECONDS) * 1000) {
    return { name: 'recovery_hold', target: 10 };
  }
  return { name: 'ramp_down', target: 0 };
}

const spikeHooks = {
  onResponse(response, tags) {
    const metrics = phaseMetrics[tags.spike_phase];
    if (metrics) {
      metrics.duration.add(response.timings.duration);
      metrics.failed.add(response.status === 0 || response.status >= 400);
      metrics.requests.add(1);
    }
  },
  onStep(passed, tags) {
    const metrics = phaseMetrics[tags.spike_phase];
    if (metrics) metrics.checks.add(passed);
  },
  onWorkflow(passed, tags) {
    const metrics = phaseMetrics[tags.spike_phase];
    if (metrics) metrics.workflows.add(passed);
  },
};

export function spikeWorkflow() {
  const elapsedMs = exec.instance.currentTestRunDuration;
  const phase = phaseForElapsed(elapsedMs);
  const passed = runEshopWorkflow({
    accounts,
    products,
    baseUrl: BASE_URL,
    stageTags: { spike_phase: phase.name, target_vus: String(phase.target) },
    hooks: spikeHooks,
    thinkTimeRange: { min: 1, max: 3 },
  });
  if (phase.name === 'recovery_hold' && passed) {
    const recoveryHoldStartMs = (BASELINE_SECONDS + SPIKE_RAMP_SECONDS + SPIKE_HOLD_SECONDS + RECOVERY_DROP_SECONDS) * 1000;
    recoveryFirstSuccessfulWorkflowMs.add(Math.max(0, elapsedMs - recoveryHoldStartMs));
  }
}

function value(data, metric, key) {
  return data.metrics[metric] && data.metrics[metric].values
    ? data.metrics[metric].values[key]
    : null;
}

function number(value, digits = 3) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'N/A';
}

function rate(value) {
  return Number.isFinite(value) ? `${(100 * value).toFixed(3)}%` : 'N/A';
}

function phaseCard(data, phase, durationSeconds, label) {
  const prefix = `spike_${phase}_`;
  const requests = value(data, `${prefix}http_requests`, 'count');
  return `<article><h2>${label}</h2><dl>`
    + `<dt>Requests</dt><dd>${number(requests, 0)}</dd>`
    + `<dt>RPS</dt><dd>${number(Number.isFinite(requests) ? requests / durationSeconds : null)}</dd>`
    + `<dt>Average</dt><dd>${number(value(data, `${prefix}http_duration_ms`, 'avg'))} ms</dd>`
    + `<dt>p95</dt><dd>${number(value(data, `${prefix}http_duration_ms`, 'p(95)'))} ms</dd>`
    + `<dt>HTTP failed</dt><dd>${rate(value(data, `${prefix}http_failed`, 'rate'))}</dd>`
    + `<dt>Business checks</dt><dd>${rate(value(data, `${prefix}business_checks_pass`, 'rate'))}</dd>`
    + `<dt>Workflow success</dt><dd>${rate(value(data, `${prefix}workflow_success`, 'rate'))}</dd>`
    + '</dl></article>';
}

function spikeTimelineHtml(data) {
  const firstRecovery = value(data, 'spike_recovery_first_successful_workflow_ms', 'min');
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<title>HW05 Spike phase timeline ${RUN_ID}</title>`
    + '<style>body{font-family:Arial,sans-serif;margin:2rem;max-width:1100px}.timeline{display:flex;height:2.5rem;margin:1rem 0}.baseline{background:#4e79a7;flex:90}.transition{background:#f28e2b;flex:5}.peak{background:#e15759;flex:90}.recovery{background:#59a14f;flex:125}.timeline span{color:#fff;padding:.6rem;overflow:hidden;white-space:nowrap}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}article{border:1px solid #bbb;padding:1rem}dl{display:grid;grid-template-columns:1fr 1fr;margin:0}dt,dd{padding:.25rem 0}.note{background:#fff4ce;padding:1rem}</style></head><body>'
    + `<h1>HW05 Spike phase timeline</h1><p>Run ID: <code>${RUN_ID}</code></p>`
    + '<div class="timeline"><span class="baseline">Baseline 10 VU</span><span class="transition">↑</span><span class="peak">40 VU spike</span><span class="transition">↓</span><span class="recovery">10 VU recovery</span></div>'
    + '<main>'
    + phaseCard(data, 'baseline', BASELINE_SECONDS, 'Baseline: 10 VU / 90 s')
    + phaseCard(data, 'spike_peak', SPIKE_HOLD_SECONDS, 'Spike peak: 40 VU / 90 s')
    + phaseCard(data, 'recovery_hold', RECOVERY_HOLD_SECONDS, 'Recovery hold: 10 VU / 120 s')
    + '</main>'
    + `<p class="note">Earliest successful recovery workflow after the drop: ${number(firstRecovery)} ms. This is not by itself a baseline-recovery time. Determine recovery time from 15-second raw-metric windows using the documented p95/error/success criteria.</p>`
    + '</body></html>';
}

export function handleSummary(data) {
  const base = `23120252_Spike_${RUN_ID}`;
  return {
    [`${OUTPUT_DIR}/k6-summary/${base}_summary.json`]: JSON.stringify(data, null, 2),
    [`${OUTPUT_DIR}/html-reports/spike-${RUN_ID}/${base}_phase_timeline.html`]: spikeTimelineHtml(data),
  };
}
