# Order Service

> **Phase 1 implementation** of the Order Service microservice.
> Accepts, validates, persists, and fans out order events to SNS and EventBridge.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Role](#architecture-role)
3. [Prerequisites](#prerequisites)
4. [Environment Variables](#environment-variables)
5. [Local Development](#local-development)
6. [API Reference](#api-reference)
   - [POST /orders](#post-orders)
   - [GET /health](#get-health)
7. [Event Schemas](#event-schemas)
   - [§6.1 SNS ORDER_PLACED Event](#61-sns-order_placed-event)
   - [§6.2 EventBridge OrderPlaced Event](#62-eventbridge-orderplaced-event)
8. [Error Responses](#error-responses)
9. [Observability](#observability)
10. [Testing](#testing)
11. [Build & Deploy](#build--deploy)
12. [Project Structure](#project-structure)

---

## Overview

The Order Service is an HTTP API Gateway + Lambda microservice that:

1. **Validates** the incoming order payload using [Zod](https://zod.dev/) schema definitions
2. **Persists** the order to the DynamoDB `Orders` table with `status=PLACED`
3. **Fans out** an `ORDER_PLACED` event to SNS (Phase 1, `MESSAGING_MODE=SNS`) for delivery to the Notification and Inventory SQS queues
4. **Publishes** an `OrderPlaced` event to EventBridge for the Helpdesk Service to consume (all phases)
5. **Returns** `201 Created` with the `orderId`, `status`, and `correlationId`

---

## Architecture Role

```
Client
  │  POST /orders
  ▼
API Gateway (HTTP API)
  │
  ▼
Order Lambda (this service)
  ├── DynamoDB PutItem ──────────────────► Orders table (status=PLACED)
  ├── SNS Publish (MESSAGING_MODE=SNS) ──► order-events-{env}
  │     ├── SQS subscription ────────────► notification-queue-{env}
  │     └── SQS subscription ────────────► inventory-queue-{env}
  └── EB PutEvents ───────────────────────► order-events-bus-{env}
                                              └── Rule (country ≠ IN) ► Helpdesk Lambda
```

> See [`docs/architecture.md`](../../docs/architecture.md) for the full system diagram.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 22 (see `.nvmrc`) |
| npm | ≥ 10 |
| AWS CLI | ≥ 2.x |
| AWS CDK | ≥ 2.x |

AWS credentials with the following IAM permissions must be available for deployment:

- `dynamodb:PutItem` on `orders-{env}`
- `sns:Publish` on `order-events-{env}`
- `events:PutEvents` on `order-events-bus-{env}`

For local development using integration tests, additionally:

- `dynamodb:Query`, `dynamodb:DeleteItem` on `orders-{env}`
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:PurgeQueue`, `sqs:GetQueueUrl` on `notification-queue-{env}` / `inventory-queue-{env}`
- `ssm:GetParameter` on `/order-service/{env}/*`

---

## Environment Variables

These are injected by CDK at deploy time. For local integration testing, override them via shell export or a `.env` file.

### Runtime (Lambda)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORDERS_TABLE_NAME` | ✅ | — | DynamoDB table name — e.g. `orders-dev` |
| `ORDER_EVENTS_TOPIC_ARN` | ✅ | — | SNS topic ARN — e.g. `arn:aws:sns:ap-south-1:123456789012:order-events-dev` |
| `ORDER_EVENTS_BUS_NAME` | ✅ | — | EventBridge custom bus name — e.g. `order-events-bus-dev` |
| `MESSAGING_MODE` | ✅ | `SNS` | `SNS` (Phase 1) or `STREAMS` (Phase 2). Controls whether SNS fan-out fires. Read **per-invocation** so it can be toggled without a cold start. |
| `AWS_REGION` | auto | `ap-south-1` | Injected by the Lambda runtime. Stored as `region` on each DynamoDB record. |
| `POWERTOOLS_SERVICE_NAME` | auto | `order-service` | Set by CDK via `PowertoolsLambda` construct. |
| `LOG_LEVEL` | optional | `INFO` | Powertools log level: `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `POWERTOOLS_TRACER_CAPTURE_RESPONSE` | auto | `true` | X-Ray captures Lambda response. |

### Integration Tests Only

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORDER_SERVICE_API_URL` | optional | resolved from SSM | Base URL of the deployed API Gateway |
| `ORDERS_TABLE_NAME` | optional | `orders-dev` | Override for a non-default DynamoDB table |
| `DEPLOY_ENV` | optional | `dev` | Target environment for SSM parameter resolution |
| `EB_CATCHALL_QUEUE_URL` | optional | — | SQS queue wired to all EB events — enables direct EventBridge assertion in integration tests |

---

## Local Development

### 1. Install dependencies

```bash
# From the repository root
npm ci
```

### 2. Build the Lambda bundle

```bash
# Production (minified)
npm run build --workspace=src/order-service

# Development (source maps, no minify)
npm run build:dev --workspace=src/order-service
```

The output is written to `src/order-service/dist/handler.js`.

### 3. Run unit tests

```bash
# Unit tests only (no AWS credentials needed)
npm run test

# With coverage report (≥ 80% gate)
npm run test:coverage
```

### 4. Run integration tests

Integration tests exercise **real deployed AWS resources** in the `dev` environment.

```bash
# Prerequisites: deploy the dev stack and configure AWS credentials
cdk deploy OrderServiceStack-ap-south-1-dev --context env=dev

# Run integration tests
npm run test:integration
```

> See [`tests/postman/README.md`](../../tests/postman/README.md) for Postman / Newman instructions.

---

## API Reference

All responses include the `X-Correlation-Id` header echoing the value from the request (or a server-generated UUID v4 if absent).

### POST /orders

Places a new order.

**Request headers**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | ✅ | Must be `application/json` |
| `x-correlation-id` | optional | Caller-provided UUID v4. Generated server-side if absent. |

**Request body**

```jsonc
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",  // optional — auto-generated if absent
  "userId": "user-123",                               // required, non-empty string
  "userEmail": "user@example.com",                    // required, valid email
  "country": "IN",                                    // required, ISO 3166-1 alpha-2 (2 UPPER chars)
  "currency": "INR",                                  // required, ISO 4217 (3 UPPER chars)
  "totalAmount": 1499.00,                             // required, strictly positive number
  "items": [                                          // required, at least 1 item
    {
      "productId": "prod-001",                        // required, non-empty string
      "productName": "Widget",                        // required, non-empty string
      "quantity": 2,                                  // required, integer ≥ 1
      "unitPrice": 749.50                             // required, number ≥ 0
    }
  ]
}
```

**Successful response — `201 Created`**

```json
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "PLACED",
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

**Idempotency** — Submitting a request with an `orderId` matching an existing record returns `201` without throwing (the DynamoDB `ConditionExpression` catches the duplicate and the handler returns immediately with the original response).

---

### GET /health

Lightweight health check endpoint — no auth, no downstream calls.
Used by Route 53 health checks (failure threshold: 3 consecutive failures).

**Response — `200 OK`**

```json
{
  "status": "ok",
  "service": "order-service"
}
```

---

## Error Responses

All error responses use the following JSON envelope:

```jsonc
{
  "error": "ValidationError",        // Error class name
  "message": "Human-readable text",  // Error summary
  "statusCode": 400,                 // HTTP status code
  "correlationId": "<uuid>",         // Echoed from request or server-generated
  "details": [ ... ]                 // Zod issues (ValidationError only)
}
```

| HTTP Status | `error` value | Cause |
|---|---|---|
| `400` | `ValidationError` | Request body fails Zod schema validation, or body is not valid JSON |
| `404` | `NotFound` | Route not registered (e.g. `DELETE /orders`) |
| `500` | `DatabaseError` | DynamoDB `PutItem` failed |
| `502` | `MessagingError` | SNS `Publish` or EventBridge `PutEvents` failed |
| `500` | `InternalError` | Unclassified / unexpected error |

---

## Event Schemas

### §6.1 SNS ORDER_PLACED Event

Published to `order-events-{env}` SNS topic when `MESSAGING_MODE=SNS`.
Delivered to `notification-queue` and `inventory-queue` via SQS subscriptions (raw message delivery enabled — no SNS envelope wrapper in the SQS body).

```jsonc
{
  "eventId": "uuid-v4",                  // Unique event ID
  "eventType": "ORDER_PLACED",          // Always "ORDER_PLACED"
  "timestamp": "2026-03-01T17:00:00Z",  // ISO 8601 write timestamp
  "source": "order-service",
  "region": "ap-south-1",              // Region where the order was placed
  "correlationId": "uuid-v4",          // Propagated from the original request
  "data": {
    "orderId": "uuid-v4",
    "userId": "user-123",
    "userEmail": "user@example.com",
    "country": "IN",
    "currency": "INR",
    "totalAmount": 1499.00,
    "items": [
      {
        "productId": "prod-001",
        "productName": "Widget",
        "quantity": 2,
        "unitPrice": 749.50
      }
    ],
    "status": "PLACED"
  }
}
```

**SNS Message Attributes**

| Attribute | DataType | Value |
|---|---|---|
| `eventType` | String | `ORDER_PLACED` |
| `correlationId` | String | UUID v4 |

> Full schema reference: [`architecture.md §6.1`](../../docs/architecture.md)

---

### §6.2 EventBridge OrderPlaced Event

Published to `order-events-bus-{env}` on **every** order (both Phase 1 and Phase 2).

| Field | Value |
|---|---|
| `Source` | `order-service` |
| `DetailType` | `OrderPlaced` |
| `EventBusName` | `order-events-bus-{env}` |

**`Detail` payload:**

```jsonc
{
  "orderId": "uuid-v4",
  "userId": "user-123",
  "userEmail": "user@example.com",
  "country": "US",              // Used by Helpdesk EventBridge rule: country ≠ "IN"
  "totalAmount": 299.99,
  "currency": "USD",
  "correlationId": "uuid-v4"
}
```

The Helpdesk Lambda (`HelpdeskStack`, US-4.1) subscribes to this bus with the rule:

```json
{
  "source": ["order-service"],
  "detail-type": ["OrderPlaced"],
  "detail": { "country": [{ "anything-but": "IN" }] }
}
```

> Full schema reference: [`architecture.md §6.2`](../../docs/architecture.md)

---

## Observability

### Structured Logging (AWS Lambda Powertools)

Every Lambda invocation emits structured JSON log entries. Key fields on every log line:

| Field | Description |
|---|---|
| `correlationId` | Request correlation ID (propagated from `x-correlation-id` header) |
| `service` | Always `order-service` |
| `level` | `INFO` / `WARN` / `ERROR` |
| `timestamp` | ISO 8601 |

**Key log messages:**

| Level | Message | When |
|---|---|---|
| `INFO` | `Incoming request` | Every Lambda invocation |
| `INFO` | `Order payload validated` | After successful Zod parse |
| `INFO` | `Order persisted to DynamoDB` | After `PutItem` succeeds |
| `WARN` | `Duplicate orderId detected — returning idempotent 201` | `ConditionalCheckFailedException` |
| `INFO` | `SNS ORDER_PLACED event published` | After SNS `Publish` succeeds |
| `INFO` | `EventBridge OrderPlaced event published` | After EB `PutEvents` succeeds |
| `INFO` | `Order placed successfully` | After all fan-out calls succeed |
| `WARN` | `Route not found` | Unknown HTTP method/path |
| `ERROR` | `Application error` | Any `AppError` subclass thrown |

### X-Ray Tracing

Active X-Ray tracing is enabled via the `PowertoolsLambda` CDK construct.
A custom X-Ray subsegment (`handlePlaceOrder`) wraps the full order placement flow.

### CloudWatch Alarms

| Alarm | Threshold | Description |
|---|---|---|
| `order-service-error-rate-dev` | > 1% | Lambda errors / invocations over 1 min |
| `order-service-throttles-dev` | > 0 | Any Lambda throttle triggers alert |
| `order-service-dlq-depth-dev` | > 0 | Messages visible in the DLQ |

---

## Testing

```bash
# Unit tests (mocked AWS clients — no credentials needed)
npm run test

# Unit tests with coverage report (≥ 80% gate)
npm run test:coverage

# CI mode (--ci flag, coverage enforced)
npm run test:ci

# Integration tests (real AWS resources in dev — requires creds + deployed stack)
npm run test:integration
```

**Unit test coverage (latest):**

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `handler.ts` | 97.4% | 82.75% | 100% | 97.36% |
| `schemas.ts` | 100% | 100% | 100% | 100% |
| `clients.ts` | 100% | 100% | 100% | 100% |

---

## Build & Deploy

```bash
# 1. Build Lambda bundle (production, minified)
npm run build --workspace=src/order-service
# Output: src/order-service/dist/handler.js + handler.js.map

# 2. CDK synth (validate CloudFormation)
npm run cdk:synth -- --context env=dev

# 3. Deploy to dev
cd infra && npx cdk deploy OrderServiceStack-ap-south-1-dev \
  --context env=dev \
  --require-approval never

# 4. Verify health endpoint
curl https://<api-gw-id>.execute-api.ap-south-1.amazonaws.com/health
```

The full CI/CD pipeline (`.github/workflows/order-service.yml`) automates all steps above on every push to `main`.

---

## Project Structure

```
src/order-service/
├── src/
│   ├── handler.ts        # Lambda entry point — routes GET /health + POST /orders
│   ├── schemas.ts        # Zod schemas (OrderPayloadSchema) + TypeScript interfaces
│   └── clients.ts        # AWS SDK client singletons (DynamoDB, SNS, EventBridge)
├── tests/
│   ├── handler.test.ts              # Unit tests (aws-sdk-client-mock)
│   └── handler.integration.test.ts  # Integration tests (real AWS resources)
├── dist/                 # esbuild output (git-ignored)
├── package.json
└── tsconfig.json
```

### Key dependencies

| Package | Role |
|---|---|
| `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` | DynamoDB v3 SDK with Document client |
| `@aws-sdk/client-sns` | SNS v3 SDK |
| `@aws-sdk/client-eventbridge` | EventBridge v3 SDK |
| `@aws-lambda-powertools/logger` | Structured JSON logging |
| `@aws-lambda-powertools/tracer` | X-Ray tracing |
| `zod` | Runtime schema validation |
| `@order-notification/shared` | Shared error classes, correlation utilities, Zod base schemas |
