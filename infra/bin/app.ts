#!/usr/bin/env node
import 'source-map-support/register';

import * as cdk from 'aws-cdk-lib';

import { BaselineStack } from '../stacks/BaselineStack';
import { InventoryServiceStack } from '../stacks/InventoryServiceStack';
import { NotificationServiceStack } from '../stacks/NotificationServiceStack';
import { OrderServiceStack } from '../stacks/OrderServiceStack';
import { SharedStack } from '../stacks/SharedStack';
import { HelpdeskStack } from '../stacks/HelpdeskStack';
import { ObservabilityStack } from '../stacks/ObservabilityStack';

// ---------------------------------------------------------------------------
// CDK App — Multi-Region Deployment (US-6.1)
//
// Deploys all service stacks to both ap-south-1 (primary) and us-east-1
// (secondary) regions. DynamoDB Global Tables replicate data across both
// regions. ACM certificates and API Gateway Custom Domain Names are
// provisioned per-region for `api.<domainName>`.
//
// Usage:
//   cdk synth --context env=dev
//   cdk deploy --all --context env=dev --require-approval never
//   cdk diff --context env=staging
// ---------------------------------------------------------------------------

const app = new cdk.App();

/**
 * Reads a strongly-typed context value from cdk.json or the `--context` CLI flag.
 */
function getContext<T>(key: string): T {
    const value = app.node.tryGetContext(key) as T | undefined;
    if (value === undefined) {
        throw new Error(
            `Required CDK context key "${key}" is not set. ` +
            `Pass it via --context ${key}=<value> or define it in cdk.json.`,
        );
    }
    return value;
}

/** Environment name — one of "dev", "staging", or "prod". */
const envName = app.node.tryGetContext('env') as string ?? 'dev';
const envConfig = getContext<{
    account: string;
    region: string;
    secondaryRegion: string;
    env: string;
    owner: string;
    domainName?: string;
    primaryApiGatewayDomainName?: string;
    secondaryApiGatewayDomainName?: string;
}>(envName);

const primaryEnv: cdk.Environment = {
    account: envConfig.account,
    region: envConfig.region,
};

const secondaryEnv: cdk.Environment = {
    account: envConfig.account,
    region: envConfig.secondaryRegion,
};

/** us-east-1 environment — SharedStack must be deployed here (Route 53 requirement). */
const usEast1Env: cdk.Environment = {
    account: envConfig.account,
    region: 'us-east-1',
};

/** All regions for DynamoDB Global Table replication. */
const allRegions = [envConfig.region, envConfig.secondaryRegion];

/** Domain name for ACM certificates and API Gateway Custom Domain Names. */
const domainName = envConfig.domainName ?? 'spworks.click';

// ---------------------------------------------------------------------------
// Baseline / Shared Stacks
// ---------------------------------------------------------------------------

// Primary region baseline
const baselineStackPrimary = new BaselineStack(app, `BaselineStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    primaryRegion: envConfig.region,
    secondaryRegion: envConfig.secondaryRegion,
    owner: envConfig.owner,
    description: `Baseline shared parameters and tagging — ${envConfig.env} (${envConfig.region})`,
});

// Secondary region baseline
const baselineStackSecondary = new BaselineStack(app, `BaselineStack-${envConfig.secondaryRegion}-${envName}`, {
    env: secondaryEnv,
    envName: envConfig.env,
    primaryRegion: envConfig.region,
    secondaryRegion: envConfig.secondaryRegion,
    owner: envConfig.owner,
    description: `Baseline shared parameters and tagging — ${envConfig.env} (${envConfig.secondaryRegion})`,
});

// SharedStack (us-east-1) — Route 53 hosted zone, health checks, latency routing
// NOTE: primaryApiGatewayDomainName and secondaryApiGatewayDomainName are
// overridden after OrderServiceStacks are deployed. Use placeholder values
// for initial cdk synth / cdk diff.
const sharedStack = new SharedStack(app, `SharedStack-us-east-1-${envName}`, {
    env: usEast1Env,
    envName: envConfig.env,
    domainName,
    primaryApiGatewayDomainName:
        envConfig.primaryApiGatewayDomainName ??
        `placeholder-primary.execute-api.${envConfig.region}.amazonaws.com`,
    secondaryApiGatewayDomainName:
        envConfig.secondaryApiGatewayDomainName ??
        `placeholder-secondary.execute-api.us-east-1.amazonaws.com`,
    owner: envConfig.owner,
    description: `Route 53 hosted zone, health checks, and latency routing — ${envConfig.env}`,
});

// ---------------------------------------------------------------------------
// Order Service Stacks — deployed to BOTH regions (US-6.1)
//
// - DynamoDB Global Table replication enabled across both regions
// - ACM certificate + API Gateway Custom Domain Name per region
// ---------------------------------------------------------------------------

const orderServiceStackPrimary = new OrderServiceStack(app, `OrderServiceStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    domainName,
    replicationRegions: allRegions,
    description: `Order Service — infrastructure (${envConfig.region}, ${envConfig.env})`,
    ...(app.node.tryGetContext('orderLambdaReservedConcurrency') !== undefined && {
        orderLambdaReservedConcurrency: Number(app.node.tryGetContext('orderLambdaReservedConcurrency')),
    }),
});
orderServiceStackPrimary.addDependency(baselineStackPrimary);

const orderServiceStackSecondary = new OrderServiceStack(app, `OrderServiceStack-${envConfig.secondaryRegion}-${envName}`, {
    env: secondaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    domainName,
    isSecondaryRegion: true,
    // Only the primary stack creates replicas; secondary references the same Global Table.
    // Passing replicationRegions only on the primary stack avoids conflicting replica creation.
    description: `Order Service — infrastructure (${envConfig.secondaryRegion}, ${envConfig.env})`,
    ...(app.node.tryGetContext('orderLambdaReservedConcurrency') !== undefined && {
        orderLambdaReservedConcurrency: Number(app.node.tryGetContext('orderLambdaReservedConcurrency')),
    }),
});
orderServiceStackSecondary.addDependency(baselineStackSecondary);
// Secondary depends on primary because the Global Table is created in primary
orderServiceStackSecondary.addDependency(orderServiceStackPrimary);

// ---------------------------------------------------------------------------
// Notification Service Stacks — deployed to BOTH regions (US-6.1)
// ---------------------------------------------------------------------------

const notificationServiceStackPrimary = new NotificationServiceStack(app, `NotificationServiceStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    replicationRegions: allRegions,
    description: `Notification Service — infrastructure (${envConfig.region}, ${envConfig.env})`,
});
notificationServiceStackPrimary.addDependency(orderServiceStackPrimary);

const notificationServiceStackSecondary = new NotificationServiceStack(app, `NotificationServiceStack-${envConfig.secondaryRegion}-${envName}`, {
    env: secondaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    isSecondaryRegion: true,
    // Only primary creates replicas to avoid conflicting Global Table creation
    description: `Notification Service — infrastructure (${envConfig.secondaryRegion}, ${envConfig.env})`,
});
notificationServiceStackSecondary.addDependency(orderServiceStackSecondary);
notificationServiceStackSecondary.addDependency(notificationServiceStackPrimary);

// ---------------------------------------------------------------------------
// Inventory Service Stacks — deployed to BOTH regions (US-6.1)
// ---------------------------------------------------------------------------

const inventoryServiceStackPrimary = new InventoryServiceStack(app, `InventoryServiceStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Inventory Service — infrastructure (${envConfig.region}, ${envConfig.env})`,
});
inventoryServiceStackPrimary.addDependency(orderServiceStackPrimary);

const inventoryServiceStackSecondary = new InventoryServiceStack(app, `InventoryServiceStack-${envConfig.secondaryRegion}-${envName}`, {
    env: secondaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Inventory Service — infrastructure (${envConfig.secondaryRegion}, ${envConfig.env})`,
});
inventoryServiceStackSecondary.addDependency(orderServiceStackSecondary);

// ---------------------------------------------------------------------------
// Helpdesk Service Stacks — deployed to BOTH regions (US-6.1)
// ---------------------------------------------------------------------------

const helpdeskStackPrimary = new HelpdeskStack(app, `HelpdeskStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Helpdesk Service — infrastructure (${envConfig.region}, ${envConfig.env})`,
});
helpdeskStackPrimary.addDependency(orderServiceStackPrimary);

const helpdeskStackSecondary = new HelpdeskStack(app, `HelpdeskStack-${envConfig.secondaryRegion}-${envName}`, {
    env: secondaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Helpdesk Service — infrastructure (${envConfig.secondaryRegion}, ${envConfig.env})`,
});
helpdeskStackSecondary.addDependency(orderServiceStackSecondary);

// ---------------------------------------------------------------------------
// Observability Stacks — deployed to BOTH regions (US-6.1)
//
// Depends on ALL four service stacks in the same region because it uses
// Fn.importValue to reference their CloudFormation exports.
// ---------------------------------------------------------------------------

const observabilityStackPrimary = new ObservabilityStack(app, `ObservabilityStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Observability Stack — Dashboards & Alerts (${envConfig.region}, ${envConfig.env})`,
});
observabilityStackPrimary.addDependency(orderServiceStackPrimary);
observabilityStackPrimary.addDependency(notificationServiceStackPrimary);
observabilityStackPrimary.addDependency(inventoryServiceStackPrimary);
observabilityStackPrimary.addDependency(helpdeskStackPrimary);
observabilityStackPrimary.addDependency(sharedStack);

const observabilityStackSecondary = new ObservabilityStack(app, `ObservabilityStack-${envConfig.secondaryRegion}-${envName}`, {
    env: secondaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Observability Stack — Dashboards & Alerts (${envConfig.secondaryRegion}, ${envConfig.env})`,
});
observabilityStackSecondary.addDependency(orderServiceStackSecondary);
observabilityStackSecondary.addDependency(notificationServiceStackSecondary);
observabilityStackSecondary.addDependency(inventoryServiceStackSecondary);
observabilityStackSecondary.addDependency(helpdeskStackSecondary);
observabilityStackSecondary.addDependency(sharedStack);

app.synth();
