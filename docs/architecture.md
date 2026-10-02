# State, delivery and recovery

Amounts use integer ZAR cents. Requests begin `QUEUED`; the logical execution is `QUEUED` then `RUNNING` when n8n accepts a webhook. Integration results atomically reserve the cheapest quotation and route approval, producing `AWAITING_APPROVAL`. A manager decision either closes `REJECTED` and releases budget, or transitions to `APPROVED`, creates a finalization outbox event, and completes with a unique purchase order. Integration failure becomes `FAILED`; callback/approval deadline expiry becomes `TIMED_OUT`; finance or atomic reservation failure becomes `INSUFFICIENT_BUDGET`.

## Transaction boundaries

Request + execution + creation audit + outbox insertion commit together. Callback processing commits receipt + quotations + conditional budget reservation + approval + status + audit together. Manager decisions commit approval + status + audit + finalization outbox together. Finalization commits order + reserved-to-spent transfer + status + audit together. Transactions use serializable isolation with bounded conflict retries. Budget SQL checks available funds atomically, and database constraints prevent negative reserves/spend and overspending.

Orders and approvals are unique per request. Quotes are unique per supplier/request/attempt. The order amount is validated against the reservation and selected quotation. Employee ownership restricts requests, executions and orders; only the assigned manager can decide, even if another manager can inspect a request. Employees cannot recover exceptions or alter workflow rules/integration credentials.

## Delivery responsibilities

1. The PostgreSQL outbox is polled under row locks. The publisher sends persistent RabbitMQ events using broker confirms and marks publication only after confirmation. If it crashes after a confirm but before commit, duplicate publication is safe.
2. RabbitMQ has a durable domain exchange/consumer queue. The consumer adds a BullMQ `deliver` job using the event UUID as its stable job ID, then records a PostgreSQL inbox receipt, then acknowledges RabbitMQ. A crash between these steps causes redelivery and the existing job/receipt deduplicates it. Completed delivery jobs are retained to preserve stable-job deduplication. The invalid-message queue retains malformed envelope messages.
3. BullMQ alone handles delivery retries, using five attempts and exponential backoff. Its workers dispatch events to n8n HTTP webhooks. RabbitMQ does not independently retry the finance/supplier business operation. n8n runs the HTTP integrations; it retries only persistence callbacks, which are idempotent.
4. Every active execution has a PostgreSQL deadline. Reconciliation creates delayed BullMQ jobs every two seconds, using execution/attempt/phase/deadline as the stable ID. Waiting occupies no worker. Expired jobs re-check authoritative state before acting. The reconciler restores missed jobs after a normal Redis/service restart.

A webhook HTTP acceptance is not procurement success. Business transitions only happen on authenticated callbacks. `RUNNING` updates are conditional, so a fast callback cannot be overwritten by late delivery bookkeeping. Missing callbacks eventually produce a timed-out exception. Admin recovery increments the attempt and creates a new event; it does not reuse an old receipt or overwrite the definition version.

## Callback safety

The internal API and n8n webhooks require the shared workflow header credential. Each event also has a random callback key bound to execution/attempt/phase. The backend does not return callback keys in user-facing responses. A callback receipt has a unique execution/attempt/phase constraint. Repeated callbacks return the committed outcome without repeating a reservation/order. A callback from an old attempt or a different phase returns conflict. A rejected/completed/timed-out execution cannot be resurrected by delayed messages. Approval decisions after closure or deadline are rejected. No browser can call these internal APIs with only a user JWT.

## Compensation and recovery

Rejected or expired approvals release reserved funds. Integration failure and callback deadline expiry also release any reservation. If finalization failed after approval, manual retry re-reserves the approved quotation atomically; insufficient funds prevent unsafe retry. Unapproved failures restart collection and route a new approval, clearing any expired undecided approval. Approved failures retry only finalization. Unique order constraints and transaction conflict retry prevent concurrent workers creating duplicate orders.

Controlled simulator outages/missing quotes/timeouts affect attempt one only. This lets the same request demonstrate an integration failure and later recovery. Actual network outages and invalid integration credentials continue failing until fixed. No frontend action fabricates a successful integration.

## Credentials and observability

Integration API keys/client secrets use AES-256-GCM encryption with a separate environment-provided key. Admin reads return metadata only; writes never echo the secret. URLs are fixed to the local simulator, preventing arbitrary URL/SSRF configuration. The internal credential adapter decrypts only server-side, or exchanges OAuth client credentials for a short-lived token. n8n retrieves the HTTP headers over the private Compose network. n8n execution payload storage is disabled because these transient outputs contain credentials. Do not enable it without replacing the adapter with n8n-managed credentials and reviewing redaction.

Pino logs method/path/status/duration/correlation ID without request bodies or auth headers. OpenTelemetry automatically instruments HTTP, PostgreSQL, Redis and RabbitMQ where supported, exporting via the collector to Jaeger. Execution records retain correlation IDs, starting definition version, attempts, phase, deadlines, errors and the most recent n8n execution ID. Audit entries preserve phase results and earlier collection n8n IDs. UI metrics query these persisted business records; connectivity checks query live services.

The provided roles are a local demonstration. JWTs expire after two hours, password hashes use bcrypt, and login attempts are bounded in memory. No refresh-token or email/password-recovery service is included. Browser reload requires sign-in again.
