import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import { SharedStack } from '../../stacks/SharedStack';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
    envName: 'dev',
    domainName: 'spkumarorder.com',
    primaryApiGatewayDomainName: 'abc123.execute-api.ap-south-1.amazonaws.com',
    secondaryApiGatewayDomainName: 'xyz789.execute-api.us-east-1.amazonaws.com',
    owner: 'platform-team',
};

function buildStack(overrides: Partial<typeof DEFAULT_PROPS> = {}): {
    stack: SharedStack;
    template: Template;
    app: cdk.App;
} {
    const app = new cdk.App();
    const stack = new SharedStack(app, 'SharedStack-us-east-1-dev', {
        env: { account: '123456789012', region: 'us-east-1' },
        ...DEFAULT_PROPS,
        ...overrides,
    });
    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedStack', () => {
    describe('synthesis', () => {
        it('synthesises without errors', () => {
            const { app } = buildStack();
            expect(() => app.synth()).not.toThrow();
        });
    });

    // -------------------------------------------------------------------------
    // Route 53 hosted zone
    // -------------------------------------------------------------------------
    describe('Route 53 hosted zone', () => {
        it('creates a public hosted zone for api.spkumarorder.com', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::HostedZone', {
                Name: 'api.spkumarorder.com.',
            });
        });

        it('creates exactly one hosted zone', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::Route53::HostedZone', 1);
        });

        it('uses the correct domainName to derive the api subdomain', () => {
            const { template } = buildStack({ domainName: 'example.io' });
            template.hasResourceProperties('AWS::Route53::HostedZone', {
                Name: 'api.example.io.',
            });
        });
    });

    // -------------------------------------------------------------------------
    // Route 53 health checks
    // -------------------------------------------------------------------------
    describe('Route 53 health checks', () => {
        it('creates exactly two health checks (primary and secondary)', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::Route53::HealthCheck', 2);
        });

        it('configures the primary (ap-south-1) health check correctly', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::HealthCheck', {
                HealthCheckConfig: Match.objectLike({
                    Type: 'HTTPS',
                    FullyQualifiedDomainName: DEFAULT_PROPS.primaryApiGatewayDomainName,
                    ResourcePath: '/health',
                    Port: 443,
                    RequestInterval: 30,
                    FailureThreshold: 3,
                    EnableSNI: true,
                }),
            });
        });

        it('configures the secondary (us-east-1) health check correctly', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::HealthCheck', {
                HealthCheckConfig: Match.objectLike({
                    Type: 'HTTPS',
                    FullyQualifiedDomainName: DEFAULT_PROPS.secondaryApiGatewayDomainName,
                    ResourcePath: '/health',
                    Port: 443,
                    RequestInterval: 30,
                    FailureThreshold: 3,
                    EnableSNI: true,
                }),
            });
        });

        it('tags the primary health check with env=dev and region=ap-south-1', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::HealthCheck', {
                HealthCheckTags: Match.arrayWith([
                    { Key: 'env', Value: 'dev' },
                    { Key: 'region', Value: 'ap-south-1' },
                    { Key: 'service', Value: 'shared' },
                ]),
            });
        });

        it('tags the secondary health check with env=dev and region=us-east-1', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::HealthCheck', {
                HealthCheckTags: Match.arrayWith([
                    { Key: 'env', Value: 'dev' },
                    { Key: 'region', Value: 'us-east-1' },
                    { Key: 'service', Value: 'shared' },
                ]),
            });
        });
    });

    // -------------------------------------------------------------------------
    // Route 53 CNAME latency-based records
    // -------------------------------------------------------------------------
    describe('latency-based routing records', () => {
        it('creates exactly two CNAME records', () => {
            const { template } = buildStack();
            const records = template.findResources('AWS::Route53::RecordSet', {
                Properties: { Type: 'CNAME' },
            });
            expect(Object.keys(records)).toHaveLength(2);
        });

        it('creates the primary latency record targeting ap-south-1', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Region: 'ap-south-1',
                Type: 'CNAME',
                ResourceRecords: [DEFAULT_PROPS.primaryApiGatewayDomainName],
                SetIdentifier: 'dev-primary-ap-south-1',
                TTL: '60',
            });
        });

        it('creates the secondary latency record targeting us-east-1', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Region: 'us-east-1',
                Type: 'CNAME',
                ResourceRecords: [DEFAULT_PROPS.secondaryApiGatewayDomainName],
                SetIdentifier: 'dev-secondary-us-east-1',
                TTL: '60',
            });
        });

        it('associates each routing record with its health check', () => {
            const { template } = buildStack();
            // Both CNAME records must have a HealthCheckId
            const records = template.findResources('AWS::Route53::RecordSet', {
                Properties: { Type: 'CNAME' },
            });
            const allHaveHealthCheck = Object.values(records).every(
                (r) => (r as { Properties: Record<string, unknown> }).Properties['HealthCheckId'] !== undefined,
            );
            expect(allHaveHealthCheck).toBe(true);
        });

        it('points records at the api subdomain', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Name: 'api.spkumarorder.com.',
                Region: 'ap-south-1',
            });
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Name: 'api.spkumarorder.com.',
                Region: 'us-east-1',
            });
        });
    });

    // -------------------------------------------------------------------------
    // SSM parameters
    // -------------------------------------------------------------------------
    describe('SSM parameters', () => {
        it('exports the hosted zone ID as an SSM parameter', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/dev/hosted-zone-id',
                Type: 'String',
            });
        });

        it('exports the hosted zone ARN as an SSM parameter', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/dev/hosted-zone-arn',
                Type: 'String',
            });
        });

        it('exports the primary health check ID as an SSM parameter', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/dev/primary-health-check-id',
                Type: 'String',
            });
        });

        it('exports the secondary health check ID as an SSM parameter', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/dev/secondary-health-check-id',
                Type: 'String',
            });
        });

        it('exports the api subdomain as an SSM parameter', () => {
            const { template } = buildStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/dev/api-subdomain',
                Value: 'api.spkumarorder.com',
                Type: 'String',
            });
        });

        it('creates exactly 5 SSM parameters', () => {
            const { template } = buildStack();
            template.resourceCountIs('AWS::SSM::Parameter', 5);
        });

        it('uses the correct envName in the SSM parameter path', () => {
            const { template } = buildStack({ envName: 'staging' });
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/staging/hosted-zone-id',
            });
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/staging/primary-health-check-id',
            });
        });
    });

    // -------------------------------------------------------------------------
    // CloudFormation outputs
    // -------------------------------------------------------------------------
    describe('CloudFormation outputs', () => {
        it('has a HostedZoneId output', () => {
            const { template } = buildStack();
            template.hasOutput('HostedZoneId', {});
        });

        it('has a HostedZoneArn output', () => {
            const { template } = buildStack();
            template.hasOutput('HostedZoneArn', {});
        });

        it('has a PrimaryHealthCheckId output', () => {
            const { template } = buildStack();
            template.hasOutput('PrimaryHealthCheckId', {});
        });

        it('has a SecondaryHealthCheckId output', () => {
            const { template } = buildStack();
            template.hasOutput('SecondaryHealthCheckId', {});
        });

        it('has an ApiSubdomain output with the correct value', () => {
            const { template } = buildStack();
            template.hasOutput('ApiSubdomain', {
                Value: 'api.spkumarorder.com',
            });
        });

        it('has a NameServers output', () => {
            const { template } = buildStack();
            template.hasOutput('NameServers', {});
        });

        it('exports HostedZoneId with the correct export name', () => {
            const { template } = buildStack();
            template.hasOutput('HostedZoneId', {
                Export: { Name: 'SharedStack-dev-HostedZoneId' },
            });
        });
    });

    // -------------------------------------------------------------------------
    // Stack instance properties
    // -------------------------------------------------------------------------
    describe('stack properties', () => {
        it('exposes hostedZone as a public property', () => {
            const { stack } = buildStack();
            expect(stack.hostedZone).toBeDefined();
        });

        it('exposes primaryHealthCheck as a public property', () => {
            const { stack } = buildStack();
            expect(stack.primaryHealthCheck).toBeDefined();
        });

        it('exposes secondaryHealthCheck as a public property', () => {
            const { stack } = buildStack();
            expect(stack.secondaryHealthCheck).toBeDefined();
        });
    });
});
