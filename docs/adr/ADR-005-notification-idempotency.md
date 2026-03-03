# ADR 005: Notification Service Idempotency Strategy

## Status
Accepted

## Context
The Notification Service consumes order placement events (`ORDER_PLACED`) from a standard SQS queue, triggered via SNS fan-out from the Order Service. SQS provides *at-least-once* delivery semantics, meaning the same message may be delivered more than once to the Notification Lambda. Additionally, transient errors during an execution (e.g., an SES timeout) can result in the entire batch of SQS messages being re-delivered if not explicitly handled.

If a duplicate message is processed blindly, the service will send duplicate confirmation emails to customers, leading to a poor user experience and increased SES costs. AWS best practices mandate that Lambda consumers of SQS must be idempotent.

We had two common approaches for idempotency:
1.  **Tracking `messageId`**: Store the unique SQS `messageId` in a fast storage layer (like DynamoDB or Redis) and check it before processing. If it exists, the message has already been processed.
2.  **Tracking Business State (`orderId`)**: Since the fundamental goal is verifying whether an email was already sent for a specific *order*, we can use the `orderId` natively included in the event payload. 

## Decision
We chose **Tracking Business State (`orderId`) using the existing DynamoDB Notifications Table**.

Our strategy relies on a simple read-before-write check within the downstream payload processing:
1.  **Check**: Before invoking the SES `SendEmail` API, we query the `NotificationsTable` using the `GSI-orderId` Global Secondary Index, filtering for the specific `orderId`.
2.  **Evaluate**: If a notification record of `type='CONFIRMATION'` and `status='SENT'` exists, we acknowledge the message (preventing SQS redelivery) and return cleanly.
3.  **Process**: If no such record exists, we send the email via SES and persist the success/failure state back to the same table.

## Consequences

### Positive
- **Simplicity**: Does not require introducing an entirely separate data store (like ElastiCache/Redis) or building a separate transient lock table solely for `messageId` TTL tracking. We leverage our existing `NotificationsTable` directly.
- **Auditable Truth**: Focusing on business outcomes (`status='SENT'` and `orderId`) directly aligns the datastore state with real-world end-user outcomes.
- **Cost Effective**: Read queries via GSI on DynamoDB PAY_PER_REQUEST billing are heavily cached, cheap, and simple. We avoid maintaining a parallel DB tracking system.

### Negative / Risk
- **Race conditions**: If two identical events are processed at the *exact same millisecond* across two separate Lambda execution contexts, both might read cleanly before either has a chance to complete the `SendEmail` and write their state back. 
- **Mitigation**: While present, this edge case is acceptable in our system context because standard SQS redelivery wait times are significantly longer than the Lambda execution time (`~100-300ms`). It heavily minimizes concurrency overlap.
- **Eventual Consistency**: The `GSI-orderId` is eventually consistent by nature. The chance of a read missing a recently completed write due to GSI replication latency is non-zero, though typically resolves within ~10ms.
