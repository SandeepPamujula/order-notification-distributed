/**
 * @module @order-notification/order-service
 *
 * Public exports for the Order Service Lambda.
 */

export { handler } from './handler';
export { OrderPayloadSchema } from './schemas';
export type { OrderPayload, OrderRecord, SnsOrderEvent, EventBridgeOrderDetail } from './schemas';
