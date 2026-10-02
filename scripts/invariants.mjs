// Small, targeted persistence/callback checks after `npm run smoke`.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const n = l.indexOf('=');
      return [l.slice(0, n), l.slice(n + 1)];
    }),
);
const db = new PrismaClient({
  datasources: {
    db: { url: `postgresql://opsflow:${env.POSTGRES_PASSWORD}@localhost:5433/opsflow` },
  },
});
const report = JSON.parse(readFileSync('verification/smoke.json', 'utf8'));
async function main() {
  const recovery = report.cases.find((x) => x.attempt === 2);
  const execution = await db.execution.findUniqueOrThrow({
    where: {
      id:
        recovery.executionId ||
        (await db.execution.findUniqueOrThrow({ where: { requestId: recovery.requestId } })).id,
    },
  });
  const callback = {
    executionId: execution.id,
    attempt: execution.attempt,
    callbackKey: execution.callbackKey,
    phase: 'FINALIZE',
  };
  const post = (body) =>
    fetch('http://localhost:3000/api/internal/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-workflow-token': env.WORKFLOW_TOKEN },
      body: JSON.stringify(body),
    });
  const duplicate = await post(callback);
  assert.equal(duplicate.status, 201);
  assert.equal((await duplicate.json()).duplicate, true);
  const stale = await post({ ...callback, attempt: 1 });
  assert.equal(stale.status, 409);
  const wrongPhase = await post({ ...callback, phase: 'COLLECT', financeOk: true, quotes: [] });
  assert.equal(wrongPhase.status, 409);
  const invalid = await post({ ...callback, unexpected: true });
  assert.equal(invalid.status, 400);
  assert.equal(await db.purchaseOrder.count({ where: { requestId: recovery.requestId } }), 1);
  const budgets = await db.budget.findMany();
  for (const b of budgets) {
    assert.ok(b.reservedCents >= 0);
    assert.ok(b.spentCents >= 0);
    assert.ok(b.spentCents + b.reservedCents <= b.limitCents);
  }
  const audits = await db.auditEvent.count();
  assert.ok(audits > 0);
  await assert.rejects(
    db.$executeRaw`UPDATE "AuditEvent" SET "action"='tampered' WHERE "requestId"=${recovery.requestId}::uuid`,
    /History records are immutable/,
  );
  await assert.rejects(
    db.$executeRaw`UPDATE "WorkflowDefinition" SET "template"='tampered' WHERE "id"=${execution.definitionId}::uuid`,
    /History records are immutable/,
  );
  const result = {
    result: 'PASS',
    checks: [
      'duplicate callback is idempotent',
      'stale attempt rejected',
      'out-of-order phase rejected',
      'invalid callback rejected',
      'one purchase order',
      'budget invariants',
      'audit immutability',
      'workflow-version immutability',
    ],
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync('verification/invariants.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
