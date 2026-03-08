import {
    ContractSnsOrderEventSchema,
    ContractEventBridgeEnvelopeSchema,
    ContractDynamoDBStreamRecordSchema,
} from '../src/contract-schemas';

// Consumers' schemas
import { SnsOrderEventSchema as NotificationSnsSchema } from '../../notification-service/src/schemas';
import { SnsOrderEventSchema as InventorySnsSchema } from '../../inventory-service/src/schemas';
import { EventBridgeOrderPlacedSchema as HelpdeskEbSchema } from '../../helpdesk-service/src/schemas';

// OrderService typings
import { SnsOrderEvent, EventBridgeOrderDetail } from '../../order-service/src/schemas';

describe('Cross-Service Contract Tests', () => {
    describe('SNS/SQS ORDER_PLACED event (§6.1)', () => {
        // Mock a payload exactly as order-service would produce it, typed against its interface.
        const orderSnsPayload: SnsOrderEvent = {
            eventId: '123e4567-e89b-12d3-a456-426614174000',
            eventType: 'ORDER_PLACED',
            timestamp: '2023-10-01T12:00:00.000Z',
            source: 'order-service',
            region: 'ap-south-1',
            correlationId: 'corr-1234',
            data: {
                orderId: '123e4567-e89b-12d3-a456-426614174000',
                userId: 'user123',
                userEmail: 'user@example.com',
                country: 'IN',
                currency: 'INR',
                totalAmount: 1500,
                items: [
                    {
                        productId: 'prod1',
                        productName: 'Product 1',
                        quantity: 1,
                        unitPrice: 1500,
                    },
                ],
                status: 'PLACED',
            },
        };

        it('Producer test (Order Service): published SNS event payload matches contract schema', () => {
            // Assert that the strongly typed object from the producer passes the shared contract.
            expect(() => ContractSnsOrderEventSchema.parse(orderSnsPayload)).not.toThrow();
        });

        it('Consumer test (Notification Service): handler can parse contract-schema compliant SNS events', () => {
            expect(() => NotificationSnsSchema.parse(orderSnsPayload)).not.toThrow();
        });

        it('Consumer test (Inventory Service): handler can parse contract-schema compliant SNS events', () => {
            expect(() => InventorySnsSchema.parse(orderSnsPayload)).not.toThrow();
        });
    });

    describe('EventBridge OrderPlaced event (§6.2)', () => {
        // Mock payload from OrderService as strictly typed by its producer interface
        const orderEbDetail: EventBridgeOrderDetail = {
            orderId: '123e4567-e89b-12d3-a456-426614174000',
            userId: 'user123',
            userEmail: 'user@example.com',
            country: 'US',
            totalAmount: 200,
            currency: 'USD',
            correlationId: 'corr-1234',
        };

        const eventBridgeWrapper = {
            source: 'order-service' as const,
            'detail-type': 'OrderPlaced' as const,
            detail: orderEbDetail,
        };

        it('Producer test (Order Service): published EventBridge event matches contract schema', () => {
            expect(() => ContractEventBridgeEnvelopeSchema.parse(eventBridgeWrapper)).not.toThrow();
        });

        it('Consumer test (Helpdesk Service): handler can parse contract-schema compliant EB events', () => {
            expect(() => HelpdeskEbSchema.parse(eventBridgeWrapper)).not.toThrow();
        });
    });

    describe('DynamoDB Streams record (§6.3)', () => {
        // Mock payload representing a raw DDB stream record
        const ddbStreamRecord = {
            dynamodb: {
                NewImage: {
                    orderId: { S: '123e4567-e89b-12d3-a456-426614174000' },
                    userId: { S: 'user123' },
                    country: { S: 'US' },
                },
                Keys: {
                    orderId: { S: '123e4567-e89b-12d3-a456-426614174000' }
                },
                SequenceNumber: '111',
                SizeBytes: 26,
                StreamViewType: 'NEW_AND_OLD_IMAGES'
            },
            eventName: 'INSERT',
            eventSource: 'aws:dynamodb',
            eventVersion: '1.1',
            eventID: '123',
            awsRegion: 'ap-south-1'
        };

        it('Contract schema validates DynamoDB stream record shape', () => {
            expect(() => ContractDynamoDBStreamRecordSchema.parse(ddbStreamRecord)).not.toThrow();
        });
    });
});
