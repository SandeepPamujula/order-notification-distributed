/**
 * Unit tests for the Order Service Lambda handler (US-1.2).
 *
 * Mocking strategy:
 *  - AWS SDK clients (DynamoDB, SNS, EventBridge) are mocked using aws-sdk-client-mock.
 *  - Environment variables are set before each test and restored after.
 *  - No real AWS calls are made.
 */

import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the handler so the clients module
// returns the mocked instances.
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);
const ebMock = mockClient(EventBridgeClient);

// ---------------------------------------------------------------------------
// Import handler AFTER mocks are in place
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/first -- mocks must be set up first
import { handler } from '../src/handler';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ENV = {
    ORDERS_TABLE_NAME: 'orders-dev',
    ORDER_EVENTS_TOPIC_ARN: 'arn:aws:sns:ap-south-1:123456789012:order-events-dev',
    ORDER_EVENTS_BUS_NAME: 'order-events-bus-dev',
    MESSAGING_MODE: 'SNS',
    AWS_REGION: 'ap-south-1',
};

/** Builds a minimal valid order payload. */
const validPayload = () => ({
    userId: 'user-123',
    userEmail: 'user@example.com',
    country: 'IN',
    currency: 'INR',
    totalAmount: 2999.0,
    items: [
        {
            productId: 'prod-001',
            productName: 'Wireless Mouse',
            quantity: 1,
            unitPrice: 2999.0,
        },
    ],
});

/** Builds a mock APIGatewayProxyEventV2 for POST /orders. */
function buildPostOrdersEvent(
    body: unknown,
    headers: Record<string, string> = {},
): APIGatewayProxyEventV2 {
    return {
        version: '2.0',
        routeKey: 'POST /orders',
        rawPath: '/orders',
        rawQueryString: '',
        headers: {
            'content-type': 'application/json',
            'x-correlation-id': 'test-correlation-id',
            ...headers,
        },
        requestContext: {
            http: {
                method: 'POST',
                path: '/orders',
                protocol: 'HTTP/1.1',
                sourceIp: '1.2.3.4',
                userAgent: 'test-agent',
            },
            accountId: '123456789012',
            apiId: 'test-api-id',
            authorizerType: undefined,
            domainName: 'test.execute-api.ap-south-1.amazonaws.com',
            domainPrefix: 'test',
            requestId: 'test-request-id',
            routeKey: 'POST /orders',
            stage: '$default',
            time: '01/Jan/2026:00:00:00 +0000',
            timeEpoch: 1_735_689_600_000,
        },
        body: JSON.stringify(body),
        isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
}

/** Builds a mock APIGatewayProxyEventV2 for GET /health. */
function buildGetHealthEvent(): APIGatewayProxyEventV2 {
    return {
        version: '2.0',
        routeKey: 'GET /health',
        rawPath: '/health',
        rawQueryString: '',
        headers: {},
        requestContext: {
            http: {
                method: 'GET',
                path: '/health',
                protocol: 'HTTP/1.1',
                sourceIp: '127.0.0.1',
                userAgent: 'Route53-health-checker/2.0',
            },
            accountId: '123456789012',
            apiId: 'test-api-id',
            authorizerType: undefined,
            domainName: 'test.execute-api.ap-south-1.amazonaws.com',
            domainPrefix: 'test',
            requestId: 'test-health-request-id',
            routeKey: 'GET /health',
            stage: '$default',
            time: '01/Jan/2026:00:00:00 +0000',
            timeEpoch: 1_735_689_600_000,
        },
        body: null,
        isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
}

/** Parse the result body as JSON. */
function parseBody(result: unknown): Record<string, unknown> {
    return JSON.parse((result as { body: string }).body) as Record<string, unknown>;
}

/** Get statusCode from result. */
function statusCode(result: unknown): number {
    return (result as { statusCode: number }).statusCode;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(() => {
    ddbMock.reset();
    snsMock.reset();
    ebMock.reset();
    Object.assign(process.env, TEST_ENV);
});

afterEach(() => {
    // Restore env to avoid leakage between tests
    for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) {
            delete process.env[key];
        }
    }
    Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
    it('returns 200 with status=ok', async () => {
        const result = await handler(buildGetHealthEvent());
        expect(statusCode(result)).toBe(200);
        const body = parseBody(result);
        expect(body['status']).toBe('ok');
        expect(body['service']).toBe('order-service');
    });

    it('includes X-Correlation-Id response header', async () => {
        const result = await handler(buildGetHealthEvent()) as { headers: Record<string, string> };
        expect(result.headers['X-Correlation-Id']).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// POST /orders — happy path
// ---------------------------------------------------------------------------

describe('POST /orders — happy path (MESSAGING_MODE=SNS)', () => {
    beforeEach(() => {
        ddbMock.on(PutCommand).resolves({});
        snsMock.on(PublishCommand).resolves({ MessageId: 'test-msg-id' });
        ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });
    });

    it('returns 201 Created with orderId, status=PLACED, and correlationId', async () => {
        const result = await handler(buildPostOrdersEvent(validPayload()));
        expect(statusCode(result)).toBe(201);
        const body = parseBody(result);
        expect(body['status']).toBe('PLACED');
        expect(body['orderId']).toBeDefined();
        expect(body['correlationId']).toBe('test-correlation-id');
    });

    it('auto-generates a UUID v4 orderId when not provided', async () => {
        const result = await handler(buildPostOrdersEvent(validPayload()));
        const body = parseBody(result);
        expect(body['orderId']).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
    });

    it('uses caller-supplied orderId', async () => {
        const orderId = '550e8400-e29b-41d4-a716-446655440000';
        const result = await handler(buildPostOrdersEvent({ ...validPayload(), orderId }));
        expect(parseBody(result)['orderId']).toBe(orderId);
    });

    it('calls DynamoDB PutCommand exactly once', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    it('calls SNS PublishCommand exactly once when MESSAGING_MODE=SNS', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1);
    });

    it('calls EventBridge PutEventsCommand exactly once', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });

    it('includes X-Correlation-Id in response headers', async () => {
        const result = await handler(buildPostOrdersEvent(validPayload())) as {
            headers: Record<string, string>;
        };
        expect(result.headers['X-Correlation-Id']).toBe('test-correlation-id');
    });

    it('generates correlationId when not supplied in request headers', async () => {
        const event = buildPostOrdersEvent(validPayload(), {});
        // Remove the pre-set correlation header
        const headers = event.headers as Record<string, string | undefined>;
        delete headers['x-correlation-id'];
        const result = await handler(event) as { body: string; headers: Record<string, string> };
        const body = JSON.parse(result.body) as Record<string, string>;
        expect(body['correlationId']).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(result.headers['X-Correlation-Id']).toBe(body['correlationId']);
    });

    it('uses ConditionExpression for idempotency on DynamoDB PutCommand', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        const calls = ddbMock.commandCalls(PutCommand);
        expect(calls[0]?.args[0].input.ConditionExpression).toBe('attribute_not_exists(orderId)');
    });

    it('publishes SNS event with correct eventType and source', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        const calls = snsMock.commandCalls(PublishCommand);
        const message = JSON.parse(calls[0]?.args[0].input.Message ?? '{}') as {
            eventType: string;
            source: string;
            data: { status: string };
        };
        expect(message.eventType).toBe('ORDER_PLACED');
        expect(message.source).toBe('order-service');
        expect(message.data.status).toBe('PLACED');
    });

    it('publishes EventBridge event with correct Source, DetailType, and country', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        const calls = ebMock.commandCalls(PutEventsCommand);
        const entry = calls[0]?.args[0].input.Entries?.[0];
        expect(entry?.Source).toBe('order-service');
        expect(entry?.DetailType).toBe('OrderPlaced');
        const detail = JSON.parse(entry?.Detail ?? '{}') as {
            country: string;
            correlationId: string;
        };
        expect(detail.country).toBe('IN');
        expect(detail.correlationId).toBe('test-correlation-id');
    });

    it('correlationId is propagated to SNS message attributes', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        const calls = snsMock.commandCalls(PublishCommand);
        const attrs = calls[0]?.args[0].input.MessageAttributes ?? {};
        expect(attrs['correlationId']?.StringValue).toBe('test-correlation-id');
    });
});

// ---------------------------------------------------------------------------
// MESSAGING_MODE=STREAMS
// ---------------------------------------------------------------------------

describe('POST /orders — MESSAGING_MODE=STREAMS', () => {
    beforeEach(() => {
        process.env['MESSAGING_MODE'] = 'STREAMS';
        ddbMock.on(PutCommand).resolves({});
        ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });
    });

    it('does NOT call SNS PublishCommand when MESSAGING_MODE=STREAMS', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    });

    it('still calls EventBridge PutEventsCommand when MESSAGING_MODE=STREAMS', async () => {
        await handler(buildPostOrdersEvent(validPayload()));
        expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });

    it('still returns 201 Created when MESSAGING_MODE=STREAMS', async () => {
        const result = await handler(buildPostOrdersEvent(validPayload()));
        expect(statusCode(result)).toBe(201);
    });
});

// ---------------------------------------------------------------------------
// POST /orders — 400 validation errors
// ---------------------------------------------------------------------------

describe('POST /orders — 400 Bad Request', () => {
    it('returns 400 for non-JSON body', async () => {
        const event = buildPostOrdersEvent(null);
        (event as unknown as { body: string }).body = 'not-valid-json{{{';
        const result = await handler(event);
        expect(statusCode(result)).toBe(400);
        expect(parseBody(result)['error']).toBe('ValidationError');
    });

    it('returns 400 when userId is missing', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { userId: _userId, ...withoutUserId } = validPayload();
        const result = await handler(buildPostOrdersEvent(withoutUserId));
        expect(statusCode(result)).toBe(400);
        expect(parseBody(result)['error']).toBe('ValidationError');
        expect(parseBody(result)['details']).toBeDefined();
    });

    it('returns 400 when userEmail is invalid', async () => {
        const result = await handler(
            buildPostOrdersEvent({ ...validPayload(), userEmail: 'not-an-email' }),
        );
        expect(statusCode(result)).toBe(400);
        expect(parseBody(result)['error']).toBe('ValidationError');
    });

    it('returns 400 for country code longer than 2 chars (e.g. "INDIA")', async () => {
        const result = await handler(
            buildPostOrdersEvent({ ...validPayload(), country: 'INDIA' }),
        );
        expect(statusCode(result)).toBe(400);
        expect(parseBody(result)['error']).toBe('ValidationError');
    });

    it('returns 400 for lowercase country code', async () => {
        const result = await handler(
            buildPostOrdersEvent({ ...validPayload(), country: 'in' }),
        );
        expect(statusCode(result)).toBe(400);
    });

    it('returns 400 for invalid currency code (too long)', async () => {
        const result = await handler(
            buildPostOrdersEvent({ ...validPayload(), currency: 'dollars' }),
        );
        expect(statusCode(result)).toBe(400);
    });

    it('returns 400 for negative totalAmount', async () => {
        const result = await handler(
            buildPostOrdersEvent({ ...validPayload(), totalAmount: -5 }),
        );
        expect(statusCode(result)).toBe(400);
    });

    it('returns 400 for zero totalAmount', async () => {
        const result = await handler(
            buildPostOrdersEvent({ ...validPayload(), totalAmount: 0 }),
        );
        expect(statusCode(result)).toBe(400);
    });

    it('returns 400 for empty items array', async () => {
        const result = await handler(
            buildPostOrdersEvent({ ...validPayload(), items: [] }),
        );
        expect(statusCode(result)).toBe(400);
        expect(parseBody(result)['error']).toBe('ValidationError');
    });

    it('returns 400 for item with quantity 0', async () => {
        const result = await handler(
            buildPostOrdersEvent({
                ...validPayload(),
                items: [{ productId: 'p1', productName: 'P1', quantity: 0, unitPrice: 10 }],
            }),
        );
        expect(statusCode(result)).toBe(400);
    });

    it('includes correlationId in 400 response body', async () => {
        const result = await handler(buildPostOrdersEvent({}));
        expect(parseBody(result)['correlationId']).toBe('test-correlation-id');
    });
});

// ---------------------------------------------------------------------------
// POST /orders — 500 DynamoDB failure
// ---------------------------------------------------------------------------

describe('POST /orders — 500 DynamoDB failure', () => {
    it('returns 500 DatabaseError when DynamoDB PutCommand fails', async () => {
        ddbMock.on(PutCommand).rejects(new Error('DynamoDB service unavailable'));
        const result = await handler(buildPostOrdersEvent(validPayload()));
        expect(statusCode(result)).toBe(500);
        const body = parseBody(result);
        expect(body['error']).toBe('DatabaseError');
        expect(body['correlationId']).toBe('test-correlation-id');
    });

    it('does NOT call SNS or EventBridge when DynamoDB fails', async () => {
        ddbMock.on(PutCommand).rejects(new Error('DynamoDB unavailable'));
        await handler(buildPostOrdersEvent(validPayload()));
        expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
        expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    it('returns 201 idempotently on ConditionalCheckFailedException (duplicate orderId)', async () => {
        const dupErr = Object.assign(new Error('Duplicate'), {
            name: 'ConditionalCheckFailedException',
        });
        ddbMock.on(PutCommand).rejects(dupErr);
        const result = await handler(buildPostOrdersEvent(validPayload()));
        expect(statusCode(result)).toBe(201);
        expect(parseBody(result)['status']).toBe('PLACED');
    });
});

// ---------------------------------------------------------------------------
// POST /orders — 502 Messaging failure
// ---------------------------------------------------------------------------

describe('POST /orders — 502 Messaging failure', () => {
    beforeEach(() => {
        ddbMock.on(PutCommand).resolves({});
    });

    it('returns 502 MessagingError when SNS PublishCommand throws', async () => {
        snsMock.on(PublishCommand).rejects(new Error('SNS unavailable'));
        ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });
        const result = await handler(buildPostOrdersEvent(validPayload()));
        expect(statusCode(result)).toBe(502);
        expect(parseBody(result)['error']).toBe('MessagingError');
    });

    it('returns 502 MessagingError when EventBridge PutEventsCommand throws', async () => {
        snsMock.on(PublishCommand).resolves({ MessageId: 'ok' });
        ebMock.on(PutEventsCommand).rejects(new Error('EventBridge unavailable'));
        const result = await handler(buildPostOrdersEvent(validPayload()));
        expect(statusCode(result)).toBe(502);
        expect(parseBody(result)['error']).toBe('MessagingError');
    });

    it('wraps non-Error DynamoDB rejection into DatabaseError (non-Error branch)', async () => {
        // Simulate DynamoDB throwing a plain string — covers the `err instanceof Error ? err : new Error(String(err))` false branch
        ddbMock.on(PutCommand).rejects('DynamoDB string error');
        const result = await handler(buildPostOrdersEvent(validPayload()));
        expect(statusCode(result)).toBe(500);
        expect(parseBody(result)['error']).toBe('DatabaseError');
    });
});

// ---------------------------------------------------------------------------
// Unknown routes — 404
// ---------------------------------------------------------------------------

describe('Unknown route', () => {
    it('returns 404 for DELETE /orders', async () => {
        const event = buildPostOrdersEvent(null);
        (event.requestContext.http as { method: string; path: string }).method = 'DELETE';
        const result = await handler(event);
        expect(statusCode(result)).toBe(404);
    });
});
