import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// StandardAlarms — error-rate, throttle, and DLQ-depth alarms for a Lambda
// ---------------------------------------------------------------------------

export interface StandardAlarmsProps {
    /**
     * The Lambda function to monitor.
     */
    readonly lambdaFunction: lambda.IFunction;

    /**
     * Logical service name used in alarm names and descriptions.
     * e.g. `order-service`, `notification-service`.
     */
    readonly serviceName: string;

    /**
     * Environment name for scoping alarm names.
     * e.g. `dev` | `staging` | `prod`.
     */
    readonly envName: string;

    /**
     * Optional DLQ to create a depth alarm for.
     * When provided a `dlqDepthAlarm` is created on the queue.
     */
    readonly dlq?: sqs.IQueue;

    /**
     * Error rate threshold as a **percentage** (0–100).
     * Alarm fires when Lambda errors / invocations exceed this threshold.
     * Defaults to `1` (1%).
     */
    readonly errorRateThresholdPercent?: number;

    /**
     * Throttle count threshold.
     * Alarm fires when Lambda throttles exceed this value in any 1-minute period.
     * Defaults to `0` (any throttle triggers the alarm).
     */
    readonly throttleCountThreshold?: number;

    /**
     * SNS topic ARN for CloudWatch alarm actions (optional).
     * When provided, alarms will notify this topic.
     */
    readonly alarmTopicArn?: string;
}

/**
 * A set of pre-configured CloudWatch alarms for a Lambda function:
 *
 * 1. **Error-rate alarm** — fires when `errors / invocations > threshold%`.
 * 2. **Throttle alarm** — fires when throttles exceed the threshold count.
 * 3. **DLQ-depth alarm** (optional) — fires when the DLQ has visible messages.
 *
 * @example
 * ```ts
 * const alarms = new StandardAlarms(this, 'OrderAlarms', {
 *   lambdaFunction: orderFn,
 *   serviceName: 'order-service',
 *   envName: 'dev',
 *   dlq: notificationDlq.queue,
 * });
 * ```
 */
export class StandardAlarms extends cdk.Resource {
    /** Alarm for Lambda error rate exceeding the configured threshold. */
    public readonly errorRateAlarm: cloudwatch.Alarm;

    /** Alarm for Lambda throttle count exceeding the configured threshold. */
    public readonly throttleAlarm: cloudwatch.Alarm;

    /**
     * Alarm for DLQ depth.
     * Only defined when `props.dlq` is provided.
     */
    public readonly dlqDepthAlarm?: cloudwatch.Alarm;

    constructor(scope: Construct, id: string, props: StandardAlarmsProps) {
        super(scope, id);

        const {
            lambdaFunction,
            serviceName,
            envName,
            dlq,
            errorRateThresholdPercent = 1,
            throttleCountThreshold = 0,
        } = props;

        // -----------------------------------------------------------------------
        // Error-rate alarm
        // Uses a MathExpression: IF(invocations > 0, errors / invocations * 100, 0)
        // Avoids division-by-zero when there are no invocations.
        // -----------------------------------------------------------------------
        const errorRateMetric = new cloudwatch.MathExpression({
            expression: 'IF(invocations > 0, errors / invocations * 100, 0)',
            usingMetrics: {
                errors: lambdaFunction.metricErrors({
                    period: cdk.Duration.minutes(1),
                    statistic: 'Sum',
                }),
                invocations: lambdaFunction.metricInvocations({
                    period: cdk.Duration.minutes(1),
                    statistic: 'Sum',
                }),
            },
            period: cdk.Duration.minutes(1),
            label: `${serviceName} Error Rate (%)`,
        });

        this.errorRateAlarm = new cloudwatch.Alarm(this, 'ErrorRateAlarm', {
            alarmName: `${serviceName}-error-rate-${envName}`,
            alarmDescription: `${serviceName} Lambda error rate exceeded ${errorRateThresholdPercent}% in ${envName}`,
            metric: errorRateMetric,
            threshold: errorRateThresholdPercent,
            comparisonOperator:
                cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 2,
            datapointsToAlarm: 2,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // -----------------------------------------------------------------------
        // Throttle alarm
        // -----------------------------------------------------------------------
        this.throttleAlarm = new cloudwatch.Alarm(this, 'ThrottleAlarm', {
            alarmName: `${serviceName}-throttles-${envName}`,
            alarmDescription: `${serviceName} Lambda throttled invocations detected in ${envName}`,
            metric: lambdaFunction.metricThrottles({
                period: cdk.Duration.minutes(1),
                statistic: 'Sum',
            }),
            threshold: throttleCountThreshold,
            comparisonOperator:
                cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // -----------------------------------------------------------------------
        // DLQ depth alarm (optional)
        // -----------------------------------------------------------------------
        if (dlq !== undefined) {
            this.dlqDepthAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
                alarmName: `${serviceName}-dlq-depth-${envName}`,
                alarmDescription: `${serviceName} DLQ has visible messages in ${envName} — investigate immediately`,
                metric: dlq.metricApproximateNumberOfMessagesVisible({
                    period: cdk.Duration.minutes(1),
                    statistic: 'Maximum',
                }),
                threshold: 0,
                comparisonOperator:
                    cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                evaluationPeriods: 1,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
        }

        if (props.alarmTopicArn) {
            const sns = require('aws-cdk-lib/aws-sns');
            const cwActions = require('aws-cdk-lib/aws-cloudwatch-actions');
            const topic = sns.Topic.fromTopicArn(this, 'AlarmTopic', props.alarmTopicArn);
            const action = new cwActions.SnsAction(topic);

            this.errorRateAlarm.addAlarmAction(action);
            this.throttleAlarm.addAlarmAction(action);
            if (this.dlqDepthAlarm) {
                this.dlqDepthAlarm.addAlarmAction(action);
            }
        }
    }
}
