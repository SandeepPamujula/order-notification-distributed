import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

// Mocks
const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESClient);

// Import handler AFTER mocks
import { handler } from '../src/handler';

// Test helpers
const TEST_ENV = {
    NOTIFICATIONS_TABLE_NAME: 'notifications-dev',
    SES_FROM_ADDRESS: 'test@spkumarorder.com',
};

const validSnsOrderEvent = {
    eventId: 'evt-123',
    correlationId: 'test-correlation-id',
    eventType: 'ORDER_PLACED',
    source: 'order-service',
    timestamp: new Date().toISOString(),
    region: 'ap-south-1',
    data: {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'PLACED',
        createdAt: new Date().toISOString(),
        userId: 'user-123',
        userEmail: 'user@example.com',
        country: 'IN',
        currency: 'INR',
        totalAmount: 100,
        items: [
            { productId: 'p1', productName: 'P1', quantity: 1, unitPrice: 100 }
        ]
    }
};

const buildSqsEvent = (records: Partial<SQSRecord>[]): SQSEvent => {
    return {
        Records: records.map((r, i) => ({
            messageId: r.messageId || `msg-${i}`,
            receiptHandle: `receipt-${i}`,
            body: r.body || '',
            attributes: r.attributes || {
                ApproximateReceiveCount: '1',
                ApproximateFirstReceiveTimestamp: '123',
                MessageDeduplicationId: '',
                MessageGroupId: '',
                SenderId: '',
                SentTimestamp: '123'
            },
            messageAttributes: {},
            md5OfBody: '',
            eventSource: 'aws:sqs',
            eventSourceARN: 'arn:aws:sqs:region:123456789012:queue',
            awsRegion: 'region'
        }))
    } as SQSEvent;
};

const savedEnv = { ...process.env };

beforeEach(() => {
    ddbMock.reset();
    sesMock.reset();
    Object.assign(process.env, TEST_ENV);
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) {
            delete process.env[key];
        }
    }
    Object.assign(process.env, savedEnv);
});

describe('Notification Service Handler', () => {

    it('valid SQS batch -> sends email + writes DDB record for each message', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        ddbMock.on(PutCommand).resolves({});
        sesMock.on(SendEmailCommand).resolves({ MessageId: 'ses-msg-1' });

        const event = buildSqsEvent([
            { body: JSON.stringify(validSnsOrderEvent), messageId: 'm1' }
        ]);

        const result = await handler(event);

        expect(result.batchItemFailures).toHaveLength(0);
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
        expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
        expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it('duplicate message (idempotency) -> email NOT sent, DDB not double-written', async () => {
        ddbMock.on(QueryCommand).resolves({
            Items: [{ type: 'CONFIRMATION', status: 'SENT' }]
        });

        const event = buildSqsEvent([
            { body: JSON.stringify(validSnsOrderEvent), messageId: 'm1' }
        ]);

        const result = await handler(event);

        expect(result.batchItemFailures).toHaveLength(0);
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
        expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it('SES failure -> batchItemFailures contains the failing itemIdentifier', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        // It will retry SES 3 times. We need it to fail all 3 times.
        sesMock.on(SendEmailCommand).rejects(new Error('SES failed'));
        // PutCommand succeeds to save the FAILED status
        ddbMock.on(PutCommand).resolves({});

        const event = buildSqsEvent([
            { body: JSON.stringify(validSnsOrderEvent), messageId: 'm1' }
        ]);

        const result = await handler(event);

        expect(result.batchItemFailures).toHaveLength(1);
        expect((result.batchItemFailures as any)[0].itemIdentifier).toBe('m1');

        // SES called 3 times due to retry
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(3);

        // PutCommand called to save the FAILED status
        const putCalls = ddbMock.commandCalls(PutCommand);
        expect(putCalls).toHaveLength(1);
        expect(putCalls[0]?.args[0].input.Item?.status).toBe('FAILED');
        expect(putCalls[0]?.args[0].input.Item?.errorMessage).toBe('SES failed');
    });

    it('SES failure not an error object -> batchItemFailures contains the failing itemIdentifier', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        // It will retry SES 3 times. We need it to fail all 3 times.
        sesMock.on(SendEmailCommand).rejects('String error');
        // PutCommand succeeds to save the FAILED status
        ddbMock.on(PutCommand).resolves({});

        const event = buildSqsEvent([
            { body: JSON.stringify(validSnsOrderEvent), messageId: 'm1' }
        ]);

        const result = await handler(event);

        expect(result.batchItemFailures).toHaveLength(1);
        expect((result.batchItemFailures as any)[0].itemIdentifier).toBe('m1');

        // SES called 3 times due to retry
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(3);

        // PutCommand called to save the FAILED status
        const putCalls = ddbMock.commandCalls(PutCommand);
        expect(putCalls).toHaveLength(1);
        expect(putCalls[0]?.args[0].input.Item?.status).toBe('FAILED');
        expect(putCalls[0]?.args[0].input.Item?.errorMessage).toBe('String error');
    });

    it('Zod parse failure on malformed message -> item in batchItemFailures', async () => {
        const event = buildSqsEvent([
            { body: JSON.stringify({ bad: 'data' }), messageId: 'm1' }
        ]);

        const result = await handler(event);

        expect(result.batchItemFailures).toHaveLength(1);
        expect((result.batchItemFailures as any)[0].itemIdentifier).toBe('m1');
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
        expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it('non-JSON body -> item in batchItemFailures', async () => {
        const event = buildSqsEvent([
            { body: 'invalid json', messageId: 'm1' }
        ]);

        const result = await handler(event);

        expect(result.batchItemFailures).toHaveLength(1);
        expect((result.batchItemFailures as any)[0].itemIdentifier).toBe('m1');
    });

    it('Unhandled error processing SQS record -> item in batchItemFailures', async () => {
        ddbMock.on(QueryCommand).rejects(new Error('DDB failed during query'));

        const event = buildSqsEvent([
            { body: JSON.stringify(validSnsOrderEvent), messageId: 'm1' }
        ]);

        const result = await handler(event);

        expect(result.batchItemFailures).toHaveLength(1);
        expect((result.batchItemFailures as any)[0].itemIdentifier).toBe('m1');
    });

});
