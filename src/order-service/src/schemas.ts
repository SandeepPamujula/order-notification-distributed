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

/**
 * SNS ORDER_PLACED event envelope published by the Order Lambda.
 *
 * Published to the `order-events-{env}` SNS topic when `MESSAGING_MODE=SNS`.
 * Delivered to `notification-queue` and `inventory-queue` via raw SQS subscriptions
 * (no SNS envelope wrapper — consumers receive this object directly as the SQS `body`).
 *
 * @see architecture.md §6.1
 */
export interface SnsOrderEvent {
    /** Unique event identifier (UUID v4). */
    eventId: string;
    /** Always `"ORDER_PLACED"`. Used for SNS subscription filter policies. */
    eventType: 'ORDER_PLACED';
    /** ISO 8601 timestamp of when the order was written to DynamoDB. */
    timestamp: string;
    /** Always `"order-service"`. Identifies the publishing service. */
    source: 'order-service';
    /** AWS region where the order was placed (e.g. `"ap-south-1"`). */
    region: string;
    /** Correlation ID propagated from the originating HTTP request. */
    correlationId: string;
    /** Full order payload plus the resolved `status`. */
    data: OrderPayload & {
        /** Always `"PLACED"` at the time of initial fan-out. */
        status: 'PLACED';
    };
}

// ---------------------------------------------------------------------------
// EventBridge event detail shape (§6.2 of architecture.md)
// ---------------------------------------------------------------------------

/**
 * EventBridge `OrderPlaced` event detail published by the Order Lambda.
 *
 * Published to `order-events-bus-{env}` on **every** order (Phase 1 and Phase 2).
 * The Helpdesk Lambda subscribes via an EventBridge rule that matches
 * `detail.country` with `anything-but: "IN"`.
 *
 * Event metadata (set by the Lambda):
 *  - `Source`:     `"order-service"`
 *  - `DetailType`: `"OrderPlaced"`
 *
 * @see architecture.md §6.2
 */
export interface EventBridgeOrderDetail {
    /** Order identifier (UUID v4). */
    orderId: string;
    /** User identifier who placed the order. */
    userId: string;
    /** User email address for Helpdesk notifications. */
    userEmail: string;
    /** Shipping destination country (ISO 3166-1 alpha-2). Used by Helpdesk EB rule filter. */
    country: string;
    /** Total order amount (strictly positive). */
    totalAmount: number;
    /** Payment currency (ISO 4217, e.g. `"INR"`, `"USD"`). */
    currency: string;
    /** Correlation ID propagated from the originating HTTP request. */
    correlationId: string;
}
