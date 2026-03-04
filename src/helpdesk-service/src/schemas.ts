import { z } from 'zod';
import {
    CountryCodeSchema,
    CurrencyCodeSchema,
    EmailSchema,
    NonEmptyStringSchema,
    PositiveAmountSchema,
    UuidSchema,
} from '@shared/schemas';

/**
 * Zod schema defining the structure of the OrderPlaced event payload
 * received by the Helpdesk Service from EventBridge.
 */
export const HelpdeskOrderDetailSchema = z.object({
    orderId: UuidSchema.or(NonEmptyStringSchema),
    userId: NonEmptyStringSchema,
    userEmail: EmailSchema,
    country: CountryCodeSchema,
    totalAmount: PositiveAmountSchema,
    currency: CurrencyCodeSchema,
    correlationId: z.string(),
});

/**
 * Full EventBridge event schema for OrderPlaced events.
 */
export const EventBridgeOrderPlacedSchema = z.object({
    source: z.literal('order-service'),
    'detail-type': z.literal('OrderPlaced'),
    detail: HelpdeskOrderDetailSchema,
});

export type HelpdeskOrderDetail = z.infer<typeof HelpdeskOrderDetailSchema>;
export type EventBridgeOrderPlaced = z.infer<typeof EventBridgeOrderPlacedSchema>;
