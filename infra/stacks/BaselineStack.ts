import * as cdk from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { TaggingAspect } from '../aspects/TaggingAspect';

// ---------------------------------------------------------------------------
// BaselineStack — shared SSM parameters and App-level tagging
// ---------------------------------------------------------------------------

export interface BaselineStackProps extends cdk.StackProps {
    /** Environment name: dev | staging | prod */
    readonly envName: string;
    /** Primary AWS region (e.g. ap-south-1) */
    readonly primaryRegion: string;
    /** Secondary AWS region (e.g. us-east-1) */
    readonly secondaryRegion: string;
    /** Owner tag value */
    readonly owner: string;
}

/**
 * Baseline stack provisioned in the primary region.
 *
 * Responsibilities:
 * - Stores shared SSM parameters consumed by all service stacks.
 * - Applies the `TaggingAspect` at App level so every resource is tagged.
 *
 * All service-specific stacks (OrderServiceStack, NotificationServiceStack, …)
 * will be added here in subsequent milestones.
 */
export class BaselineStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: BaselineStackProps) {
        super(scope, id, props);

        const { envName, primaryRegion, secondaryRegion, owner } = props;

        // -----------------------------------------------------------------------
        // Apply tagging aspect at App level — propagates to all stacks & resources
        // -----------------------------------------------------------------------
        cdk.Aspects.of(scope).add(
            new TaggingAspect({
                env: envName,
                service: 'shared',
                owner,
            }),
        );

        // -----------------------------------------------------------------------
        // Shared SSM parameters
        // -----------------------------------------------------------------------

        new StringParameter(this, 'PrimaryRegionParam', {
            parameterName: `/shared/${envName}/primary-region`,
            stringValue: primaryRegion,
            description: 'Primary AWS region for the order-notification system',
        });

        new StringParameter(this, 'SecondaryRegionParam', {
            parameterName: `/shared/${envName}/secondary-region`,
            stringValue: secondaryRegion,
            description: 'Secondary (failover) AWS region for the order-notification system',
        });

        new StringParameter(this, 'EnvNameParam', {
            parameterName: `/shared/${envName}/env-name`,
            stringValue: envName,
            description: 'Environment name (dev | staging | prod)',
        });

        // Placeholder for ops email — must be overridden with a real address before deployment
        new StringParameter(this, 'OpsEmailParam', {
            parameterName: `/shared/${envName}/ops-email`,
            stringValue: 'ops@example.com',
            description: 'Ops email address for CloudWatch alarm notifications',
        });

        // -----------------------------------------------------------------------
        // Stack outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'EnvName', { value: envName });
        new cdk.CfnOutput(this, 'PrimaryRegion', { value: primaryRegion });
        new cdk.CfnOutput(this, 'SecondaryRegion', { value: secondaryRegion });
    }
}
