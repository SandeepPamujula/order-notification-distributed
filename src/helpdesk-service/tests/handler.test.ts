import { mockClient } from 'aws-sdk-client-mock';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

// Mocks
const sesMock = mockClient(SESClient);

// Import handler AFTER mocks
import { handler } from '../src/handler';
import { ValidationError, InternalError, EmailError } from '@shared/errors';

const TEST_ENV = {
    SES_HELPDESK_ADDRESS: 'helpdesk@spkumarorder.com',
};

const validEventBridgeEvent = {
    source: 'order-service',
    'detail-type': 'OrderPlaced',
    detail: {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        userId: 'user-123',
        userEmail: 'user@example.com',
        country: 'US',
        currency: 'USD',
        totalAmount: 100,
        correlationId: 'test-correlation-id',
    }
};

const savedEnv = { ...process.env };

beforeEach(() => {
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

describe('Helpdesk Service Handler', () => {

    it('valid event -> ses:SendEmail called', async () => {
        sesMock.on(SendEmailCommand).resolves({ MessageId: 'ses-msg-1' });

        await handler(validEventBridgeEvent, {} as any);

        const sendEmailCalls = sesMock.commandCalls(SendEmailCommand);
        expect(sendEmailCalls).toHaveLength(1);
        const firstCall = sendEmailCalls[0];
        expect(firstCall).toBeDefined();
        // @ts-ignore
        expect(firstCall.args[0].input.Destination?.ToAddresses).toContain('helpdesk@spkumarorder.com');
        // @ts-ignore
        expect(firstCall.args[0].input.Message?.Subject?.Data).toContain('US');
    });

    it('invalid event -> Zod error thrown', async () => {
        const invalidEvent = {
            source: 'order-service',
            'detail-type': 'OrderPlaced',
            detail: {
                orderId: '123'
                // Missing required fields
            }
        };

        await expect(handler(invalidEvent, {} as any)).rejects.toThrow(ValidationError);
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    });

    it('throws InternalError if SES_HELPDESK_ADDRESS is missing', async () => {
        delete process.env.SES_HELPDESK_ADDRESS;

        await expect(handler(validEventBridgeEvent, {} as any)).rejects.toThrow(InternalError);
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    });

    it('throws EmailError if SES SendEmail fails', async () => {
        sesMock.on(SendEmailCommand).rejects(new Error('SES Failed'));

        await expect(handler(validEventBridgeEvent, {} as any)).rejects.toThrow(EmailError);
        expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    });
});
