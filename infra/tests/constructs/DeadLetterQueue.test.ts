import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { DeadLetterQueue } from '../../constructs/DeadLetterQueue';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeStack(): { app: cdk.App; stack: cdk.Stack } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
        env: { account: '123456789012', region: 'ap-south-1' },
    });
    return { app, stack };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeadLetterQueue', () => {
    describe('SQS queue', () => {
        it('should create an SQS queue with the correct name', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'notification-dlq-dev',
            });
        });

        it('should use SSE-SQS encryption by default', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'inventory',
                envName: 'staging',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::SQS::Queue', {
                SqsManagedSseEnabled: true,
            });
        });

        it('should default message retention to 14 days (1209600 seconds)', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::SQS::Queue', {
                MessageRetentionPeriod: 1209600, // 14 days in seconds
            });
        });

        it('should allow overriding the retention period', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
                retentionPeriod: cdk.Duration.days(7),
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::SQS::Queue', {
                MessageRetentionPeriod: 604800, // 7 days in seconds
            });
        });

        it('should use environment name in the queue name', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'order',
                envName: 'prod',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'order-dlq-prod',
            });
        });
    });

    describe('CloudWatch alarm', () => {
        it('should create a CloudWatch alarm with the correct name', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'notification-dlq-depth-dev',
            });
        });

        it('should alarm on ApproximateNumberOfMessagesVisible metric', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                MetricName: 'ApproximateNumberOfMessagesVisible',
                Namespace: 'AWS/SQS',
            });
        });

        it('should set threshold to 0 (alarm on any message)', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                Threshold: 0,
                ComparisonOperator: 'GreaterThanThreshold',
            });
        });

        it('should treat missing data as NOT_BREACHING', () => {
            const { stack } = makeStack();
            new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                TreatMissingData: 'notBreaching',
            });
        });
    });

    describe('exposed properties', () => {
        it('should expose the queue and alarm properties', () => {
            const { stack } = makeStack();
            const dlq = new DeadLetterQueue(stack, 'TestDLQ', {
                queueName: 'notification',
                envName: 'dev',
            });

            expect(dlq.queue).toBeDefined();
            expect(dlq.alarm).toBeDefined();
        });
    });
});
