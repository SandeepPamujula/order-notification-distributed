// ---------------------------------------------------------------------------
// Order Service — AWS SDK client singletons
//
// Clients are initialised once at module load time (outside the handler) so
// they are reused across warm Lambda invocations, avoiding repeated
// connection overhead.
// ---------------------------------------------------------------------------

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SNSClient } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Raw DynamoDB client — wrapped by the Document client below. */
const dynamoDbClient = new DynamoDBClient({});

/**
 * DynamoDB Document client — automatically marshals/unmarshals JavaScript
 * objects to/from DynamoDB's native typed attribute format.
 */
export const docClient = DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: {
        // Omit undefined attributes from the marshalled item
        removeUndefinedValues: true,
    },
});

/** SNS client used for Phase 1 fan-out. */
export const snsClient = new SNSClient({});

/** EventBridge client used to publish OrderPlaced events (both phases). */
export const eventBridgeClient = new EventBridgeClient({});
