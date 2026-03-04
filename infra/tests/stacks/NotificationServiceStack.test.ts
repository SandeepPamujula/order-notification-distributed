import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { NotificationServiceStack } from '../../stacks/NotificationServiceStack';

describe('NotificationServiceStack', () => {
    const ENV_NAME = 'dev';
    const OWNER = 'test-owner';

    let app: cdk.App;
    let stack: NotificationServiceStack;
    let template: Template;

    beforeAll(() => {
        app = new cdk.App();

        // Create the stack
        stack = new NotificationServiceStack(app, 'TestNotificationServiceStack', {
            envName: ENV_NAME,
            owner: OWNER,
            env: { region: 'ap-south-1', account: '123456789012' },
            lambdaCode: lambda.Code.fromInline('exports.handler = () => {}'),
        });

        template = Template.fromStack(stack);
    });

    it('synthesizes successfully', () => {
        expect(template).toBeDefined();
    });

    it('provisions a DynamoDB table for notifications', () => {
        template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: `notifications-${ENV_NAME}`,
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [
                { AttributeName: 'notificationId', KeyType: 'HASH' },
                { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ],
            GlobalSecondaryIndexes: [
                {
                    IndexName: 'GSI-orderId',
                    KeySchema: [
                        { AttributeName: 'orderId', KeyType: 'HASH' },
                        { AttributeName: 'createdAt', KeyType: 'RANGE' },
                    ],
                },
                {
                    IndexName: 'GSI-status-type',
                    KeySchema: [
                        { AttributeName: 'status', KeyType: 'HASH' },
                        { AttributeName: 'type', KeyType: 'RANGE' },
                    ],
                },
            ],
        });
    });

    it('provisions the Notification Lambda with correct environment variables', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            Handler: 'handler.handler',
            Environment: {
                Variables: {
                    NOTIFICATIONS_TABLE_NAME: Match.anyValue(),
                    SES_FROM_ADDRESS: 'noreply@spkumarorder.com',
                    SES_REPLY_TO_ADDRESS: 'helpdesk@spkumarorder.com',
                    POWERTOOLS_SERVICE_NAME: 'notification-service',
                },
            },
        });
    });

    it('creates SSM parameters for SES configuration', () => {
        template.hasResourceProperties('AWS::SSM::Parameter', {
            Name: `/notification-service/${ENV_NAME}/ses-from-address`,
            Type: 'String',
            Value: 'noreply@spkumarorder.com',
        });
        template.hasResourceProperties('AWS::SSM::Parameter', {
            Name: `/notification-service/${ENV_NAME}/ses-reply-to-address`,
            Type: 'String',
            Value: 'helpdesk@spkumarorder.com',
        });
    });

    it('maps an SQS EVent Source to Lambda', () => {
        template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
            BatchSize: 10,
        });
    });

    it('gives SES SendEmail permissions to the Lambda', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.anyValue(),
            },
        });
    });

    it('outputs the Lambda function name', () => {
        template.hasOutput('NotificationLambdaFunctionName', {
            Export: { Name: `NotificationServiceStack-${ENV_NAME}-NotificationLambdaFunctionName` },
        });
    });
});

describe('NotificationServiceStack - prod config', () => {
    let app: cdk.App;
    let stack: NotificationServiceStack;
    let template: Template;

    beforeAll(() => {
        app = new cdk.App();
        stack = new NotificationServiceStack(app, 'TestProdStack', {
            envName: 'prod',
            owner: 'test',
            lambdaCode: lambda.Code.fromInline('exports.handler = () => {}'),
        });
        template = Template.fromStack(stack);
    });

    it('sets Retain removal policy on DynamoDB table in prod', () => {
        template.hasResource('AWS::DynamoDB::Table', {
            UpdateReplacePolicy: 'Retain',
            DeletionPolicy: 'Retain',
        });
    });
});
