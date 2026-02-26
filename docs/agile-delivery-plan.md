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
| **Testing** | Jest unit tests + integration tests, ≥ 80% coverage gate |
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
**Story Points:** 3 | **Status:** [ ]

**Description:** As a CDK author, I want reusable CDK construct helpers for Lambdas, DLQs, alarms, and tagging so that every service stack is consistent.

**Tasks:**
- [ ] Create `infra/constructs/PowertoolsLambda.ts` — Lambda with Powertools env vars, X-Ray active tracing, log format JSON
- [ ] Create `infra/constructs/DeadLetterQueue.ts` — SQS DLQ with CloudWatch alarm on `ApproximateNumberOfMessagesVisible > 0`
- [ ] Create `infra/constructs/StandardAlarms.ts` — error-rate alarm, throttle alarm, DLQ depth alarm
- [ ] Create `infra/constructs/TaggingAspect.ts` — CDK Aspect that enforces `env`, `service`, `owner` tags on all resources
- [ ] Unit-test all constructs with `aws-cdk-lib/assertions`

**Acceptance Criteria:**
- CDK assertions tests cover all constructs
- Every Lambda created via `PowertoolsLambda` automatically has: X-Ray active tracing, structured JSON log format, Powertools env vars
- Tagging Aspect applied at `App` level tags all synthesised resources

---

### US-0.3 — Shared CDK Stack: Route 53 & Health Checks
**Story Points:** 3 | **Status:** [ ]

**Description:** As an operator, I want the `SharedStack` to own the Route 53 hosted zone and health checks so that global routing is managed centrally.

**Tasks:**
- [ ] Create `infra/stacks/SharedStack.ts` (deployed to `us-east-1` — Route 53 is global, hosted zones must be in `us-east-1`)
- [ ] Define hosted zone for `api.sporder.com`
- [ ] Define latency-based routing records pointing to API Gateway endpoints in `ap-south-1` and `us-east-1`
- [ ] Define Route 53 health checks for both regions (HTTP path: `/health`, failure threshold: 3)
- [ ] Export hosted zone ARN and health check IDs as SSM parameters for use by regional stacks
- [ ] Write `docs/adr/ADR-002-global-routing-strategy.md`

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
**Story Points:** 5 | **Status:** [ ]

**Description:** As a CDK author, I want the `OrderServiceStack` to provision all Phase 1 infrastructure for the Order Service.

**Tasks:**
- [ ] Create `infra/stacks/OrderServiceStack.ts`
- [ ] Provision DynamoDB Global Table `Orders` (On-Demand, `NEW_AND_OLD_IMAGES` stream enabled for Phase 2 readiness)
  - PK: `orderId` (String), SK: `createdAt` (String)
  - GSI-1: `GSI-userId-createdAt` (PK: `userId`, SK: `createdAt`)
  - GSI-2: `GSI-country-status` (PK: `country`, SK: `status`)
  - TTL attribute: `ttl`
- [ ] Provision SNS topic `order-events-{env}` with SSE enabled
- [ ] Provision SQS queues `notification-queue` and `inventory-queue` with:
  - Visibility timeout: 6× Lambda timeout
  - Receive count: 3, DLQ: `notification-dlq` / `inventory-dlq`
- [ ] Subscribe SQS queues to SNS topic with raw message delivery disabled (envelope needed for filtering)
- [ ] Provision HTTP API Gateway with `POST /orders` route and Lambda integration
- [ ] Provision `GET /health` route returning `200 OK` (for Route 53 health checks)
- [ ] Provision Order Lambda (`PowertoolsLambda`) with least-privilege IAM:
  - `dynamodb:PutItem` on Orders table
  - `sns:Publish` on order-events topic
  - `events:PutEvents` on EventBridge bus
- [ ] Provision EventBridge custom bus `order-events-bus-{env}`
- [ ] Store `MESSAGING_MODE` as SSM Parameter (`/order-service/{env}/messaging-mode`, default: `SNS`)
- [ ] Apply `TaggingAspect` with `service=order-service`
- [ ] Write `docs/adr/ADR-003-order-service-infrastructure.md`

**Acceptance Criteria:**
- `cdk synth` produces no errors or security warnings
- No wildcard IAM actions or resources
- All SQS queues have DLQs with CloudWatch alarms
- SSM parameter `MESSAGING_MODE` is readable by Order Lambda at runtime

---

### US-1.2 — Order Lambda Handler
**Story Points:** 5 | **Status:** [ ]

**Description:** As the Order Service, I want to validate the incoming order payload, persist it to DynamoDB, fan-out to SNS and EventBridge, and return a `201 Created` response within 1 second.

**Tasks:**
- [ ] Create `src/order-service/handler.ts` as the Lambda entry point
- [ ] Define Zod schema `OrderPayloadSchema`:
  ```
  orderId: UUID v4 (auto-generated if absent)
  userId: string (min 1)
  userEmail: email
  country: ISO 3166-1 alpha-2 (2 uppercase chars)
  currency: ISO 4217 (3 uppercase chars)
  totalAmount: positive number
  items: array of { productId, productName, quantity (≥1), unitPrice (≥0) } (min 1 item)
  ```
- [ ] Validate request body with Zod; return `400` with structured error on failure
- [ ] Generate `orderId` (UUID v4) if not provided
- [ ] Generate `correlationId` (UUID v4), inject into Powertools logger context + response header `X-Correlation-Id`
- [ ] Write order to DynamoDB with `status: "PLACED"`, `region: process.env.AWS_REGION`, `createdAt`, `updatedAt`
- [ ] Read `MESSAGING_MODE` from env var; if `SNS`, publish `ORDER_PLACED` event to SNS
- [ ] Always publish `OrderPlaced` event to EventBridge (both phases)
- [ ] Return `201 Created` with `{ orderId, status: "PLACED", correlationId }`
- [ ] Create custom error classes: `ValidationError`, `DatabaseError`, `MessagingError`
- [ ] Structured error handler middleware: log error + correlation ID, return appropriate HTTP status

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
**Story Points:** 3 | **Status:** [ ]

**Description:** As a QA engineer, I want comprehensive unit tests for the Order Lambda handler so that regressions are caught before deployment.

**Tasks:**
- [ ] Mock DynamoDB, SNS, and EventBridge clients using `aws-sdk-client-mock`
- [ ] Test: valid payload → 201 + DynamoDB PutItem called + SNS Publish called + EB PutEvents called
- [ ] Test: invalid payload (missing required field) → 400
- [ ] Test: invalid `country` code (e.g. `"INDIA"`) → 400
- [ ] Test: `MESSAGING_MODE=STREAMS` → SNS Publish NOT called, EB PutEvents still called
- [ ] Test: DynamoDB failure → 500 with `DatabaseError`
- [ ] Test: correlation ID propagated to all downstream calls
- [ ] Achieve ≥ 80% coverage

**Acceptance Criteria:**
- `npm run test` exits 0
- Coverage report shows ≥ 80% for `src/order-service/`
- All mocked AWS clients assert correct input parameters

---

### US-1.4 — Order Service Integration Tests
**Story Points:** 3 | **Status:** [ ]

**Description:** As a QA engineer, I want integration tests that verify the Order Lambda interacts correctly with real (dev) DynamoDB and SNS.

**Tasks:**
- [ ] Use `jest` with `--testPathPattern=integration` tag
- [ ] Test: `POST /orders` → item appears in DynamoDB Orders table with correct attributes
- [ ] Test: `POST /orders` → SNS message is delivered to notification-queue and inventory-queue
- [ ] Test: `POST /orders` → EventBridge event is placed on `order-events-bus`
- [ ] Run against `dev` environment (real AWS resources)

**Acceptance Criteria:**
- Integration tests pass against deployed `dev` stack
- DynamoDB item with correct `orderId`, `status=PLACED`, `region` confirmed via `GetItem`
- SQS messages appear in queues within 5 seconds post-test

---

### US-1.5 — Order Service CI/CD Pipeline (DEV)
**Story Points:** 3 | **Status:** [ ]

**Description:** As a developer, I want a per-service CI/CD pipeline for the Order Service so that every commit is automatically validated and deployed to `dev`.

**Tasks:**
- [ ] Create `.github/workflows/order-service.yml` (or CodePipeline equivalent)
- [ ] Pipeline stages:
  1. **Lint** — `eslint src/order-service/`
  2. **Type Check** — `tsc --noEmit`
  3. **Test** — `jest --coverage` with 80% gate
  4. **Build** — `esbuild` bundle for Lambda
  5. **CDK Synth** — `cdk synth OrderServiceStack-dev`
  6. **Deploy** — `cdk deploy OrderServiceStack-dev --require-approval never`
- [ ] `cdk diff` runs on every PR as a required check
- [ ] Automatic rollback triggered by CloudWatch alarm breach (error rate > 1%)
- [ ] Manual approval gate added before `staging` promotion (future milestone)

**Acceptance Criteria:**
- Pushing to `main` triggers full pipeline
- Pipeline fails if unit test coverage < 80%
- Pipeline fails if `cdk synth` produces errors
- Rollback mechanism verified by artificially triggering alarm in dev

---

### US-1.6 — Order Service Documentation
**Story Points:** 2 | **Status:** [ ]

**Description:** As a new developer, I want complete documentation for the Order Service so I can understand, run, and extend it quickly.

**Tasks:**
- [ ] Create `src/order-service/README.md` with:
  - Setup instructions (env vars, local run)
  - Event schema (request payload + response)
  - SNS event schema reference → `architecture.md §6.1`
  - EventBridge event schema reference → `architecture.md §6.2`
  - Environment variables table
- [ ] JSDoc on: `handler`, `OrderPayloadSchema`, all error classes, all helper functions
- [ ] Write `docs/adr/ADR-004-order-validation-strategy.md`

**Acceptance Criteria:**
- `README.md` covers all env vars, setup steps, and event schemas
- No public function or interface lacks JSDoc

---

## Milestone 2 — Notification Service (Phase 1)

### Goals
Implement the Notification Lambda triggered by SQS, persisting notification records to DynamoDB and sending user confirmation emails via SES.

---

### US-2.1 — CDK Stack: Notification Service Infrastructure (Phase 1)
**Story Points:** 5 | **Status:** [ ]

**Description:** As a CDK author, I want the `NotificationServiceStack` to provision the Notification Lambda, Notifications DynamoDB Global Table, and SES configuration for Phase 1.

**Tasks:**
- [ ] Create `infra/stacks/NotificationServiceStack.ts`
- [ ] Provision DynamoDB Global Table `Notifications` (On-Demand):
  - PK: `notificationId` (String), SK: `createdAt` (String)
  - GSI-1: `GSI-orderId` (PK: `orderId`, SK: `createdAt`)
  - GSI-2: `GSI-status-type` (PK: `status`, SK: `type`)
  - TTL attribute: `ttl`
- [ ] Import `notification-queue` from `OrderServiceStack` (cross-stack reference via SSM parameter)
- [ ] Provision Notification Lambda (`PowertoolsLambda`) as SQS event source (batch size: 10, bisect on error: true)
- [ ] DLQ: `notification-dlq` (already provisioned in `OrderServiceStack`, import reference)
- [ ] Lambda IAM (least privilege):
  - `dynamodb:PutItem` on Notifications table
  - `ses:SendEmail` on verified SES identities only
  - `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on notification-queue
- [ ] Store SES configuration in SSM:
  - `/notification-service/{env}/ses-from-address`
  - `/notification-service/{env}/ses-reply-to-address`
- [ ] Apply `TaggingAspect` with `service=notification-service`

**Acceptance Criteria:**
- No wildcard IAM permissions
- SQS event source mapping has `bisectBatchOnError: true` and `reportBatchItemFailures: true`
- CloudWatch alarm on DLQ depth > 0

---

### US-2.2 — Notification Lambda Handler
**Story Points:** 5 | **Status:** [ ]

**Description:** As the Notification Service, I want to process SQS messages, log order details, send a confirmation email to the user, and persist a notification record to DynamoDB.

**Tasks:**
- [ ] Create `src/notification-service/handler.ts`
- [ ] Define Zod schema for SNS → SQS message envelope (parse `Records[].body` → SNS envelope → `data` field)
- [ ] For each SQS record:
  1. Extract `correlationId` from event; inject into Powertools logger
  2. Log order details (structured JSON)
  3. Send confirmation email via SES (to `userEmail`):
     - Subject: `Order Confirmed — {orderId}`
     - Body: plain text with orderId, items, totalAmount, currency
  4. `PutItem` to Notifications table: `notificationId` (UUID), `orderId`, `userId`, `userEmail`, `type=CONFIRMATION`, `status=SENT/FAILED`, `channel=EMAIL`, `subject`, `body`, `sentAt`, `retryCount`
  5. On SES failure: update `status=FAILED`, `errorMessage`, increment `retryCount`; **return `itemIdentifier`** in `batchItemFailures` for SQS partial batch failure
- [ ] Implement exponential backoff retry (max 3 attempts) for SES errors
- [ ] Idempotency: check Notifications table for existing `notificationId` before sending email (prevent duplicate sends on SQS redelivery)

**Acceptance Criteria:**
- Each processed message results in a DynamoDB notification record with `status=SENT` (or `FAILED`)
- SQS partial batch failure (`batchItemFailures`) correctly reported for failed items
- Duplicate SQS redelivery does not send duplicate email (idempotency check)
- `correlationId` from order event flows through to all log entries and DynamoDB record

---

### US-2.3 — Notification Service Unit Tests
**Story Points:** 3 | **Status:** [ ]

**Tasks:**
- [ ] Mock SES (`SendEmailCommand`) and DynamoDB (`PutItemCommand`)
- [ ] Test: valid SQS batch → sends email + writes DDB record for each message
- [ ] Test: SES failure → `batchItemFailures` contains the failing `itemIdentifier`
- [ ] Test: duplicate message (idempotency) → email NOT sent, DDB not double-written
- [ ] Test: Zod parse failure on malformed message → item in `batchItemFailures`
- [ ] Coverage ≥ 80%

---

### US-2.4 — Notification Service Integration Tests
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Send test SQS message to `notification-queue` in `dev`
- [ ] Assert: Notification record appears in DynamoDB Notifications table with `status=SENT`
- [ ] Assert: SES `SendEmail` called with correct `To`, `Subject` (verified using SES simulator address in sandbox)

---

### US-2.5 — Notification Service CI/CD Pipeline (DEV)
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Create `.github/workflows/notification-service.yml`
- [ ] Same stages as US-1.5 (Lint → Type Check → Test → Build → CDK Synth → Deploy)
- [ ] `cdk diff` on every PR as required check
- [ ] Rollback on CloudWatch alarm breach (error rate > 1%)

---

### US-2.6 — Notification Service Documentation
**Story Points:** 1 | **Status:** [ ]

**Tasks:**
- [ ] `src/notification-service/README.md`: setup, env vars, SQS message schema, DynamoDB record schema
- [ ] JSDoc on all public functions and interfaces
- [ ] `docs/adr/ADR-005-notification-idempotency.md`

---

## Milestone 3 — Inventory Service (Phase 1)

### Goals
Implement the Inventory Lambda triggered by SQS that logs/prints order details (no database).

---

### US-3.1 — CDK Stack: Inventory Service Infrastructure (Phase 1)
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Create `infra/stacks/InventoryServiceStack.ts`
- [ ] Import `inventory-queue` from `OrderServiceStack` (via SSM)
- [ ] Provision Inventory Lambda (`PowertoolsLambda`) as SQS event source (batch size: 10, bisect on error: true)
- [ ] Lambda IAM (least privilege): `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on inventory-queue
- [ ] Apply `TaggingAspect` with `service=inventory-service`

---

### US-3.2 — Inventory Lambda Handler
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Create `src/inventory-service/handler.ts`
- [ ] For each SQS record: extract `correlationId`, log full order details via Powertools structured logger
- [ ] Return success for all records (no DLQ expected for simple logging failures — log errors and continue)

**Acceptance Criteria:**
- Order details logged as structured JSON on every invocation
- Lambda does not throw on malformed messages (log + skip)

---

### US-3.3 — Inventory Service Tests, CI/CD & Docs
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Unit tests: valid batch → logs each record; malformed message → logs error, no throw
- [ ] Coverage ≥ 80%
- [ ] `.github/workflows/inventory-service.yml` (same pipeline stages)
- [ ] `src/inventory-service/README.md`

---

## Milestone 4 — Helpdesk Service (Phase 1 & 2)

### Goals
Implement the Helpdesk Lambda triggered by EventBridge for non-India orders, sending a helpdesk email via SES.

---

### US-4.1 — CDK Stack: Helpdesk Service Infrastructure
**Story Points:** 3 | **Status:** [ ]

**Tasks:**
- [ ] Create `infra/stacks/HelpdeskStack.ts`
- [ ] Provision EventBridge rule on `order-events-bus-{env}`:
  - Source: `order-service`
  - `detail-type`: `OrderPlaced`
  - Filter: `detail.country` → `{ "anything-but": "IN" }`
- [ ] Provision Helpdesk Lambda (`PowertoolsLambda`) as EventBridge target
- [ ] Lambda IAM: `ses:SendEmail` on verified helpdesk SES identity only
- [ ] Store helpdesk email in SSM: `/helpdesk-service/{env}/ses-helpdesk-address`
- [ ] Apply `TaggingAspect` with `service=helpdesk-service`
- [ ] Write `docs/adr/ADR-006-eventbridge-helpdesk-routing.md`

**Acceptance Criteria:**
- EventBridge rule only triggers for `country ≠ "IN"`
- India orders (`country=IN`) do NOT trigger Helpdesk Lambda (verified by test)

---

### US-4.2 — Helpdesk Lambda Handler
**Story Points:** 3 | **Status:** [ ]

**Tasks:**
- [ ] Create `src/helpdesk-service/handler.ts`
- [ ] Parse EventBridge event with Zod schema matching `architecture.md §6.2`
- [ ] Extract `correlationId` from event detail; inject into Powertools logger
- [ ] Send helpdesk email via SES:
  - To: helpdesk address (from SSM)
  - Subject: `Non-India Order Alert — {orderId} ({country})`
  - Body: orderId, userId, userEmail, country, totalAmount, currency
- [ ] Log successful send with correlationId

**Acceptance Criteria:**
- Helpdesk email sent for every EventBridge invocation
- `correlationId` present in all log entries
- Zod parse failure logs error and throws (triggers EventBridge retry)

---

### US-4.3 — Helpdesk Service Tests, CI/CD & Docs
**Story Points:** 2 | **Status:** [ ]

**Tasks:**
- [ ] Unit tests: valid event → `ses:SendEmail` called; invalid event → Zod error thrown
- [ ] Integration test: post non-India order → Helpdesk Lambda invoked (verify via CloudWatch Logs)
- [ ] `.github/workflows/helpdesk-service.yml`
- [ ] `src/helpdesk-service/README.md`

---

## Milestone 5 — Observability Stack

### Goals
Provision the `ObservabilityStack` with CloudWatch dashboards, alarms, and X-Ray configuration covering all services.

---

### US-5.1 — ObservabilityStack CDK
**Story Points:** 5 | **Status:** [ ]

**Description:** As an operator, I want a centralised observability stack that provides dashboards and alerts for all services.

**Tasks:**

**CloudWatch Alarms (per service, per region):**
- [ ] Order Lambda: error rate > 1%, throttle count > 0, DLQ depth > 0
- [ ] Notification Lambda: error rate > 1%, throttle count > 0, DLQ depth > 0, SES bounce rate > 5%
- [ ] Inventory Lambda: error rate > 1%, throttle count > 0
- [ ] Helpdesk Lambda: error rate > 1%
- [ ] API Gateway: p99 latency > 1000ms, 5XX rate > 1%

**CloudWatch Dashboards:**
- [ ] **Order Service:** API GW latency (p50/p99), Lambda errors/duration, DynamoDB WCU/throttles
- [ ] **Notification Service:** SQS queue depth, Lambda errors, SES send/bounce/complaint rates, DLQ depth
- [ ] **Inventory Service:** SQS queue depth, Lambda errors, DLQ depth
- [ ] **System Health:** Cross-region Lambda errors comparison, DLQ message counts, Route 53 health check status

**X-Ray:**
- [ ] Confirm all Lambdas (from `PowertoolsLambda` construct) have `tracing: lambda.Tracing.ACTIVE`
- [ ] Add X-Ray groups for each service for filtered trace views

**SNS Alarm Actions:**
- [ ] Create SNS alarm topic; subscribe ops email address (from SSM `/shared/{env}/ops-email`)
- [ ] All alarms send notifications to this topic

**Acceptance Criteria:**
- Every alarm defined in CDK with appropriate thresholds
- Dashboard widgets display real metrics from deployed dev resources
- All Lambdas appear in X-Ray service map after test invocations

---

## Milestone 6 — Multi-Region Deployment

### Goals
Deploy all stacks to both `ap-south-1` and `us-east-1` with DynamoDB Global Table replication enabled.

---

### US-6.1 — Multi-Region CDK Deployment
**Story Points:** 5 | **Status:** [ ]

**Tasks:**
- [ ] Update `infra/bin/app.ts` to instantiate all service stacks for both regions:
  ```
  new OrderServiceStack(app, 'OrderServiceStack-ap-south-1-dev', { env: { region: 'ap-south-1' }, ... })
  new OrderServiceStack(app, 'OrderServiceStack-us-east-1-dev', { env: { region: 'us-east-1' }, ... })
  ```
- [ ] Configure DynamoDB Global Tables replication: Orders table replicated to both regions; Notifications table replicated to both regions
- [ ] Deploy `SharedStack` to `us-east-1` (Route 53 is global but must be in us-east-1)
- [ ] Configure Route 53 latency routing records pointing to API GW endpoints in each region
- [ ] Configure Route 53 health checks targeting `GET /health` in each region
- [ ] Write `docs/adr/ADR-007-multi-region-deployment.md`

**Acceptance Criteria:**
- `POST api.sporder.com/orders` from an India-like IP resolves to `ap-south-1`
- `POST api.sporder.com/orders` from a US-like IP resolves to `us-east-1`
- Writing an order in `ap-south-1` → item appears in `us-east-1` DynamoDB replica within ~5 seconds
- Simulating `ap-south-1` health check failure → Route 53 routes to `us-east-1`

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
| M6 — Multi-Region Deployment | 8 | 🟡 Medium |
| M7 — Phase 2 Migration | 12 | 🟡 Medium |
| M8 — Production Hardening | 10 | 🟡 Medium |
| **Total** | **97** | |

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
