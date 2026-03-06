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

---

# Multi-Region — Postman Integration Tests (US-6.1)

> **User Story:** US-6.1 — Multi-Region CDK Deployment
> **Collection file:** `multi-region-integration.postman_collection.json`
> **Environment file:** `multi-region-dev.postman_environment.json`

These tests verify the multi-region deployment using the Route 53 hosted zone (`api.spworks.click`), direct regional endpoints, cross-region DynamoDB Global Table replication, and region parity.

---

## Quick Start

### 1. Get the Regional API URLs

```bash
# Primary region (ap-south-1)
aws ssm get-parameter \
  --name "/order-service/dev/api-gateway-url" \
  --query "Parameter.Value" --output text \
  --region ap-south-1

# Secondary region (us-east-1)
aws ssm get-parameter \
  --name "/order-service/dev/api-gateway-url" \
  --query "Parameter.Value" --output text \
  --region us-east-1
```

### 2. Import into Postman (GUI)

1. Open Postman → **Import** → drag-and-drop both multi-region `.json` files
2. Select the **"Multi-Region — dev"** environment
3. Update these environment variables:
   - `HOSTED_ZONE_URL` → `https://api.spworks.click`
   - `PRIMARY_BASE_URL` → `https://<primary-id>.execute-api.ap-south-1.amazonaws.com`
   - `SECONDARY_BASE_URL` → `https://<secondary-id>.execute-api.us-east-1.amazonaws.com`
4. Click **Run Collection** to execute all tests in order

### 3. Run via Newman (CLI / CI)

```bash
newman run tests/postman/multi-region-integration.postman_collection.json \
  --environment tests/postman/multi-region-dev.postman_environment.json \
  --env-var HOSTED_ZONE_URL=https://api.spworks.click \
  --env-var PRIMARY_BASE_URL=https://<PRIMARY_ID>.execute-api.ap-south-1.amazonaws.com \
  --env-var SECONDARY_BASE_URL=https://<SECONDARY_ID>.execute-api.us-east-1.amazonaws.com \
  --reporters cli,junit \
  --reporter-junit-export newman-multi-region-report.xml
```

---

## Multi-Region Test Folders

| # | Folder | Tests | Description |
|---|--------|-------|-------------|
| 1 | Custom Domain Health Check | 2 | `GET api.spworks.click/health` → 200, TLS cert valid |
| 2 | Custom Domain Order Placement | 2 | `POST api.spworks.click/orders` → 201 happy path, 400 validation |
| 3 | Primary Region Direct (ap-south-1) | 2 | Direct health check + order placement against primary |
| 4 | Secondary Region Direct (us-east-1) | 2 | Direct health check + order placement against secondary |
| 5 | Cross-Region DynamoDB Replication | 2 | Write in primary, verify secondary is reachable, log CLI command for replication check |
| 6 | Region Parity | 2 | Both regions return identical response shapes for health + errors |

**Total: 12 tests**

---

## What the Multi-Region Tests Prove

| Verification | How |
|---|---|
| **ACM certificate is valid** | TLS handshake succeeds on `https://api.spworks.click` |
| **API Gateway Custom Domain** works | Health check via custom domain returns 200 |
| **Route 53 latency routing** resolves | Custom domain response succeeds from any location |
| **Both regions are independently healthy** | Direct health checks on both `execute-api` URLs |
| **Both regions accept orders** | Direct `POST /orders` on both regional endpoints |
| **DynamoDB Global Table replication** | Order written in `ap-south-1`, verifiable in `us-east-1` via CLI |
| **Response parity** | Both regions return the same keys, error types, and shapes |

---

## Environment Variables

| Variable | Description |
|---|---|
| `HOSTED_ZONE_URL` | `https://api.spworks.click` — Route 53 latency-routed URL |
| `PRIMARY_BASE_URL` | Direct `execute-api` URL for `ap-south-1` |
| `SECONDARY_BASE_URL` | Direct `execute-api` URL for `us-east-1` |
| `DOMAIN_NAME` | `api.spworks.click` — used for explicit TLS test |
| `DEPLOY_ENV` | `dev` — descriptive only |

