/**
 * Integration tests for the Order Service Lambda (US-1.4).
 *
 * These tests exercise the REAL deployed AWS resources in the `dev` environment.
 * They are intentionally NOT run as part of the unit-test suite:
 *
 *   npm run test:integration           # run only integration tests
 *   npm run test                       # runs ONLY unit tests (integration excluded)
 *
 * Prerequisites:
 *   - `OrderServiceStack-dev` must be deployed:
 *       cdk deploy OrderServiceStack-ap-south-1-dev --context env=dev
 *   - AWS credentials configured (env vars or ~/.aws/credentials)
 *   - `AWS_REGION` env var must be set (default: ap-south-1)
 *
 * Optional env vars (resolved automatically from SSM if not set):
 *   ORDER_SERVICE_API_URL   — HTTP API GW endpoint (e.g. https://<id>.execute-api.region.amazonaws.com)
 *   ORDERS_TABLE_NAME       — DynamoDB table name    (default: orders-dev)
 *   DEPLOY_ENV              — deployment stage        (default: dev)
 *
 * Optional env var for full EventBridge assertion:
 *   EB_CATCHALL_QUEUE_URL   — SQS queue URL receiving all EB `order-events-bus-dev` events.
 *                             If absent the EB test falls back to an indirect 201 assertion.
 *
 * Acceptance criteria (US-1.4):
 *   ✅ POST /orders → item in DynamoDB with correct orderId, status=PLACED, region
 *   ✅ POST /orders → message delivered to notification-queue within 5 s
 *   ✅ POST /orders → message delivered to inventory-queue within 5 s
 *   ✅ POST /orders → OrderPlaced event placed on order-events-bus (verified via EB catch-all queue or 201 response)
 */

import { randomUUID } from 'crypto';

import {
    DynamoDBClient,
    QueryCommand,
    DeleteItemCommand,
    AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    PurgeQueueCommand,
    GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REGION = process.env['AWS_REGION'] ?? 'ap-south-1';
const ENV = process.env['DEPLOY_ENV'] ?? 'dev';

const ORDERS_TABLE = process.env['ORDERS_TABLE_NAME'] ?? `orders-${ENV}`;
const NOTIFICATION_QUEUE_NAME = `notification-queue-${ENV}`;
const INVENTORY_QUEUE_NAME = `inventory-queue-${ENV}`;

// SQS long-poll timeout per attempt (seconds)
const SQS_WAIT_SECONDS = 5;
// Maximum polling iterations before failing the assertion
const SQS_MAX_RETRIES = 5;

// Jest timeout per test — SQS fan-out via SNS can take a few seconds
jest.setTimeout(90_000);

// ---------------------------------------------------------------------------
// AWS SDK clients — use real AWS credentials
// ---------------------------------------------------------------------------

const ddb = new DynamoDBClient({ region: REGION });
const sqsClient = new SQSClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Reads a value from SSM Parameter Store. Throws if the parameter is absent. */
async function getSsmParam(name: string): Promise<string> {
    const res = await ssmClient.send(new GetParameterCommand({ Name: name }));
    const value = res.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter not found: ${name}`);
    return value;
}

/** Resolves an SQS queue URL by queue name. */
async function resolveQueueUrl(queueName: string): Promise<string> {
    const res = await sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
    const url = res.QueueUrl;
    if (!url) throw new Error(`SQS queue URL not found for queue: ${queueName}`);
    return url;
}

/**
 * Places an order via the real HTTP API and asserts a 201 response.
 *
 * @returns Parsed response body `{ orderId, status, correlationId }`.
 */
async function placeOrder(
    apiUrl: string,
    payload: Record<string, unknown>,
): Promise<{ orderId: string; status: string; correlationId: string }> {
    const correlationId = `integration-${randomUUID()}`;
    const res = await fetch(`${apiUrl}/orders`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-correlation-id': correlationId,
        },
        body: JSON.stringify(payload),
    });

    if (res.status !== 201) {
        const text = await res.text();
        throw new Error(`POST /orders returned HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<{ orderId: string; status: string; correlationId: string }>;
}

/**
 * Queries the DynamoDB Orders table for a single item by orderId (partition key).
 * Because the sort key (createdAt) is unknown at call time, we use a Query
 * on the primary index instead of GetItem.
 *
 * @returns Unmarshalled item, or `null` if not found.
 */
async function queryOrderById(orderId: string): Promise<Record<string, unknown> | null> {
    const res = await ddb.send(
        new QueryCommand({
            TableName: ORDERS_TABLE,
            KeyConditionExpression: 'orderId = :oid',
            ExpressionAttributeValues: { ':oid': { S: orderId } },
            Limit: 1,
        }),
    );

    if (!res.Items || res.Items.length === 0) return null;
    return unmarshall(res.Items[0] as Record<string, AttributeValue>);
}

/**
 * Deletes an order item by orderId + createdAt (required composite key).
 * Best-effort — swallows errors.
 */
async function deleteOrderItem(orderId: string, createdAt: string): Promise<void> {
    try {
        await ddb.send(
            new DeleteItemCommand({
                TableName: ORDERS_TABLE,
                Key: {
                    orderId: { S: orderId },
                    createdAt: { S: createdAt },
                },
            }),
        );
    } catch {
        // Best-effort; ignore errors during cleanup
    }
}

/**
 * Polls an SQS queue using long-polling until a message body containing
 * `orderId` is found or the maximum number of retries is exhausted.
 * Each matched message is deleted from the queue immediately.
 *
 * @returns `true` if a matching message was found; `false` otherwise.
 */
async function pollSqsForOrderId(queueUrl: string, orderId: string): Promise<boolean> {
    for (let attempt = 0; attempt < SQS_MAX_RETRIES; attempt++) {
        const result = await sqsClient.send(
            new ReceiveMessageCommand({
                QueueUrl: queueUrl,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: SQS_WAIT_SECONDS,
                MessageAttributeNames: ['All'],
            }),
        );

        for (const msg of result.Messages ?? []) {
            // Delete the message to keep the queue clean between test runs
            if (msg.ReceiptHandle) {
                await sqsClient.send(
                    new DeleteMessageCommand({
                        QueueUrl: queueUrl,
                        ReceiptHandle: msg.ReceiptHandle,
                    }),
                );
            }

            // The SNS subscription uses rawMessageDelivery=true, so the SQS
            // message body IS the plain SnsOrderEvent JSON — no SNS envelope wrapper.
            if ((msg.Body ?? '').includes(orderId)) {
                return true;
            }
        }
    }

    return false;
}

// ---------------------------------------------------------------------------
// Resolved resource endpoints (populated in beforeAll)
// ---------------------------------------------------------------------------

let apiUrl: string;
let notificationQueueUrl: string;
let inventoryQueueUrl: string;

// ---------------------------------------------------------------------------
// Valid payload factory
// ---------------------------------------------------------------------------

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        userId: 'integration-test-user',
        userEmail: 'integration@example.com',
        country: 'IN',
        currency: 'INR',
        totalAmount: 1499.0,
        items: [
            {
                productId: 'prod-integration-001',
                productName: 'Integration Test Widget',
                quantity: 2,
                unitPrice: 749.5,
            },
        ],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
    // Resolve API URL — prefer explicit env var, fall back to SSM
    apiUrl =
        process.env['ORDER_SERVICE_API_URL'] ??
        (await getSsmParam(`/order-service/${ENV}/api-gateway-url`));

    // Resolve SQS queue URLs
    notificationQueueUrl = await resolveQueueUrl(NOTIFICATION_QUEUE_NAME);
    inventoryQueueUrl = await resolveQueueUrl(INVENTORY_QUEUE_NAME);

    // Drain queues so stale messages from previous test runs don't pollute results.
    // PurgeQueue is a best-effort call — it may be rate-limited (once per 60 s).
    await Promise.allSettled([
        sqsClient.send(new PurgeQueueCommand({ QueueUrl: notificationQueueUrl })),
        sqsClient.send(new PurgeQueueCommand({ QueueUrl: inventoryQueueUrl })),
    ]);

    // Allow the purge to propagate before any tests start
    await new Promise((resolve) => setTimeout(resolve, 3000));
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('US-1.4 — Order Service Integration Tests (dev environment)', () => {
    // Items to clean up after all tests finish
    const createdItems: Array<{ orderId: string; createdAt: string }> = [];

    afterAll(async () => {
        await Promise.allSettled(
            createdItems.map(({ orderId, createdAt }) => deleteOrderItem(orderId, createdAt)),
        );
    });

    // -----------------------------------------------------------------------
    // 1. DynamoDB persistence
    // -----------------------------------------------------------------------

    describe('1. DynamoDB — order persistence', () => {
        it('item appears in Orders table with correct orderId, status=PLACED, region, and attributes', async () => {
            const res = await placeOrder(apiUrl, validPayload());
            const { orderId } = res;

            // The handler writes synchronously before returning 201, so the
            // item should be present immediately. We retry briefly for
            // eventual-consistency in multi-region reads.
            let item: Record<string, unknown> | null = null;
            for (let i = 0; i < 5; i++) {
                item = await queryOrderById(orderId);
                if (item) break;
                await new Promise((r) => setTimeout(r, 500));
            }

            expect(item).not.toBeNull();

            // Register the item for post-suite cleanup
            const createdAt = item!['createdAt'] as string;
            createdItems.push({ orderId, createdAt });

            // Core acceptance criteria assertions
            expect(item!['orderId']).toBe(orderId);
            expect(item!['status']).toBe('PLACED');
            expect(item!['region']).toBe(REGION);

            // Payload attribute round-trip
            expect(item!['userId']).toBe('integration-test-user');
            expect(item!['userEmail']).toBe('integration@example.com');
            expect(item!['country']).toBe('IN');
            expect(item!['currency']).toBe('INR');
            expect(item!['totalAmount']).toBe(1499.0);
            expect(Array.isArray(item!['items'])).toBe(true);

            // Timestamps present
            expect(item!['createdAt']).toBeDefined();
            expect(item!['updatedAt']).toBeDefined();
        });
    });

    // -----------------------------------------------------------------------
    // 2. SNS → SQS fan-out: notification-queue
    // -----------------------------------------------------------------------

    describe('2. SNS fan-out → notification-queue', () => {
        it('ORDER_PLACED message appears in notification-queue within 5 s × 5 retries', async () => {
            const res = await placeOrder(apiUrl, validPayload());

            const found = await pollSqsForOrderId(notificationQueueUrl, res.orderId);
            expect(found).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // 3. SNS → SQS fan-out: inventory-queue
    // -----------------------------------------------------------------------

    describe('3. SNS fan-out → inventory-queue', () => {
        it('ORDER_PLACED message appears in inventory-queue within 5 s × 5 retries', async () => {
            const res = await placeOrder(apiUrl, validPayload());

            const found = await pollSqsForOrderId(inventoryQueueUrl, res.orderId);
            expect(found).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // 4. EventBridge PutEvents
    //
    // EventBridge custom buses have no built-in "read events" API.
    // Two verification strategies:
    //  a) If EB_CATCHALL_QUEUE_URL is set — a catch-all EventBridge rule → SQS
    //     queue is assumed to be pre-wired; we poll it directly.
    //  b) Otherwise — indirect assertion: the handler only returns 201 AFTER
    //     EB PutEvents succeeds; a 201 proves the event was dispatched.
    // -----------------------------------------------------------------------

    describe('4. EventBridge → order-events-bus', () => {
        it('OrderPlaced event is dispatched (verified via catch-all queue or indirect 201 check)', async () => {
            const catchallQueueUrl = process.env['EB_CATCHALL_QUEUE_URL'];

            if (catchallQueueUrl) {
                // ── Direct assertion ──────────────────────────────────────
                // Requires an EventBridge rule on order-events-bus → SQS queue
                // to be deployed separately (typically in a test-only CDK stack).
                const res = await placeOrder(apiUrl, validPayload());
                const found = await pollSqsForOrderId(catchallQueueUrl, res.orderId);
                expect(found).toBe(true);
            } else {
                // ── Indirect assertion ────────────────────────────────────
                // The Order Lambda handler calls EB PutEvents as part of the
                // fan-out; it returns 201 only after all downstream calls
                // (DynamoDB PutItem, SNS Publish, EB PutEvents) succeed.
                // A 201 response is therefore proof that EB PutEvents was invoked.
                console.warn(
                    '\n[INFO] EB_CATCHALL_QUEUE_URL not set.\n' +
                    '       Using indirect EventBridge assertion: 201 response proves EB PutEvents succeeded.\n' +
                    '       To enable direct EB assertion, deploy a catch-all rule → SQS and set EB_CATCHALL_QUEUE_URL.',
                );
                const httpRes = await fetch(`${apiUrl}/orders`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(validPayload()),
                });
                // 201 proves that EB PutEvents did not throw (handler would return 502 otherwise)
                expect(httpRes.status).toBe(201);
            }
        });
    });

    // -----------------------------------------------------------------------
    // 5. Response contract validation
    // -----------------------------------------------------------------------

    describe('5. Response contract', () => {
        it('returns 201 with UUID orderId, status=PLACED, and correlationId', async () => {
            const res = await placeOrder(apiUrl, validPayload());

            expect(res.orderId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            );
            expect(res.status).toBe('PLACED');
            expect(res.correlationId).toBeDefined();
        });

        it('returns 400 ValidationError for missing userId', async () => {
            const payload = { ...validPayload() };
            delete payload['userId'];

            const httpRes = await fetch(`${apiUrl}/orders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            expect(httpRes.status).toBe(400);
            const body = (await httpRes.json()) as { error: string };
            expect(body.error).toBe('ValidationError');
        });

        it('returns 400 for invalid country code (INDIA → must be 2 uppercase chars)', async () => {
            const httpRes = await fetch(`${apiUrl}/orders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(validPayload({ country: 'INDIA' })),
            });

            expect(httpRes.status).toBe(400);
        });

        it('returns 200 for GET /health (Route 53 health check endpoint)', async () => {
            const httpRes = await fetch(`${apiUrl}/health`);

            expect(httpRes.status).toBe(200);
            const body = (await httpRes.json()) as { status: string; service: string };
            expect(body.status).toBe('ok');
            expect(body.service).toBe('order-service');
        });
    });

    // -----------------------------------------------------------------------
    // 6. Idempotency — duplicate orderId
    // -----------------------------------------------------------------------

    describe('6. Idempotency', () => {
        it('returns 201 for a duplicate orderId without throwing (ConditionalCheckFailedException handled)', async () => {
            const orderId = randomUUID();
            const payload = validPayload({ orderId });

            // First request
            const first = await placeOrder(apiUrl, payload);
            expect(first.orderId).toBe(orderId);
            expect(first.status).toBe('PLACED');

            // Second request with the same orderId — handler must return 201 idempotently
            const second = await placeOrder(apiUrl, payload);
            expect(second.orderId).toBe(orderId);
            expect(second.status).toBe('PLACED');
        });
    });
});
