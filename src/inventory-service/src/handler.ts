import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { createLogger } from '@shared/index';
import { SnsOrderEventSchema } from './schemas';

const logger = createLogger({ serviceName: 'inventory-service' });

/**
 * Lambda handler for processing SQS messages containing order events for Inventory.
 * Responsible for validating the event, and logging the order details.
 * No DLQ expected for simple logging failures — log errors and continue.
 *
 * @param event The SQS event object containing a batch of messages.
 * @returns An empty batchItemFailures list, as we always return success for the records.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    // We never populate batchItemFailures because we want to return success for all records,
    // avoiding the DLQ for simple logging failures.
    const batchItemFailures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
        const messageId = record.messageId;

        // Setup logger context
        logger.resetKeys();

        try {
            // 1. Parse message body
            let rawBody: unknown;
            try {
                rawBody = JSON.parse(record.body);
            } catch (err) {
                logger.error('Failed to parse SQS message body as JSON', { messageId, error: err });
                continue;
            }

            const parseResult = SnsOrderEventSchema.safeParse(rawBody);
            if (!parseResult.success) {
                logger.error('SQS message failed Zod validation', { messageId, issues: parseResult.error.issues });
                continue;
            }

            const orderEvent = parseResult.data;
            const correlationId = orderEvent.correlationId;
            logger.appendKeys({ correlationId });

            // 2. Log full order details via Powertools structured logger
            logger.info('Processing order for inventory', {
                orderId: orderEvent.data.orderId,
                userId: orderEvent.data.userId,
                status: orderEvent.data.status,
                fullOrderDetails: orderEvent.data,
            });

        } catch (err) {
            logger.error('Unhandled error processing SQS record', { messageId, error: err });
            // Do not throw, log errors and continue
        }
    }

    return { batchItemFailures };
};
