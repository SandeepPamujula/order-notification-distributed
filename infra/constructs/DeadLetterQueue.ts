import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// DeadLetterQueue — SQS DLQ with a CloudWatch alarm on visible message count
// ---------------------------------------------------------------------------

export interface DeadLetterQueueProps {
    /**
     * Logical name suffix for the queue (e.g. `notification`, `inventory`).
     * The physical queue name will be `<queueName>-dlq-<env>`.
     */
    readonly queueName: string;

    /**
     * Environment name injected into the queue name and alarm for uniqueness.
     * e.g. `dev` | `staging` | `prod`.
     */
    readonly envName: string;

    /**
     * Retention period for messages in the DLQ.
     * Defaults to 14 days (maximum SQS retention).
     */
    readonly retentionPeriod?: cdk.Duration;

    /**
     * SNS topic ARN for CloudWatch alarm actions (optional).
     * When provided, the `ApproximateNumberOfMessagesVisible > 0` alarm will
     * notify this topic.
     */
    readonly alarmTopicArn?: string;
}

/**
 * A dead-letter SQS queue with an associated CloudWatch alarm that fires
 * whenever at least one message is visible in the queue.
 *
 * @example
 * ```ts
 * const dlq = new DeadLetterQueue(this, 'NotificationDLQ', {
 *   queueName: 'notification',
 *   envName: 'dev',
 * });
 *
 * // Use as a DLQ for a source queue:
 * const sourceQueue = new sqs.Queue(this, 'NotificationQueue', {
 *   deadLetterQueue: {
 *     queue: dlq.queue,
 *     maxReceiveCount: 3,
 *   },
 * });
 * ```
 */
export class DeadLetterQueue extends cdk.Resource {
    /** The underlying SQS queue resource. */
    public readonly queue: sqs.Queue;

    /** The CloudWatch alarm that fires when messages are visible in the DLQ. */
    public readonly alarm: cloudwatch.Alarm;

    constructor(scope: Construct, id: string, props: DeadLetterQueueProps) {
        super(scope, id);

        const {
            queueName,
            envName,
            retentionPeriod = cdk.Duration.days(14),
        } = props;

        // -----------------------------------------------------------------------
        // DLQ — Server-side encryption with SQS-managed keys (SSE-SQS)
        // -----------------------------------------------------------------------
        this.queue = new sqs.Queue(this, 'Queue', {
            queueName: `${queueName}-dlq-${envName}`,
            retentionPeriod,
            // SSE-SQS: no extra cost, protects data at rest
            encryption: sqs.QueueEncryption.SQS_MANAGED,
        });

        // -----------------------------------------------------------------------
        // CloudWatch alarm — alert whenever any message lands in the DLQ
        // -----------------------------------------------------------------------
        this.alarm = new cloudwatch.Alarm(this, 'DepthAlarm', {
            alarmName: `${queueName}-dlq-depth-${envName}`,
            alarmDescription: `DLQ ${queueName}-dlq-${envName} has messages — investigate immediately`,
            metric: this.queue.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            threshold: 0,
            comparisonOperator:
                cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        if (props.alarmTopicArn) {
            // Lazy load SNS and CloudWatchActions since they are heavy imports if unused
            const sns = require('aws-cdk-lib/aws-sns');
            const cwActions = require('aws-cdk-lib/aws-cloudwatch-actions');
            const topic = sns.Topic.fromTopicArn(this, 'AlarmTopic', props.alarmTopicArn);
            this.alarm.addAlarmAction(new cwActions.SnsAction(topic));
        }
    }
}
