import { z } from 'zod';
import {
    CountryCodeSchema,
    CurrencyCodeSchema,
    EmailSchema,
    NonEmptyStringSchema,
    OrderItemSchema,
    PositiveAmountSchema,
    UuidSchema,
    OrderStatusSchema,
} from '@shared/schemas';

// Reusable payload schema piece (mirrors OrderPayload from order-service)
export const OrderPayloadSchema = z.object({
    orderId: UuidSchema,
    userId: NonEmptyStringSchema,
    userEmail: EmailSchema,
    country: CountryCodeSchema,
    currency: CurrencyCodeSchema,
    totalAmount: PositiveAmountSchema,
    items: z.array(OrderItemSchema).min(1),
});

export const SnsOrderEventSchema = z.object({
    eventId: UuidSchema.or(NonEmptyStringSchema),
    eventType: z.literal('ORDER_PLACED'),
    timestamp: z.string(),
    source: z.literal('order-service'),
    region: z.string(),
    correlationId: z.string(),
    data: OrderPayloadSchema.extend({
        status: OrderStatusSchema,
    }),
});

export type SnsOrderEvent = z.infer<typeof SnsOrderEventSchema>;

export interface NotificationRecord {
    notificationId: string;
    orderId: string;
    userId: string;
    userEmail: string;
    type: 'CONFIRMATION';
    status: 'SENT' | 'FAILED';
    channel: 'EMAIL';
    subject: string;
    body: string;
    sentAt: string;
    createdAt: string;
    retryCount: number;
    errorMessage?: string;
    ttl?: number;
}
