import { z } from 'zod';

// ---------------------------------------------------------------------------
// Base Zod schemas shared across all services
// ---------------------------------------------------------------------------

/** UUID v4 string */
export const UuidSchema = z.string().uuid();

/** ISO 3166-1 alpha-2 country code (2 uppercase letters) */
export const CountryCodeSchema = z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO 3166-1 alpha-2 country code');

/** ISO 4217 currency code (3 uppercase letters) */
export const CurrencyCodeSchema = z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'Must be a 3-letter ISO 4217 currency code');

/** Positive monetary amount */
export const PositiveAmountSchema = z.number().positive();

/** Non-empty string */
export const NonEmptyStringSchema = z.string().min(1);

/** Email address */
export const EmailSchema = z.string().email();

/** Order status */
export const OrderStatusSchema = z.enum(['PLACED', 'CONFIRMED', 'CANCELLED', 'FAILED']);

/** Notification status */
export const NotificationStatusSchema = z.enum(['SENT', 'FAILED', 'PENDING']);

/** Notification type */
export const NotificationTypeSchema = z.enum(['CONFIRMATION', 'HELPDESK_ALERT']);

/** Notification channel */
export const NotificationChannelSchema = z.enum(['EMAIL', 'SMS']);

/** Messaging mode — controls Phase 1 (SNS) vs Phase 2 (DynamoDB Streams) fan-out */
export const MessagingModeSchema = z.enum(['SNS', 'STREAMS']);

/** Order item */
export const OrderItemSchema = z.object({
    productId: NonEmptyStringSchema,
    productName: NonEmptyStringSchema,
    quantity: z.number().int().min(1),
    unitPrice: z.number().min(0),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;
export type NotificationType = z.infer<typeof NotificationTypeSchema>;
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
export type MessagingMode = z.infer<typeof MessagingModeSchema>;
