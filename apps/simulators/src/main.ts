import express from 'express';
import Ajv from 'ajv';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false }));
const log = pino({ base: { service: 'opsflow-simulators' } });
const validate = new Ajv().compile(
  JSON.parse(fs.readFileSync('packages/contracts/integration-request.schema.json', 'utf8')),
);
const matches = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.post('/oauth/token', (req, res) => {
  if (
    req.body.grant_type !== 'client_credentials' ||
    req.body.client_id !== 'opsflow-local' ||
    !matches(req.body.client_secret || '', process.env.SIMULATOR_API_KEY!)
  ) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }
  res.json({
    access_token: jwt.sign({ scope: 'finance suppliers' }, process.env.SIMULATOR_API_KEY!, {
      expiresIn: '5m',
      issuer: 'opsflow-local-simulator',
      audience: 'opsflow-integrations',
    }),
    token_type: 'Bearer',
    expires_in: 300,
  });
});
app.use((req, res, next) => {
  let valid = matches((req.headers['x-api-key'] as string) || '', process.env.SIMULATOR_API_KEY!);
  if (!valid)
    try {
      jwt.verify(
        (req.headers.authorization || '').replace(/^Bearer /, ''),
        process.env.SIMULATOR_API_KEY!,
        { issuer: 'opsflow-local-simulator', audience: 'opsflow-integrations' },
      );
      valid = true;
    } catch {}
  if (!valid) {
    res.status(401).json({ error: 'Unauthenticated simulator request' });
    return;
  }
  if (!validate(req.body)) {
    res.status(400).json({ error: 'Invalid JSON contract', details: validate.errors });
    return;
  }
  const body = req.body as any;
  log.info(
    {
      path: req.path,
      correlationId: body.correlationId,
      attempt: body.attempt,
      scenario: body.scenario,
    },
    'Integration invoked',
  );
  next();
});
app.post('/finance/check', async (req, res) => {
  const b = req.body;
  if (b.scenario === 'finance_failure' && b.attempt === 1) {
    res.status(503).json({ ok: false, error: 'Controlled finance service outage' });
    return;
  }
  if (b.scenario === 'timeout' && b.attempt === 1) {
    await new Promise((r) => setTimeout(r, 20000));
    res.status(504).json({ ok: false, error: 'Controlled finance timeout' });
    return;
  }
  try {
    const response = await fetch(`${process.env.API_URL}/api/internal/budget/${b.department}`, {
      headers: {
        'x-workflow-token': process.env.WORKFLOW_TOKEN!,
        'x-correlation-id': b.correlationId,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Authoritative budget service unavailable');
    const budget = (await response.json()) as any;
    res.json({
      ok: budget.availableCents >= b.amountCents,
      availableCents: budget.availableCents,
      currency: 'ZAR',
    });
  } catch (e: any) {
    res.status(503).json({ ok: false, error: e.message });
  }
});
app.post('/suppliers/quotes', (req, res) => {
  const b = req.body;
  if (b.scenario === 'supplier_failure' && b.attempt === 1) {
    res.status(503).json({ error: 'Controlled supplier service outage' });
    return;
  }
  if (b.scenario === 'missing_quotes' && b.attempt === 1) {
    res.json({ quotes: [] });
    return;
  }
  res.json({
    quotes: [
      {
        supplierId: 'atlas',
        reference: `ATLAS-${b.requestId.slice(0, 8)}-${b.attempt}`,
        amountCents: Math.round(b.amountCents * 0.95),
        deliveryDays: 5,
      },
      {
        supplierId: 'nova',
        reference: `NOVA-${b.requestId.slice(0, 8)}-${b.attempt}`,
        amountCents: b.amountCents,
        deliveryDays: 3,
      },
    ],
  });
});
app.listen(4000, '0.0.0.0', () =>
  log.info('Finance, supplier and OAuth simulators listening on 4000'),
);
