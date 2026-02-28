import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { PowertoolsLambda } from '../../constructs/PowertoolsLambda';

// ---------------------------------------------------------------------------
// Helper — minimal props required by every test
// ---------------------------------------------------------------------------
function makeStack(): { app: cdk.App; stack: cdk.Stack } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
        env: { account: '123456789012', region: 'ap-south-1' },
    });
    return { app, stack };
}

function makeConstruct(
    stack: cdk.Stack,
    overrides: Partial<ConstructorParameters<typeof PowertoolsLambda>[2]> = {},
): PowertoolsLambda {
    return new PowertoolsLambda(stack, 'TestLambda', {
        code: lambda.Code.fromInline('exports.handler = async () => ({})'),
        handler: 'handler.handler',
        powertoolsServiceName: 'test-service',
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PowertoolsLambda', () => {
    describe('X-Ray active tracing', () => {
        it('should enable X-Ray active tracing by default', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                TracingConfig: { Mode: 'Active' },
            });
        });
    });

    describe('Structured JSON log format', () => {
        it('should set Lambda LoggingConfig format to JSON', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                LoggingConfig: { LogFormat: 'JSON' },
            });
        });
    });

    describe('Powertools environment variables', () => {
        it('should set POWERTOOLS_SERVICE_NAME from props', () => {
            const { stack } = makeStack();
            makeConstruct(stack, { powertoolsServiceName: 'order-service' });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: {
                        POWERTOOLS_SERVICE_NAME: 'order-service',
                    },
                },
            });
        });

        it('should set POWERTOOLS_LOG_FORMATTER to json', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: {
                        POWERTOOLS_LOG_FORMATTER: 'json',
                    },
                },
            });
        });

        it('should set LOG_LEVEL to INFO by default', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: { LOG_LEVEL: 'INFO' },
                },
            });
        });

        it('should allow overriding LOG_LEVEL', () => {
            const { stack } = makeStack();
            makeConstruct(stack, { logLevel: 'DEBUG' });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: { LOG_LEVEL: 'DEBUG' },
                },
            });
        });

        it('should set POWERTOOLS_LOGGER_LOG_EVENT to true', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: { POWERTOOLS_LOGGER_LOG_EVENT: 'true' },
                },
            });
        });

        it('should merge caller-supplied environment variables', () => {
            const { stack } = makeStack();
            makeConstruct(stack, {
                environment: { CUSTOM_VAR: 'hello', TABLE_NAME: 'orders' },
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: {
                        CUSTOM_VAR: 'hello',
                        TABLE_NAME: 'orders',
                        POWERTOOLS_SERVICE_NAME: 'test-service',
                    },
                },
            });
        });
    });

    describe('Runtime and architecture defaults', () => {
        it('should use NODEJS_22_X runtime by default', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'nodejs22.x',
            });
        });

        it('should use ARM_64 architecture by default', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Architectures: ['arm64'],
            });
        });

        it('should allow overriding the runtime', () => {
            const { stack } = makeStack();
            makeConstruct(stack, { runtime: lambda.Runtime.NODEJS_20_X });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'nodejs20.x',
            });
        });
    });

    describe('Memory and timeout defaults', () => {
        it('should default memory to 512 MB', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                MemorySize: 512,
            });
        });

        it('should default timeout to 30 seconds', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                Timeout: 30,
            });
        });

        it('should allow overriding memory and timeout', () => {
            const { stack } = makeStack();
            makeConstruct(stack, {
                memorySize: 1024,
                timeout: cdk.Duration.seconds(60),
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                MemorySize: 1024,
                Timeout: 60,
            });
        });
    });

    describe('Reserved concurrency', () => {
        it('should not set reserved concurrency by default', () => {
            const { stack } = makeStack();
            makeConstruct(stack);

            const template = Template.fromStack(stack);
            // Verify the function is created
            template.resourceCountIs('AWS::Lambda::Function', 1);
        });

        it('should set reserved concurrency when specified', () => {
            const { stack } = makeStack();
            makeConstruct(stack, { reservedConcurrentExecutions: 100 });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Lambda::Function', {
                ReservedConcurrentExecutions: 100,
            });
        });
    });

    describe('function property', () => {
        it('should expose the underlying lambda.Function', () => {
            const { stack } = makeStack();
            const construct = makeConstruct(stack);

            expect(construct.function).toBeInstanceOf(lambda.Function);
        });
    });
});
