# Helpdesk Service

The Helpdesk Service is responsible for asynchronously processing order events and sending an alert email for any non-India orders placed in the system via SES.

## Setup

This service is part of the broader Order Notification mono-repo.

```bash
cd src/helpdesk-service
npm ci
npm run build
npm run test
```

## Environment Variables

The AWS Lambda function expects the following environment variables natively injected via the CDK infrastructure:

- `SES_HELPDESK_ADDRESS`: The verified SES email address used as both the sender and recipient of the alert emails.
- `POWERTOOLS_SERVICE_NAME`: The AWS Powertools identifier used for structured logs/tracing (typically `helpdesk-service`).

## Event Schema (EventBridge OrderPlaced)

The service consumes events directly from the Custom EventBridge Bus. The EventBridge filter ensures the Helpdesk Lambda only receives `OrderPlaced` events where `detail.country` is not `"IN"`.

```json
{
  "source": "order-service",
  "detail-type": "OrderPlaced",
  "detail": {
    "orderId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "user-123",
    "userEmail": "customer@example.com",
    "country": "US",
    "totalAmount": 150.00,
    "currency": "USD",
    "correlationId": "test-correlation-id"
  }
}
```

## Behavior & Observability

- **Logs**: The handler parses the detailed payload (validating it directly against `EventBridgeOrderPlacedSchema`), injecting the `correlationId` into all log entries and X-Ray metadata automatically.
- **Failures**: Errors formatting the request or interacting with SES bubble up to EventBridge. The Lambda configuration explicitly retries failed invocations up to 2 times, to ensure intermittent SES limits or delays do not result in a dropped alert email.
