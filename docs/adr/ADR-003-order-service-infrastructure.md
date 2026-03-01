# ADR-003 — Order Service Infrastructure (Phase 1)

**Status:** Accepted  
**Date:** 2026-03-01  
**Deciders:** Platform Team  
**Relates to:** US-1.1, `architecture.md §2.1`, `architecture.md §7.1`

---

## Context

The Order Service is the entry point for all order traffic. It must:

- Accept `POST /orders` requests via an HTTP API Gateway
- Persist orders to DynamoDB
- Fan-out order events to downstream services (Notification, Inventory) via SNS + SQS (Phase 1)
- Route non-India orders to the Helpdesk Lambda via EventBridge
- Respond within **< 1 second** (acknowledgement SLA)
- Be deployable to both `ap-south-1` and `us-east-1` with identical stacks

This ADR documents the infrastructure decisions made for `OrderServiceStack` (Phase 1, 10K TPS target).

---

## Decisions

### 1. HTTP API Gateway v2 over REST API v1

**Decision:** Use `AWS::ApiGatewayV2::Api` (HTTP API).

**Rationale:**
- HTTP APIs are ~70% cheaper than REST APIs for equivalent proxy integrations.
- Lower per-request latency (no additional REST processing overhead).
- `POST /orders` is a simple Lambda-proxy integration — no need for REST API features (usage plans, API keys, request validators at GW level).
- Validation is performed inside the Lambda via Zod (architectural standard).

**Trade-off:** HTTP APIs lack built-in AWS WAF integration (WAF is added in US-8.2 via a WAF WebACL associated with the Stage). This is acceptable for Phase 1/dev.

---

### 2. SNS Subscription Raw Message Delivery Enabled

**Decision:** Set `rawMessageDelivery: true` on both SNS → SQS subscriptions.

**Rationale:**
- The SNS topic is used purely as a fan-out mechanism. No SNS subscription filter policies are required.
- EventBridge (not SNS) handles filtered routing — specifically, the Helpdesk rule (`country ≠ IN`) uses the EventBridge custom bus.
- With raw delivery enabled, SQS consumers receive the plain JSON payload without the SNS envelope wrapper, which simplifies Lambda handler parsing and Zod schema validation.
- Avoids the need for consumers to handle `{ Type: "Notification", Message: "..." }` wrapping.

**Trade-off:** If SNS subscription filter policies are needed in future, raw message delivery must be disabled. This is a one-line CDK change and a non-breaking infrastructure update.

---

### 3. EventBridge Custom Bus (not default bus)

**Decision:** Provision a custom EventBridge bus `order-events-bus-{env}`.

**Rationale:**
- The default event bus receives AWS service events (e.g. EC2 state changes, Console login). Mixing application events with AWS service events on the default bus creates noise and increases the risk of accidental rule matches.
- A custom bus scopes IAM permissions: only the Order Lambda has `events:PutEvents` on this specific bus ARN.
- Isolates order events per environment (`order-events-bus-dev`, `order-events-bus-staging`, `order-events-bus-prod`).

---

### 4. DynamoDB Streams Enabled from Day One (Phase 2 Readiness)

**Decision:** Enable `StreamViewType.NEW_AND_OLD_IMAGES` on the Orders table at creation time.

**Rationale:**
- Enabling streams on an existing table is a non-destructive operation, but it requires a CloudFormation table update. Since DynamoDB tables can be sensitive to updates (index additions can cause replacement in some CDK versions), it is safer to enable it upfront.
- The stream ARN is exported to SSM (`/order-service/{env}/orders-table-stream-arn`) immediately, so Phase 2 (US-7.1 ESM wiring) requires no change to `OrderServiceStack`.
- `NEW_AND_OLD_IMAGES` is chosen over `NEW_IMAGE` to support potential future use cases (auditing, undo operations).

**Trade-off:** Minimal cost increase (~$0.02/GB for stream reads); negligible at Phase 1 volumes.

---

### 5. MESSAGING_MODE Feature Flag via SSM Parameter

**Decision:** Store `MESSAGING_MODE` as an SSM parameter (`/order-service/{env}/messaging-mode`, default: `SNS`). The value is also injected as a Lambda environment variable at deploy time.

**Rationale:**
- Allows switching from Phase 1 (SNS fan-out) to Phase 2 (DynamoDB Streams) without a code change or Lambda redeployment.
- SSM Parameter Store is the standard secrets/config store in this system (no hardcoded values, per engineering standards).
- The Lambda reads the env var at startup (set by CDK to `SNS`). During Phase 2 migration (US-7.3), the SSM value and Lambda env var are both flipped to `STREAMS` via `update-function-configuration`.

---

### 6. Cross-Stack References via SSM Parameters (not CloudFormation Exports)

**Decision:** All cross-stack references are exported as SSM parameters, not CloudFormation `Fn::ImportValue` exports.

**Rationale:**
- CloudFormation `Fn::ImportValue` creates a hard dependency between stacks. Once a stack imports an export, the exporting stack cannot be updated to modify or remove that output — the importing stack must be deleted first.
- SSM parameters can be updated freely without coordination between stacks. Downstream stacks resolve SSM values at synthesis time (for CDK) or at runtime (for Lambda env vars), decoupling the deployment lifecycle.
- This pattern is consistent with `SharedStack` (US-0.3) and `BaselineStack` (US-0.1).

---

### 7. Least-Privilege IAM

**Decision:** Order Lambda is granted only:
- `dynamodb:PutItem` (via `grantWriteData`) on the Orders table ARN
- `sns:Publish` on the order-events topic ARN
- `events:PutEvents` on the order-events-bus ARN
- `ssm:GetParameter` on the MESSAGING_MODE parameter ARN

No wildcard actions or resources. Verified by CDK assertions tests (`IAM — least privilege` suite).

---

## Alternatives Considered

| Option | Decision | Reason Rejected |
|---|---|---|
| REST API v1 | HTTP API v2 | 70% cost saving; REST features not needed for simple proxy |
| SNS with raw delivery disabled | Enabled | Simplifies consumer parsing; EventBridge handles filtering |
| Default EventBridge bus | Custom bus | Isolation, scoped IAM, per-env naming |
| DynamoDB Streams disabled initially | Enabled upfront | Avoids risky table update later; negligible cost |
| CloudFormation exports for cross-stack refs | SSM parameters | Avoids hard deployment coupling between stacks |

---

## Consequences

- **Immediate:** `OrderServiceStack` deploys all Phase 1 Order Service infrastructure in a single `cdk deploy`.
- **Phase 2:** No changes to `OrderServiceStack` are required for DynamoDB Streams ESM wiring (US-7.1) — the stream ARN is already in SSM.
- **Multi-Region (US-6.1):** The stack is instantiated twice in `app.ts` (once per region). DynamoDB Global Table replication is enabled in US-6.1.
- **Future:** If SNS filter policies are ever needed, raw message delivery must be disabled — a non-breaking CDK change.
