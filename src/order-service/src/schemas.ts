import { randomUUID } from 'crypto';

import { z } from 'zod';

import {
    CountryCodeSchema,
    CurrencyCodeSchema,
    EmailSchema,
    NonEmptyStringSchema,
    OrderItemSchema,
    PositiveAmountSchema,
    UuidSchema,
} from '@shared/schemas';

// ---------------------------------------------------------------------------
// Order Service — Zod schemas
// ---------------------------------------------------------------------------

/**
 * Schema for the incoming POST /orders request payload.
 *
 * All fields are validated before any persistence or fan-out occurs.
 * `orderId` is auto-generated (UUID v4) if the caller does not supply one.
 */
export const OrderPayloadSchema = z.object({
    /** Order identifier — UUID v4. Auto-generated server-side if absent. */
    orderId: UuidSchema.optional().default(() => randomUUID()),
    /** User identifier. Must be non-empty. */
    userId: NonEmptyStringSchema,
    /** User email address — used by Notification Service for confirmation email. */
    userEmail: EmailSchema,
    /** Shipping destination country — ISO 3166-1 alpha-2 (2 uppercase chars). */
    country: CountryCodeSchema,
    /** Payment currency — ISO 4217 (3 uppercase chars, e.g. INR, USD). */
    currency: CurrencyCodeSchema,
    /** Total order amount. Must be strictly positive. */
    totalAmount: PositiveAmountSchema,
    /**
     * Line items — at least one item is required.
     * Each item must have productId, productName, quantity (≥1), unitPrice (≥0).
     */
    items: z.array(OrderItemSchema).min(1, 'Order must contain at least one item'),
});

/** Validated, fully-resolved order payload (orderId is always present). */
export type OrderPayload = z.infer<typeof OrderPayloadSchema>;

// ---------------------------------------------------------------------------
// DynamoDB item shape written by the Order Lambda
// ---------------------------------------------------------------------------

/** Represents the full order record stored in DynamoDB. */
export interface OrderRecord extends OrderPayload {
    /** Order status on initial write — always "PLACED". */
    status: 'PLACED';
    /** ISO 8601 timestamp of order creation (DynamoDB Sort Key). */
    createdAt: string;
    /** ISO 8601 timestamp of last update (same as createdAt on initial write). */
    updatedAt: string;
    /** AWS region where the order was originally placed. */
    region: string;
}

// ---------------------------------------------------------------------------
// SNS event payload schema (§6.1 of architecture.md)
// ---------------------------------------------------------------------------

/** SNS ORDER_PLACED event envelope published by the Order Lambda. */
export interface SnsOrderEvent {
    eventId: string;
    eventType: 'ORDER_PLACED';
    timestamp: string;
    source: 'order-service';
    region: string;
    correlationId: string;
    data: OrderPayload & {
        status: 'PLACED';
    };
}

// ---------------------------------------------------------------------------
// EventBridge event detail shape (§6.2 of architecture.md)
// ---------------------------------------------------------------------------

/** EventBridge `OrderPlaced` event detail published by the Order Lambda. */
export interface EventBridgeOrderDetail {
    orderId: string;
    userId: string;
    userEmail: string;
    country: string;
    totalAmount: number;
    currency: string;
    correlationId: string;
}
