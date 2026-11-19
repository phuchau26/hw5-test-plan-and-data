import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const businessChecksPass = new Rate('business_checks_pass');
export const workflowSuccess = new Rate('workflow_success');
export const workflowElapsedMs = new Trend('workflow_elapsed_ms', true);
export const authenticationFailures = new Rate('authentication_failures');
export const overloadFailures = new Rate('overload_failures');
export const checkoutSuccess = new Rate('checkout_success');
export const completedWorkflows = new Counter('completed_workflows');

export function parseCsv(csvText) {
  const lines = csvText
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  const [header, ...rows] = lines.map((line) => line.split(',').map((cell) => cell.trim()));
  return rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] || ''])));
}

export function validateWorkflowData(accounts, products, maxVus) {
  if (accounts.length < maxVus) {
    throw new Error(`Expected at least ${maxVus} isolated accounts; found ${accounts.length}.`);
  }
  const selectedAccounts = accounts.slice(0, maxVus);
  if (new Set(selectedAccounts.map((account) => account.username)).size !== maxVus) {
    throw new Error(`The first ${maxVus} usernames must be unique for 1:1 VU mapping.`);
  }
  if (selectedAccounts.some((account) => !account.username || !account.password || !account.shipping_address)) {
    throw new Error(`Each of the first ${maxVus} account rows requires username, password, and shipping_address.`);
  }
  if (products.length === 0) {
    throw new Error('No verified product row is available in test-data/products.csv.');
  }
}

function thinkTime(minSeconds, maxSeconds) {
  sleep(minSeconds + Math.floor(Math.random() * (maxSeconds - minSeconds + 1)));
}

function responseIsOverload(response) {
  return response.status === 0 || response.status === 429 || response.status >= 500;
}

function recordResponse(response, tags, hooks) {
  overloadFailures.add(responseIsOverload(response), tags);
  if (hooks && hooks.onResponse) hooks.onResponse(response, tags);
}

function checked(response, step, assertions, tags, hooks) {
  const passed = check(response, assertions, tags);
  businessChecksPass.add(passed, { ...tags, step });
  if (hooks && hooks.onStep) hooks.onStep(passed, { ...tags, step });
  return passed;
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function finishWorkflow(startedAt, tags, passed, failedStep, hooks, thinkTimeRange) {
  workflowSuccess.add(passed, { ...tags, failed_step: failedStep || 'none' });
  workflowElapsedMs.add(Date.now() - startedAt, {
    ...tags,
    outcome: passed ? 'passed' : 'failed',
    failed_step: failedStep || 'none',
  });
  if (passed) completedWorkflows.add(1, tags);
  if (hooks && hooks.onWorkflow) hooks.onWorkflow(passed, tags, failedStep);
  if (!passed) thinkTime(thinkTimeRange.min, thinkTimeRange.max);
}

function abortForAuthenticationFailure(login, tags, hooks) {
  authenticationFailures.add(true, tags);
  if (hooks && hooks.onAuthenticationFailure) hooks.onAuthenticationFailure(login, tags);
  exec.test.abort(
    `Authentication precondition failed for VU ${tags.vu} (HTTP ${login.status}). `
      + 'Stop before lockout/retry amplification and validate the local account dataset/database.',
  );
}

export function runEshopWorkflow(config) {
  const {
    accounts,
    products,
    baseUrl,
    stageTags = {},
    hooks = {},
    thinkTimeRange = { min: 1, max: 3 },
  } = config;
  const startedAt = Date.now();
  const account = accounts[exec.vu.idInTest - 1];
  if (!account) {
    throw new Error(`No dedicated account exists for VU ${exec.vu.idInTest}; account sharing is forbidden.`);
  }
  const product = products[(exec.vu.idInTest - 1) % products.length];
  const tags = { ...stageTags, vu: String(exec.vu.idInTest), workflow: 'purchase-confirmation' };

  const login = http.post(
    `${baseUrl}/api/login`,
    jsonBody({ email: account.username, password: account.password }),
    { headers: JSON_HEADERS, tags: { ...tags, step: 'login' } },
  );
  recordResponse(login, { ...tags, step: 'login' }, hooks);
  const loginOk = checked(login, 'login', {
    'login HTTP 200': (r) => r.status === 200,
    'login returns JWT': (r) => Boolean(r.json('token')),
  }, tags, hooks);
  if (!loginOk) {
    if (login.status === 401 || login.status === 403) {
      abortForAuthenticationFailure(login, tags, hooks);
      return false;
    }
    finishWorkflow(startedAt, tags, false, 'login', hooks, thinkTimeRange);
    return false;
  }
  authenticationFailures.add(false, tags);
  const token = login.json('token');
  const auth = { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` } };

  thinkTime(thinkTimeRange.min, thinkTimeRange.max);
  const search = http.get(`${baseUrl}/api/products?search=${encodeURIComponent(product.search_term)}`, {
    tags: { ...tags, step: 'search_products' },
  });
  recordResponse(search, { ...tags, step: 'search_products' }, hooks);
  const searchOk = checked(search, 'search_products', {
    'search HTTP 200': (r) => r.status === 200,
    'search returns an array': (r) => Array.isArray(r.json()),
    'configured product is returned': (r) => r.json().some((item) => String(item.id) === product.product_id),
  }, tags, hooks);
  if (!searchOk) {
    finishWorkflow(startedAt, tags, false, 'search_products', hooks, thinkTimeRange);
    return false;
  }
  const selected = search.json().find((item) => String(item.id) === product.product_id);

  thinkTime(thinkTimeRange.min, thinkTimeRange.max);
  const detail = http.get(`${baseUrl}/api/products/${product.product_id}`, {
    tags: { ...tags, step: 'product_detail' },
  });
  recordResponse(detail, { ...tags, step: 'product_detail' }, hooks);
  const detailOk = checked(detail, 'product_detail', {
    'detail HTTP 200': (r) => r.status === 200,
    'detail ID matches configured product': (r) => String(r.json('id')) === product.product_id,
    'detail includes a name': (r) => Boolean(r.json('name')),
  }, tags, hooks);
  if (!detailOk) {
    finishWorkflow(startedAt, tags, false, 'product_detail', hooks, thinkTimeRange);
    return false;
  }

  thinkTime(thinkTimeRange.min, thinkTimeRange.max);
  const cart = http.post(
    `${baseUrl}/api/cart`,
    jsonBody({ id: selected.id, name: selected.name, price: selected.price, quantity: Number(product.quantity) }),
    { ...auth, tags: { ...tags, step: 'add_to_cart' } },
  );
  recordResponse(cart, { ...tags, step: 'add_to_cart' }, hooks);
  const cartOk = checked(cart, 'add_to_cart', {
    'cart HTTP 200': (r) => r.status === 200,
    'cart confirms add': (r) => r.json('message') === 'Added to cart',
  }, tags, hooks);
  if (!cartOk) {
    finishWorkflow(startedAt, tags, false, 'add_to_cart', hooks, thinkTimeRange);
    return false;
  }

  thinkTime(thinkTimeRange.min, thinkTimeRange.max);
  const checkout = http.post(
    `${baseUrl}/api/checkout`,
    jsonBody({
      total_amount: Number(selected.price) * Number(product.quantity),
      shipping_address: account.shipping_address,
    }),
    { ...auth, tags: { ...tags, step: 'checkout' } },
  );
  recordResponse(checkout, { ...tags, step: 'checkout' }, hooks);
  const checkoutOk = checked(checkout, 'checkout', {
    'checkout HTTP 200': (r) => r.status === 200,
    'checkout returns order ID': (r) => Number.isInteger(r.json('orderId')),
  }, tags, hooks);
  checkoutSuccess.add(checkoutOk, tags);
  if (!checkoutOk) {
    finishWorkflow(startedAt, tags, false, 'checkout', hooks, thinkTimeRange);
    return false;
  }
  const orderId = checkout.json('orderId');

  thinkTime(thinkTimeRange.min, thinkTimeRange.max);
  const history = http.get(`${baseUrl}/api/orders/my-orders`, {
    ...auth,
    tags: { ...tags, step: 'order_history' },
  });
  recordResponse(history, { ...tags, step: 'order_history' }, hooks);
  const historyOk = checked(history, 'order_history', {
    'history HTTP 200': (r) => r.status === 200,
    'new checkout appears in history': (r) => r.json().some((order) => Number(order.id) === Number(orderId)),
    'new checkout is pending': (r) => r.json().some(
      (order) => Number(order.id) === Number(orderId) && order.status === 'pending',
    ),
  }, tags, hooks);
  if (!historyOk) {
    finishWorkflow(startedAt, tags, false, 'order_history', hooks, thinkTimeRange);
    return false;
  }

  finishWorkflow(startedAt, tags, true, null, hooks, thinkTimeRange);
  return true;
}
