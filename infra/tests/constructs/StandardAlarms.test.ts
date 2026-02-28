import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';

import { StandardAlarms } from '../../constructs/StandardAlarms';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeStack(): { app: cdk.App; stack: cdk.Stack } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
        env: { account: '123456789012', region: 'ap-south-1' },
    });
    return { app, stack };
}

function makeFunction(stack: cdk.Stack): lambda.Function {
    return new lambda.Function(stack, 'TestFn', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'handler.handler',
        code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StandardAlarms', () => {
    describe('error-rate alarm', () => {
        it('should create an error-rate alarm with the correct name', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-error-rate-dev',
            });
        });

        it('should default error-rate threshold to 1%', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            // The error rate alarm uses a MathExpression metric (AWS::CloudWatch::Alarm with Metrics array)
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-error-rate-dev',
                Threshold: 1,
                ComparisonOperator: 'GreaterThanThreshold',
            });
        });

        it('should allow overriding the error-rate threshold', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
                errorRateThresholdPercent: 5,
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-error-rate-dev',
                Threshold: 5,
            });
        });

        it('should evaluate over 2 periods for the error-rate alarm', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-error-rate-dev',
                EvaluationPeriods: 2,
                DatapointsToAlarm: 2,
            });
        });
    });

    describe('throttle alarm', () => {
        it('should create a throttle alarm with the correct name', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'notification-service',
                envName: 'staging',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'notification-service-throttles-staging',
            });
        });

        it('should default throttle threshold to 0 (any throttle triggers alarm)', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-throttles-dev',
                Threshold: 0,
                ComparisonOperator: 'GreaterThanThreshold',
            });
        });

        it('should allow overriding the throttle threshold', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
                throttleCountThreshold: 10,
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-throttles-dev',
                Threshold: 10,
            });
        });

        it('should use the Throttles metric', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-throttles-dev',
                MetricName: 'Throttles',
                Namespace: 'AWS/Lambda',
            });
        });
    });

    describe('DLQ depth alarm (optional)', () => {
        it('should NOT create a DLQ depth alarm when dlq is not provided', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            // Only 2 alarms should exist (error-rate and throttle)
            template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
        });

        it('should create a DLQ depth alarm when a queue is provided', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);
            const queue = new sqs.Queue(stack, 'TestDLQ', {
                queueName: 'test-dlq',
            });

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
                dlq: queue,
            });

            const template = Template.fromStack(stack);
            // 3 alarms: error-rate, throttle, dlq-depth
            template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
        });

        it('should name the DLQ depth alarm with serviceName and envName', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);
            const queue = new sqs.Queue(stack, 'TestDLQ', {
                queueName: 'test-dlq',
            });

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
                dlq: queue,
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-dlq-depth-dev',
                Threshold: 0,
                ComparisonOperator: 'GreaterThanThreshold',
            });
        });

        it('should use ApproximateNumberOfMessagesVisible for the DLQ alarm', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);
            const queue = new sqs.Queue(stack, 'TestDLQ');

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
                dlq: queue,
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'order-service-dlq-depth-dev',
                MetricName: 'ApproximateNumberOfMessagesVisible',
                Namespace: 'AWS/SQS',
            });
        });
    });

    describe('missing data treatment', () => {
        it('should treat missing data as NOT_BREACHING for all alarms', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            // Both alarms should have notBreaching
            template.allResourcesProperties('AWS::CloudWatch::Alarm', {
                TreatMissingData: Match.anyValue(),
            });
            const alarms = template.findResources('AWS::CloudWatch::Alarm');
            const alarmValues = Object.values(alarms);
            expect(alarmValues.length).toBe(2);
            for (const alarm of alarmValues) {
                expect(
                    (alarm as { Properties: Record<string, unknown> }).Properties
                        .TreatMissingData,
                ).toBe('notBreaching');
            }
        });
    });

    describe('exposed properties', () => {
        it('should expose errorRateAlarm and throttleAlarm', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);

            const alarms = new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
            });

            expect(alarms.errorRateAlarm).toBeDefined();
            expect(alarms.throttleAlarm).toBeDefined();
            expect(alarms.dlqDepthAlarm).toBeUndefined();
        });

        it('should expose dlqDepthAlarm when dlq is provided', () => {
            const { stack } = makeStack();
            const fn = makeFunction(stack);
            const queue = new sqs.Queue(stack, 'TestDLQ');

            const alarms = new StandardAlarms(stack, 'Alarms', {
                lambdaFunction: fn,
                serviceName: 'order-service',
                envName: 'dev',
                dlq: queue,
            });

            expect(alarms.dlqDepthAlarm).toBeDefined();
        });
    });
});
