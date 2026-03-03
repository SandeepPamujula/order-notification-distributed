# Notification Service

The Notification Service is responsible for asynchronously sending order confirmation emails and tracking their status. It is designed to be highly resilient, handling duplicate messages, schema changes, and downstream failures gracefully.

## Setup

This service is part of the broader Order Service mono-repo.

```bash
cd src/notification-service
npm ci
npm run build
npm run test
```

## Environment Variables

The AWS Lambda function expects the following environment variables natively injected via the CDK infrastructure:

- `NOTIFICATIONS_TABLE_NAME`: The name of the DynamoDB table used to store notification records (mandatory).
- `SES_FROM_ADDRESS`: The verified AWS SES email address to use as the `Source` sender (mandatory).
- `SES_REPLY_TO_ADDRESS`: The email address used in SES to receive customer replies (optional, managed via SSM).
- `POWERTOOLS_SERVICE_NAME`: The AWS Powertools identifier used for structured logs/tracing.

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

## DynamoDB Record Schema (`NotificationsTable`)

All sent notification activity is audited within a single-table DynamoDB design setup.

```json
{
  "notificationId": "UUID",                   // [PK] Generated unique identifier for this notification
  "createdAt": "2026-03-03T12:00:00.000Z",    // [SK] Timestamp of record creation
  "orderId": "UUID",                          // [GSI-1 PK] Maps accurately to the source order ID
  "userId": "string",
  "userEmail": "customer@example.com",
  "type": "CONFIRMATION",                     // Type of notification
  "status": "SENT | FAILED",                  // [GSI-2 PK] Current delivery outcome 
  "channel": "EMAIL",                         // Target channel used
  "subject": "Order Confirmed — UUID",
  "body": "Your order ...", 
  "sentAt": "2026-03-03T12:00:02.000Z",       // Exact time SES returned a successful confirmation status
  "retryCount": 1,                            // SQS ApproximateReceiveCount to track idempotency loops
  "errorMessage": "..."                       // Included natively if status === 'FAILED'
}
```
