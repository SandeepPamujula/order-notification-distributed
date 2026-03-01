# Order Service — Postman Integration Tests

> **User Story:** US-1.4-P — Postman API tests mirroring the Jest integration test suite.
> **Collection file:** `order-service-integration.postman_collection.json`
> **Environment file:** `order-service-dev.postman_environment.json`

---

## Quick Start

### 1. Get the API URL

```bash
# From AWS SSM (after deploying OrderServiceStack-dev)
aws ssm get-parameter \
  --name "/order-service/dev/api-gateway-url" \
  --query "Parameter.Value" --output text
```

### 2. Import into Postman (GUI)

1. Open Postman → **Import** → drag-and-drop both `.json` files
2. Select the **"Order Service — dev"** environment (top-right dropdown)
3. Set `BASE_URL` to the `execute-api` URL from step 1
4. Click **Run Collection** to execute all tests in order

### 3. Run via Newman (CLI / CI)

```bash
# Install Newman once
npm install -g newman

# Run with the dev environment
newman run tests/postman/order-service-integration.postman_collection.json \
  --environment tests/postman/order-service-dev.postman_environment.json \
  --env-var BASE_URL=https://<YOUR_API_GW_ID>.execute-api.ap-south-1.amazonaws.com \
  --reporters cli,junit \
  --reporter-junit-export newman-report.xml
```

---

## Test Folders

| # | Folder | Tests | Description |
|---|--------|-------|-------------|
| 1 | Health Check | 4 | `GET /health` → 200 `{status:ok, service:order-service}` |
| 2 | Happy Path | 2 | `POST /orders` → 201, UUID `orderId`, `status=PLACED`, headers |
| 3 | EventBridge Dispatch | 2 | 201 response proves `EB PutEvents` succeeded (indirect assertion) |
| 4 | Validation Errors | 10 | 400 for every invalid input: missing field, bad country/email/currency, zero amount, empty items |
| 5 | Idempotency | 2 | Duplicate `orderId` → 201 both times (no 500) |
| 6 | Unknown Routes | 2 | `DELETE /orders` + unregistered path → 404 |

**Total: 22 tests**

---

## Collection Variables

These are auto-managed by pre-request and test scripts — you do **not** need to set them manually.

| Variable | Set by | Purpose |
|---|---|---|
| `orderId` | Pre-request scripts | Fresh UUID per request |
| `correlationId` | Pre-request scripts | Sent as `x-correlation-id` header |
| `createdOrderId` | Happy-path test script | Captured for idempotency test |
| `idempotencyOrderId` | Idempotency pre-request script | Fixed UUID used for both duplicate requests |

---

## Global Assertions (run on every response)

A collection-level test script asserts that **every response** contains the `X-Correlation-Id` header.
This enforces the acceptance criterion that correlation IDs flow from request to response on all paths.

---

## Comparison with Jest Integration Tests

| Jest test (`handler.integration.test.ts`) | Postman equivalent |
|---|---|
| `GET /health → 200 ok` | Folder 1 — Health Check |
| `POST /orders → 201, UUID orderId, PLACED` | Folder 2 — Happy Path |
| `POST /orders → EB indirect 201` | Folder 3 — EventBridge Dispatch |
| `POST /orders → 400 (missing userId)` | Folder 4 — Validation Errors |
| `POST /orders → 400 (country INDIA)` | Folder 4 — Validation Errors |
| `POST /orders → idempotency 201` | Folder 5 — Idempotency |
| Unknown route → 404 | Folder 6 — Unknown Routes |

> **Note:** SQS fan-out assertions (Jest tests 2 & 3 — polling notification-queue / inventory-queue)
> cannot be expressed in Postman without a custom proxy. These remain covered exclusively by the Jest
> integration suite. The Postman collection covers all HTTP-level assertions.

---

## Limitations

- **SQS polling** — Postman cannot poll SQS directly. The Jest integration tests (`npm run test:integration`) must be used to verify SNS → SQS fan-out.
- **DynamoDB direct reads** — Postman tests the HTTP layer only. DynamoDB attribute verification is done in the Jest suite.
- **EventBridge direct assertion** — Requires a catch-all SQS queue + `EB_CATCHALL_QUEUE_URL` env var (Jest). Postman uses the indirect 201 assertion.
