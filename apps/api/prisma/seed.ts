import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { encrypt } from '../src/credentials';
const db = new PrismaClient();
async function main() {
  const passwordHash = await hash(process.env.DEMO_PASSWORD || 'OpsFlow2026!', 12);
  for (const [email, name, role] of [
    ['employee@opsflow.local', 'Eden Employee', 'EMPLOYEE'],
    ['manager@opsflow.local', 'Morgan Manager', 'MANAGER'],
    ['admin@opsflow.local', 'Alex Administrator', 'ADMIN'],
  ] as const)
    await db.user.upsert({
      where: { email },
      update: {},
      create: { email, name, role, passwordHash },
    });
  const manager = await db.user.findUniqueOrThrow({ where: { email: 'manager@opsflow.local' } });
  for (const department of ['IT', 'OPERATIONS'])
    await db.budget.upsert({
      where: { department },
      update: {},
      create: { department, limitCents: 50000000 },
    });
  for (const [id, name] of [
    ['atlas', 'Atlas Equipment'],
    ['nova', 'Nova Supplies'],
  ])
    await db.supplier.upsert({ where: { id }, update: {}, create: { id, name } });
  if (!(await db.workflowDefinition.count()))
    await db.workflowDefinition.create({
      data: {
        version: 1,
        template: 'procurement-v1',
        config: { approvalTimeoutMinutes: 60, rules: [{ minCents: 0, managerId: manager.id }] },
      },
    });
  for (const name of ['finance', 'suppliers'])
    await db.integrationConfig.upsert({
      where: { name },
      update: {},
      create: {
        name,
        authType: 'api-key',
        encryptedSecret: encrypt(process.env.SIMULATOR_API_KEY!),
        enabled: true,
      },
    });
  console.log('Seed ready: employee, manager, admin @opsflow.local (existing data preserved).');
}
main().finally(() => db.$disconnect());
