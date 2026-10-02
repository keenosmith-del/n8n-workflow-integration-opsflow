import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type { RequestDto, Role } from '@opsflow/contracts';
import './style.css';
type User = { id: string; name: string; email: string; role: Role };
type Session = { accessToken: string; user: User };
const money = (c: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format((c || 0) / 100);
const date = (v: string) => new Date(v).toLocaleString();
const short = (s: string) => s.replaceAll('_', ' ');
function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.toLowerCase()}`}>{short(value)}</span>;
}
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [page, setPage] = useState('Dashboard');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [login, setLogin] = useState({ email: 'employee@opsflow.local', password: 'OpsFlow2026!' });
  const [request, setRequest] = useState({
    title: 'Engineering laptop',
    justification: 'Equipment for the new engineering team member.',
    amount: '15000',
    department: 'IT',
    scenario: 'normal',
  });
  const [decisionComment, setDecisionComment] = useState('Reviewed budget and quotations.');
  const [config, setConfig] = useState({
    approvalTimeoutMinutes: 60,
    rules: [] as { minCents: number; managerId: string }[],
  });
  const [integration, setIntegration] = useState({
    name: 'finance',
    authType: 'api-key',
    enabled: true,
    secret: '',
    clientId: '',
  });
  const api = useCallback(
    async (path: string, method = 'GET', body?: unknown) => {
      const res = await fetch('/api/' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await res.json();
      if (!res.ok) {
        if (res.status === 401 && session) {
          setSession(null);
          setData(null);
        }
        const message = typeof value.message === 'object' ? value.message.message : value.message;
        throw new Error(
          (Array.isArray(message) ? message.join('; ') : message) || `HTTP ${res.status}`,
        );
      }
      return value;
    },
    [session],
  );
  const refresh = useCallback(async () => {
    if (!session) return;
    let value: any;
    if (detailId) value = await api('requests/' + detailId);
    else if (page === 'Dashboard') value = await api('dashboard');
    else if (page === 'Requests')
      value = await api(
        `requests?q=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`,
      );
    else if (page === 'Approvals') value = await api('approvals');
    else if (page === 'Purchase orders') value = await api('orders');
    else if (page === 'Executions')
      value = await api(
        `executions?q=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`,
      );
    else if (page === 'Exceptions') value = await api('exceptions');
    else if (page === 'Configuration') {
      const [workflows, managers, integrations, health] = await Promise.all([
        api('workflows'),
        api('managers'),
        api('integrations'),
        api('operations/health'),
      ]);
      value = { workflows, managers, integrations, health };
    } else if (page === 'Audit') value = await api('audits');
    else return;
    setData(value);
  }, [session, api, page, detailId, search, status]);
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    setBusy(true);
    refresh()
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    const timer = setInterval(
      () =>
        refresh().catch((e) => {
          if (active) setError(e.message);
        }),
      4000,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (data?.workflows?.[0]) setConfig(data.workflows[0].config);
  }, [page, !!data?.workflows]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const navigate = (p: string) => {
    setDetailId(null);
    setPage(p);
    setSearch('');
    setStatus('');
    setNotice('');
  };
  const inspect = (id: string) => {
    setDetailId(id);
    setNotice('');
  };
  const decide = (id: string, decision: 'APPROVE' | 'REJECT') =>
    act(async () => {
      await api(`requests/${id}/decision`, 'POST', { decision, comment: decisionComment });
      setNotice(
        decision === 'APPROVE'
          ? 'Approved. n8n will create the purchase order.'
          : 'Rejected. The budget reservation has been released.',
      );
      await refresh();
    });
  const retry = (id: string) =>
    act(async () => {
      await api(`executions/${id}/retry`, 'POST');
      setNotice('A new attempt has been queued through RabbitMQ and n8n.');
      await refresh();
    });
  if (!session)
    return (
      <main className="login">
        <h1>OpsFlow</h1>
        <p>Procurement & integration operations</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const result = await api('auth/login', 'POST', login);
              setSession(result);
              setPage('Dashboard');
              setDetailId(null);
            });
          }}
        >
          <label>
            Email
            <input
              type="email"
              value={login.email}
              onChange={(e) => setLogin({ ...login, email: e.target.value })}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={login.password}
              onChange={(e) => setLogin({ ...login, password: e.target.value })}
              required
            />
          </label>
          <button disabled={busy}>Sign in</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <aside>
          Local demo accounts
          <p>
            employee@opsflow.local
            <br />
            manager@opsflow.local
            <br />
            admin@opsflow.local
          </p>
          <p>Password: OpsFlow2026!</p>
        </aside>
      </main>
    );
  const nav = [
    'Dashboard',
    'Requests',
    ...(session.user.role !== 'MANAGER' ? ['New request'] : []),
    ...(session.user.role === 'MANAGER' ? ['Approvals'] : []),
    'Purchase orders',
    'Executions',
    ...(session.user.role === 'ADMIN' ? ['Exceptions', 'Configuration', 'Audit'] : []),
  ];
  return (
    <>
      <header>
        <strong>OpsFlow</strong>
        <span>
          {session.user.name} · {session.user.role.toLowerCase()}
        </span>
        <button
          className="secondary"
          onClick={() => {
            setSession(null);
            setData(null);
            setError('');
            setNotice('');
          }}
        >
          Sign out
        </button>
      </header>
      <div className="shell">
        <nav>
          {nav.map((p) => (
            <button className={page === p ? 'selected' : ''} key={p} onClick={() => navigate(p)}>
              {p}
            </button>
          ))}
          <a href="/api/docs" target="_blank" rel="noreferrer">
            API documentation ↗
          </a>
        </nav>
        <main>
          <div className="heading">
            <h1>{detailId ? 'Request details' : page}</h1>
            {detailId ? (
              <button className="secondary" onClick={() => setDetailId(null)}>
                Back
              </button>
            ) : (
              <button className="secondary" disabled={busy} onClick={() => void act(refresh)}>
                Refresh
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
            </div>
          )}
          {busy && <p role="status">Loading…</p>}
          {detailId && data?.id === detailId && (
            <>
              <section>
                <h2>
                  {data.title} <Badge value={data.status} />
                </h2>
                <p>{data.justification}</p>
                <dl>
                  <dt>Requested maximum</dt>
                  <dd>{money(data.amountCents)}</dd>
                  <dt>Department</dt>
                  <dd>{data.department}</dd>
                  <dt>Employee</dt>
                  <dd>{data.employee.name}</dd>
                  <dt>Created</dt>
                  <dd>{date(data.createdAt)}</dd>
                  <dt>Reserved</dt>
                  <dd>{money(data.reservedCents)}</dd>
                  <dt>Demonstration mode</dt>
                  <dd>{data.scenario}</dd>
                </dl>
              </section>
              <section>
                <h2>Quotations</h2>
                <Table
                  heads={['Supplier', 'Amount', 'Delivery', 'Attempt', 'Reference']}
                  rows={data.quotations.map((q: any) => [
                    q.supplier.name,
                    money(q.amountCents),
                    `${q.deliveryDays} days`,
                    q.attempt,
                    q.reference,
                  ])}
                />
              </section>
              {data.approval && (
                <section>
                  <h2>Approval</h2>
                  <p>
                    Assigned to {data.approval.manager.name} · Due {date(data.approval.dueAt)}
                  </p>
                  {data.approval.decision ? (
                    <p>
                      {data.approval.decision}: {data.approval.comment}
                    </p>
                  ) : data.status === 'AWAITING_APPROVAL' &&
                    session.user.id === data.approval.managerId ? (
                    <>
                      <label>
                        Decision comment
                        <textarea
                          value={decisionComment}
                          onChange={(e) => setDecisionComment(e.target.value)}
                          minLength={3}
                        />
                      </label>
                      <div className="actions">
                        <button disabled={busy} onClick={() => decide(data.id, 'APPROVE')}>
                          Approve
                        </button>
                        <button
                          disabled={busy}
                          className="danger"
                          onClick={() => decide(data.id, 'REJECT')}
                        >
                          Reject
                        </button>
                      </div>
                    </>
                  ) : (
                    <p>Waiting for the assigned manager.</p>
                  )}
                </section>
              )}
              {data.purchaseOrder && (
                <section>
                  <h2>Purchase order {data.purchaseOrder.number}</h2>
                  <p>
                    {data.purchaseOrder.supplier.name} · {money(data.purchaseOrder.amountCents)} ·{' '}
                    {date(data.purchaseOrder.createdAt)}
                  </p>
                </section>
              )}
              <section>
                <h2>Execution</h2>
                <dl>
                  <dt>Status</dt>
                  <dd>
                    <Badge value={data.execution.status} />
                  </dd>
                  <dt>Workflow</dt>
                  <dd>
                    {data.execution.definition.template} · v{data.execution.definition.version}
                  </dd>
                  <dt>Attempt / phase</dt>
                  <dd>
                    {data.execution.attempt} / {data.execution.phase}
                  </dd>
                  <dt>Correlation ID</dt>
                  <dd>
                    <code>{data.execution.correlationId}</code>
                  </dd>
                  <dt>n8n execution ID</dt>
                  <dd>{data.execution.n8nExecutionId || 'Pending callback'}</dd>
                  <dt>Deadline</dt>
                  <dd>{date(data.execution.deadline)}</dd>
                </dl>
                {data.execution.error && <p className="error">{data.execution.error}</p>}
                {session.user.role === 'ADMIN' &&
                  ['FAILED', 'TIMED_OUT'].includes(data.execution.status) && (
                    <button disabled={busy} onClick={() => retry(data.execution.id)}>
                      Retry execution
                    </button>
                  )}
              </section>
              <Audit rows={data.audits} />
            </>
          )}
          {!detailId && page === 'Dashboard' && data?.statuses && (
            <>
              <div className="cards">
                <section>
                  <small>Requests</small>
                  <strong>
                    {data.statuses.reduce((s: number, x: any) => s + x._count._all, 0)}
                  </strong>
                </section>
                <section>
                  <small>Purchase orders</small>
                  <strong>{data.orders._count._all}</strong>
                </section>
                <section>
                  <small>Committed spend</small>
                  <strong>{money(data.orders._sum.amountCents || 0)}</strong>
                </section>
                <section>
                  <small>Open exceptions</small>
                  <strong>{data.exceptions}</strong>
                </section>
              </div>
              <section>
                <h2>Request status</h2>
                <div className="actions">
                  {data.statuses.map((s: any) => (
                    <span key={s.status}>
                      <Badge value={s.status} /> {s._count._all}
                    </span>
                  ))}
                </div>
                {!data.statuses.length && (
                  <p>No requests yet. Submit an equipment request to start.</p>
                )}
              </section>
              <section>
                <h2>Department budgets</h2>
                <Table
                  heads={['Department', 'Limit', 'Reserved', 'Spent', 'Available']}
                  rows={data.budgets.map((b: any) => [
                    b.department,
                    money(b.limitCents),
                    money(b.reservedCents),
                    money(b.spentCents),
                    money(b.limitCents - b.reservedCents - b.spentCents),
                  ])}
                />
              </section>
              <section>
                <h2>Recent executions</h2>
                <Table
                  heads={['Request', 'State', 'Version', 'Updated']}
                  rows={data.latest.map((x: any) => [
                    <button className="link" onClick={() => inspect(x.request.id)}>
                      {x.request.title}
                    </button>,
                    <Badge value={x.status} />,
                    `v${x.definition.version}`,
                    date(x.updatedAt),
                  ])}
                />
              </section>
            </>
          )}
          {!detailId && page === 'New request' && (
            <section>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const cents = Math.round(Number(request.amount) * 100);
                    const dto: RequestDto = {
                      title: request.title,
                      justification: request.justification,
                      amountCents: cents,
                      department: request.department,
                      scenario: request.scenario,
                    };
                    const created = await api('requests', 'POST', dto);
                    setPage('Requests');
                    setDetailId(created.id);
                    setNotice(
                      'Request persisted. Waiting for n8n to collect budget and quotations.',
                    );
                  });
                }}
              >
                <label>
                  Equipment / title
                  <input
                    value={request.title}
                    onChange={(e) => setRequest({ ...request, title: e.target.value })}
                    required
                    minLength={3}
                    maxLength={120}
                  />
                </label>
                <label>
                  Business justification
                  <textarea
                    value={request.justification}
                    onChange={(e) => setRequest({ ...request, justification: e.target.value })}
                    required
                    minLength={10}
                    maxLength={2000}
                  />
                </label>
                <label>
                  Maximum amount (ZAR)
                  <input
                    type="number"
                    value={request.amount}
                    onChange={(e) => setRequest({ ...request, amount: e.target.value })}
                    required
                    min={1}
                    max={1000000}
                    step="0.01"
                  />
                </label>
                <label>
                  Department
                  <select
                    value={request.department}
                    onChange={(e) => setRequest({ ...request, department: e.target.value })}
                  >
                    <option>IT</option>
                    <option>OPERATIONS</option>
                  </select>
                </label>
                <label>
                  Local integration scenario
                  <select
                    value={request.scenario}
                    onChange={(e) => setRequest({ ...request, scenario: e.target.value })}
                  >
                    {[
                      'normal',
                      'finance_failure',
                      'supplier_failure',
                      'missing_quotes',
                      'timeout',
                    ].map((s) => (
                      <option key={s} value={s}>
                        {short(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted">
                  Controlled failures apply to the first execution attempt. An administrator can
                  retry to demonstrate recovery.
                </p>
                <button disabled={busy}>Submit request</button>
              </form>
            </section>
          )}
          {!detailId && ['Requests', 'Executions'].includes(page) && (
            <div className="filters">
              <label>
                Search
                <input
                  placeholder={page === 'Requests' ? 'Title or correlation ID' : 'Correlation ID'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <label>
                Status
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">All states</option>
                  {[
                    'QUEUED',
                    ...(page === 'Executions' ? ['RUNNING'] : []),
                    'AWAITING_APPROVAL',
                    'APPROVED',
                    'REJECTED',
                    'COMPLETED',
                    'INSUFFICIENT_BUDGET',
                    'FAILED',
                    'TIMED_OUT',
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {!detailId && page === 'Requests' && Array.isArray(data) && (
            <section>
              <Table
                heads={['Request', 'Employee', 'Maximum', 'Status', 'Created']}
                rows={data.map((r: any) => [
                  <button className="link" onClick={() => inspect(r.id)}>
                    {r.title}
                  </button>,
                  r.employee.name,
                  money(r.amountCents),
                  <Badge value={r.status} />,
                  date(r.createdAt),
                ])}
              />
            </section>
          )}
          {!detailId && page === 'Approvals' && Array.isArray(data) && (
            <section>
              <p>Review quotations and budget reservations before deciding.</p>
              <Table
                heads={['Request', 'Employee', 'Maximum', 'Deadline', 'Action']}
                rows={data.map((a: any) => [
                  a.request.title,
                  a.request.employee.name,
                  money(a.request.amountCents),
                  date(a.dueAt),
                  <button onClick={() => inspect(a.requestId)}>Review</button>,
                ])}
              />
            </section>
          )}
          {!detailId && page === 'Purchase orders' && Array.isArray(data) && (
            <section>
              <Table
                heads={['Order', 'Request', 'Supplier', 'Amount', 'Created']}
                rows={data.map((o: any) => [
                  o.number,
                  <button className="link" onClick={() => inspect(o.requestId)}>
                    {o.request.title}
                  </button>,
                  o.supplier.name,
                  money(o.amountCents),
                  date(o.createdAt),
                ])}
              />
            </section>
          )}
          {!detailId && page === 'Executions' && Array.isArray(data) && (
            <section>
              <Table
                heads={[
                  'Request',
                  'Status',
                  'Attempt',
                  'Workflow',
                  'Correlation ID',
                  'Diagnostics',
                ]}
                rows={data.map((x: any) => [
                  <button className="link" onClick={() => inspect(x.requestId)}>
                    {x.request.title}
                  </button>,
                  <Badge value={x.status} />,
                  x.attempt,
                  `v${x.definition.version}`,
                  <code>{x.correlationId}</code>,
                  x.error || x.phase,
                ])}
              />
            </section>
          )}
          {!detailId && page === 'Exceptions' && Array.isArray(data) && (
            <section>
              <Table
                heads={['Request', 'Reason', 'Attempt', 'Raised', 'Resolution']}
                rows={data.map((x: any) => [
                  <button className="link" onClick={() => inspect(x.execution.requestId)}>
                    {x.execution.request.title}
                  </button>,
                  x.reason,
                  x.attempt,
                  date(x.createdAt),
                  x.resolvedAt ? (
                    `Retried ${date(x.resolvedAt)}`
                  ) : (
                    <button disabled={busy} onClick={() => retry(x.executionId)}>
                      Retry
                    </button>
                  ),
                ])}
              />
            </section>
          )}
          {!detailId && page === 'Audit' && Array.isArray(data) && <Audit rows={data} />}
          {!detailId && page === 'Configuration' && data?.workflows && (
            <>
              <section>
                <h2>Service connectivity</h2>
                <div className="actions">
                  {['rabbitmq', 'redis', 'n8n'].map((s) => (
                    <span key={s}>
                      {s}: <Badge value={data.health[s] ? 'CONNECTED' : 'UNAVAILABLE'} />
                    </span>
                  ))}
                </div>
                <p>Unpublished outbox events: {data.health.unpublishedEvents}</p>
                <pre>{JSON.stringify(data.health.jobs, null, 2)}</pre>
              </section>
              <section>
                <h2>Approval and routing configuration</h2>
                <p>
                  Publishing creates an immutable definition version. Existing executions retain
                  their starting version.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      await api('workflows', 'POST', { template: 'procurement-v1', ...config });
                      setNotice('Workflow configuration version published.');
                      await refresh();
                    });
                  }}
                >
                  <label>
                    Approval timeout (minutes)
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      value={config.approvalTimeoutMinutes}
                      onChange={(e) =>
                        setConfig({ ...config, approvalTimeoutMinutes: Number(e.target.value) })
                      }
                    />
                  </label>
                  {config.rules.map((r, i) => (
                    <div className="rule" key={i}>
                      <label>
                        Minimum request (ZAR)
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={r.minCents / 100}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              rules: config.rules.map((x, j) =>
                                j === i
                                  ? { ...x, minCents: Math.round(Number(e.target.value) * 100) }
                                  : x,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        Assigned manager
                        <select
                          value={r.managerId}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              rules: config.rules.map((x, j) =>
                                j === i ? { ...x, managerId: e.target.value } : x,
                              ),
                            })
                          }
                        >
                          {data.managers.map((m: any) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {i > 0 && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            setConfig({ ...config, rules: config.rules.filter((_, j) => j !== i) })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setConfig({
                          ...config,
                          rules: [
                            ...config.rules,
                            { minCents: 1000000, managerId: data.managers[0].id },
                          ],
                        })
                      }
                    >
                      Add threshold
                    </button>
                    <button disabled={busy}>Publish new version</button>
                  </div>
                </form>
                <Table
                  heads={['Version', 'Template', 'Created']}
                  rows={data.workflows.map((w: any) => [
                    `v${w.version}`,
                    w.template,
                    date(w.createdAt),
                  ])}
                />
              </section>
              <section>
                <h2>Integration credentials</h2>
                <p>
                  Credentials are encrypted in PostgreSQL and never returned to this interface. The
                  local OAuth client ID is <code>opsflow-local</code>; retain the seeded secret to
                  test OAuth.
                </p>
                <Table
                  heads={['Integration', 'Authentication', 'Enabled']}
                  rows={data.integrations.map((c: any) => [c.name, c.authType, String(c.enabled)])}
                />
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const dto = {
                        ...integration,
                        ...(!integration.secret ? { secret: undefined } : {}),
                      };
                      await api('integrations', 'PUT', dto);
                      setIntegration({ ...integration, secret: '' });
                      setNotice('Integration settings saved.');
                      await refresh();
                    });
                  }}
                >
                  <label>
                    Integration
                    <select
                      value={integration.name}
                      onChange={(e) => {
                        const c = data.integrations.find((x: any) => x.name === e.target.value);
                        setIntegration({
                          name: c.name,
                          authType: c.authType,
                          enabled: c.enabled,
                          secret: '',
                          clientId: c.clientId || '',
                        });
                      }}
                    >
                      <option value="finance">Finance</option>
                      <option value="suppliers">Suppliers</option>
                    </select>
                  </label>
                  <label>
                    Authentication
                    <select
                      value={integration.authType}
                      onChange={(e) => setIntegration({ ...integration, authType: e.target.value })}
                    >
                      <option value="api-key">API key</option>
                      <option value="oauth2-client-credentials">
                        OAuth2 client credentials (local)
                      </option>
                    </select>
                  </label>
                  {integration.authType === 'oauth2-client-credentials' && (
                    <label>
                      Client ID
                      <input
                        value={integration.clientId}
                        onChange={(e) =>
                          setIntegration({ ...integration, clientId: e.target.value })
                        }
                        required
                      />
                    </label>
                  )}
                  <label>
                    New secret (optional)
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={integration.secret}
                      onChange={(e) => setIntegration({ ...integration, secret: e.target.value })}
                      minLength={8}
                      placeholder="Leave blank to retain current secret"
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={integration.enabled}
                      onChange={(e) =>
                        setIntegration({ ...integration, enabled: e.target.checked })
                      }
                    />{' '}
                    Enabled
                  </label>
                  <button disabled={busy}>Save integration</button>
                </form>
              </section>
            </>
          )}
        </main>
      </div>
    </>
  );
}
function Table({ heads, rows }: { heads: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="table">
      <table>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="muted">No records to show.</p>}
    </div>
  );
}
function Audit({ rows }: { rows: any[] }) {
  return (
    <section>
      <h2>Immutable audit history</h2>
      <Table
        heads={['Time', 'Event', 'Actor', 'Details']}
        rows={rows.map((a) => [
          date(a.createdAt),
          short(a.action),
          a.actorId,
          <pre>{JSON.stringify(a.data, null, 2)}</pre>,
        ])}
      />
    </section>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
