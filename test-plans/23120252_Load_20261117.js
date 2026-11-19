import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';

// DESIGN ONLY — do not execute until the student approves this plan.
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const MAX_VUS = 10;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const RUN_MODE = __ENV.RUN_MODE || 'load';
const RUN_ID = __ENV.RUN_ID;
const OUTPUT_DIR = __ENV.OUTPUT_DIR || 'results';

export const business_checks_pass = new Rate('business_checks_pass');
export const workflow_elapsed_ms = new Trend('workflow_elapsed_ms', true);
export const authentication_failures = new Rate('authentication_failures');

const thresholds = {
  http_req_duration: ['p(95)<2000'],
  http_req_failed: ['rate<0.01'],
  business_checks_pass: ['rate>=0.99'],
  authentication_failures: ['rate==0'],
};

export const options = RUN_MODE === 'verification'
  ? {
      scenarios: {
        verification_workflow: {
          executor: 'per-vu-iterations',
          vus: 1,
          iterations: 1,
          maxDuration: '30s',
          exec: 'workflow',
          tags: { test_type: 'verification', workflow: 'purchase-confirmation' },
        },
      },
      thresholds,
    }
  : {
      scenarios: {
        load_workflow: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '60s', target: 10 }, // ramp-up
            { duration: '180s', target: 10 }, // steady load
            { duration: '30s', target: 0 }, // ramp-down
          ],
          gracefulRampDown: '0s',
          exec: 'workflow',
          tags: { test_type: 'load', workflow: 'purchase-confirmation' },
        },
      },
      thresholds,
    };

// The runner supplies RUN_ID so each approved execution creates a distinct summary.
export function handleSummary(data) {
  if (!RUN_ID) {
    throw new Error('RUN_ID is required so a k6 summary cannot overwrite a previous run.');
  }
  const filename = RUN_MODE === 'verification'
    ? `23120252_Load_${RUN_ID}_verification_summary.json`
    : `23120252_Load_${RUN_ID}_summary.json`;
  return {
    [`${OUTPUT_DIR}/k6-summary/${filename}`]: JSON.stringify(data, null, 2),
  };
}

function parseCsv(csvText) {
  const lines = csvText
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  const [header, ...rows] = lines.map((line) => line.split(',').map((cell) => cell.trim()));
  return rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] || ''])));
}

const accounts = new SharedArray('load accounts', () => parseCsv(open('../test-data/credentials.local.csv')));
const products = new SharedArray('load products', () => parseCsv(open('../test-data/products.csv')));

if (accounts.length < MAX_VUS) {
  throw new Error(`Expected at least ${MAX_VUS} isolated accounts; found ${accounts.length}.`);
}
if (new Set(accounts.slice(0, MAX_VUS).map((account) => account.username)).size !== MAX_VUS) {
  throw new Error('The first ten account usernames must be unique for 1:1 VU mapping.');
}
if (accounts.slice(0, MAX_VUS).some((account) => !account.username || !account.password || !account.shipping_address)) {
  throw new Error('Each of the first ten account rows requires username, password, and shipping_address.');
}
if (products.length === 0) {
  throw new Error('No verified product row is available in test-data/products.csv.');
}

function thinkTime() {
  sleep(1 + Math.floor(Math.random() * 3));
}

function checked(response, name, assertions) {
  const passed = check(response, assertions);
  business_checks_pass.add(passed, { step: name });
  return passed;
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function finishFailedWorkflow(startedAt, tags, failedStep) {
  workflow_elapsed_ms.add(Date.now() - startedAt, { ...tags, outcome: 'failed', failed_step: failedStep });
  // A failed request still represents a user waiting before abandoning/retrying.
  // This prevents a tight iteration loop for non-authentication failures.
  thinkTime();
}

function abortForAuthenticationFailure(login, tags) {
  authentication_failures.add(true, tags);
  // Do not retry 401/403: this SUT increments failed-login attempts and can lock accounts.
  // One auth failure invalidates the one-account-per-VU precondition, so continuing would
  // produce misleading Load metrics and a rapid 401 loop.
  exec.test.abort(`Authentication precondition failed for VU ${tags.vu} (HTTP ${login.status}). Stop and validate the local account dataset/database.`);
}

export function workflow() {
  const startedAt = Date.now();
  // Ramping VUs have stable 1-based IDs during a run. Ten max VUs map 1:1 to ten rows.
  const account = accounts[exec.vu.idInTest - 1];
  if (!account) {
    throw new Error(`No dedicated account exists for VU ${exec.vu.idInTest}; do not reuse an account.`);
  }
  const product = products[(exec.vu.idInTest - 1) % products.length];
  const tags = { vu: String(exec.vu.idInTest) };

  const login = http.post(
    `${BASE_URL}/api/login`,
    jsonBody({ email: account.username, password: account.password }),
    { headers: JSON_HEADERS, tags: { ...tags, step: 'login' } },
  );
  const loginOk = checked(login, 'login', {
    'login HTTP 200': (r) => r.status === 200,
    'login returns JWT': (r) => Boolean(r.json('token')),
  });
  if (!loginOk) {
    if (login.status === 401 || login.status === 403) {
      abortForAuthenticationFailure(login, tags);
      return;
    }
    finishFailedWorkflow(startedAt, tags, 'login');
    return;
  }
  authentication_failures.add(false, tags);
  const token = login.json('token');
  const auth = { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` } };

  thinkTime();
  const search = http.get(`${BASE_URL}/api/products?search=${encodeURIComponent(product.search_term)}`, {
    tags: { ...tags, step: 'search_products' },
  });
  const searchOk = checked(search, 'search_products', {
    'search HTTP 200': (r) => r.status === 200,
    'search returns an array': (r) => Array.isArray(r.json()),
    'configured product is returned': (r) => r.json().some((item) => String(item.id) === product.product_id),
  });
  if (!searchOk) {
    finishFailedWorkflow(startedAt, tags, 'search_products');
    return;
  }
  const selected = search.json().find((item) => String(item.id) === product.product_id);

  thinkTime();
  const detail = http.get(`${BASE_URL}/api/products/${product.product_id}`, {
    tags: { ...tags, step: 'product_detail' },
  });
  const detailOk = checked(detail, 'product_detail', {
    'detail HTTP 200': (r) => r.status === 200,
    'detail ID matches configured product': (r) => String(r.json('id')) === product.product_id,
    'detail includes a name': (r) => Boolean(r.json('name')),
  });
  if (!detailOk) {
    finishFailedWorkflow(startedAt, tags, 'product_detail');
    return;
  }

  thinkTime();
  const cart = http.post(
    `${BASE_URL}/api/cart`,
    jsonBody({ id: selected.id, name: selected.name, price: selected.price, quantity: Number(product.quantity) }),
    { ...auth, tags: { ...tags, step: 'add_to_cart' } },
  );
  const cartOk = checked(cart, 'add_to_cart', {
    'cart HTTP 200': (r) => r.status === 200,
    'cart confirms add': (r) => r.json('message') === 'Added to cart',
  });
  if (!cartOk) {
    finishFailedWorkflow(startedAt, tags, 'add_to_cart');
    return;
  }

  thinkTime();
  const checkout = http.post(
    `${BASE_URL}/api/checkout`,
    jsonBody({ total_amount: Number(selected.price) * Number(product.quantity), shipping_address: account.shipping_address }),
    { ...auth, tags: { ...tags, step: 'checkout' } },
  );
  const checkoutOk = checked(checkout, 'checkout', {
    'checkout HTTP 200': (r) => r.status === 200,
    'checkout returns order ID': (r) => Number.isInteger(r.json('orderId')),
  });
  if (!checkoutOk) {
    finishFailedWorkflow(startedAt, tags, 'checkout');
    return;
  }
  const orderId = checkout.json('orderId');

  thinkTime();
  const history = http.get(`${BASE_URL}/api/orders/my-orders`, {
    ...auth,
    tags: { ...tags, step: 'order_history' },
  });
  const historyOk = checked(history, 'order_history', {
    'history HTTP 200': (r) => r.status === 200,
    'new checkout appears in history': (r) => r.json().some((order) => Number(order.id) === Number(orderId)),
    'new checkout is pending': (r) => r.json().some((order) => Number(order.id) === Number(orderId) && order.status === 'pending'),
  });

  if (!historyOk) {
    finishFailedWorkflow(startedAt, tags, 'order_history');
    return;
  }

  workflow_elapsed_ms.add(Date.now() - startedAt, { ...tags, outcome: 'passed' });
}
