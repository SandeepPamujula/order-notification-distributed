# Inventory Service

The Inventory Service is responsible for asynchronously processing order events and logging them for inventory purposes. In Phase 1, it simply logs the full order details using Powertools structured logging without any database persistence.

## Setup

This service is part of the broader Order Service mono-repo.

```bash
cd src/inventory-service
npm ci
npm run build
npm run test
```

## Environment Variables

The AWS Lambda function expects the following environment variables natively injected via the CDK infrastructure:

- `POWERTOOLS_SERVICE_NAME`: The AWS Powertools identifier used for structured logs/tracing (typically `inventory-service`).
- `POWERTOOLS_METRICS_NAMESPACE`: Namespace for custom metrics if any.

## SQS Message Schema (SNS Order Event)

The service consumes events via an EventBridge/SNS to SQS fan-out pattern. Messages are `ORDER_PLACED` events from the Order Service:

```json
{
  "eventId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "eventType": "ORDER_PLACED",
  "timestamp": "2026-03-03T12:00:00.000Z",
  "source": "order-service",
  "region": "ap-south-1",
  "correlationId": "test-correlation-id",
  "data": {
    "orderId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "user-123",
    "userEmail": "customer@example.com",
    "country": "US",
    "currency": "USD",
    "totalAmount": 150.00,
    "status": "PLACED",
    "items": [
      {
        "productId": "prod-456",
        "productName": "Widget",
        "quantity": 2,
        "unitPrice": 75.00
      }
    ]
  }
}
```

## Behavior & Observability

- **Logs**: Order details are parsed and logged out using Powertools (`logger.info`). The log will automatically include the trace context and the original X-Correlation-ID for end-to-end trace correlation.
- **Failures**: The handler catches unhandled errors, logs them, and explicitly ignores them in terms of batch failures (`batchItemFailures` is always empty). This ensures SQS messages are deleted after processing, preventing poison pills and eliminating the need for complex DLQ redrives for simple logging errors.
