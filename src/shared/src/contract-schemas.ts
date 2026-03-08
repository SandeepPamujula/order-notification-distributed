import { z } from 'zod';

export const ContractOrderPayloadSchema = z.object({
    orderId: z.string().uuid().or(z.string().min(1)),
    userId: z.string().min(1),
    userEmail: z.string().email(),
    country: z.string().length(2),
    currency: z.string().length(3),
    totalAmount: z.number().positive(),
    items: z.array(z.object({
        productId: z.string().min(1),
        productName: z.string().min(1),
        quantity: z.number().int().min(1),
        unitPrice: z.number().min(0),
    })).min(1),
});

export const ContractSnsOrderEventSchema = z.object({
    eventId: z.string().uuid().or(z.string().min(1)),
    eventType: z.literal('ORDER_PLACED'),
    timestamp: z.string(),
    source: z.literal('order-service'),
    region: z.string(),
    correlationId: z.string(),
    data: ContractOrderPayloadSchema.extend({
        status: z.enum(['PLACED', 'CONFIRMED', 'CANCELLED', 'FAILED']),
    }),
});

export const ContractEventBridgeOrderPlacedSchema = z.object({
    orderId: z.string().uuid().or(z.string().min(1)),
    userId: z.string().min(1),
    userEmail: z.string().email(),
    country: z.string().length(2),
    totalAmount: z.number().positive(),
    currency: z.string().length(3),
    correlationId: z.string(),
});

export const ContractEventBridgeEnvelopeSchema = z.object({
    source: z.literal('order-service'),
    'detail-type': z.literal('OrderPlaced'),
    detail: ContractEventBridgeOrderPlacedSchema,
});

export const ContractDynamoDBStreamRecordSchema = z.object({
    dynamodb: z.object({
        NewImage: z.record(z.any()).optional(),
        OldImage: z.record(z.any()).optional(),
        Keys: z.record(z.any()).optional(),
        SequenceNumber: z.string(),
        SizeBytes: z.number(),
        StreamViewType: z.string(),
    }),
    eventName: z.enum(['INSERT', 'MODIFY', 'REMOVE']),
    eventSource: z.literal('aws:dynamodb'),
    eventVersion: z.string(),
    eventID: z.string(),
    awsRegion: z.string(),
});
