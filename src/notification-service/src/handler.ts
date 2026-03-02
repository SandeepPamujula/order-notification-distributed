import { randomUUID } from 'crypto';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SendEmailCommand } from '@aws-sdk/client-ses';

import { createLogger } from '@shared/index';
import { docClient, sesClient } from './clients';
import { SnsOrderEventSchema, NotificationRecord } from './schemas';

const logger = createLogger({ serviceName: 'notification-service' });

const NOTIFICATIONS_TABLE_NAME = process.env['NOTIFICATIONS_TABLE_NAME'] ?? '';
const SES_FROM_ADDRESS = process.env['SES_FROM_ADDRESS'] ?? 'noreply@sporder.com';

/**
 * Sleeps for a given number of milliseconds
 */
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Helper to execute a function with exponential backoff (max 3 attempts).
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 3;
    let attempt = 1;
    let lastError: unknown;

    while (attempt <= MAX_ATTEMPTS) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt === MAX_ATTEMPTS) break;

            // Exponential backoff: 500ms, 1000ms
            const backoffMs = Math.pow(2, attempt - 1) * 500;
            logger.warn(`SES send failed, retrying in ${backoffMs}ms... (Attempt ${attempt}/${MAX_ATTEMPTS})`, { error });
            await delay(backoffMs);
            attempt++;
        }
    }
    throw lastError;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
        const messageId = record.messageId;
        const retryCount = Number(record.attributes.ApproximateReceiveCount || 1);

        // Setup logger context
        logger.resetKeys();

        try {
            // 1. Parse message body
            let rawBody: unknown;
            try {
                rawBody = JSON.parse(record.body);
            } catch (err) {
                logger.error('Failed to parse SQS message body as JSON', { messageId, error: err });
                batchItemFailures.push({ itemIdentifier: messageId });
                continue;
            }

            const parseResult = SnsOrderEventSchema.safeParse(rawBody);
            if (!parseResult.success) {
                logger.error('SQS message failed Zod validation', { messageId, issues: parseResult.error.issues });
                batchItemFailures.push({ itemIdentifier: messageId });
                continue;
            }

            const orderEvent = parseResult.data;
            const correlationId = orderEvent.correlationId;
            logger.appendKeys({ correlationId });

            // 2. Log order details
            logger.info('Processing order event', { orderId: orderEvent.data.orderId, userId: orderEvent.data.userId });

            const { orderId, userEmail, items, totalAmount, currency, userId } = orderEvent.data;
            const subject = `Order Confirmed — ${orderId}`;
            const bodyText = `Your order ${orderId} has been placed successfully.\nTotal amount: ${totalAmount} ${currency}\nItems: ${items.map(i => i.productName).join(', ')}`;

            // 3. Idempotency Check: check Notifications table GSI-1 (orderId) for existing SENT confirmation
            const queryRes = await docClient.send(new QueryCommand({
                TableName: NOTIFICATIONS_TABLE_NAME,
                IndexName: 'GSI-orderId',
                KeyConditionExpression: 'orderId = :orderId',
                ExpressionAttributeValues: {
                    ':orderId': orderId,
                }
            }));

            const existingNotifications = (queryRes.Items ?? []) as NotificationRecord[];
            const alreadySent = existingNotifications.some(n => n.type === 'CONFIRMATION' && n.status === 'SENT');

            if (alreadySent) {
                logger.info('Idempotency check: Confirmation email already sent for order', { orderId });
                // Do not return failure, SQS will delete it
                continue;
            }

            // 4. Send email via SES with exponential backoff
            const notificationId = randomUUID();
            const now = new Date().toISOString();

            try {
                await withRetry(async () => {
                    await sesClient.send(new SendEmailCommand({
                        Source: SES_FROM_ADDRESS,
                        Destination: { ToAddresses: [userEmail] },
                        Message: {
                            Subject: { Data: subject },
                            Body: { Text: { Data: bodyText } }
                        }
                    }));
                });

                logger.info('Confirmation email sent', { orderId, notificationId, userEmail });

                // 5. PutItem to Notifications table (Success)
                await docClient.send(new PutCommand({
                    TableName: NOTIFICATIONS_TABLE_NAME,
                    Item: {
                        notificationId,
                        orderId,
                        userId,
                        userEmail,
                        type: 'CONFIRMATION',
                        status: 'SENT',
                        channel: 'EMAIL',
                        subject,
                        body: bodyText,
                        sentAt: new Date().toISOString(),
                        createdAt: now,
                        retryCount
                    } satisfies NotificationRecord
                }));

            } catch (sesError) {
                logger.error('Failed to send confirmation email', { orderId, error: sesError });

                // PutItem to Notifications table (Failure)
                await docClient.send(new PutCommand({
                    TableName: NOTIFICATIONS_TABLE_NAME,
                    Item: {
                        notificationId,
                        orderId,
                        userId,
                        userEmail,
                        type: 'CONFIRMATION',
                        status: 'FAILED',
                        channel: 'EMAIL',
                        subject,
                        body: bodyText,
                        sentAt: new Date().toISOString(),
                        createdAt: now,
                        retryCount,
                        errorMessage: sesError instanceof Error ? sesError.message : String(sesError)
                    } satisfies NotificationRecord
                }));

                batchItemFailures.push({ itemIdentifier: messageId });
            }

        } catch (err) {
            logger.error('Unhandled error processing SQS record', { messageId, error: err });
            batchItemFailures.push({ itemIdentifier: messageId });
        }
    }

    return { batchItemFailures };
};
