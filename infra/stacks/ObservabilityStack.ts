import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as xray from 'aws-cdk-lib/aws-xray';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

import { TaggingAspect } from '../aspects/TaggingAspect';

export interface ObservabilityStackProps extends cdk.StackProps {
    readonly envName: string;
    readonly owner: string;
}

/**
 * Observability Stack.
 * Provisions centralized Dashboards, X-Ray groups, and the Ops SNS Topic.
 */
export class ObservabilityStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
        super(scope, id, props);

        const { envName, owner } = props;

        // -----------------------------------------------------------------------
        // 1. Ops SNS Topic for Alarms
        // -----------------------------------------------------------------------
        const opsEmail = ssm.StringParameter.valueForStringParameter(this, `/shared/${envName}/ops-email`);

        const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
            topicName: `alarm-topic-${envName}`,
            displayName: `Ops Alarms — ${envName}`,
        });

        alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(opsEmail));

        // -----------------------------------------------------------------------
        // 2. Import CFN Exports from Service Stacks (Local Region)
        // -----------------------------------------------------------------------
        const orderLambdaName = cdk.Fn.importValue(`OrderServiceStack-${envName}-OrderLambdaFunctionName`);
        const notificationLambdaName = cdk.Fn.importValue(`NotificationServiceStack-${envName}-NotificationLambdaFunctionName`);
        const inventoryLambdaName = cdk.Fn.importValue(`InventoryServiceStack-${envName}-InventoryLambdaFunctionName`);
        const helpdeskLambdaName = cdk.Fn.importValue(`HelpdeskStack-${envName}-HelpdeskLambdaFunctionName`);
        const ordersTableName = cdk.Fn.importValue(`OrderServiceStack-${envName}-OrdersTableName`);
        const httpApiId = cdk.Fn.importValue(`OrderServiceStack-${envName}-HttpApiId`);

        // SQS Queue names
        const notificationQueueName = `notification-queue-${envName}`;
        const notificationDlqName = `notification-dlq-${envName}`;
        const inventoryQueueName = `inventory-queue-${envName}`;
        const inventoryDlqName = `inventory-dlq-${envName}`;

        // -----------------------------------------------------------------------
        // 3. X-Ray Groups
        // -----------------------------------------------------------------------
        const services = ['order-service', 'notification-service', 'inventory-service', 'helpdesk-service'];
        services.forEach(service => {
            new xray.CfnGroup(this, `${service}XRayGroup`, {
                groupName: `${service}-${envName}`,
                filterExpression: `service("${service}")`,
            });
        });

        // -----------------------------------------------------------------------
        // 4. Dashboards
        // -----------------------------------------------------------------------

        // 4a. Order Service Dashboard
        const orderDashboard = new cloudwatch.Dashboard(this, 'OrderDashboard', {
            dashboardName: `order-service-${this.region}-${envName}`,
        });

                orderDashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'API GW Latency (p50/p99)',
                left: [
                    new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: 'Latency', dimensionsMap: { ApiId: httpApiId }, statistic: 'p50', period: cdk.Duration.minutes(1) }) as any,
                    new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: 'Latency', dimensionsMap: { ApiId: httpApiId }, statistic: 'p99', period: cdk.Duration.minutes(1) } as any),
                ],
            } as any),
            new cloudwatch.GraphWidget({
                title: 'Order Lambda Errors / Duration',
                left: [new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: orderLambdaName }, statistic: 'Sum', period: cdk.Duration.minutes(1) }) as any],
                right: [new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Duration', dimensionsMap: { FunctionName: orderLambdaName }, statistic: 'Average', period: cdk.Duration.minutes(1) })],
            }) as any,
            new cloudwatch.GraphWidget({
                title: 'Orders Table Consumed WCU / Throttles',
                left: [new cloudwatch.Metric({ namespace: 'AWS/DynamoDB', metricName: 'ConsumedWriteCapacityUnits', dimensionsMap: { TableName: ordersTableName }, statistic: 'Sum', period: cdk.Duration.minutes(1) }) as any],
                right: [new cloudwatch.Metric({ namespace: 'AWS/DynamoDB', metricName: 'WriteThrottleEvents', dimensionsMap: { TableName: ordersTableName }, statistic: 'Sum', period: cdk.Duration.minutes(1) })],
            }) as any
        );

        // 4b. Notification Service Dashboard
        const notificationDashboard = new cloudwatch.Dashboard(this, 'NotificationDashboard', {
            dashboardName: `notification-service-${this.region}-${envName}`,
        });

                notificationDashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'SQS Queue / DLQ Depth',
                left: [new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: notificationQueueName }, statistic: 'Maximum', period: cdk.Duration.minutes(1) }) as any],
                right: [new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: notificationDlqName }, statistic: 'Maximum', period: cdk.Duration.minutes(1) })],
            }) as any,
            new cloudwatch.GraphWidget({
                title: 'Notification Lambda Errors',
                left: [new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: notificationLambdaName }, statistic: 'Sum', period: cdk.Duration.minutes(1) }) as any],
            }) as any,
            new cloudwatch.GraphWidget({
                title: 'SES Sends vs Bounces vs Complaints',
                left: [
                    new cloudwatch.Metric({ namespace: 'AWS/SES', metricName: 'Send', statistic: 'Sum', period: cdk.Duration.minutes(1) }) as any,
                    new cloudwatch.Metric({ namespace: 'AWS/SES', metricName: 'Bounce', statistic: 'Sum', period: cdk.Duration.minutes(1) } as any),
                    new cloudwatch.Metric({ namespace: 'AWS/SES', metricName: 'Complaint', statistic: 'Sum', period: cdk.Duration.minutes(1) } as any),
                ]
            } as any)
        );

        // 4c. Inventory Service Dashboard
        const inventoryDashboard = new cloudwatch.Dashboard(this, 'InventoryDashboard', {
            dashboardName: `inventory-service-${this.region}-${envName}`,
        }) as any;

                inventoryDashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'SQS Queue / DLQ Depth',
                left: [new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: inventoryQueueName }, statistic: 'Maximum', period: cdk.Duration.minutes(1) }) as any],
                right: [new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: inventoryDlqName }, statistic: 'Maximum', period: cdk.Duration.minutes(1) })],
            }) as any,
            new cloudwatch.GraphWidget({
                title: 'Inventory Lambda Errors',
                left: [new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: inventoryLambdaName }, statistic: 'Sum', period: cdk.Duration.minutes(1) }) as any],
            }) as any
        );

        // 4d. System Health Dashboard
        const systemDashboard = new cloudwatch.Dashboard(this, 'SystemHealthDashboard', {
            dashboardName: `system-health-${this.region}-${envName}`,
        });

        // Try getting primary health check ID from us-east-1 (SharedStack)
        const getPrimaryHealthCheckId = new cr.AwsCustomResource(this, 'GetPrimaryHealthCheckId', {
            onCreate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: `/shared/${envName}/primary-health-check-id` },
                region: 'us-east-1',
                physicalResourceId: cr.PhysicalResourceId.of('PrimaryHealthCheckId'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE } as any),
        });
        const primaryHealthCheckId = getPrimaryHealthCheckId.getResponseField('Parameter.Value');

                systemDashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'Lambda Errors (All Services)',
                left: [
                    new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: orderLambdaName }, statistic: 'Sum', period: cdk.Duration.minutes(1) }) as any,
                    new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: notificationLambdaName }, statistic: 'Sum', period: cdk.Duration.minutes(1) } as any),
                    new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: inventoryLambdaName }, statistic: 'Sum', period: cdk.Duration.minutes(1) } as any),
                    new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: helpdeskLambdaName }, statistic: 'Sum', period: cdk.Duration.minutes(1) } as any),
                ],
            } as any),
            new cloudwatch.GraphWidget({
                title: 'DLQ Depth (All Services)',
                left: [
                    new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: notificationDlqName }, statistic: 'Maximum', period: cdk.Duration.minutes(1) }) as any,
                    new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensionsMap: { QueueName: inventoryDlqName }, statistic: 'Maximum', period: cdk.Duration.minutes(1) } as any),
                ],
            } as any),
            new cloudwatch.GraphWidget({
                title: 'Route 53 Health Check Status (1 = Healthy, 0 = Unhealthy)',
                left: [
                    new cloudwatch.Metric({ namespace: 'AWS/Route53', metricName: 'HealthCheckStatus', dimensionsMap: { HealthCheckId: primaryHealthCheckId }, region: 'us-east-1', statistic: 'Minimum', period: cdk.Duration.minutes(1) }) as any
                ]
            } as any)
        );

        // Tagging Aspect
        cdk.Aspects.of(this).add(
            new TaggingAspect({ env: envName, service: 'observability', owner } as any),
        );
    }
}
