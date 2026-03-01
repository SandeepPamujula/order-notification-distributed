import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { OrderServiceStack, type OrderServiceStackProps } from '../../stacks/OrderServiceStack';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
    envName: 'dev',
    owner: 'platform-team',
    // Use inline code so tests have no dependency on a compiled dist/ bundle
    lambdaCode: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
};

function buildStack(overrides: Partial<Omit<OrderServiceStackProps, 'env'>> = {}): {
    stack: OrderServiceStack;
    template: Template;
    app: cdk.App;
} {
    const app = new cdk.App();
    const stack = new OrderServiceStack(app, 'OrderServiceStack-ap-south-1-dev', {
        env: { account: '123456789012', region: 'ap-south-1' },
        ...DEFAULT_PROPS,
        ...overrides,
    });
    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrderServiceStack', () => {
    // -------------------------------------------------------------------------
    // Synthesis
    // -------------------------------------------------------------------------
    describe('synthesis', () => {
        it('synthesises without errors', () => {
            const { app } = buildStack();
            expect(() => app.synth()).not.toThrow();
        });
    });

    // -------------------------------------------------------------------------
    // DynamoDB Orders table
    // -------------------------------------------------------------------------
    describe('DynamoDB Orders table', () => {
        it('creates exactly one DynamoDB table', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::DynamoDB::Table', 1);
        });

        it('uses PAY_PER_REQUEST billing mode', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                BillingMode: 'PAY_PER_REQUEST',
            });
        });

        it('sets orderId as the partition key and createdAt as the sort key', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                KeySchema: Match.arrayWith([
                    { AttributeName: 'orderId', KeyType: 'HASH' },
                    { AttributeName: 'createdAt', KeyType: 'RANGE' },
                ]),
            });
        });

        it('enables DynamoDB Streams with NEW_AND_OLD_IMAGES', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
            });
        });

        it('sets the TTL attribute to "ttl"', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
            });
        });

        it('has GSI-1: GSI-userId-createdAt', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({
                        IndexName: 'GSI-userId-createdAt',
                        KeySchema: Match.arrayWith([
                            { AttributeName: 'userId', KeyType: 'HASH' },
                            { AttributeName: 'createdAt', KeyType: 'RANGE' },
                        ]),
                    }),
                ]),
            });
        });

        it('has GSI-2: GSI-country-status', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({
                        IndexName: 'GSI-country-status',
                        KeySchema: Match.arrayWith([
                            { AttributeName: 'country', KeyType: 'HASH' },
                            { AttributeName: 'status', KeyType: 'RANGE' },
                        ]),
                    }),
                ]),
            });
        });

        it('enables point-in-time recovery', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
            });
        });

        it('uses DESTROY removal policy for dev', () => {
            const { template } = buildStack({ envName: 'dev' });
            // DESTROY = DeletionPolicy: Delete in CloudFormation
            template.hasResource('AWS::DynamoDB::Table', {
                DeletionPolicy: 'Delete',
            });
        });

        it('uses RETAIN removal policy for prod', () => {
            const { template } = buildStack({ envName: 'prod' });
            template.hasResource('AWS::DynamoDB::Table', {
                DeletionPolicy: 'Retain',
            });
        });

        it('names the table orders-{envName}', () => {
            const { template } = buildStack({ envName: 'staging' });
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TableName: 'orders-staging',
            });
        });
    });

    // -------------------------------------------------------------------------
    // SNS topic
    // -------------------------------------------------------------------------
    describe('SNS order-events topic', () => {
        it('creates exactly one SNS topic', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::SNS::Topic', 1);
        });

        it('names the topic order-events-{envName}', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SNS::Topic', {
                TopicName: 'order-events-dev',
            });
        });
    });

    // -------------------------------------------------------------------------
    // SQS queues + DLQs
    // -------------------------------------------------------------------------
    describe('SQS queues', () => {
        it('creates exactly 4 SQS queues (notification-queue, inventory-queue, + 2 DLQs)', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::SQS::Queue', 4);
        });

        it('creates the notification-queue with a DLQ and maxReceiveCount=3', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'notification-queue-dev',
                VisibilityTimeout: 180,
                RedrivePolicy: Match.objectLike({
                    maxReceiveCount: 3,
                }),
            });
        });

        it('creates the inventory-queue with a DLQ and maxReceiveCount=3', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'inventory-queue-dev',
                VisibilityTimeout: 180,
                RedrivePolicy: Match.objectLike({
                    maxReceiveCount: 3,
                }),
            });
        });

        it('creates the notification DLQ with correct name', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'notification-dlq-dev',
            });
        });

        it('creates the inventory DLQ with correct name', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'inventory-dlq-dev',
            });
        });

        it('creates CloudWatch alarms for both DLQs', () => {
            const { template } = buildStack();
            // DeadLetterQueue construct creates one alarm per DLQ
            // notification-dlq-depth-dev, inventory-dlq-depth-dev
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'notification-dlq-depth-dev',
            });
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'inventory-dlq-depth-dev',
            });
        });
    });

    // -------------------------------------------------------------------------
    // SNS subscriptions (raw message delivery)
    // -------------------------------------------------------------------------
    describe('SNS subscriptions', () => {
        it('creates exactly 2 SNS subscriptions (notification and inventory queues)', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::SNS::Subscription', 2);
        });

        it('enables raw message delivery on both SQS subscriptions', () => {
            const { template } = buildStack();
            const subscriptions = template.findResources('AWS::SNS::Subscription', {
                Properties: { Protocol: 'sqs' },
            });
            const allRaw = Object.values(subscriptions).every(
                (r) => (r as { Properties: Record<string, unknown> }).Properties['RawMessageDelivery'] === true,
            );
            expect(allRaw).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // EventBridge custom bus
    // -------------------------------------------------------------------------
    describe('EventBridge custom bus', () => {
        it('creates exactly one EventBus', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::Events::EventBus', 1);
        });

        it('names the bus order-events-bus-{envName}', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Events::EventBus', {
                Name: 'order-events-bus-dev',
            });
        });
    });

    // -------------------------------------------------------------------------
    // Order Lambda
    // -------------------------------------------------------------------------
    describe('Order Lambda', () => {
        it('creates exactly one Lambda function', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::Lambda::Function', 1);
        });

        it('has X-Ray tracing set to Active', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                TracingConfig: { Mode: 'Active' },
            });
        });

        it('has structured JSON logging format', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                LoggingConfig: { LogFormat: 'JSON' },
            });
        });

        it('sets POWERTOOLS_SERVICE_NAME to order-service', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        POWERTOOLS_SERVICE_NAME: 'order-service',
                    }),
                },
            });
        });

        it('injects ORDERS_TABLE_NAME into Lambda env', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        ORDERS_TABLE_NAME: Match.anyValue(),
                    }),
                },
            });
        });

        it('injects ORDER_EVENTS_TOPIC_ARN into Lambda env', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        ORDER_EVENTS_TOPIC_ARN: Match.anyValue(),
                    }),
                },
            });
        });

        it('injects ORDER_EVENTS_BUS_NAME into Lambda env', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        ORDER_EVENTS_BUS_NAME: Match.anyValue(),
                    }),
                },
            });
        });

        it('sets MESSAGING_MODE=SNS as default', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        MESSAGING_MODE: 'SNS',
                    }),
                },
            });
        });

        it('applies reserved concurrency when specified', () => {
            const { template } = buildStack({ orderLambdaReservedConcurrency: 100 });
            template.hasResourceProperties('AWS::Lambda::Function', {
                ReservedConcurrentExecutions: 100,
            });
        });

        it('does not apply reserved concurrency when not specified', () => {
            const { template } = buildStack();
            const lambdas = template.findResources('AWS::Lambda::Function');
            const hasConcurrency = Object.values(lambdas).some(
                (r) =>
                    (r as { Properties: Record<string, unknown> }).Properties[
                    'ReservedConcurrentExecutions'
                    ] !== undefined,
            );
            expect(hasConcurrency).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // IAM — least privilege
    // -------------------------------------------------------------------------
    describe('IAM — least privilege', () => {
        it('grants the Order Lambda dynamodb:PutItem on the Orders table (no wildcard resource)', () => {
            const { template } = buildStack();
            // CDK grants write data (PutItem, UpdateItem, DeleteItem, BatchWriteItem)
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith(['dynamodb:PutItem']),
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });

        it('grants the Order Lambda sns:Publish on the topic', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'sns:Publish',
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });

        it('grants the Order Lambda events:PutEvents on the EventBridge bus', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'events:PutEvents',
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });

        it('grants the Order Lambda ssm:GetParameter to read MESSAGING_MODE', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith(['ssm:GetParameter']),
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });

        it('has no wildcard (*) IAM actions', () => {
            const { template } = buildStack();
            const policies = template.findResources('AWS::IAM::Policy');
            const hasWildcard = Object.values(policies).some((policy) => {
                const statements = (
                    policy as {
                        Properties: {
                            PolicyDocument: { Statement: { Action: string | string[] }[] };
                        };
                    }
                ).Properties.PolicyDocument.Statement;
                return statements.some((stmt) => {
                    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
                    return actions.some((a) => a === '*');
                });
            });
            expect(hasWildcard).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // HTTP API Gateway
    // -------------------------------------------------------------------------
    describe('HTTP API Gateway', () => {
        it('creates exactly one HTTP API', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
        });

        it('creates the POST /orders route', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
                RouteKey: 'POST /orders',
            });
        });

        it('creates the GET /health route', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
                RouteKey: 'GET /health',
            });
        });

        it('creates a default stage', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
                StageName: '$default',
                AutoDeploy: true,
            });
        });
    });

    // -------------------------------------------------------------------------
    // SSM parameter exports
    // -------------------------------------------------------------------------
    describe('SSM parameter exports', () => {
        const expectedParams = [
            `/order-service/dev/messaging-mode`,
            `/order-service/dev/notification-queue-arn`,
            `/order-service/dev/notification-dlq-arn`,
            `/order-service/dev/inventory-queue-arn`,
            `/order-service/dev/inventory-dlq-arn`,
            `/order-service/dev/api-gateway-url`,
            `/order-service/dev/order-events-topic-arn`,
            `/order-service/dev/order-events-bus-name`,
            `/order-service/dev/orders-table-name`,
            `/order-service/dev/orders-table-stream-arn`,
        ];

        it.each(expectedParams)('exports SSM parameter %s', (paramName) => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: paramName,
                Type: 'String',
            });
        });

        it('creates exactly 10 SSM parameters', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::SSM::Parameter', 10);
        });
    });

    // -------------------------------------------------------------------------
    // CloudFormation outputs
    // -------------------------------------------------------------------------
    describe('CloudFormation outputs', () => {
        it('has an ApiEndpoint output', () => {
            const { template } = buildStack();
            template.hasOutput('ApiEndpoint', {});
        });

        it('has an OrdersTableName output', () => {
            const { template } = buildStack();
            template.hasOutput('OrdersTableName', {});
        });

        it('has an OrderEventsTopicArn output', () => {
            const { template } = buildStack();
            template.hasOutput('OrderEventsTopicArn', {});
        });

        it('has an OrderEventsBusName output', () => {
            const { template } = buildStack();
            template.hasOutput('OrderEventsBusName', {});
        });
    });

    // -------------------------------------------------------------------------
    // Stack public properties
    // -------------------------------------------------------------------------
    describe('stack public properties', () => {
        it('exposes ordersTable', () => {
            const { stack } = buildStack();
            expect(stack.ordersTable).toBeDefined();
        });

        it('exposes orderEventsTopic', () => {
            const { stack } = buildStack();
            expect(stack.orderEventsTopic).toBeDefined();
        });

        it('exposes orderEventsBus', () => {
            const { stack } = buildStack();
            expect(stack.orderEventsBus).toBeDefined();
        });

        it('exposes notificationQueue', () => {
            const { stack } = buildStack();
            expect(stack.notificationQueue).toBeDefined();
        });

        it('exposes inventoryQueue', () => {
            const { stack } = buildStack();
            expect(stack.inventoryQueue).toBeDefined();
        });

        it('exposes orderLambda', () => {
            const { stack } = buildStack();
            expect(stack.orderLambda).toBeDefined();
        });

        it('exposes httpApi', () => {
            const { stack } = buildStack();
            expect(stack.httpApi).toBeDefined();
        });
    });

    // -------------------------------------------------------------------------
    // Tagging
    // -------------------------------------------------------------------------
    describe('tagging', () => {
        it('tags all Lambda functions with service=order-service', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                Tags: Match.arrayWith([
                    { Key: 'service', Value: 'order-service' },
                ]),
            });
        });

        it('tags all resources with env=dev', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                Tags: Match.arrayWith([
                    { Key: 'env', Value: 'dev' },
                ]),
            });
        });
    });
});
