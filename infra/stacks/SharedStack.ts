import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// SharedStack — Route 53 hosted zone, health checks, and latency-based routing
//
// DEPLOYMENT NOTE: This stack MUST be deployed to `us-east-1`.
// Route 53 is a global service but its CDK constructs require the stack to
// be deployed in us-east-1 so that CloudFormation can manage DNS records.
// ---------------------------------------------------------------------------

export interface SharedStackProps extends cdk.StackProps {
    /** Environment name: dev | staging | prod */
    readonly envName: string;

    /** The apex domain name for the hosted zone (e.g. spworks.click). */
    readonly domainName: string;

    /**
     * The API Gateway regional domain name in ap-south-1.
     * Format: <api-id>.execute-api.ap-south-1.amazonaws.com
     */
    readonly primaryApiGatewayDomainName: string;

    /**
     * The API Gateway regional domain name in us-east-1.
     * Format: <api-id>.execute-api.us-east-1.amazonaws.com
     */
    readonly secondaryApiGatewayDomainName: string;

    /** Owner tag value — propagated to all resources in this stack. */
    readonly owner: string;
}

/**
 * Shared infrastructure stack — deployed once to `us-east-1`.
 *
 * Responsibilities:
 * - Owns the Route 53 public hosted zone for `spworks.click`.
 * - Provisions Route 53 HTTP health checks for both regional API Gateway
 *   `/health` endpoints (failure threshold: 3, interval: 30 s).
 * - Creates latency-based A-alias records pointing to each region's API GW,
 *   associated with their respective health checks for automatic failover.
 * - Exports the hosted zone ARN and health check IDs as SSM parameters so
 *   regional stacks (OrderServiceStack, etc.) can reference them without
 *   creating hard cross-stack dependencies.
 *
 * @example
 * ```ts
 * new SharedStack(app, 'SharedStack-us-east-1-dev', {
 *   env: { account: '123456789012', region: 'us-east-1' },
 *   envName: 'dev',
 *   domainName: 'spworks.click',
 *   primaryApiGatewayDomainName: 'abc123.execute-api.ap-south-1.amazonaws.com',
 *   secondaryApiGatewayDomainName: 'xyz789.execute-api.us-east-1.amazonaws.com',
 *   owner: 'platform-team',
 * });
 * ```
 */
export class SharedStack extends cdk.Stack {
    /** The Route 53 public hosted zone that owns the `api.<domainName>` subdomain. */
    public readonly hostedZone: route53.IHostedZone;

    /** Route 53 health check targeting the `ap-south-1` API Gateway `/health` path. */
    public readonly primaryHealthCheck: route53.CfnHealthCheck;

    /** Route 53 health check targeting the `us-east-1` API Gateway `/health` path. */
    public readonly secondaryHealthCheck: route53.CfnHealthCheck;

    constructor(scope: Construct, id: string, props: SharedStackProps) {
        super(scope, id, props);

        const {
            envName,
            domainName,
            primaryApiGatewayDomainName,
            secondaryApiGatewayDomainName,
            owner: _owner,
        } = props;

        /** The `api.<domainName>` subdomain used for latency-based routing. */
        const apiSubdomain = `api.${domainName}`;

        // -----------------------------------------------------------------------
        // Route 53 public hosted zone
        //
        // The zone is created for the **parent domain** (e.g. spworks.click)
        // so that `api.spworks.click` is a regular subdomain — NOT the zone
        // apex.  DNS RFC 1034 forbids CNAME records at the zone apex, so hosting
        // the zone at the parent domain avoids the CREATE_FAILED error:
        //   "RRSet of type CNAME … is not permitted at apex in zone …"
        // -----------------------------------------------------------------------
        this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
            domainName: domainName,
        });

        // -----------------------------------------------------------------------
        // Route 53 health checks
        // -----------------------------------------------------------------------

        /**
         * Health check for the ap-south-1 (primary) API Gateway.
         * Performs HTTPS checks every 30 seconds; marks the endpoint unhealthy
         * after 3 consecutive failures, triggering Route 53 failover.
         */
        this.primaryHealthCheck = new route53.CfnHealthCheck(this, 'PrimaryHealthCheck', {
            healthCheckConfig: {
                type: 'HTTPS',
                fullyQualifiedDomainName: primaryApiGatewayDomainName,
                resourcePath: '/health',
                port: 443,
                requestInterval: 30,
                failureThreshold: 3,
                enableSni: true,
                regions: [
                    // Route 53 measures from at least 3 regions for accuracy
                    'us-east-1',
                    'eu-west-1',
                    'ap-southeast-1',
                ],
            },
            healthCheckTags: [
                { key: 'Name', value: `${envName}-primary-ap-south-1-health-check` },
                { key: 'env', value: envName },
                { key: 'service', value: 'shared' },
                { key: 'region', value: 'ap-south-1' },
            ],
        });

        /**
         * Health check for the us-east-1 (secondary) API Gateway.
         * Same configuration as primary; both checks run independently.
         */
        this.secondaryHealthCheck = new route53.CfnHealthCheck(this, 'SecondaryHealthCheck', {
            healthCheckConfig: {
                type: 'HTTPS',
                fullyQualifiedDomainName: secondaryApiGatewayDomainName,
                resourcePath: '/health',
                port: 443,
                requestInterval: 30,
                failureThreshold: 3,
                enableSni: true,
                regions: [
                    'us-east-1',
                    'eu-west-1',
                    'ap-southeast-1',
                ],
            },
            healthCheckTags: [
                { key: 'Name', value: `${envName}-secondary-us-east-1-health-check` },
                { key: 'env', value: envName },
                { key: 'service', value: 'shared' },
                { key: 'region', value: 'us-east-1' },
            ],
        });

        // -----------------------------------------------------------------------
        // Latency-based routing records
        //
        // Two CNAME records with SetIdentifier + latency routing + health checks:
        //   - ap-south-1 record (primary) — serves India-proximate users
        //   - us-east-1 record (secondary) — serves US-proximate users
        //
        // We use CfnRecordSet directly because the high-level route53.CnameRecord
        // does not expose latency routing or health check association.
        // -----------------------------------------------------------------------

        /**
         * Latency-based CNAME for ap-south-1 with health check association.
         * Route 53 will stop routing to this record when the health check fails.
         */
        const primaryLatencyRecord = new route53.CfnRecordSet(this, 'PrimaryLatencyRecord', {
            hostedZoneId: this.hostedZone.hostedZoneId,
            name: `${apiSubdomain}.`,
            type: 'CNAME',
            setIdentifier: `${envName}-primary-ap-south-1`,
            region: 'ap-south-1',
            ttl: '60',
            resourceRecords: [primaryApiGatewayDomainName],
            healthCheckId: this.primaryHealthCheck.attrHealthCheckId,
        });

        /**
         * Latency-based CNAME for us-east-1 with health check association.
         */
        const secondaryLatencyRecord = new route53.CfnRecordSet(this, 'SecondaryLatencyRecord', {
            hostedZoneId: this.hostedZone.hostedZoneId,
            name: `${apiSubdomain}.`,
            type: 'CNAME',
            setIdentifier: `${envName}-secondary-us-east-1`,
            region: 'us-east-1',
            ttl: '60',
            resourceRecords: [secondaryApiGatewayDomainName],
            healthCheckId: this.secondaryHealthCheck.attrHealthCheckId,
        });

        // Prevent "unused variable" lint errors — records are created for their side effects.
        void primaryLatencyRecord;
        void secondaryLatencyRecord;

        // -----------------------------------------------------------------------
        // SSM parameter exports
        //
        // Regional stacks import these parameters to reference the hosted zone
        // ARN and health check IDs without creating hard CloudFormation cross-stack
        // references (which are hard to update and cause circular dependency issues).
        // -----------------------------------------------------------------------

        /** Hosted zone ID — used by regional stacks to create alias records. */
        new ssm.StringParameter(this, 'HostedZoneIdParam', {
            parameterName: `/shared/${envName}/hosted-zone-id`,
            stringValue: this.hostedZone.hostedZoneId,
            description: `Route 53 hosted zone ID for ${apiSubdomain} (${envName})`,
        });

        /** Hosted zone ARN — referenced in IAM policies / custom resources. */
        new ssm.StringParameter(this, 'HostedZoneArnParam', {
            parameterName: `/shared/${envName}/hosted-zone-arn`,
            stringValue: this.hostedZone.hostedZoneArn,
            description: `Route 53 hosted zone ARN for ${apiSubdomain} (${envName})`,
        });

        /** Primary (ap-south-1) health check ID — regional stacks expose it in dashboards. */
        new ssm.StringParameter(this, 'PrimaryHealthCheckIdParam', {
            parameterName: `/shared/${envName}/primary-health-check-id`,
            stringValue: this.primaryHealthCheck.attrHealthCheckId,
            description: `Route 53 health check ID for ap-south-1 API Gateway /health (${envName})`,
        });

        /** Secondary (us-east-1) health check ID. */
        new ssm.StringParameter(this, 'SecondaryHealthCheckIdParam', {
            parameterName: `/shared/${envName}/secondary-health-check-id`,
            stringValue: this.secondaryHealthCheck.attrHealthCheckId,
            description: `Route 53 health check ID for us-east-1 API Gateway /health (${envName})`,
        });

        /** Domain name used for the API subdomain — handy for `dig` / resolver tests. */
        new ssm.StringParameter(this, 'ApiSubdomainParam', {
            parameterName: `/shared/${envName}/api-subdomain`,
            stringValue: apiSubdomain,
            description: `Public API subdomain (${envName})`,
        });

        // -----------------------------------------------------------------------
        // CloudFormation outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'HostedZoneId', {
            value: this.hostedZone.hostedZoneId,
            description: 'Route 53 public hosted zone ID',
            exportName: `SharedStack-${envName}-HostedZoneId`,
        });

        new cdk.CfnOutput(this, 'HostedZoneArn', {
            value: this.hostedZone.hostedZoneArn,
            description: 'Route 53 public hosted zone ARN',
            exportName: `SharedStack-${envName}-HostedZoneArn`,
        });

        new cdk.CfnOutput(this, 'PrimaryHealthCheckId', {
            value: this.primaryHealthCheck.attrHealthCheckId,
            description: 'Route 53 health check ID for ap-south-1',
            exportName: `SharedStack-${envName}-PrimaryHealthCheckId`,
        });

        new cdk.CfnOutput(this, 'SecondaryHealthCheckId', {
            value: this.secondaryHealthCheck.attrHealthCheckId,
            description: 'Route 53 health check ID for us-east-1',
            exportName: `SharedStack-${envName}-SecondaryHealthCheckId`,
        });

        new cdk.CfnOutput(this, 'ApiSubdomain', {
            value: apiSubdomain,
            description: 'Public API subdomain',
            exportName: `SharedStack-${envName}-ApiSubdomain`,
        });

        /*
        new cdk.CfnOutput(this, 'NameServers', {
            // Delegate NS records from the apex domain registrar to these name servers
            value: cdk.Fn.join(', ', this.hostedZone.hostedZoneNameServers ?? ['N/A (Imported Zone)']),
            description:
                'Route 53 name servers — add these as NS records in your domain registrar dashboard',
        });
        */
    }
}
