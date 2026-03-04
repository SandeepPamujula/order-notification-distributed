import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { Context } from 'aws-lambda';

import { ValidationError, InternalError, EmailError } from '@shared/errors';
import { createLogger, createTracer } from '@shared/powertools';

import { EventBridgeOrderPlacedSchema } from './schemas';

const logger = createLogger({ serviceName: 'helpdesk-service' });
const tracer = createTracer('helpdesk-service');

// Initialise SES client outside handler for reuse
const sesClient = tracer.captureAWSv3Client(
    new SESClient({ region: process.env.AWS_REGION || 'ap-south-1' }),
) as SESClient;

/**
 * EventBridge handler for processing OrderPlaced events (Helpdesk Service).
 * Filters non-India orders and sends an alert email to the helpdesk.
 *
 * @param event - The EventBridge `OrderPlaced` event
 * @param context - The Lambda execution context
 */
export const handleEventBridgeEvent = async (event: unknown, _context: Context): Promise<void> => {
    // 1. Zod parsing
    const parsedEvent = EventBridgeOrderPlacedSchema.safeParse(event);
    if (!parsedEvent.success) {
        logger.error('Invalid EventBridge event payload', {
            error: parsedEvent.error.flatten(),
            event,
        });
        throw new ValidationError('Invalid EventBridge payload', 'unknown', parsedEvent.error.flatten());
    }

    const { detail } = parsedEvent.data;

    // 2. Extract correlationId
    logger.appendKeys({ correlationId: detail.correlationId });
    logger.info('Received non-India order event', {
        orderId: detail.orderId,
        country: detail.country,
        amount: detail.totalAmount,
        currency: detail.currency,
    });

    // 3. Send email via SES
    try {
        const sesHelpdeskAddress = process.env.SES_HELPDESK_ADDRESS;
        if (!sesHelpdeskAddress) {
            throw new InternalError('Missing SES_HELPDESK_ADDRESS environment variable', detail.correlationId);
        }

        const subject = `Non-India Order Alert — ${detail.orderId} (${detail.country})`;
        const bodyText = `
Order Details:
--------------
Order ID: ${detail.orderId}
User ID: ${detail.userId}
User Email: ${detail.userEmail}
Country: ${detail.country}
Total Amount: ${detail.totalAmount}
Currency: ${detail.currency}
`.trim();

        const command = new SendEmailCommand({
            Source: sesHelpdeskAddress,
            Destination: {
                ToAddresses: [sesHelpdeskAddress],
            },
            Message: {
                Subject: { Data: subject },
                Body: { Text: { Data: bodyText } },
            },
        });

        await sesClient.send(command);

        // 4. Log successful send
        logger.info('Helpdesk email sent successfully', {
            orderId: detail.orderId,
        });
    } catch (error) {
        logger.error('Failed to send helpdesk email', { error: error as Error });
        if (error instanceof InternalError) {
            throw error;
        }
        throw new EmailError('Failed to send Helpdesk SES email', detail.correlationId, error as Error);
    }
};

/**
 * Main Lambda entry point.
 */
export const handler = async (event: unknown, context: Context): Promise<void> => {
    // Inject Powertools contexts
    logger.addContext(context);

    // Process the event
    await handleEventBridgeEvent(event, context);
};
