import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { TaggingAspect } from '../aspects/TaggingAspect';
import { DeadLetterQueue } from '../constructs/DeadLetterQueue';
import { PowertoolsLambda } from '../constructs/PowertoolsLambda';

// ---------------------------------------------------------------------------
// OrderServiceStack — Phase 1 infrastructure for the Order Service
//
// Provisions:
//  - DynamoDB Orders table (On-Demand, Streams enabled, GSIs for user + country queries)
//  - SNS topic `order-events-{env}` for fan-out
//  - SQS queues: notification-queue + inventory-queue, each with a DLQ
//  - HTTP API Gateway with POST /orders + GET /health
//  - Order Lambda (PowertoolsLambda) with least-privilege IAM
//  - EventBridge custom bus `order-events-bus-{env}`
//  - MESSAGING_MODE SSM parameter (default: SNS)
//  - Cross-stack SSM parameter exports
//
// Phase 2 readiness:
//  - DynamoDB stream ARN exported to SSM for ESM wiring in US-7.1
// ---------------------------------------------------------------------------

export interface OrderServiceStackProps extends cdk.StackProps {
    /** Environment name: dev | staging | prod */
    readonly envName: string;
    /** Owner tag value */
    readonly owner: string;
    /**
     * Path to the Order Lambda code asset directory.
     * Defaults to `../src/order-service/dist` relative to this file.
     * Pass `lambda.Code.fromInline('exports.handler = () => {}')` in unit tests.
     */
    readonly lambdaCode?: lambda.Code;
    /**
     * Reserved concurrent executions for the Order Lambda.
     * Set via CDK context per environment; leave undefined for dev to avoid limits.
     */
    readonly orderLambdaReservedConcurrency?: number;
}

/**
 * Order Service CDK stack — Phase 1.
 *
 * Deploy this stack once per region:
 * ```
 * cdk deploy OrderServiceStack-ap-south-1-dev --context env=dev
 * cdk deploy OrderServiceStack-us-east-1-dev --context env=dev
 * ```
 */
export class OrderServiceStack extends cdk.Stack {
    /** The DynamoDB Orders table. */
    public readonly ordersTable: dynamodb.Table;

    /** The SNS topic used for Phase 1 fan-out. */
    public readonly orderEventsTopic: sns.Topic;

    /** The EventBridge custom bus for helpdesk routing. */
    public readonly orderEventsBus: events.EventBus;

    /** The SQS queue consumed by the Notification Lambda. */
    public readonly notificationQueue: sqs.Queue;

    /** The SQS queue consumed by the Inventory Lambda. */
    public readonly inventoryQueue: sqs.Queue;

    /** The Order Lambda function. */
    public readonly orderLambda: lambda.Function;

    /** The HTTP API Gateway. */
    public readonly httpApi: apigwv2.HttpApi;

    constructor(scope: Construct, id: string, props: OrderServiceStackProps) {
        super(scope, id, props);

        const { envName, owner, lambdaCode, orderLambdaReservedConcurrency } = props;

        // -----------------------------------------------------------------------
        // 1. DynamoDB Orders table
        //
        //  - On-Demand billing (scales automatically, no provisioning needed)
        //  - NEW_AND_OLD_IMAGES streams (Phase 2 readiness — ESM wired in US-7.1)
        //  - GSI-1: query orders by userId
        //  - GSI-2: query orders by country + status
        //  - TTL: allows automated expiry of old order records
        // -----------------------------------------------------------------------
        this.ordersTable = new dynamodb.Table(this, 'OrdersTable', {
            tableName: `orders-${envName}`,
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Enable streams now so Phase 2 ESM can be attached without table replacement
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            timeToLiveAttribute: 'ttl',
            // Point-in-time recovery for resilience
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // GSI-1: query orders by user (e.g. "all orders for userId X")
        this.ordersTable.addGlobalSecondaryIndex({
            indexName: 'GSI-userId-createdAt',
            partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // GSI-2: query orders by country + status (e.g. "all PLACED orders for country US")
        this.ordersTable.addGlobalSecondaryIndex({
            indexName: 'GSI-country-status',
            partitionKey: { name: 'country', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // -----------------------------------------------------------------------
        // 2. EventBridge custom bus
        //
        // All-inclusive bus owned by Order Service.
        // HelpdeskStack attaches an EventBridge rule here for country ≠ IN filtering.
        // -----------------------------------------------------------------------
        this.orderEventsBus = new events.EventBus(this, 'OrderEventsBus', {
            eventBusName: `order-events-bus-${envName}`,
        });

        // -----------------------------------------------------------------------
        // 3. SNS topic — order-events fan-out (Phase 1)
        //
        // Server-side encryption via SNS-managed keys (no KMS cost overhead in dev).
        // Raw message delivery is ENABLED on subscriptions so the SQS consumer
        // receives the plain JSON payload — EventBridge handles the filtered
        // routing and any message transformation.
        // -----------------------------------------------------------------------
        this.orderEventsTopic = new sns.Topic(this, 'OrderEventsTopic', {
            topicName: `order-events-${envName}`,
            displayName: `Order Events — ${envName}`,
        });

        // -----------------------------------------------------------------------
        // 4. SQS queues + DLQs (notification and inventory)
        //
        // Visibility timeout = 6× Lambda timeout (30 s) = 180 s per AWS best practice.
        // maxReceiveCount = 3 → after 3 failures the message moves to the DLQ.
        // -----------------------------------------------------------------------

        // --- Notification DLQ & queue ---
        const notificationDlq = new DeadLetterQueue(this, 'NotificationDLQ', {
            queueName: 'notification',
            envName,
        });

        this.notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
            queueName: `notification-queue-${envName}`,
            visibilityTimeout: cdk.Duration.seconds(180),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            deadLetterQueue: {
                queue: notificationDlq.queue,
                maxReceiveCount: 3,
            },
        });

        // --- Inventory DLQ & queue ---
        const inventoryDlq = new DeadLetterQueue(this, 'InventoryDLQ', {
            queueName: 'inventory',
            envName,
        });

        this.inventoryQueue = new sqs.Queue(this, 'InventoryQueue', {
            queueName: `inventory-queue-${envName}`,
            visibilityTimeout: cdk.Duration.seconds(180),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            deadLetterQueue: {
                queue: inventoryDlq.queue,
                maxReceiveCount: 3,
            },
        });

        // Subscribe queues to SNS topic with raw message delivery enabled.
        // rawMessageDelivery: true → SQS consumer receives the plain JSON body directly
        // (no SNS envelope wrapper), simplifying handler parsing.
        this.orderEventsTopic.addSubscription(
            new snsSubscriptions.SqsSubscription(this.notificationQueue, {
                rawMessageDelivery: true,
            }),
        );

        this.orderEventsTopic.addSubscription(
            new snsSubscriptions.SqsSubscription(this.inventoryQueue, {
                rawMessageDelivery: true,
            }),
        );

        // -----------------------------------------------------------------------
        // 5. MESSAGING_MODE SSM parameter
        //
        // Controls whether Order Lambda publishes to SNS (Phase 1) or relies on
        // DynamoDB Streams (Phase 2). Default: SNS. Flip to STREAMS during
        // Phase 2 migration (US-7.3) without a code redeployment.
        // -----------------------------------------------------------------------
        const messagingModeParam = new ssm.StringParameter(this, 'MessagingModeParam', {
            parameterName: `/order-service/${envName}/messaging-mode`,
            stringValue: 'SNS',
            description: 'Messaging backend: SNS (Phase 1) | STREAMS (Phase 2)',
        });

        // -----------------------------------------------------------------------
        // 6. Order Lambda
        //
        // Uses the PowertoolsLambda construct for consistent X-Ray tracing,
        // structured JSON logging, and Powertools env vars.
        // -----------------------------------------------------------------------
        const orderLambdaConstruct = new PowertoolsLambda(this, 'OrderLambda', {
            powertoolsServiceName: 'order-service',
            handler: 'handler.handler',
            // In tests we pass lambda.Code.fromInline(); in production we use the esbuild dist bundle.
            code: lambdaCode ?? lambda.Code.fromAsset('../src/order-service/dist'),
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
            ...(orderLambdaReservedConcurrency !== undefined && { reservedConcurrentExecutions: orderLambdaReservedConcurrency }),
            environment: {
                ORDERS_TABLE_NAME: this.ordersTable.tableName,
                ORDER_EVENTS_TOPIC_ARN: this.orderEventsTopic.topicArn,
                ORDER_EVENTS_BUS_NAME: this.orderEventsBus.eventBusName,
                // MESSAGING_MODE is read from SSM at Lambda startup (cached in process env by the handler)
                MESSAGING_MODE: 'SNS',
            },
        });

        this.orderLambda = orderLambdaConstruct.function;

        // -----------------------------------------------------------------------
        // 7. Least-privilege IAM for Order Lambda
        // -----------------------------------------------------------------------

        // DynamoDB: PutItem only on the Orders table
        this.ordersTable.grantWriteData(this.orderLambda);

        // SNS: Publish only on the order-events topic
        this.orderEventsTopic.grantPublish(this.orderLambda);

        // EventBridge: PutEvents on the custom bus
        this.orderLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['events:PutEvents'],
                resources: [this.orderEventsBus.eventBusArn],
            }),
        );

        // SSM: read MESSAGING_MODE at runtime
        messagingModeParam.grantRead(this.orderLambda);

        // -----------------------------------------------------------------------
        // 8. HTTP API Gateway — POST /orders + GET /health
        //
        // HTTP API (v2) is used instead of REST API (v1) — lower cost and
        // lower latency for simple proxy integrations.
        // -----------------------------------------------------------------------
        this.httpApi = new apigwv2.HttpApi(this, 'OrderHttpApi', {
            apiName: `order-service-api-${envName}`,
            description: `Order Service HTTP API — ${envName}`,
            // Default stage deployed automatically
            createDefaultStage: true,
        });

        const orderLambdaIntegration = new apigwv2Integrations.HttpLambdaIntegration(
            'OrderLambdaIntegration',
            this.orderLambda,
        );

        // POST /orders — main order placement route
        this.httpApi.addRoutes({
            path: '/orders',
            methods: [apigwv2.HttpMethod.POST],
            integration: orderLambdaIntegration,
        });

        // GET /health — lightweight health check for Route 53 health checks
        // No auth required (Route 53 health checker cannot authenticate).
        this.httpApi.addRoutes({
            path: '/health',
            methods: [apigwv2.HttpMethod.GET],
            integration: orderLambdaIntegration,
        });

        // -----------------------------------------------------------------------
        // 9. Cross-stack SSM parameter exports
        //
        // All downstream service stacks (Notification, Inventory, Helpdesk,
        // Observability, SharedStack Phase 2) import these parameters to avoid
        // hard CloudFormation cross-stack references.
        // -----------------------------------------------------------------------

        new ssm.StringParameter(this, 'NotificationQueueArnParam', {
            parameterName: `/order-service/${envName}/notification-queue-arn`,
            stringValue: this.notificationQueue.queueArn,
            description: 'ARN of the SQS notification-queue (consumed by NotificationServiceStack)',
        });

        new ssm.StringParameter(this, 'NotificationDlqArnParam', {
            parameterName: `/order-service/${envName}/notification-dlq-arn`,
            stringValue: notificationDlq.queue.queueArn,
            description: 'ARN of the notification DLQ',
        });

        new ssm.StringParameter(this, 'InventoryQueueArnParam', {
            parameterName: `/order-service/${envName}/inventory-queue-arn`,
            stringValue: this.inventoryQueue.queueArn,
            description: 'ARN of the SQS inventory-queue (consumed by InventoryServiceStack)',
        });

        new ssm.StringParameter(this, 'InventoryDlqArnParam', {
            parameterName: `/order-service/${envName}/inventory-dlq-arn`,
            stringValue: inventoryDlq.queue.queueArn,
            description: 'ARN of the inventory DLQ',
        });

        // Raw API Gateway URL — used by SharedStack health checks until custom domains are configured (US-6.1)
        new ssm.StringParameter(this, 'ApiGatewayUrlParam', {
            parameterName: `/order-service/${envName}/api-gateway-url`,
            stringValue: this.httpApi.apiEndpoint,
            description: 'Raw HTTP API Gateway URL (execute-api) for the Order Service',
        });

        new ssm.StringParameter(this, 'OrderEventsTopicArnParam', {
            parameterName: `/order-service/${envName}/order-events-topic-arn`,
            stringValue: this.orderEventsTopic.topicArn,
            description: 'ARN of the SNS order-events topic (Phase 1)',
        });

        new ssm.StringParameter(this, 'OrderEventsBusNameParam', {
            parameterName: `/order-service/${envName}/order-events-bus-name`,
            stringValue: this.orderEventsBus.eventBusName,
            description: 'Name of the EventBridge custom bus for order events',
        });

        new ssm.StringParameter(this, 'OrdersTableNameParam', {
            parameterName: `/order-service/${envName}/orders-table-name`,
            stringValue: this.ordersTable.tableName,
            description: 'DynamoDB Orders table name',
        });

        // Stream ARN — wired to ESM in US-7.1 (Phase 2 migration)
        new ssm.StringParameter(this, 'OrdersTableStreamArnParam', {
            parameterName: `/order-service/${envName}/orders-table-stream-arn`,
            stringValue: this.ordersTable.tableStreamArn ?? 'STREAM_NOT_ENABLED',
            description: 'DynamoDB Orders table stream ARN (used by Phase 2 ESM in US-7.1)',
        });

        // -----------------------------------------------------------------------
        // 10. Tagging
        //
        // Apply service-specific tag at stack level — TaggingAspect at App level
        // (BaselineStack) sets env + owner; here we set service=order-service.
        // -----------------------------------------------------------------------
        cdk.Aspects.of(this).add(
            new TaggingAspect({ env: envName, service: 'order-service', owner }),
        );

        // -----------------------------------------------------------------------
        // 11. CloudFormation outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'ApiEndpoint', {
            value: this.httpApi.apiEndpoint,
            description: 'HTTP API Gateway endpoint URL',
            exportName: `OrderServiceStack-${envName}-ApiEndpoint`,
        });

        new cdk.CfnOutput(this, 'OrdersTableName', {
            value: this.ordersTable.tableName,
            description: 'DynamoDB Orders table name',
            exportName: `OrderServiceStack-${envName}-OrdersTableName`,
        });

        new cdk.CfnOutput(this, 'OrderEventsTopicArn', {
            value: this.orderEventsTopic.topicArn,
            description: 'SNS order-events topic ARN',
            exportName: `OrderServiceStack-${envName}-OrderEventsTopicArn`,
        });

        new cdk.CfnOutput(this, 'OrderEventsBusName', {
            value: this.orderEventsBus.eventBusName,
            description: 'EventBridge custom bus name',
            exportName: `OrderServiceStack-${envName}-OrderEventsBusName`,
        });
    }
}
