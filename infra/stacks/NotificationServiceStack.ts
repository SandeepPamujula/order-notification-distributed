import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { TaggingAspect } from '../aspects/TaggingAspect';
import { PowertoolsLambda } from '../constructs/PowertoolsLambda';
import { StandardAlarms } from '../constructs/StandardAlarms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

export interface NotificationServiceStackProps extends cdk.StackProps {
    readonly envName: string;
    readonly owner: string;
    readonly lambdaCode?: lambda.Code;
}

/**
 * Notification Service CDK stack — Phase 1.
 */
export class NotificationServiceStack extends cdk.Stack {
    public readonly notificationsTable: dynamodb.Table;
    public readonly notificationLambda: lambda.Function;

    constructor(scope: Construct, id: string, props: NotificationServiceStackProps) {
        super(scope, id, props);

        const { envName, owner, lambdaCode } = props;

        // 1. DynamoDB Notifications table
        this.notificationsTable = new dynamodb.Table(this, 'NotificationsTable', {
            tableName: `notifications-${envName}`,
            partitionKey: { name: 'notificationId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });

        this.notificationsTable.addGlobalSecondaryIndex({
            indexName: 'GSI-orderId',
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        this.notificationsTable.addGlobalSecondaryIndex({
            indexName: 'GSI-status-type',
            partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'type', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 2. Import SQS queues from SSM
        const notificationQueueArn = ssm.StringParameter.valueForStringParameter(
            this,
            `/order-service/${envName}/notification-queue-arn`,
        );

        const notificationDlqArn = ssm.StringParameter.valueForStringParameter(
            this,
            `/order-service/${envName}/notification-dlq-arn`,
        );

        const notificationQueue = sqs.Queue.fromQueueArn(this, 'NotificationQueue', notificationQueueArn);
        const notificationDlq = sqs.Queue.fromQueueArn(this, 'NotificationDLQ', notificationDlqArn);

        // 3. Store SES configuration in SSM
        new ssm.StringParameter(this, 'SesFromAddressParam', {
            parameterName: `/notification-service/${envName}/ses-from-address`,
            stringValue: `noreply@spkumarorder.com`,
            description: 'SES From address for notifications',
        });

        new ssm.StringParameter(this, 'SesReplyToAddressParam', {
            parameterName: `/notification-service/${envName}/ses-reply-to-address`,
            stringValue: `helpdesk@spkumarorder.com`,
            description: 'SES Reply-To address for notifications',
        });

        // 4. Notification Lambda
        const notificationLambdaConstruct = new PowertoolsLambda(this, 'NotificationLambda', {
            powertoolsServiceName: 'notification-service',
            handler: 'handler.handler',
            code: lambdaCode ?? lambda.Code.fromAsset('../src/notification-service/dist'),
            environment: {
                NOTIFICATIONS_TABLE_NAME: this.notificationsTable.tableName,
                SES_FROM_ADDRESS: `noreply@spkumarorder.com`,
                SES_REPLY_TO_ADDRESS: `helpdesk@spkumarorder.com`,
            },
        });

        this.notificationLambda = notificationLambdaConstruct.function;

        // Lambda IAM
        this.notificationsTable.grantWriteData(this.notificationLambda);
        this.notificationsTable.grantReadData(this.notificationLambda);

        // Least privilege for SES: Verified identities only.
        this.notificationLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ses:SendEmail'],
                resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
            }),
        );

        // 5. SQS Event Source Mapping
        this.notificationLambda.addEventSource(
            new lambdaEventSources.SqsEventSource(notificationQueue, {
                batchSize: 10,
                // TS won't allow bisectBatchOnError for SQS. The instruction might refer to reportBatchItemFailures.
                reportBatchItemFailures: true,
            })
        );

        // DLQ CloudWatch alarm is built into DeadLetterQueue, but we can also use StandardAlarms
        const alarmTopicArn = `arn:aws:sns:${this.region}:${this.account}:alarm-topic-${envName}`;

        new StandardAlarms(this, 'NotificationAlarms', {
            lambdaFunction: this.notificationLambda,
            serviceName: 'notification-service',
            envName,
            dlq: notificationDlq,
            errorRateThresholdPercent: 1,
            throttleCountThreshold: 0,
            alarmTopicArn,
        });

        // 5.1 SES Bounce Rate Alarm (> 5%)
        const bounceMetric = new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Bounce',
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
        });
        const sendMetric = new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Send',
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
        });
        // We use a safe MathExpression to calculate the bounce rate. If no sends, returns 0.
        const bounceRateMetric = new cloudwatch.MathExpression({
            expression: 'IF(sends > 0, bounces / sends * 100, 0)',
            usingMetrics: {
                bounces: bounceMetric,
                sends: sendMetric,
            },
            period: cdk.Duration.minutes(1),
            label: 'SES Bounce Rate (%)',
        });

        const sesBounceAlarm = new cloudwatch.Alarm(this, 'SesBounceAlarm', {
            alarmName: `ses-bounce-rate-${envName}`,
            alarmDescription: `SES Bounce Rate exceeded 5%`,
            metric: bounceRateMetric,
            threshold: 5,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        sesBounceAlarm.addAlarmAction(new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, 'SesAlarmTopic', alarmTopicArn)));

        cdk.Aspects.of(this).add(
            new TaggingAspect({ env: envName, service: 'notification-service', owner }),
        );

        // -----------------------------------------------------------------------
        // 6. CloudFormation outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'NotificationLambdaFunctionName', {
            value: this.notificationLambda.functionName,
            description: 'Notification Lambda function name',
            exportName: `NotificationServiceStack-${envName}-NotificationLambdaFunctionName`,
        });
    }
}
