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

/**
 * Reusable payload schema piece representing the core order details.
 */
export const OrderPayloadSchema = z.object({
    orderId: UuidSchema,
    userId: NonEmptyStringSchema,
    userEmail: EmailSchema,
    country: CountryCodeSchema,
    currency: CurrencyCodeSchema,
    totalAmount: PositiveAmountSchema,
    items: z.array(OrderItemSchema).min(1),
});

/**
 * Zod schema defining the structure of an SNS Order Event.
 */
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
