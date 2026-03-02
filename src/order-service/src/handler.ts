/**
 * @module handler
 *
 * Order Service Lambda — entry point for POST /orders and GET /health.
 *
 * Responsibilities (Phase 1):
 *  1. Extract / generate a correlationId for tracing.
 *  2. Validate the request body with Zod (OrderPayloadSchema).
 *  3. Persist the order to DynamoDB with status=PLACED.
 *  4. Publish an ORDER_PLACED event to SNS (if MESSAGING_MODE=SNS).
 *  5. Always publish an OrderPlaced event to EventBridge (helpdesk routing).
 *  6. Return 201 Created with { orderId, status, correlationId }.
 *
 * Error handling:
 *  - ValidationError  → 400 Bad Request
 *  - DatabaseError    → 500 Internal Server Error
 *  - MessagingError   → 502 Bad Gateway
 *  - Uncaught errors  → 500 Internal Server Error
 *
 * All errors are logged with correlationId before being returned as structured JSON.
 */

import { randomUUID } from 'crypto';

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand } from '@aws-sdk/client-sns';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';

// Use @shared/* alias (resolved via jest moduleNameMapper + tsconfig paths)
import {
    buildResponseHeaders,
    extractOrGenerateCorrelationId,
    createLogger,
    createTracer,
    DatabaseError,
    MessagingError,
    ValidationError,
    AppError,
} from '@shared/index';

import { OrderPayloadSchema } from './schemas';
import type { SnsOrderEvent, EventBridgeOrderDetail } from './schemas';
import { docClient, snsClient, eventBridgeClient } from './clients';

// ---------------------------------------------------------------------------
// Module-level singletons — reused across warm invocations
// ---------------------------------------------------------------------------

const logger = createLogger({ serviceName: 'order-service' });
const tracer = createTracer('order-service');

// Static env vars — safe to read at module init (do not change between invocations)
const ORDERS_TABLE_NAME = process.env['ORDERS_TABLE_NAME'] ?? '';
const ORDER_EVENTS_TOPIC_ARN = process.env['ORDER_EVENTS_TOPIC_ARN'] ?? '';
const ORDER_EVENTS_BUS_NAME = process.env['ORDER_EVENTS_BUS_NAME'] ?? '';
const AWS_REGION = process.env['AWS_REGION'] ?? 'ap-south-1';

// Dynamic env var — read per-invocation so tests can override it between runs
// (MESSAGING_MODE is controlled via SSM and can change without a cold start in theory)
function getMessagingMode(): string {
    return process.env['MESSAGING_MODE'] ?? 'SNS';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Main Lambda handler — routes GET /health and POST /orders.
 */
export const handler = async (
    event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
    const correlationId = extractOrGenerateCorrelationId(event.headers);

    // Reset any keys appended by a previous warm invocation, then inject the
    // new correlationId so it appears on every log line for this request.
    logger.resetKeys();
    logger.appendKeys({ correlationId });

    const { requestContext } = event;
    const method = requestContext.http.method;
    const path = requestContext.http.path;

    logger.info('Incoming request', { method, path });

    // -----------------------------------------------------------------------
    // GET /health — lightweight health check for Route 53
    // -----------------------------------------------------------------------
    if (method === 'GET' && path === '/health') {
        return {
            statusCode: 200,
            headers: buildResponseHeaders(correlationId),
            body: JSON.stringify({ status: 'ok', service: 'order-service' }),
        };
    }

    // -----------------------------------------------------------------------
    // POST /orders — main order placement flow
    // -----------------------------------------------------------------------
    if (method === 'POST' && path === '/orders') {
        return handlePlaceOrder(event, correlationId);
    }

    // -----------------------------------------------------------------------
    // Fallthrough — 404 for any other route
    // -----------------------------------------------------------------------
    logger.warn('Route not found', { method, path });
    return {
        statusCode: 404,
        headers: buildResponseHeaders(correlationId),
        body: JSON.stringify({
            error: 'NotFound',
            message: `Route ${method} ${path} not found`,
            correlationId,
        }),
    };
};

// ---------------------------------------------------------------------------
// Place order — core business logic
// ---------------------------------------------------------------------------

/**
 * Handles the POST /orders flow:
 *  1. Parse + validate the request body.
 *  2. Persist to DynamoDB.
 *  3. Fan-out to SNS (Phase 1) and EventBridge (both phases).
 */
async function handlePlaceOrder(
    event: APIGatewayProxyEventV2,
    correlationId: string,
): Promise<APIGatewayProxyResultV2> {
    const segment = tracer.getSegment();
    const subsegment = segment?.addNewSubsegment('handlePlaceOrder');

    try {
        // -------------------------------------------------------------------
        // 1. Parse + validate the request body
        // -------------------------------------------------------------------
        let rawBody: unknown;
        try {
            rawBody = JSON.parse(event.body ?? '{}');
        } catch {
            throw new ValidationError('Request body is not valid JSON', correlationId);
        }

        const parseResult = OrderPayloadSchema.safeParse(rawBody);
        if (!parseResult.success) {
            throw new ValidationError(
                'Request payload validation failed',
                correlationId,
                parseResult.error.issues,
            );
        }

        const payload = parseResult.data;
        // All fields are guaranteed by Zod; cast to string/number to satisfy strict TS
        const orderId = String(payload.orderId);
        const userId = String(payload.userId);
        const userEmail = String(payload.userEmail);
        const country = String(payload.country);
        const currency = String(payload.currency);
        const totalAmount = Number(payload.totalAmount);
        const items = payload.items;

        logger.info('Order payload validated', { orderId, userId, country });

        // -------------------------------------------------------------------
        // 2. Persist order to DynamoDB
        // -------------------------------------------------------------------
        const now = new Date().toISOString();

        try {
            await docClient.send(
                new PutCommand({
                    TableName: ORDERS_TABLE_NAME,
                    Item: {
                        orderId,
                        userId,
                        userEmail,
                        country,
                        currency,
                        totalAmount,
                        items,
                        status: 'PLACED',
                        region: AWS_REGION,
                        createdAt: now,
                        updatedAt: now,
                    },
                    // Idempotency guard: reject writes that would overwrite an existing order.
                    ConditionExpression: 'attribute_not_exists(orderId)',
                }),
            );
            logger.info('Order persisted to DynamoDB', { orderId });
        } catch (err: unknown) {
            // ConditionalCheckFailedException → duplicate orderId — return 201 idempotently.
            if (err instanceof ConditionalCheckFailedException) {
                logger.warn('Duplicate orderId detected — returning idempotent 201', { orderId });
                return {
                    statusCode: 201,
                    headers: buildResponseHeaders(correlationId),
                    body: JSON.stringify({ orderId, status: 'PLACED', correlationId }),
                };
            }
            throw new DatabaseError(
                'Failed to persist order to DynamoDB',
                correlationId,
                err instanceof Error ? err : new Error(String(err)),
            );
        }

        // -------------------------------------------------------------------
        // 3. Fan-out: SNS publish (Phase 1 only) + EventBridge (both phases)
        //
        // Both calls run in parallel to minimise latency.
        // -------------------------------------------------------------------
        const snsPromise =
            getMessagingMode() === 'SNS'
                ? publishToSns(orderId, correlationId, {
                    orderId, userId, userEmail, country, currency, totalAmount, items,
                }, now)
                : Promise.resolve();

        const ebPromise = publishToEventBridge(orderId, correlationId, {
            orderId, userId, userEmail, country, totalAmount, currency, correlationId,
        });

        await Promise.all([snsPromise, ebPromise]);

        logger.info('Order placed successfully', { orderId, messagingMode: getMessagingMode() });

        return {
            statusCode: 201,
            headers: buildResponseHeaders(correlationId),
            body: JSON.stringify({ orderId, status: 'PLACED', correlationId }),
        };
    } catch (err: unknown) {
        /* istanbul ignore next — all re-throws from publishToSns/publishToEventBridge are Error subclasses */
        if (err instanceof Error) {
            subsegment?.addError(err);
        }
        return handleError(err, correlationId);
    } finally {
        subsegment?.close();
    }
}

// ---------------------------------------------------------------------------
// SNS publish helper
// ---------------------------------------------------------------------------

/**
 * Data needed to publish an SNS ORDER_PLACED event.
 */
interface OrderData {
    orderId: string;
    userId: string;
    userEmail: string;
    country: string;
    currency: string;
    totalAmount: number;
    items: Array<{
        productId: string;
        productName: string;
        quantity: number;
        unitPrice: number;
    }>;
}

/**
 * Publishes an ORDER_PLACED event to the SNS order-events topic.
 * Only invoked when MESSAGING_MODE=SNS (Phase 1).
 *
 * @throws MessagingError on SNS SDK failure.
 */
async function publishToSns(
    orderId: string,
    correlationId: string,
    order: OrderData,
    timestamp: string,
): Promise<void> {
    const snsEvent: SnsOrderEvent = {
        eventId: randomUUID(),
        eventType: 'ORDER_PLACED',
        timestamp,
        source: 'order-service',
        region: AWS_REGION,
        correlationId,
        data: {
            orderId: order.orderId,
            userId: order.userId,
            userEmail: order.userEmail,
            country: order.country,
            currency: order.currency,
            totalAmount: order.totalAmount,
            items: order.items,
            status: 'PLACED',
        },
    };

    try {
        await snsClient.send(
            new PublishCommand({
                TopicArn: ORDER_EVENTS_TOPIC_ARN,
                Message: JSON.stringify(snsEvent),
                MessageAttributes: {
                    eventType: { DataType: 'String', StringValue: 'ORDER_PLACED' },
                    correlationId: { DataType: 'String', StringValue: correlationId },
                },
            }),
        );
        logger.info('SNS ORDER_PLACED event published', { orderId, correlationId });
    } catch (err: unknown) {
        throw new MessagingError(
            'Failed to publish order event to SNS',
            correlationId,
            err instanceof Error ? err : new Error(String(err)),
        );
    }
}

// ---------------------------------------------------------------------------
// EventBridge publish helper
// ---------------------------------------------------------------------------

/**
 * Publishes an OrderPlaced event to the custom EventBridge bus.
 * Always fires in both Phase 1 and Phase 2.
 *
 * The Helpdesk Lambda consumes events matching `country ≠ IN` via a rule
 * on this bus (HelpdeskStack, US-4.1).
 *
 * @throws MessagingError on EventBridge SDK failure.
 */
async function publishToEventBridge(
    orderId: string,
    correlationId: string,
    detail: EventBridgeOrderDetail,
): Promise<void> {
    try {
        await eventBridgeClient.send(
            new PutEventsCommand({
                Entries: [
                    {
                        EventBusName: ORDER_EVENTS_BUS_NAME,
                        Source: 'order-service',
                        DetailType: 'OrderPlaced',
                        Detail: JSON.stringify(detail),
                        Time: new Date(),
                    },
                ],
            }),
        );
        logger.info('EventBridge OrderPlaced event published', { orderId, correlationId });
    } catch (err: unknown) {
        throw new MessagingError(
            'Failed to publish OrderPlaced event to EventBridge',
            correlationId,
            err instanceof Error ? err : new Error(String(err)),
        );
    }
}

// ---------------------------------------------------------------------------
// Centralised error handler
// ---------------------------------------------------------------------------

/**
 * Maps application errors to structured HTTP responses.
 * Logs every error with correlationId before returning.
 *
 * @param err - The caught error (may be an AppError or an unknown throw).
 * @param correlationId - The current request's correlation ID.
 */
function handleError(err: unknown, correlationId: string): APIGatewayProxyResultV2 {
    if (err instanceof AppError) {
        const appErr = err;
        logger.error('Application error', {
            error: appErr.name,
            message: appErr.message,
            statusCode: appErr.statusCode,
            correlationId,
        });
        return {
            statusCode: appErr.statusCode,
            headers: buildResponseHeaders(correlationId),
            body: JSON.stringify(appErr.toJSON()),
        };
    }

    // Unexpected / unclassified error
    /* istanbul ignore next — all thrown errors in this module are Error instances */
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Unhandled error', { message, correlationId });
    return {
        statusCode: 500,
        headers: buildResponseHeaders(correlationId),
        body: JSON.stringify({
            error: 'InternalError',
            message: 'An unexpected error occurred',
            correlationId,
        }),
    };
}
