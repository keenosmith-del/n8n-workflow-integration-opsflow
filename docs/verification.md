# Verified local handoff — 3 October 2026

All nine Compose services were started successfully. PostgreSQL migrations and idempotent seeds ran through the API container startup command. n8n imported its header credential, imported both checked-in templates, published them and activated both production webhooks.

The TypeScript builds passed for shared contracts, NestJS, simulators and React/Vite. All three application Docker images built. The final dependency installation reported zero npm vulnerabilities. The generated OpenAPI document exposed 21 API paths. Jaeger received traces under service name `opsflow-api`.

## End-to-end results

The focused `npm run smoke` suite passed through the running React reverse proxy:

| Case | Persisted result |
|---|---|
| Successful procurement with local OAuth2 token exchange | Completed; unique purchase order; reserved amount transferred to spend |
| Manager rejection | Rejected; no purchase order; reservation released |
| Insufficient budget | Insufficient budget; no reservation or purchase order |
| Supplier outage followed by admin recovery | First attempt failed; second attempt completed after manager approval |

Real n8n HTTP calls to the finance and supplier simulators and authenticated callbacks were observed in service logs. RabbitMQ outbox publication and inbox receipts were verified in PostgreSQL. The smoke script also checked DTO validation, role restrictions and duplicate approval protection.

`node scripts/invariants.mjs` passed duplicate callback idempotency, stale attempt rejection, out-of-order phase rejection, invalid callback validation, order uniqueness, balanced budget constraints and rejection of audit/workflow-history updates by database triggers.

During integration debugging, a missing callback produced a real PostgreSQL `TIMED_OUT` state via the BullMQ deadline job. That diagnostic request was subsequently retried through the repaired n8n workflow and rejected through the authorized manager API, releasing its reservation. A new workflow configuration version was published; the existing execution retained its original version on retry.

The React interface was verified separately: an employee signed in, created `UI verified engineering laptop`, received actual quotations and a reserved budget; a manager signed in, found the approval inbox entry, approved it, and observed the persisted purchase order and completed execution/audit history. This record remains available in the application.

Local evidence is in the gitignored `verification/smoke.json`, `verification/invariants.json`, and `verification/ui-completed.jpg`. Tests leave honest demonstration records and immutable history in PostgreSQL.

## Limits of verification

No cloud deployment or OpenTofu apply was performed; the optional module is deployment resource scaffolding. No external OAuth provider, finance system or real supplier was used. Integration timeout handling and callback deadlines are implemented; prolonged real-network outages, catastrophic volume loss, production scaling and a real-time approval-deadline soak test are outside this small smoke suite. See the README for deployment limitations and recovery behavior.
