import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log('.env exists; preserved.');
  process.exit(0);
}
const keys = [
  'POSTGRES_PASSWORD',
  'RABBITMQ_PASSWORD',
  'JWT_SECRET',
  'WORKFLOW_TOKEN',
  'CREDENTIAL_ENCRYPTION_KEY',
  'SIMULATOR_API_KEY',
  'N8N_ENCRYPTION_KEY',
];
writeFileSync(
  '.env',
  keys.map((k) => `${k}=${randomBytes(32).toString('hex')}`).join('\n') +
    '\nDEMO_PASSWORD=OpsFlow2026!\n',
  { mode: 0o600 },
);
console.log('Created .env with unique local secrets.');
