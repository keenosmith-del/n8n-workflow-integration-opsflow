import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.env.SMOKE_URL || 'http://localhost:5173/api';
const report = { startedAt: new Date().toISOString(), base, cases: [] };
async function api(path, token, method = 'GET', body, expected = 200) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function login(role) {
  return (
    await api(
      'auth/login',
      null,
      'POST',
      { email: `${role}@opsflow.local`, password: process.env.DEMO_PASSWORD || 'OpsFlow2026!' },
      201,
    )
  ).accessToken;
}
async function wait(id, status, token) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const r = await api(`requests/${id}`, token);
    if (r.status === status) return r;
    if (
      ['FAILED', 'TIMED_OUT', 'REJECTED', 'INSUFFICIENT_BUDGET'].includes(r.status) &&
      r.status !== status
    )
      throw new Error(`Unexpected ${r.status}: ${r.execution.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Request ${id} did not reach ${status}`);
}
async function main() {
  const [employee, manager, admin] = await Promise.all(['employee', 'manager', 'admin'].map(login));
  const health = await api('operations/health', admin);
  assert.ok(health.rabbitmq && health.redis && health.n8n, 'Infrastructure must be connected');
  report.connectivity = health;
  await api('workflows', employee, 'GET', undefined, 403);
  await api(
    'requests',
    employee,
    'POST',
    {
      title: 'Invalid',
      justification: 'Validation demonstration',
      department: 'IT',
      amountCents: -1,
      scenario: 'normal',
    },
    400,
  );
  await api('internal/callback', null, 'POST', {}, 401);
  const make = async (title, scenario = 'normal', amountCents = 100000) =>
    api(
      'requests',
      employee,
      'POST',
      {
        title: `Smoke ${title} ${Date.now()}`,
        justification: 'End-to-end verification of the local procurement workflow.',
        department: 'IT',
        amountCents,
        scenario,
      },
      201,
    );
  // Actual local OAuth client-credentials exchange; restore original settings even on failure.
  const original = (await api('integrations', admin)).find((x) => x.name === 'finance');
  await api('integrations', admin, 'PUT', {
    name: 'finance',
    authType: 'oauth2-client-credentials',
    clientId: 'opsflow-local',
    enabled: true,
  });
  try {
    const r = await make('successful OAuth procurement');
    const pending = await wait(r.id, 'AWAITING_APPROVAL', employee);
    assert.equal(pending.quotations.length, 2);
    assert.ok(pending.reservedCents > 0);
    assert.ok(pending.execution.n8nExecutionId);
    await api(
      `requests/${r.id}/decision`,
      employee,
      'POST',
      { decision: 'APPROVE', comment: 'Unauthorized employee approval' },
      403,
    );
    await api(
      `requests/${r.id}/decision`,
      manager,
      'POST',
      { decision: 'APPROVE', comment: 'Approved in end-to-end smoke check' },
      201,
    );
    const done = await wait(r.id, 'COMPLETED', employee);
    assert.ok(done.purchaseOrder);
    assert.equal(done.reservedCents, 0);
    assert.ok(done.audits.some((x) => x.action === 'PURCHASE_ORDER_CREATED'));
    await api(
      `requests/${r.id}/decision`,
      manager,
      'POST',
      { decision: 'APPROVE', comment: 'Duplicate approval attempt' },
      409,
    );
    report.cases.push({
      case: 'successful procurement with local OAuth2',
      requestId: r.id,
      executionId: done.execution.id,
      purchaseOrder: done.purchaseOrder.number,
      status: done.status,
    });
  } finally {
    await api('integrations', admin, 'PUT', {
      name: 'finance',
      authType: original.authType,
      clientId: original.clientId || undefined,
      enabled: original.enabled,
    });
  }
  const rejected = await make('rejection');
  await wait(rejected.id, 'AWAITING_APPROVAL', employee);
  await api(
    `requests/${rejected.id}/decision`,
    manager,
    'POST',
    { decision: 'REJECT', comment: 'Rejected in end-to-end smoke check' },
    201,
  );
  const closed = await wait(rejected.id, 'REJECTED', employee);
  assert.equal(closed.purchaseOrder, null);
  assert.equal(closed.reservedCents, 0);
  report.cases.push({
    case: 'rejected procurement',
    requestId: rejected.id,
    status: closed.status,
  });
  const budget = await make('insufficient budget', 'normal', 60000000);
  const noBudget = await wait(budget.id, 'INSUFFICIENT_BUDGET', employee);
  assert.equal(noBudget.purchaseOrder, null);
  assert.equal(noBudget.reservedCents, 0);
  report.cases.push({ case: 'insufficient budget', requestId: budget.id, status: noBudget.status });
  const fail = await make('supplier failure and recovery', 'supplier_failure');
  const failed = await wait(fail.id, 'FAILED', employee);
  assert.match(failed.execution.error, /supplier/i);
  assert.equal(failed.reservedCents, 0);
  await api(`executions/${failed.execution.id}/retry`, employee, 'POST', {}, 403);
  await api(`executions/${failed.execution.id}/retry`, admin, 'POST', {}, 201);
  const recovered = await wait(fail.id, 'AWAITING_APPROVAL', employee);
  assert.equal(recovered.execution.attempt, 2);
  await api(
    `requests/${fail.id}/decision`,
    manager,
    'POST',
    { decision: 'APPROVE', comment: 'Approved after integration recovery' },
    201,
  );
  const completed = await wait(fail.id, 'COMPLETED', employee);
  assert.ok(completed.purchaseOrder);
  assert.ok(completed.execution.exceptions.every((x) => x.resolvedAt));
  report.cases.push({
    case: 'integration failure followed by manual recovery',
    requestId: fail.id,
    status: completed.status,
    attempt: completed.execution.attempt,
    purchaseOrder: completed.purchaseOrder.number,
  });
  const orders = await api('orders', admin);
  for (const r of report.cases.filter((x) => x.purchaseOrder))
    assert.equal(orders.filter((o) => o.requestId === r.requestId).length, 1);
  report.finishedAt = new Date().toISOString();
  report.result = 'PASS';
  mkdirSync('verification', { recursive: true });
  writeFileSync('verification/smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
