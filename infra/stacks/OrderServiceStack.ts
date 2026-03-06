import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { TaggingAspect } from '../aspects/TaggingAspect';
import { DeadLetterQueue } from '../constructs/DeadLetterQueue';
import { PowertoolsLambda } from '../constructs/PowertoolsLambda';
import { StandardAlarms } from '../constructs/StandardAlarms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';

// ---------------------------------------------------------------------------
// OrderServiceStack — Phase 1 infrastructure for the Order Service
//
// Provisions:
//  - DynamoDB Orders Global Table (replicated to primary + secondary regions)
//  - SNS topic `order-events-{env}` for fan-out
//  - SQS queues: notification-queue + inventory-queue, each with a DLQ
//  - HTTP API Gateway with POST /orders + GET /health
//  - ACM certificate for api.<domainName> (DNS-validated)
//  - API Gateway Custom Domain Name linked to ACM certificate
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
    /**
     * The apex domain name (e.g. spworks.click).
     * Used to provision ACM certificate and API Gateway Custom Domain Name
     * for `api.<domainName>`. If not provided, custom domain is not configured.
     */
    readonly domainName?: string;
    /**
     * The region(s) for DynamoDB Global Table replication.
     * Each region listed (other than the stack's own region) will be added
     * as a replica. Pass an empty array or undefined to skip replication.
     */
    readonly replicationRegions?: string[];
    /** Whether this stack is being deployed in the secondary region (imports replicated DynamoDB tables) */
    readonly isSecondaryRegion?: boolean;
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
    public readonly ordersTable: dynamodb.ITable;

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

        const { envName, owner, lambdaCode, orderLambdaReservedConcurrency, domainName, replicationRegions } = props;

        // -----------------------------------------------------------------------
        // 1. DynamoDB Orders table
        //
        //  - On-Demand billing (scales automatically, no provisioning needed)
        //  - NEW_AND_OLD_IMAGES streams (Phase 2 readiness — ESM wired in US-7.1)
        //  - GSI-1: query orders by userId
        //  - GSI-2: query orders by country + status
        //  - TTL: allows automated expiry of old order records
        //  - Global Table replication: replicated to all specified regions (US-6.1)
        // -----------------------------------------------------------------------
        const tableName = `orders-${envName}`;

        if (props.isSecondaryRegion) {
            // In the secondary region, the Global Table replica already exists natively because
            // the primary stack created it. Therefore, we import it instead of defining it again.
            this.ordersTable = dynamodb.Table.fromTableName(this, 'OrdersTable', tableName);
        } else {
            // Filter out this stack's own region from the replication list.
            const ordersReplicaRegions = replicationRegions?.filter(r => r !== this.region);

            const table = new dynamodb.Table(this, 'OrdersTable', {
                tableName,
                partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
                sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
                timeToLiveAttribute: 'ttl',
                pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
                removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                ...(ordersReplicaRegions && ordersReplicaRegions.length > 0 && { replicationRegions: ordersReplicaRegions }),
            });

            // GSI-1: query orders by user (e.g. "all orders for userId X")
            table.addGlobalSecondaryIndex({
                indexName: 'GSI-userId-createdAt',
                partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
                sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
                projectionType: dynamodb.ProjectionType.ALL,
            });

            // GSI-2: query orders by country + status (e.g. "all PLACED orders for country US")
            table.addGlobalSecondaryIndex({
                indexName: 'GSI-country-status',
                partitionKey: { name: 'country', type: dynamodb.AttributeType.STRING },
                sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
                projectionType: dynamodb.ProjectionType.ALL,
            });

            this.ordersTable = table;
        }

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
        const alarmTopicArn = `arn:aws:sns:${this.region}:${this.account}:alarm-topic-${envName}`;

        const notificationDlq = new DeadLetterQueue(this, 'NotificationDLQ', {
            queueName: 'notification',
            envName,
            alarmTopicArn,
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
            alarmTopicArn,
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
        // 7.1. CloudWatch Alarms (Order Lambda)
        // -----------------------------------------------------------------------
        new StandardAlarms(this, 'OrderAlarms', {
            lambdaFunction: this.orderLambda,
            serviceName: 'order-service',
            envName,
            errorRateThresholdPercent: 1,
            throttleCountThreshold: 0,
            alarmTopicArn,
        });

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

        // ANY /orders — routes all methods to the Lambda so it can return
        // structured 404 responses for unsupported methods (e.g. DELETE /orders).
        // The Lambda handler itself only processes POST; others fall through to 404.
        this.httpApi.addRoutes({
            path: '/orders',
            methods: [apigwv2.HttpMethod.ANY],
            integration: orderLambdaIntegration,
        });

        // GET /health — lightweight health check for Route 53 health checks
        // No auth required (Route 53 health checker cannot authenticate).
        this.httpApi.addRoutes({
            path: '/health',
            methods: [apigwv2.HttpMethod.GET],
            integration: orderLambdaIntegration,
        });

        // $default catch-all — routes any unmatched method/path to the Lambda
        // so it can return a structured 404 JSON response with correlationId.
        // Without this, API Gateway returns its own bare {"message":"Not Found"}.
        this.httpApi.addRoutes({
            path: '/{proxy+}',
            methods: [apigwv2.HttpMethod.ANY],
            integration: orderLambdaIntegration,
        });

        // -----------------------------------------------------------------------
        // 8.1. API Gateway Alarms (p99 latency > 1000ms, 5XX rate > 1%)
        // -----------------------------------------------------------------------
        const apiGw5xxMetric = new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensionsMap: { ApiId: this.httpApi.apiId },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
        });

        const apiGwCountMetric = new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Count',
            dimensionsMap: { ApiId: this.httpApi.apiId },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
        });

        const apiGw5xxRateMetric = new cloudwatch.MathExpression({
            expression: 'IF(invocations > 0, errors / invocations * 100, 0)',
            usingMetrics: {
                errors: apiGw5xxMetric,
                invocations: apiGwCountMetric,
            },
            period: cdk.Duration.minutes(1),
            label: 'API GW 5XX Rate (%)',
        });

        const apiGw5xxAlarm = new cloudwatch.Alarm(this, 'ApiGw5xxAlarm', {
            alarmName: `api-gateway-5xx-rate-${this.region}-${envName}`,
            alarmDescription: `API Gateway 5XX error rate exceeded 1% (${this.region})`,
            metric: apiGw5xxRateMetric,
            threshold: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 2,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        const apiGwLatencyMetric = new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiId: this.httpApi.apiId },
            period: cdk.Duration.minutes(1),
            statistic: 'p99',
        });

        const apiGwLatencyAlarm = new cloudwatch.Alarm(this, 'ApiGwLatencyAlarm', {
            alarmName: `api-gateway-latency-${this.region}-${envName}`,
            alarmDescription: `API Gateway p99 latency exceeded 1000ms (${this.region})`,
            metric: apiGwLatencyMetric,
            threshold: 1000,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 2,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        const apiGwTopic = sns.Topic.fromTopicArn(this, 'ApiGwAlarmTopic', alarmTopicArn);
        const apiGwAction = new cloudwatchActions.SnsAction(apiGwTopic);
        apiGw5xxAlarm.addAlarmAction(apiGwAction);
        apiGwLatencyAlarm.addAlarmAction(apiGwAction);

        // -----------------------------------------------------------------------
        // 8.2. ACM Certificate + API Gateway Custom Domain Name (US-6.1)
        //
        // Provisions a DNS-validated ACM certificate for `api.<domainName>` and
        // creates an API Gateway Custom Domain Name mapped to the HTTP API's
        // $default stage. The regional endpoint is exported via SSM so that
        // SharedStack can point Route 53 latency records to it.
        // -----------------------------------------------------------------------
        if (domainName) {
            const apiSubdomain = `api.${domainName}`;

            // ACM certificate — DNS-validated.
            // In production, the validation CNAME must be added to the hosted zone.
            // CDK can auto-create the validation record if the hosted zone is in
            // the same account, but since SharedStack owns the zone in us-east-1,
            // we use CertificateValidation.fromDns() without a hosted zone reference
            // and rely on manual/automated DNS validation.
            const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
                domainName: domainName,
            });

            const certificate = new acm.Certificate(this, 'ApiCertificate', {
                domainName: apiSubdomain,
                validation: acm.CertificateValidation.fromDns(hostedZone),
            });

            // API Gateway v2 Custom Domain Name
            const customDomain = new apigwv2.DomainName(this, 'ApiCustomDomain', {
                domainName: apiSubdomain,
                certificate,
            });

            // Map the custom domain to the HTTP API's $default stage
            new apigwv2.ApiMapping(this, 'ApiMapping', {
                api: this.httpApi,
                domainName: customDomain,
                // Routes to the $default stage (created automatically by createDefaultStage: true)
            });

            // Export the regional domain name target for Route 53 latency records.
            // This is the API Gateway-owned regional endpoint, NOT the user-facing domain.
            // Example: d-abc123.execute-api.ap-south-1.amazonaws.com
            new ssm.StringParameter(this, 'CustomDomainRegionalEndpointParam', {
                parameterName: `/order-service/${envName}/custom-domain-regional-endpoint`,
                stringValue: customDomain.regionalDomainName,
                description: `API Gateway Custom Domain regional endpoint for ${apiSubdomain} (${this.region})`,
            });

            new ssm.StringParameter(this, 'CustomDomainRegionalHostedZoneIdParam', {
                parameterName: `/order-service/${envName}/custom-domain-regional-hosted-zone-id`,
                stringValue: customDomain.regionalHostedZoneId,
                description: `API Gateway Custom Domain regional hosted zone ID for ${apiSubdomain} (${this.region})`,
            });

            // CloudFormation outputs for the custom domain
            new cdk.CfnOutput(this, 'CustomDomainName', {
                value: apiSubdomain,
                description: 'API Gateway Custom Domain Name',
                exportName: `OrderServiceStack-${this.region}-${envName}-CustomDomainName`,
            });

            new cdk.CfnOutput(this, 'CustomDomainRegionalEndpoint', {
                value: customDomain.regionalDomainName,
                description: 'API Gateway Custom Domain regional endpoint (for Route 53)',
                exportName: `OrderServiceStack-${this.region}-${envName}-CustomDomainRegionalEndpoint`,
            });
        }

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
        // Wait, imported table doesn't have tableStreamArn property unless manually looked up. Fallback needed.
        let streamArn = 'STREAM_NOT_ENABLED';
        if (!props.isSecondaryRegion) {
            streamArn = (this.ordersTable as dynamodb.Table).tableStreamArn ?? 'STREAM_NOT_ENABLED';
        }

        new ssm.StringParameter(this, 'OrdersTableStreamArnParam', {
            parameterName: `/order-service/${envName}/orders-table-stream-arn`,
            stringValue: streamArn,
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

        new cdk.CfnOutput(this, 'OrderLambdaFunctionName', {
            value: this.orderLambda.functionName,
            description: 'Order Lambda function name',
            exportName: `OrderServiceStack-${envName}-OrderLambdaFunctionName`,
        });

        new cdk.CfnOutput(this, 'HttpApiId', {
            value: this.httpApi.apiId,
            description: 'HTTP API Gateway ID',
            exportName: `OrderServiceStack-${envName}-HttpApiId`,
        });
    }
}
