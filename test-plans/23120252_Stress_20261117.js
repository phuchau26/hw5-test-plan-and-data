import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  parseCsv,
  runEshopWorkflow,
  validateWorkflowData,
} from './lib/eshop-workflow.js';

// DESIGN ONLY: do not execute before account provisioning and explicit human approval.
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RUN_ID = __ENV.RUN_ID;
const OUTPUT_DIR = __ENV.OUTPUT_DIR || 'results';
const MAX_VUS = 40;
const PLATEAU_SECONDS = 120;

const accounts = new SharedArray('stress accounts', () => parseCsv(open('../test-data/stress_accounts.local.csv')));
const products = new SharedArray('stress products', () => parseCsv(open('../test-data/products.csv')));
validateWorkflowData(accounts, products, MAX_VUS);

export const options = {
  scenarios: {
    stress_workflow: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '60s', target: 10 },
        { duration: '120s', target: 10 },
        { duration: '60s', target: 20 },
        { duration: '120s', target: 20 },
        { duration: '60s', target: 30 },
        { duration: '120s', target: 30 },
        { duration: '60s', target: 40 },
        { duration: '120s', target: 40 },
        { duration: '60s', target: 10 },
        { duration: '60s', target: 10 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
      exec: 'stressWorkflow',
      tags: { test_type: 'stress', workflow: 'purchase-confirmation' },
    },
  },
  thresholds: {
    // Safety guardrails only. They are not claims about maximum capacity.
    http_req_duration: [{ threshold: 'p(95)<5000', abortOnFail: true, delayAbortEval: '30s' }],
    http_req_failed: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '20s' }],
    business_checks_pass: [{ threshold: 'rate>=0.90', abortOnFail: true, delayAbortEval: '20s' }],
    workflow_success: [{ threshold: 'rate>=0.90', abortOnFail: true, delayAbortEval: '20s' }],
    authentication_failures: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '1s' }],
    overload_failures: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '20s' }],
  },
};

const plateauMetrics = Object.fromEntries([10, 20, 30, 40].map((vus) => [
  `plateau_${vus}`,
  {
    duration: new Trend(`stress_${vus}vu_http_duration_ms`, true),
    failed: new Rate(`stress_${vus}vu_http_failed`),
    checks: new Rate(`stress_${vus}vu_business_checks_pass`),
    requests: new Counter(`stress_${vus}vu_http_requests`),
    workflows: new Rate(`stress_${vus}vu_workflow_success`),
  },
]));

function currentStage() {
  const elapsed = exec.instance.currentTestRunDuration;
  if (elapsed < 60000) return { name: 'ramp_0_10', target: 10 };
  if (elapsed < 180000) return { name: 'plateau_10', target: 10 };
  if (elapsed < 240000) return { name: 'ramp_10_20', target: 20 };
  if (elapsed < 360000) return { name: 'plateau_20', target: 20 };
  if (elapsed < 420000) return { name: 'ramp_20_30', target: 30 };
  if (elapsed < 540000) return { name: 'plateau_30', target: 30 };
  if (elapsed < 600000) return { name: 'ramp_30_40', target: 40 };
  if (elapsed < 720000) return { name: 'plateau_40', target: 40 };
  if (elapsed < 780000) return { name: 'recovery_ramp_40_10', target: 10 };
  if (elapsed < 840000) return { name: 'recovery_10', target: 10 };
  return { name: 'ramp_10_0', target: 0 };
}

const stressHooks = {
  onResponse(response) {
    const metrics = plateauMetrics[currentStage().name];
    if (metrics) {
      metrics.duration.add(response.timings.duration);
      metrics.failed.add(response.status === 0 || response.status >= 400);
      metrics.requests.add(1);
    }
  },
  onStep(passed) {
    const metrics = plateauMetrics[currentStage().name];
    if (metrics) {
      metrics.checks.add(passed);
    }
  },
  onWorkflow(passed) {
    const metrics = plateauMetrics[currentStage().name];
    if (metrics) {
      metrics.workflows.add(passed);
    }
  },
};

export function stressWorkflow() {
  const stage = currentStage();
  return runEshopWorkflow({
    accounts,
    products,
    baseUrl: BASE_URL,
    stageTags: { stress_stage: stage.name, target_vus: String(stage.target) },
    hooks: stressHooks,
    thinkTimeRange: { min: 1, max: 3 },
  });
}

function metricValue(data, name, key) {
  return data.metrics[name] && data.metrics[name].values
    ? data.metrics[name].values[key]
    : null;
}

function format(value, digits = 3) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'N/A';
}

function percent(value) {
  return Number.isFinite(value) ? `${(100 * value).toFixed(3)}%` : 'N/A';
}

function stageReportHtml(data) {
  const rows = [10, 20, 30, 40].map((vus) => {
    const prefix = `stress_${vus}vu_`;
    const requestCount = metricValue(data, `${prefix}http_requests`, 'count');
    return `<tr><td>${vus}</td><td>${format(requestCount, 0)}</td>`
      + `<td>${format(Number.isFinite(requestCount) ? requestCount / PLATEAU_SECONDS : null)}</td>`
      + `<td>${format(metricValue(data, `${prefix}http_duration_ms`, 'avg'))}</td>`
      + `<td>${format(metricValue(data, `${prefix}http_duration_ms`, 'p(95)'))}</td>`
      + `<td>${percent(metricValue(data, `${prefix}http_failed`, 'rate'))}</td>`
      + `<td>${percent(metricValue(data, `${prefix}business_checks_pass`, 'rate'))}</td>`
      + `<td>${percent(metricValue(data, `${prefix}workflow_success`, 'rate'))}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>HW05 Stress stage report ${RUN_ID}</title>`
    + '<style>body{font-family:Arial,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}'
    + 'th,td{border:1px solid #bbb;padding:.5rem;text-align:right}th:first-child,td:first-child{text-align:left}'
    + '.note{background:#fff4ce;padding:1rem}</style></head><body>'
    + `<h1>HW05 Stress stage degradation report</h1><p>Run ID: <code>${RUN_ID}</code></p>`
    + '<p class="note">This view reports observed plateaus. The highest tested VU level is not automatically the SUT capacity.</p>'
    + '<table><thead><tr><th>Plateau (VU)</th><th>Requests</th><th>RPS</th><th>Avg (ms)</th>'
    + '<th>p95 (ms)</th><th>HTTP failed</th><th>Business checks</th><th>Workflow success</th>'
    + `</tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export function handleSummary(data) {
  if (!RUN_ID) {
    throw new Error('RUN_ID is required so Stress outputs cannot overwrite prior evidence.');
  }
  const base = `23120252_Stress_${RUN_ID}`;
  return {
    [`${OUTPUT_DIR}/k6-summary/${base}_summary.json`]: JSON.stringify(data, null, 2),
    [`${OUTPUT_DIR}/html-reports/stress-${RUN_ID}/${base}_stage_degradation.html`]: stageReportHtml(data),
  };
}
