# Order Notification Distributed System — Agile Delivery Plan

> **Source of truth:** [`docs/architecture.md`](./architecture.md)
> **Stack:** Node.js · TypeScript (strict) · AWS CDK · DynamoDB
> **Regions:** `ap-south-1` (primary) · `us-east-1` (secondary)

---

## Engineering Standards (applies to every milestone)

| Standard | Requirement |
|---|---|
| **TypeScript** | `strict: true`, no `any` |
| **Validation** | Zod on every Lambda entry point |
| **Error handling** | Custom error classes, structured responses |
| **IAM** | Least privilege — no wildcard permissions |
| **Secrets** | SSM Parameter Store / Secrets Manager — no hardcoded values |
| **Observability** | `aws-lambda-powertools` structured JSON logging + X-Ray tracing |
| **Testing** | Jest unit tests + Postman integration tests, ≥ 80% coverage gate |
| **CI/CD** | Per-service pipelines: Lint → Type Check → Test → Build → CDK Synth → Deploy |
| **Infrastructure** | One CDK stack per service, environment config via CDK context (`dev`/`staging`/`prod`) |
| **Tagging** | All resources tagged: `env`, `service`, `owner` |
| **Documentation** | `README.md`, JSDoc on all public interfaces, ADR per major decision |

---

## Milestone Overview

| Milestone | Focus | Phase |
|---|---|---|
| **M0** | Project Scaffolding & Shared Infrastructure | Pre-Phase |
| **M1** | Order Service — Phase 1 (SNS fan-out) | Phase 1 |
| **M2** | Notification Service — Phase 1 | Phase 1 |
| **M3** | Inventory Service — Phase 1 | Phase 1 |
| **M4** | Helpdesk Service — Phase 1 & 2 | Phase 1 & 2 |
| **M5** | Observability Stack | Phase 1 & 2 |
| **M6** | Multi-Region & Shared Infrastructure | Phase 1 & 2 |
| **M7** | Phase 2 Migration (DynamoDB Streams) | Phase 2 |
| **M8** | Production Hardening & Load Testing | Phase 1 & 2 |

---

## Milestone 0 — Project Scaffolding & Shared Infrastructure

### Goals
Bootstrap the monorepo, CDK app structure, shared tooling, and CI/CD pipeline skeleton.

---

### US-0.1 — Monorepo & Tooling Setup
**Story Points:** 3 | **Status:** [x] Complete

**Description:** As a developer, I want a consistent, production-ready project structure with shared tooling so that all services follow the same conventions from day one.

**Tasks:**
- [x] Initialise `src/` and `infra/` directories with `tsconfig.json` (`strict: true`)
- [x] Configure ESLint with TypeScript rules + Prettier
- [x] Add `jest.config.ts` with coverage threshold: 80%
- [x] Add `.nvmrc` pinning Node.js LTS version
- [x] Create root `package.json` with workspaces for `src/order-service`, `src/notification-service`, `src/inventory-service`, `src/helpdesk-service`
- [x] Initialise CDK app in `infra/` with `cdk.json` and context entries for `dev`, `staging`, `prod`
- [x] Add `cdk diff` to PR check workflow (GitHub Actions `.github/workflows/cdk-diff.yml`)
- [x] Create shared `src/shared/` package: custom error classes, correlation-ID utilities, Zod base schemas, Powertools logger/tracer factory
- [x] Write `docs/adr/ADR-001-monorepo-structure.md`

**Acceptance Criteria:**
- `npm run build` compiles all packages without errors
- `npm run lint` exits 0 ✅
- `npm run test` runs with coverage ≥ 80% (100% on all measured files) ✅
- `cdk synth` produces valid CloudFormation with no errors
- All resources in CDK stacks carry `env`, `service`, `owner` tags ✅ (TaggingAspect)

---

### US-0.2 — Shared CDK Constructs
**Story Points:** 3 | **Status:** [x] Complete

**Description:** As a CDK author, I want reusable CDK construct helpers for Lambdas, DLQs, alarms, and tagging so that every service stack is consistent.

**Tasks:**
- [x] Create `infra/constructs/PowertoolsLambda.ts` — Lambda with Powertools env vars, X-Ray active tracing, log format JSON
- [x] Create `infra/constructs/DeadLetterQueue.ts` — SQS DLQ with CloudWatch alarm on `ApproximateNumberOfMessagesVisible > 0`
- [x] Create `infra/constructs/StandardAlarms.ts` — error-rate alarm, throttle alarm, DLQ depth alarm
- [x] Create `infra/constructs/TaggingAspect.ts` — CDK Aspect that enforces `env`, `service`, `owner` tags on all resources
- [x] Unit-test all constructs with `aws-cdk-lib/assertions`

**Acceptance Criteria:**
- CDK assertions tests cover all constructs ✅ (100% statement/function/line coverage on all construct files)
- Every Lambda created via `PowertoolsLambda` automatically has: X-Ray active tracing, structured JSON log format, Powertools env vars ✅
- Tagging Aspect applied at `App` level tags all synthesised resources ✅

---

### US-0.3 — Shared CDK Stack: Route 53 & Health Checks
**Story Points:** 3 | **Status:** [x] Complete

**Description:** As an operator, I want the `SharedStack` to own the Route 53 hosted zone and health checks so that global routing is managed centrally.

**Tasks:**
- [x] Create `infra/stacks/SharedStack.ts` (deployed to `us-east-1` — Route 53 is global, hosted zones must be in `us-east-1`)
- [x] Define hosted zone for `api.spworks.click`
- [x] Define latency-based routing records pointing to API Gateway endpoints in `ap-south-1` and `us-east-1`
- [x] Define Route 53 health checks for both regions (HTTP path: `/health`, failure threshold: 3)
- [x] Export hosted zone ARN and health check IDs as SSM parameters for use by regional stacks
- [x] Write `docs/adr/ADR-002-global-routing-strategy.md`

> **Note:** In `dev`, Route 53 latency records point to raw `execute-api` URLs (placeholder values until `OrderServiceStack` is deployed). ACM certificates and API Gateway Custom Domain Names for `api.spworks.click` are deferred to **US-6.1** (Multi-Region Deployment).

**Acceptance Criteria:**
- `cdk diff` for `SharedStack` shows only expected resources
- Health check targets are the regional API Gateway `/health` endpoints
- Route 53 configuration verified with `dig` / Route 53 resolver tests

---

## Milestone 1 — Order Service (Phase 1)

### Goals
Implement the Order Lambda, API Gateway, DynamoDB Orders table, SNS fan-out, and EventBridge publishing for Phase 1 (10K TPS).

---

### US-1.1 — CDK Stack: Order Service Infrastructure (Phase 1)
**Story Points:** 5 | **Status:** [x] Complete

**Description:** As a CDK author, I want the `OrderServiceStack` to provision all Phase 1 infrastructure for the Order Service.

**Tasks:**
- [x] Create `infra/stacks/OrderServiceStack.ts`
- [x] Provision DynamoDB table `Orders` (On-Demand, `NEW_AND_OLD_IMAGES` stream enabled for Phase 2 readiness)
  - PK: `orderId` (String), SK: `createdAt` (String)
  - GSI-1: `GSI-userId-createdAt` (PK: `userId`, SK: `createdAt`)
  - GSI-2: `GSI-country-status` (PK: `country`, SK: `status`)
  - TTL attribute: `ttl`

  > **Note:** This is a single-region table in M1. Global Table replication is enabled in **US-6.1** (Multi-Region Deployment).

- [x] Provision SNS topic `order-events-{env}` with SSE enabled
- [x] Provision SQS queues `notification-queue` and `inventory-queue` with:
  - Visibility timeout: 6× Lambda timeout
  - Receive count: 3, DLQ: `notification-dlq` / `inventory-dlq`
- [x] Subscribe SQS queues to SNS topic with raw message delivery enabled (SNS acts as pure fan-out; EventBridge handles filtered routing and transformation)
- [x] Provision HTTP API Gateway with `POST /orders` route and Lambda integration
- [x] Provision `GET /health` route returning `200 OK` (lightweight route on Order Lambda — no auth, for Route 53 health checks)
- [x] Provision Order Lambda (`PowertoolsLambda`) with least-privilege IAM:
  - `dynamodb:PutItem` on Orders table
  - `sns:Publish` on order-events topic
  - `events:PutEvents` on EventBridge bus
- [x] Provision EventBridge custom bus `order-events-bus-{env}`
- [x] Store `MESSAGING_MODE` as SSM Parameter (`/order-service/{env}/messaging-mode`, default: `SNS`)
- [x] Export cross-stack references via SSM parameters:
  - `/order-service/{env}/notification-queue-arn`
  - `/order-service/{env}/notification-dlq-arn`
  - `/order-service/{env}/inventory-queue-arn`
  - `/order-service/{env}/inventory-dlq-arn`
  - `/order-service/{env}/api-gateway-url` (raw `execute-api` URL for `SharedStack` health checks)
  - `/order-service/{env}/order-events-topic-arn`
  - `/order-service/{env}/order-events-bus-name`
  - `/order-service/{env}/orders-table-name`
  - `/order-service/{env}/orders-table-stream-arn` (for Phase 2 ESM in US-7.1)
- [x] Apply `TaggingAspect` with `service=order-service`
- [x] Write `docs/adr/ADR-003-order-service-infrastructure.md`

**Acceptance Criteria:**
- `cdk synth` produces no errors or security warnings
- No wildcard IAM actions or resources
- All SQS queues have DLQs with CloudWatch alarms
- SSM parameter `MESSAGING_MODE` is readable by Order Lambda at runtime
- All cross-stack SSM parameters are created and resolvable

---

### US-1.2 — Order Lambda Handler
**Story Points:** 5 | **Status:** [x]

**Description:** As the Order Service, I want to validate the incoming order payload, persist it to DynamoDB, fan-out to SNS and EventBridge, and return a `201 Created` response within 1 second.

**Tasks:**
- [x] Create `src/order-service/handler.ts` as the Lambda entry point
- [x] Define Zod schema `OrderPayloadSchema`:
  ```
  orderId: UUID v4 (auto-generated if absent)
  userId: string (min 1)
  userEmail: email
  country: ISO 3166-1 alpha-2 (2 uppercase chars)
  currency: ISO 4217 (3 uppercase chars)
  totalAmount: positive number
  items: array of { productId, productName, quantity (≥1), unitPrice (≥0) } (min 1 item)
  ```
- [x] Validate request body with Zod; return `400` with structured error on failure
- [x] Generate `orderId` (UUID v4) if not provided
- [x] Generate `correlationId` (UUID v4), inject into Powertools logger context + response header `X-Correlation-Id`
- [x] Write order to DynamoDB with `status: "PLACED"`, `region: process.env.AWS_REGION`, `createdAt`, `updatedAt`
- [x] Read `MESSAGING_MODE` from env var; if `SNS`, publish `ORDER_PLACED` event to SNS
- [x] Always publish `OrderPlaced` event to EventBridge (both phases)
- [x] Return `201 Created` with `{ orderId, status: "PLACED", correlationId }`
- [x] Create custom error classes: `ValidationError`, `DatabaseError`, `MessagingError`
- [x] Structured error handler middleware: log error + correlation ID, return appropriate HTTP status

**Acceptance Criteria:**
- `POST /orders` with valid payload returns `201` in < 1 second (measured in integration test)
- `POST /orders` with invalid payload returns `400` with Zod error details
- DynamoDB `PutItem` is idempotent (UUID PK prevents duplicates)
- `X-Correlation-Id` header present on every response
- SNS publish only occurs when `MESSAGING_MODE=SNS`
- EventBridge `PutEvents` always fires
- Powertools structured log emitted on every invocation with `correlationId`, `orderId`, `country`

---

### US-1.3 — Order Service Unit Tests
**Story Points:** 3 | **Status:** [x]

**Description:** As a QA engineer, I want comprehensive unit tests for the Order Lambda handler so that regressions are caught before deployment.

**Tasks:**
- [x] Mock DynamoDB, SNS, and EventBridge clients using `aws-sdk-client-mock`
- [x] Test: valid payload → 201 + DynamoDB PutItem called + SNS Publish called + EB PutEvents called
- [x] Test: invalid payload (missing required field) → 400
- [x] Test: invalid `country` code (e.g. `"INDIA"`) → 400
- [x] Test: `MESSAGING_MODE=STREAMS` → SNS Publish NOT called, EB PutEvents still called
- [x] Test: DynamoDB failure → 500 with `DatabaseError`
- [x] Test: correlation ID propagated to all downstream calls
- [x] Achieve ≥ 80% coverage

**Acceptance Criteria:**
- `npm run test` exits 0
- Coverage report shows ≥ 80% for `src/order-service/`
- All mocked AWS clients assert correct input parameters

---

### US-1.4 — Order Service Integration Tests
**Story Points:** 3 | **Status:** [x] Complete

**Description:** As a QA engineer, I want integration tests that verify the Order Lambda interacts correctly with real (dev) DynamoDB and SNS.

**Tasks:**
- [x] Use `jest` with `--testPathPattern=integration` tag
- [x] Test: `POST /orders` → item appears in DynamoDB Orders table with correct attributes
- [x] Test: `POST /orders` → SNS message is delivered to notification-queue and inventory-queue
- [x] Test: `POST /orders` → EventBridge event is placed on `order-events-bus` (direct via `EB_CATCHALL_QUEUE_URL` or indirect via 201 assertion)
- [x] Run against `dev` environment (real AWS resources)

**Acceptance Criteria:**
- Integration tests pass against deployed `dev` stack
- DynamoDB item with correct `orderId`, `status=PLACED`, `region` confirmed via `QueryCommand`
- SQS messages appear in queues within 5 seconds post-test

---

### US-1.4-P — Order Service Postman API Tests
**Story Points:** 2 | **Status:** [x] Complete

**Description:** As a QA engineer, I want a Postman collection that mirrors the integration tests so that the Order Service HTTP API can be manually explored, regression-tested via Newman in CI, and shared with the team without needing AWS credentials.

**Tasks:**
- [x] Create `tests/postman/order-service-integration.postman_collection.json` with 22 tests across 6 folders
- [x] Folder 1: `GET /health` → 200 `{status:ok, service:order-service}`
- [x] Folder 2: `POST /orders` happy path → 201, UUID `orderId`, `status=PLACED`, `X-Correlation-Id` header
- [x] Folder 3: `POST /orders` → EventBridge indirect assertion (201 proves `PutEvents` succeeded)
- [x] Folder 4: Validation errors — 400 for missing `userId`, invalid country/email/currency, zero amount, empty items, non-JSON body
- [x] Folder 5: Idempotency — duplicate `orderId` returns 201 both times
- [x] Folder 6: Unknown routes → 404
- [x] Collection-level assert: `X-Correlation-Id` header present on every response
- [x] Pre-request scripts generate fresh UUID `orderId` and `correlationId` per request
- [x] Create `tests/postman/order-service-dev.postman_environment.json` template
- [x] Create `tests/postman/README.md` with Postman GUI + Newman CLI run instructions

**Acceptance Criteria:**
- Collection runs to 22/22 passed in Postman Collection Runner against deployed `dev` stack
- Newman CLI: `newman run ... --reporters cli,junit` exits 0
- All validation-error cases assert `error=ValidationError` in the response body
- Idempotency test: second duplicate request returns 201 (not 500)
- `X-Correlation-Id` response header asserted on every request via collection-level test

**Newman CLI (quick run):**
```bash
npm install -g newman
newman run tests/postman/order-service-integration.postman_collection.json \
  --environment tests/postman/order-service-dev.postman_environment.json \
  --env-var BASE_URL=https://<YOUR_API_GW_ID>.execute-api.ap-south-1.amazonaws.com
```

> **Note:** SQS fan-out and DynamoDB attribute assertions require the Jest integration tests
> (`npm run test:integration`). Postman covers all HTTP-layer assertions only.

---

### US-1.5 — Order Service CI/CD Pipeline (DEV)
**Story Points:** 3 | **Status:** [x] Complete

**Description:** As a developer, I want a per-service CI/CD pipeline for the Order Service so that every commit is automatically validated and deployed to `dev`.

**Tasks:**
- [x] Create `.github/workflows/order-service.yml` — full push-to-main pipeline
- [x] Create `.github/workflows/order-service-pr.yml` — PR-only CDK diff + validate check
- [x] Pipeline stages:
  1. **Lint** — `npm run lint` (ESLint --max-warnings 0)
  2. **Type Check** — `npm run type-check`
  3. **Test** — `npm run test:ci` (jest --coverage with 80% threshold gate)
  4. **Build** — `npm run build` in `src/order-service` (esbuild → `dist/handler.js`)
  5. **CDK Synth** — `cdk synth OrderServiceStack-ap-south-1-dev --context env=dev`
  6. **Deploy** — `cdk deploy OrderServiceStack-ap-south-1-dev --require-approval never`
- [x] Smoke test POST-deploy: `GET /health` must return 200 before pipeline succeeds
- [x] `cdk diff` runs on every PR as a required check (posts diff as PR comment — updates existing bot comment on re-push)
- [x] Automatic rollback watch: 5-minute post-deploy CloudWatch alarm monitor (`order-service-error-rate-dev`); triggers rollback on ALARM state
- [x] AWS credentials via OIDC (`aws-actions/configure-aws-credentials@v4`) — no long-lived keys
- [x] `concurrency` group prevents parallel deployments on the same branch
- [x] Coverage report + CDK diff output uploaded as GitHub Actions artifacts
- [ ] Manual approval gate before `staging` promotion (deferred to US-1.5-staging / future milestone)

**Acceptance Criteria:**
- Pushing to `main` triggers full pipeline (Validate → Build → Synth → Deploy → Rollback Watch)
- Pipeline fails if unit test coverage < 80% (`jest.config.ts` threshold enforced in `test:ci`)
- Pipeline fails if `cdk synth` produces errors
- PR check (`order-service-pr.yml`) is a required status check — CDK diff posted as PR comment
- Post-deploy rollback watch monitors `order-service-error-rate-dev` alarm for 5 minutes; fails pipeline and initiates rollback on breach

---

### US-1.6 — Order Service Documentation
**Story Points:** 2 | **Status:** [x] Complete

**Description:** As a new developer, I want complete documentation for the Order Service so I can understand, run, and extend it quickly.

**Tasks:**
- [x] Create `src/order-service/README.md` with:
  - Overview and architecture role diagram
  - Prerequisites (Node.js, npm, AWS CLI, CDK, required IAM permissions)
  - Full environment variables table (runtime + integration test)
  - Local development guide (install → build → unit test → integration test)
  - API reference: `POST /orders` (request/response, idempotency note) + `GET /health`
  - Event schemas: §6.1 SNS `ORDER_PLACED` (including SNS message attributes) + §6.2 EventBridge `OrderPlaced` (including rule filter pattern)
  - Structured error response format + HTTP status → error class table
  - Observability section: Powertools log messages table, X-Ray subsegment, CloudWatch alarms
  - Testing section: unit, coverage, ci, integration test commands + coverage table
  - Build & deploy commands
  - Project structure + key dependencies table
- [x] JSDoc on all public interfaces and functions in `schemas.ts`:
  - `OrderPayloadSchema` (existing, plus full field-level docs)
  - `OrderPayload` type alias
  - `OrderRecord` interface (all fields)
  - `SnsOrderEvent` interface — full class doc + all field docs + `@see architecture.md §6.1`
  - `EventBridgeOrderDetail` interface — full class doc + all field docs + `@see architecture.md §6.2`
- [x] JSDoc in `handler.ts` already complete: `@module`, `handler`, `handlePlaceOrder`, `publishToSns`, `publishToEventBridge`, `handleError`, `OrderData` interface
- [x] JSDoc in `clients.ts` already complete: `docClient`, `snsClient`, `eventBridgeClient`
- [x] Write `docs/adr/ADR-004-order-validation-strategy.md`:
  - Decision 1: Lambda-level validation (vs. API Gateway)
  - Decision 2: Zod (vs. Joi, ajv, class-validator) with comparison table
  - Decision 3: Domain constraints encoded directly in Zod primitives
  - Decision 4: Structured Zod `issues` array in 400 response body
  - Decision 5: DynamoDB `ConditionExpression` idempotency (vs. Transactions)

**Acceptance Criteria:**
- `README.md` covers all env vars, setup steps, and event schemas ✅
- No public function, interface, or type lacks JSDoc ✅ (handler.ts, schemas.ts, clients.ts all fully documented)
- `docs/adr/ADR-004-order-validation-strategy.md` explains all five validation decisions with rationale and trade-offs ✅

---

## Milestone 2 — Notification Service (Phase 1)

### Goals
Implement the Notification Lambda triggered by SQS, persisting notification records to DynamoDB and sending user confirmation emails via SES.

---

### US-2.1 — CDK Stack: Notification Service Infrastructure (Phase 1)
**Story Points:** 5 | **Status:** [x] Complete

**Description:** As a CDK author, I want the `NotificationServiceStack` to provision the Notification Lambda, Notifications DynamoDB Global Table, and SES configuration for Phase 1.

**Tasks:**
- [x] Create `infra/stacks/NotificationServiceStack.ts`
- [x] Provision DynamoDB table `Notifications` (On-Demand):
  - PK: `notificationId` (String), SK: `createdAt` (String)
  - GSI-1: `GSI-orderId` (PK: `orderId`, SK: `createdAt`)
  - GSI-2: `GSI-status-type` (PK: `status`, SK: `type`)
  - TTL attribute: `ttl`

  > **Note:** Single-region table in M2. Global Table replication is enabled in **US-6.1**.

- [x] Import `notification-queue` and `notification-dlq` from `OrderServiceStack` via SSM parameters (`/order-service/{env}/notification-queue-arn`, `/order-service/{env}/notification-dlq-arn`)
- [x] Provision Notification Lambda (`PowertoolsLambda`) as SQS event source (batch size: 10, bisect on error: true)
- [x] DLQ: imported `notification-dlq` from `OrderServiceStack`
- [x] Lambda IAM (least privilege):
  - `dynamodb:PutItem` on Notifications table
  - `ses:SendEmail` on verified SES identities only
  - `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on notification-queue
- [x] Store SES configuration in SSM:
  - `/notification-service/{env}/ses-from-address`
  - `/notification-service/{env}/ses-reply-to-address`
- [x] Apply `TaggingAspect` with `service=notification-service`

**Acceptance Criteria:**
- No wildcard IAM permissions
- SQS event source mapping has `bisectBatchOnError: true` and `reportBatchItemFailures: true`
- CloudWatch alarm on DLQ depth > 0

---

### US-2.2 — Notification Lambda Handler
**Story Points:** 5 | **Status:** [x] Complete

**Description:** As the Notification Service, I want to process SQS messages, log order details, send a confirmation email to the user, and persist a notification record to DynamoDB.

**Tasks:**
- [x] Create `src/notification-service/handler.ts`
- [x] Define Zod schema for SNS → SQS message envelope (parse `Records[].body` → SNS envelope → `data` field)
- [x] For each SQS record:
  1. Extract `correlationId` from event; inject into Powertools logger
  2. Log order details (structured JSON)
  3. Send confirmation email via SES (to `userEmail`):
     - Subject: `Order Confirmed — {orderId}`
     - Body: plain text with orderId, items, totalAmount, currency
  4. `PutItem` to Notifications table: `notificationId` (UUID), `orderId`, `userId`, `userEmail`, `type=CONFIRMATION`, `status=SENT/FAILED`, `channel=EMAIL`, `subject`, `body`, `sentAt`, `retryCount`
  5. On SES failure: update `status=FAILED`, `errorMessage`, increment `retryCount`; **return `itemIdentifier`** in `batchItemFailures` for SQS partial batch failure
- [x] Implement exponential backoff retry (max 3 attempts) for SES errors
- [x] Idempotency: check Notifications table GSI-1 (`orderId`) for existing `SENT` confirmation before sending email (prevent duplicate sends on SQS redelivery)

**Acceptance Criteria:**
- Each processed message results in a DynamoDB notification record with `status=SENT` (or `FAILED`)
- SQS partial batch failure (`batchItemFailures`) correctly reported for failed items
- Duplicate SQS redelivery does not send duplicate email (idempotency check)
- `correlationId` from order event flows through to all log entries and DynamoDB record

---

### US-2.3 — Notification Service Unit Tests
**Story Points:** 3 | **Status:** [x] Complete

**Tasks:**
- [x] Mock SES (`SendEmailCommand`) and DynamoDB (`PutItemCommand`)
- [x] Test: valid SQS batch → sends email + writes DDB record for each message
- [x] Test: SES failure → `batchItemFailures` contains the failing `itemIdentifier`
- [x] Test: duplicate message (idempotency) → email NOT sent, DDB not double-written
- [x] Test: Zod parse failure on malformed message → item in `batchItemFailures`
- [x] Coverage ≥ 80%


---

### US-2.4 — Notification Service Integration Tests
**Story Points:** 2 | **Status:** [x] Complete

**Tasks:**
- [x] Write integration test as a Postman test and include it in `tests/postman/order-service-integration.postman_collection.json`
- [x] Postman Test: Send `POST /orders` to trigger the notification flow
- [x] Assert (manual or via logs): Notification record appears in DynamoDB Notifications table with `status=SENT`
- [x] Assert (manual or via logs): SES `SendEmail` called with correct `To`, `Subject` (verified using SES simulator address in sandbox)

---

### US-2.5 — Notification Service CI/CD Pipeline (DEV)
**Story Points:** 2 | **Status:** [x] Complete

**Tasks:**
- [x] Create `.github/workflows/notification-service.yml`
- [x] Same stages as US-1.5 (Lint → Type Check → Test → Build → CDK Synth → Deploy)
- [x] `cdk diff` on every PR as required check
- [x] Rollback on CloudWatch alarm breach (error rate > 1%)

---

### US-2.6 — Notification Service Documentation
**Story Points:** 1 | **Status:** [x] Complete

**Tasks:**
- [x] `src/notification-service/README.md`: setup, env vars, SQS message schema, DynamoDB record schema
- [x] JSDoc on all public functions and interfaces
- [x] `docs/adr/ADR-005-notification-idempotency.md`

---

## Milestone 3 — Inventory Service (Phase 1)

### Goals
Implement the Inventory Lambda triggered by SQS that logs/prints order details (no database).

---

### US-3.1 — CDK Stack: Inventory Service Infrastructure (Phase 1)
**Story Points:** 2 | **Status:** [x] Complete

**Tasks:**
- [x] Create `infra/stacks/InventoryServiceStack.ts`
- [x] Import `inventory-queue` from `OrderServiceStack` (via SSM)
- [x] Provision Inventory Lambda (`PowertoolsLambda`) as SQS event source (batch size: 10, bisect on error: true)
- [x] Lambda IAM (least privilege): `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on inventory-queue
- [x] Apply `TaggingAspect` with `service=inventory-service`

---

### US-3.2 — Inventory Lambda Handler
**Story Points:** 2 | **Status:** [x] Complete

**Tasks:**
- [x] Create `src/inventory-service/handler.ts`
- [x] For each SQS record: extract `correlationId`, log full order details via Powertools structured logger
- [x] Return success for all records (no DLQ expected for simple logging failures — log errors and continue)

**Acceptance Criteria:**
- Order details logged as structured JSON on every invocation
- Lambda does not throw on malformed messages (log + skip)

---

### US-3.3 — Inventory Service Tests, CI/CD & Docs
**Story Points:** 2 | **Status:** [x] Complete

**Tasks:**
- [x] Unit tests: valid batch → logs each record; malformed message → logs error, no throw
- [x] Coverage ≥ 80%
- [x] `.github/workflows/inventory-service.yml` (same pipeline stages)
- [x] `src/inventory-service/README.md`

---

## Milestone 4 — Helpdesk Service (Phase 1 & 2)

### Goals
Implement the Helpdesk Lambda triggered by EventBridge for non-India orders, sending a helpdesk email via SES.

---

### US-4.1 — CDK Stack: Helpdesk Service Infrastructure
**Story Points:** 3 | **Status:** [x] Complete

**Tasks:**
- [x] Create `infra/stacks/HelpdeskStack.ts`
- [x] Provision EventBridge rule on `order-events-bus-{env}`:
  - Source: `order-service`
  - `detail-type`: `OrderPlaced`
  - Filter: `detail.country` → `{ "anything-but": "IN" }`
- [x] Provision Helpdesk Lambda (`PowertoolsLambda`) as EventBridge target
- [x] Lambda IAM: `ses:SendEmail` on verified helpdesk SES identity only
- [x] Store helpdesk email in SSM: `/helpdesk-service/{env}/ses-helpdesk-address`
- [x] Apply `TaggingAspect` with `service=helpdesk-service`
- [x] Write `docs/adr/ADR-006-eventbridge-helpdesk-routing.md`

**Acceptance Criteria:**
- EventBridge rule only triggers for `country ≠ "IN"`
- India orders (`country=IN`) do NOT trigger Helpdesk Lambda (verified by test)

---

### US-4.2 — Helpdesk Lambda Handler
**Story Points:** 3 | **Status:** [x] Complete

**Tasks:**
- [x] Create `src/helpdesk-service/handler.ts`
- [x] Parse EventBridge event with Zod schema matching `architecture.md §6.2`
- [x] Extract `correlationId` from event detail; inject into Powertools logger
- [x] Send helpdesk email via SES:
  - To: helpdesk address (from SSM)
  - Subject: `Non-India Order Alert — {orderId} ({country})`
  - Body: orderId, userId, userEmail, country, totalAmount, currency
- [x] Log successful send with correlationId

**Acceptance Criteria:**
- Helpdesk email sent for every EventBridge invocation
- `correlationId` present in all log entries
- Zod parse failure logs error and throws (triggers EventBridge retry)

---

### US-4.3 — Helpdesk Service Tests, CI/CD & Docs
**Story Points:** 2 | **Status:** [x] Complete

**Tasks:**
- [x] Unit tests: valid event → `ses:SendEmail` called; invalid event → Zod error thrown
- [x] Integration test: write as Postman test in `tests/postman/order-service-integration.postman_collection.json` (post non-India order → verify Helpdesk Lambda invoked via CloudWatch Logs)
- [x] `.github/workflows/helpdesk-service.yml`
- [x] `src/helpdesk-service/README.md`

---

## Milestone 5 — Observability Stack

### Goals
Provision the `ObservabilityStack` with CloudWatch dashboards, alarms, and X-Ray configuration covering all services.

---

### US-5.1 — ObservabilityStack CDK
**Story Points:** 5 | **Status:** [x] Complete

**Description:** As an operator, I want a centralised observability stack that provides dashboards and alerts for all services.

**Tasks:**

**CloudWatch Alarms (per service, per region):**
- [x] Order Lambda: error rate > 1%, throttle count > 0, DLQ depth > 0
- [x] Notification Lambda: error rate > 1%, throttle count > 0, DLQ depth > 0, SES bounce rate > 5%
- [x] Inventory Lambda: error rate > 1%, throttle count > 0
- [x] Helpdesk Lambda: error rate > 1%
- [x] API Gateway: p99 latency > 1000ms, 5XX rate > 1%

**CloudWatch Dashboards:**
- [x] **Order Service:** API GW latency (p50/p99), Lambda errors/duration, DynamoDB WCU/throttles
- [x] **Notification Service:** SQS queue depth, Lambda errors, SES send/bounce/complaint rates, DLQ depth
- [x] **Inventory Service:** SQS queue depth, Lambda errors, DLQ depth
- [x] **System Health:** Cross-region Lambda errors comparison, DLQ message counts, Route 53 health check status

**X-Ray:**
- [x] Confirm all Lambdas (from `PowertoolsLambda` construct) have `tracing: lambda.Tracing.ACTIVE`
- [x] Add X-Ray groups for each service for filtered trace views

**SNS Alarm Actions:**
- [x] Create SNS alarm topic; subscribe ops email address (from SSM `/shared/{env}/ops-email`)
- [x] All alarms send notifications to this topic

**Acceptance Criteria:**
- Every alarm defined in CDK with appropriate thresholds
- Dashboard widgets display real metrics from deployed dev resources
- All Lambdas appear in X-Ray service map after test invocations

---

## Milestone 6 — Multi-Region Deployment

### Goals
Deploy all stacks to both `ap-south-1` and `us-east-1` with DynamoDB Global Table replication enabled. Provision ACM certificates and API Gateway Custom Domain Names for `api.spworks.click` (deferred from M0).

---

### US-6.1 — Multi-Region CDK Deployment
**Story Points:** 8 | **Status:** [x] Complete

**Tasks:**
- [x] Update `infra/bin/app.ts` to instantiate all service stacks for both regions:
  ```
  new OrderServiceStack(app, 'OrderServiceStack-ap-south-1-dev', { env: { region: 'ap-south-1' }, ... })
  new OrderServiceStack(app, 'OrderServiceStack-us-east-1-dev', { env: { region: 'us-east-1' }, ... })
  ```
- [x] Configure DynamoDB Global Tables replication: Orders table replicated to both regions; Notifications table replicated to both regions
- [x] Provision ACM certificates in each region for `api.spworks.click` (DNS-validated via `SharedStack` hosted zone)
- [x] Configure API Gateway Custom Domain Names in each regional `OrderServiceStack`, linked to the ACM certificates
- [x] Update `SharedStack` Route 53 latency records: swap placeholder `execute-api` URLs with real custom domain regional endpoints (exported via SSM by `OrderServiceStack`)
- [x] Write `docs/adr/ADR-007-multi-region-deployment.md`

> **Note:** `SharedStack` (Route 53 hosted zone, health checks, latency routing) was already deployed in US-0.3. This story updates the latency records from raw `execute-api` URLs to proper custom domain endpoints.

**Acceptance Criteria:**
- `POST api.spworks.click/orders` from an India-like IP resolves to `ap-south-1`
- `POST api.spworks.click/orders` from a US-like IP resolves to `us-east-1`
- Writing an order in `ap-south-1` → item appears in `us-east-1` DynamoDB replica within ~5 seconds
- Simulating `ap-south-1` health check failure → Route 53 routes to `us-east-1`
- ACM certificates are valid and attached to API Gateway Custom Domain Names in both regions

---

### US-6.2 — Contract Tests for Cross-Service Events
**Story Points:** 3 | **Status:** [ ]

**Description:** As a service owner, I want contract tests for all Kinesis/EventBridge/SNS event schemas so that schema drift between services is caught in CI.

**Tasks:**
- [ ] Define JSON Schema / Zod schemas for:
  - SNS/SQS `ORDER_PLACED` event (§6.1)
  - EventBridge `OrderPlaced` event (§6.2)
  - DynamoDB Streams record (§6.3)
- [ ] Create contract test suite in `src/shared/contract-tests/`
- [ ] Producer test (Order Service): assert published event matches schema
- [ ] Consumer test (Notification, Inventory, Helpdesk): assert handler can parse schema-compliant events
- [ ] Add contract tests to each service's CI pipeline

**Acceptance Criteria:**
- Contract tests run in CI for all services
- Changing Order event schema without updating consumer schemas fails CI

---

## Milestone 7 — Phase 2: DynamoDB Streams Migration

### Goals
Add DynamoDB Streams triggers for Notification and Inventory Lambdas, implement ESM filter for local-write-only processing, and implement `MESSAGING_MODE` feature flag migration.

---

### US-7.1 — CDK: DynamoDB Streams Event Source Mappings
**Story Points:** 5 | **Status:** [ ]

**Tasks:**
- [ ] Add DynamoDB Streams ESM to Notification Lambda in `NotificationServiceStack`:
  - Stream: Orders table stream ARN
  - Starting position: `LATEST`
  - Batch size: 100
  - Bisect on error: true
  - DLQ: `notification-dlq`
  - ESM filter (local writes only):
    ```json
    { "Filters": [{ "Pattern": "{\"dynamodb\":{\"NewImage\":{\"aws:rep:updateregion\":{\"S\":[{\"exists\":false}]}}}}" }] }
    ```
- [ ] Add DynamoDB Streams ESM to Inventory Lambda in `InventoryServiceStack` (same filter)
- [ ] Keep SQS event source mappings in place (disabled but not removed until `MESSAGING_MODE=STREAMS` is stable)
- [ ] Lambda IAM additions:
  - Notification Lambda: `dynamodb:GetRecords`, `dynamodb:GetShardIterator`, `dynamodb:DescribeStream`, `dynamodb:ListStreams` on Orders table stream
  - Inventory Lambda: same

**Acceptance Criteria:**
- ESM filter confirmed: replicated writes (with `aws:rep:updateregion`) do NOT trigger Lambda
- Local writes DO trigger Lambda
- `cdk diff` shows only ESM additions, no other changes

---

### US-7.2 — Notification Lambda: DynamoDB Streams Handler
**Story Points:** 5 | **Status:** [ ]

**Tasks:**
- [ ] Update `src/notification-service/handler.ts` to handle both `SQSEvent` and `DynamoDBStreamEvent`
- [ ] For `DynamoDBStreamEvent`:
  - Parse `DynamoDBRecord.dynamodb.NewImage` using `@aws-sdk/util-dynamodb` `unmarshall`
  - Apply application-level filter: explicitly skip and return success if `process.env.MESSAGING_MODE === 'SNS'` to prevent duplicate emails during migration
  - Apply application-level filter: skip if `aws:rep:updateregion` present (belt-and-suspenders)
  - Extract `correlationId` from item; inject into Powertools logger
  - Execute same email send + DynamoDB Notifications PutItem as Phase 1
  - Report `batchItemFailures` with `itemIdentifier = record.dynamodb.SequenceNumber`
- [ ] Idempotency: check Notifications GSI-1 (`orderId`) for existing `SENT` confirmation before sending email

**Acceptance Criteria:**
- Phase 1 path (SQS) still works with `MESSAGING_MODE=SNS`
- Phase 2 path (Streams) works with `MESSAGING_MODE=STREAMS` — set on Lambda env var, not affecting DDB Streams trigger (streams are always on)
- Replicated stream records filtered at both ESM and application level
- Duplicate stream records (same `SequenceNumber`) handled idempotently

---

### US-7.3 — Phase Migration Execution
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Document runbook in `docs/runbooks/phase2-migration.md`:
  1. Deploy Phase 2 infrastructure (US-7.1)
  2. Monitor DLQ and Lambda errors for 15 minutes
  3. Flip `MESSAGING_MODE=STREAMS` in `us-east-1` via SSM parameter update + Lambda env redeploy
  4. Monitor CloudWatch for 30 minutes (duplicate/missing notifications)
  5. If stable, flip `MESSAGING_MODE=STREAMS` in `ap-south-1`
  6. Decommission Phase 1 SNS + SQS resources (`cdk destroy` respective constructs)
- [ ] Rollback script: set `MESSAGING_MODE=SNS` via Lambda update-function-configuration (no redeployment)

**Acceptance Criteria:**
- Runbook reviewed and approved by team
- Rollback script tested in `dev` (flipping back to SNS from STREAMS)
- No duplicate or missing notifications during migration window in `dev`

---

## Milestone 8 — Production Hardening & Load Testing

### Goals
Validate the system against target TPS, ensure all operational excellence requirements are met, and establish production readiness checklist.

---

### US-8.1 — Load & Performance Testing (Phase 1 — 10K TPS)
**Story Points:** 5 | **Status:** [ ]

**Tasks:**
- [ ] Set up `artillery` or `k6` load test scripts in `tests/load/`
- [ ] Ramp test: 0 → 10,000 RPS over 5 minutes, sustain for 10 minutes
- [ ] Assert: p99 API Gateway latency < 1000ms, error rate < 0.1% during sustained load
- [ ] Assert: DLQ depth = 0 after load test
- [ ] Measure: DynamoDB throttles (expect 0 on On-Demand)
- [ ] Measure: Lambda concurrent executions vs reserved concurrency limits
- [ ] Capture results in `docs/load-test-results/phase1-10k-tps.md`

**Acceptance Criteria:**
- System sustains 10K TPS with p99 < 1s and error rate < 0.1%
- Zero DLQ messages during sustained test
- CloudWatch dashboards show expected metric profiles

---

### US-8.2 — Security Hardening
**Story Points:** 3 | **Status:** [ ]

**Tasks:**
- [ ] Enable API Gateway request throttling (10K RPS burst limit with appropriate rate limit)
- [ ] Enable AWS WAF on API Gateway (basic rate limiting + SQL injection / XSS rules)
- [ ] Review ALL IAM policies with `aws-cdk-lib/assertions` for no wildcard actions or resources
- [ ] Enable CloudTrail for API activity logging
- [ ] Enable Amazon GuardDuty
- [ ] Rotate SSM parameter secrets review (confirm no plaintext secrets in code or CDK)
- [ ] Write `docs/adr/ADR-008-security-controls.md`

**Acceptance Criteria:**
- Zero wildcard IAM permissions (automated assertion in CDK tests)
- API Gateway WAF attached and verified
- All secrets stored in SSM / Secrets Manager, none in environment variables hardcoded in CDK

---

### US-8.3 — Production Readiness Review
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Complete production readiness checklist:
  - [ ] All CloudWatch alarms defined and tested
  - [ ] DLQ monitoring and on-call runbook exists
  - [ ] Phase 2 migration runbook approved
  - [ ] Load test results show system meets Phase 1 targets
  - [ ] All ADRs written and reviewed
  - [ ] Every service `README.md` complete
  - [ ] Contract tests passing in CI
  - [ ] AWS service limit increase requests submitted for Phase 2 (API GW 100K RPS, Lambda 20K concurrency, DynamoDB 100K WCU)
- [ ] Create `docs/runbooks/dlq-remediation.md`
- [ ] Create `docs/runbooks/region-failover-test.md`

**Acceptance Criteria:**
- All checklist items completed and verified
- AWS Support tickets for Phase 2 limit increases open with ticket numbers documented

---

## Story Point Summary

| Milestone | Points | Priority |
|---|---|---|
| M0 — Scaffolding & Shared Infra | 9 | 🔴 Critical |
| M1 — Order Service (Phase 1) | 21 | 🔴 Critical |
| M2 — Notification Service (Phase 1) | 18 | 🔴 Critical |
| M3 — Inventory Service (Phase 1) | 6 | 🟠 High |
| M4 — Helpdesk Service | 8 | 🟠 High |
| M5 — Observability Stack | 5 | 🟠 High |
| M6 — Multi-Region Deployment | 11 | 🟡 Medium |
| M7 — Phase 2 Migration | 12 | 🟡 Medium |
| M8 — Production Hardening | 10 | 🟡 Medium |
| **Total** | **100** | |

---

## Suggested Sprint Plan (2-week sprints)

| Sprint | Milestones | Focus |
|---|---|---|
| Sprint 1 | M0, M1 (US-1.1, US-1.2) | Scaffold + Order Service core |
| Sprint 2 | M1 (US-1.3–1.6), M2 (US-2.1, US-2.2) | Order tests/CI/docs + Notification core |
| Sprint 3 | M2 (US-2.3–2.6), M3, M4 | Notification & Inventory & Helpdesk |
| Sprint 4 | M5, M6 | Observability + Multi-region |
| Sprint 5 | M7 | Phase 2 DynamoDB Streams migration |
| Sprint 6 | M8 | Production hardening & load testing |
