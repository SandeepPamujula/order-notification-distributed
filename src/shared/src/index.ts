/**
 * @module @order-notification/shared
 *
 * Public surface area for the shared package.
 * Import from this package using the workspace alias:
 *   import { ValidationError, createLogger } from '@order-notification/shared';
 */

// Error classes
export {
    AppError,
    DatabaseError,
    EmailError,
    InternalError,
    MessagingError,
    ValidationError,
} from './errors';

// Correlation ID utilities
export {
    buildResponseHeaders,
    extractOrGenerateCorrelationId,
    generateCorrelationId,
} from './correlation';

// Powertools factories
export { createLogger, createTracer } from './powertools';
export type { LoggerOptions } from './powertools';

// Zod base schemas + derived types
export {
    CountryCodeSchema,
    CurrencyCodeSchema,
    EmailSchema,
    MessagingModeSchema,
    NonEmptyStringSchema,
    NotificationChannelSchema,
    NotificationStatusSchema,
    NotificationTypeSchema,
    OrderItemSchema,
    OrderStatusSchema,
    PositiveAmountSchema,
    UuidSchema,
} from './schemas';

export type {
    MessagingMode,
    NotificationChannel,
    NotificationStatus,
    NotificationType,
    OrderItem,
    OrderStatus,
} from './schemas';
