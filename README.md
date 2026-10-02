# OpsFlow enterprise procurement platform

Locally runnable React + NestJS application with PostgreSQL/Prisma business persistence, n8n HTTP orchestration, RabbitMQ domain events, and Redis/BullMQ delivery retries and deadlines. This repository contains the application, integrations, versioned workflow templates, migrations, seed data, and infrastructure.

## Start

Requires Docker Engine/Desktop with Compose v2 and Node.js 22+ for the helper scripts. Allow approximately 6 GB of Docker memory and several minutes for the first image downloads/build.

```sh
cd /Users/keenosmith/n8n/n8n-workflow-integration-opsflow
node scripts/init-env.mjs
docker compose up --build -d --wait --wait-timeout 360
```

The helper creates a gitignored `.env` with unique secrets and preserves an existing file. `.env.example` documents the variables; its placeholders are not usable credentials. Startup applies checked-in Prisma migrations, seeds missing records without resetting existing business data, imports n8n credentials/workflows, publishes each workflow, then starts n8n. No external accounts or cloud credentials are needed.

Open **http://localhost:5173**. Accounts (all use **`OpsFlow2026!`**, unless `DEMO_PASSWORD` was changed before the first seed):

| Role          | Email                  | Actions                                                           |
| ------------- | ---------------------- | ----------------------------------------------------------------- |
| Employee      | employee@opsflow.local | Submit requests, see own requests/orders/executions               |
| Manager       | manager@opsflow.local  | Review all requests, decide only assigned approvals               |
| Administrator | admin@opsflow.local    | Inspect operations, configure rules/credentials, retry exceptions |

Services:

| Service                           | Local address                                                 |
| --------------------------------- | ------------------------------------------------------------- |
| React / API proxy                 | http://localhost:5173                                         |
| NestJS REST / Swagger             | http://localhost:3000/api/docs                                |
| OpenAPI JSON                      | http://localhost:3000/api/docs-json                           |
| n8n editor                        | http://localhost:5678                                         |
| Finance/supplier simulator health | http://localhost:4000/health                                  |
| RabbitMQ management               | http://localhost:15672 (user `opsflow`, password from `.env`) |
| Jaeger traces                     | http://localhost:16686                                        |
| PostgreSQL                        | localhost:5433, database/user `opsflow`, password from `.env` |
| Redis                             | localhost:6379                                                |

n8n's editor may ask you to create its local owner account. Application users and n8n users are separate. The published webhooks operate before editor onboarding; no paid n8n features are used. Editor access is privileged; credentials must remain server-side. Workflow execution bodies are not retained in n8n because credential adapter outputs contain sensitive headers. The application retains sanitized execution diagnostics and the last n8n execution ID.

## Complete walkthrough

1. Sign in as the employee. Open **New request**, enter equipment, justification and maximum amount (for example R15,000), choose IT and `normal`, and submit.
2. The request appears as queued. RabbitMQ delivers its transactional outbox event; BullMQ dispatches it to the active n8n collection webhook. n8n calls the finance and supplier simulators over HTTP and sends an authenticated callback. Within a few seconds the request shows **Awaiting approval**, two quotations, a reserved budget and assigned manager. The UI polls persisted state every four seconds.
3. Sign out and sign in as the manager. Open **Approvals → Review**, inspect quotations and add a decision comment. Choose **Approve**. An approval event starts n8n's finalization webhook; a persisted purchase order appears, the reserved budget becomes spent, and execution becomes **Completed**. Inspect the request's full audit history, workflow version, correlation ID and n8n execution ID.
4. Submit another normal request as the employee. Reject it as the manager. It becomes **Rejected**, no order is created and its reservation is released.
5. Submit a request for **R600,000**, above the seeded R500,000 department budget. It becomes **Insufficient budget**, with no approval/order/reservation.
6. Submit a request with `supplier_failure` (or `finance_failure`, `missing_quotes`, `timeout`). The first integration attempt fails. Sign in as admin, open **Exceptions** or request details, and choose **Retry**. The controlled failure only affects attempt one; attempt two obtains quotations. Approve it as manager to complete recovery. Genuine service outages continue to fail until connectivity/configuration is restored.
7. As admin, open **Configuration**. Edit approval timeout and amount thresholds; the highest matching threshold selects a manager. Publish to create an immutable definition version. Existing executions keep their starting version. Integration settings let you disable an integration or change its write-only secret/authentication type.
8. To demonstrate local OAuth2, set finance to `oauth2-client-credentials`, enter client ID **`opsflow-local`**, and leave the secret blank to retain the seeded simulator secret. Submit a normal request. The adapter performs a real token exchange at the local simulator and n8n uses the resulting short-lived bearer token. This does not claim an external OAuth provider connection.

## Focused verification

```sh
npm ci
npm run db:generate
npm run build
npm run smoke
node scripts/invariants.mjs
```

`smoke` uses the running application through the React reverse proxy and real active n8n webhooks. It checks success with local OAuth2, rejection, insufficient budget, supplier failure followed by manual recovery, validation/RBAC and duplicate approval/order protection. It restores the finance authentication setting and writes a local, gitignored `verification/smoke.json`. Demo records remain visible. If the demo password was changed, set `DEMO_PASSWORD` when running smoke. The invariant check verifies authenticated callback deduplication/stale-phase protection, balanced budgets and database history triggers using the generated Prisma client and PostgreSQL port 5433. The small suite assumes enough unspent IT budget for two R1,000 purchases. Build checks require no live services; smoke requires the full healthy stack.

## Architecture and boundaries

- `apps/web`: React/TypeScript/Vite forms, requests, manager inbox, orders, executions, exceptions, dashboard, admin configuration and audit history. No frontend mock responses. Auth tokens stay in memory and clear on sign-out or expiry.
- `apps/api`: NestJS authentication, guards, DTO validation, exception filter, Swagger, procurement/operations/events modules. PostgreSQL is authoritative for users, budgets, requests, quotations, approvals, orders, workflow definitions, execution attempts, exceptions, audit history, outbox and inbox/callback receipts.
- `apps/simulators`: authenticated finance/supplier HTTP APIs and a local OAuth2 client-credentials token endpoint. Finance reads the actual available budget from NestJS. JSON Schema validates integration inputs. Failure modes are controlled per request/attempt.
- `packages/contracts`: shared DTOs/types and the integration JSON Schema. REST validation and OpenAPI derive from these DTOs; frontend request types are shared.
- `workflows`: two supported versioned n8n templates. Collection invokes finance/suppliers and persists results; finalization creates the purchase order through NestJS. Approval waiting is persisted in PostgreSQL between these two webhook executions, with no application worker or n8n execution held open. This is one logical application execution with phase-specific orchestration runs.
- `infra`: Compose, collector/Jaeger, nginx proxy, n8n bootstrap, and optional OpenTofu deployment resource scaffolding. No cloud deployment required.

A request's workflow definition version is fixed on creation. Rule changes are append-only version publications; template v1 remains a supported immutable orchestration contract. Introducing a new template requires new webhook paths and explicit backend support, not overwriting running versions. This intentionally does not implement a visual workflow designer.

See [architecture and recovery details](docs/architecture.md) for the state machine, idempotency and compensation rules.

## Development

For normal use the all-container startup is sufficient. To work on the UI, run `npm run dev:web` (Vite proxies `/api` to the running API); stop the Compose web service first to free port 5173. Backend changes can use `docker compose up -d --build api` without resetting data. `npm run dev:api` builds and watches compiled output; in a second terminal use `npx tsc -p apps/api/tsconfig.json --watch` to rebuild source edits. For a host-run backend, override the Compose URLs with localhost URLs and PostgreSQL port 5433. Do not run two backend instances just for hot reload unless intentionally testing concurrent workers.

## Troubleshooting

```sh
docker compose ps
docker compose logs --tail=80 api n8n simulators
docker compose logs --tail=80 rabbitmq redis postgres
```

- Requests remain queued: inspect admin service connectivity and unpublished outbox count. n8n must show both OpsFlow templates activated in startup logs. Webhook delivery retries five times with exponential backoff; exhausted delivery becomes a persisted exception.
- Workflow publishes but callback fails: inspect logs, DTO errors and the matching execution correlation ID. Ensure all services share the generated workflow token. A new attempt rejects old callbacks.
- n8n modifications: restart imports the checked-in templates again. Save template edits in `workflows` and version the contract before changing behavior. Bootstrap follows n8n's [Server CLI import/publish and restart instructions](https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line).
- Port conflict: change only the host side of the relevant `ports` entry. PostgreSQL intentionally uses 5433 because a host database may use 5432. Update the frontend `WEB_ORIGIN` if changing its port.
- Simulator failure: first-attempt failure is intentional when a failure scenario was chosen. Retry as admin. Ordinary requests use the normal HTTP integration.
- Secrets changed after initialization: existing seeded users/integration secrets are preserved. Keep the credential encryption key and n8n encryption key stable for existing volumes. Update secrets through admin integration configuration when changing the simulator API key. PostgreSQL's initial password is not reset by changing `.env`.
- Python task-runner warning in n8n: these templates only use Webhook and HTTP Request nodes; a Python runner is not required.
- Stop with `docker compose down`. Named volumes preserve data. Removing volumes destroys the demo history; do so only when you deliberately want a fresh stack.

## Scope and limitations

This is a complete local portfolio demonstration, not a hardened internet deployment. Services bind to localhost; TLS, external identity/real suppliers, secret-manager rotation, backups, production database permissions and multi-tenant isolation are deployment work. One manager is seeded, but routing supports multiple manager records. Approval deadlines and integration deadlines are enforced and compensated; a retry after an approved finalization failure must re-reserve the budget before proceeding. No external OAuth connection is claimed. OpenTofu provisions reusable Docker network/volume resources, not a complete cloud platform. Jaeger traces are in-memory and disappear when it restarts. Audit immutability is enforced by database triggers for ordinary writes; a database administrator can always alter database protections. Redis uses AOF persistence and RabbitMQ/PostgreSQL use volumes; catastrophic deletion of these volumes requires recovery from backups.
