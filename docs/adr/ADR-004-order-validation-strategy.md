# ADR-004 — Order Service Validation Strategy

**Status:** Accepted
**Date:** 2026-03-01
**Authors:** Platform Team
**Story:** US-1.2 / US-1.6

---

## Context

The Order Lambda is the entry point for every order in the system. Before any persistence or fan-out occurs, the incoming HTTP payload must be rigorously validated to prevent malformed data from propagating into DynamoDB, SNS, or EventBridge. We needed to decide:

1. **Where** to perform validation (API Gateway vs. Lambda)
2. **What library** to use for schema validation
3. **How** to model domain constraints (country code, currency, positive amount, etc.)
4. **How** to represent and return validation errors to callers
5. **How** to handle idempotency for duplicate order IDs

---

## Decision

### 1. Validate inside the Lambda — not in API Gateway

We perform all validation inside the Lambda handler (`src/order-service/src/handler.ts`) rather than using API Gateway request validators or JSON Schema models defined in the CDK stack.

**Rationale:**

- **Portability**: Lambda-level validation works identically in unit tests (via `aws-sdk-client-mock`), integration tests, and production — no difference in behaviour between API Gateway's JSON Schema engine and the Lambda's runtime.
- **Expressiveness**: API Gateway JSON Schema validation cannot enforce cross-field constraints (e.g. `totalAmount > 0` combined with `items[*].quantity ≥ 1`) or custom error message formatting.
- **Consistency**: All services in the system will follow this pattern, making the validation logic predictable and testable without AWS credentials.
- **Error detail**: We return Zod's structured `issues` array in the `400` response body, giving callers precise field-level error messages. API Gateway's built-in validation returns a generic `{"message": "Invalid request body"}` with no field details.

**Trade-off accepted**: Lambda is invoked even for malformed payloads. At 10K TPS this adds marginal cost compared to API Gateway rejection. However, the benefit of rich error messages and consistent behaviour outweighs this cost at our scale.

### 2. Use Zod for schema validation

We chose [Zod](https://zod.dev/) over alternatives (Joi, yup, ajv, class-validator).

**Rationale:**

| Criterion | Zod | Joi | ajv |
|---|---|---|---|
| TypeScript-first (inferred types) | ✅ | ⚠️ manual types | ⚠️ JSON Schema only |
| Tree-shakeable (esbuild-friendly) | ✅ | ❌ large bundle | ✅ |
| Composable schema primitives | ✅ | ✅ | ❌ verbose |
| `.safeParse()` (no exceptions) | ✅ | ❌ throws | ✅ |
| Unified schema + TypeScript type | ✅ | ❌ | ❌ |
| Already used in `@shared/schemas` | ✅ | — | — |

The `@shared/schemas` package defines reusable Zod primitives (`UuidSchema`, `EmailSchema`, `CountryCodeSchema`, `CurrencyCodeSchema`, `PositiveAmountSchema`, `OrderItemSchema`) that are composed into the `OrderPayloadSchema`. This single source of truth ensures the same constraints are used in the Lambda, integration tests, and contract tests.

### 3. Domain constraints encoded directly in Zod

| Field | Constraint | Zod primitive |
|---|---|---|
| `orderId` | UUID v4, optional — generated if absent | `UuidSchema.optional().default(() => randomUUID())` |
| `userId` | Non-empty string | `NonEmptyStringSchema` (`z.string().min(1)`) |
| `userEmail` | RFC 5322 email | `EmailSchema` (`z.string().email()`) |
| `country` | ISO 3166-1 alpha-2 (2 UPPERCASE chars) | `CountryCodeSchema` (`z.string().length(2).regex(/^[A-Z]{2}$/)`) |
| `currency` | ISO 4217 (3 UPPERCASE chars) | `CurrencyCodeSchema` (`z.string().length(3).regex(/^[A-Z]{3}$/)`) |
| `totalAmount` | Strictly positive number | `PositiveAmountSchema` (`z.number().positive()`) |
| `items` | Array of ≥ 1 item, each with `quantity ≥ 1` and `unitPrice ≥ 0` | `z.array(OrderItemSchema).min(1)` |

### 4. Structured error response format

On validation failure, the handler returns:

```jsonc
// HTTP 400
{
  "error": "ValidationError",
  "message": "Request payload validation failed",
  "statusCode": 400,
  "correlationId": "<uuid>",
  "details": [
    { "code": "too_small", "path": ["totalAmount"], "message": "Number must be greater than 0", "minimum": 0, "type": "number", "inclusive": false }
  ]
}
```

The `details` field is the raw Zod `ZodIssue[]` array. This gives consumers precise, machine-readable field-level errors without requiring custom mapping logic.

**Alternative considered**: mapping Zod issues to a simpler `{ field, message }[]` format. Rejected because it would hide Zod's rich `code` and `path` data and require ongoing maintenance as Zod's issue types evolve.

### 5. Idempotency via DynamoDB ConditionExpression

The `PutItem` call uses `ConditionExpression: "attribute_not_exists(orderId)"`. If the `orderId` already exists:

- DynamoDB throws `ConditionalCheckFailedException`.
- The handler catches it and **returns `201` idempotently** with the original `{ orderId, status: "PLACED", correlationId }` response.
- No SNS or EventBridge calls are made on duplicate writes — we avoid double fan-out.

**Rationale**: Idempotent writes are safer than upserts (`PutItem` unconditionally overwrites). Using a UUID v4 `orderId` as the primary key naturally prevents collision between different orders. Client-supplied `orderId` values allow callers to retry safely on network timeouts.

**Alternative considered**: Using DynamoDB Transactions (`TransactWriteItems`) with a separate idempotency table. Rejected as over-engineered for Phase 1 — the `ConditionExpression` approach is sufficient and avoids the 25-item transaction limit.

---

## Consequences

### Positive

- Every validation rule has a corresponding unit test with `aws-sdk-client-mock` — no AWS credentials needed to verify validation behaviour.
- TypeScript types (`OrderPayload`, `OrderRecord`, `SnsOrderEvent`, `EventBridgeOrderDetail`) are inferred directly from Zod schemas, eliminating type drift.
- Adding a new validation rule (e.g. restricting `currency` to a defined list) requires a one-line Zod change that automatically propagates to all consumers of `@shared/schemas`.
- Idempotent writes + `201` on duplicate IDs make the API safe to retry from client code without side effects.

### Negative / Trade-offs

- Lambda is invoked for all malformed requests (additional cost vs. API Gateway-level rejection).
- Zod's `issues` array is exposed directly in the `400` response — consumers must understand Zod's error format. This is a minor coupling that we accept for now; a stable error mapping layer can be added if needed.
- The `ConditionExpression` idempotency guard only protects duplicate `orderId` writes. It does not guard against non-idempotent side effects if SNS/EB calls succeed on the first attempt but DynamoDB rolls back (not possible given `PutItem` completes before fan-out — the order of operations prevents this).

---

## References

- [Zod documentation](https://zod.dev/)
- [AWS DynamoDB Condition Expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html)
- [`src/shared/src/schemas.ts`](../../src/shared/src/schemas.ts) — shared Zod primitives
- [`src/order-service/src/schemas.ts`](../../src/order-service/src/schemas.ts) — `OrderPayloadSchema` definition
- [architecture.md §6.1](../../docs/architecture.md) — SNS event schema
- [architecture.md §6.2](../../docs/architecture.md) — EventBridge event schema
- ADR-001 — Monorepo Structure
- ADR-003 — Order Service Infrastructure (Phase 1)
