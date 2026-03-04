#!/usr/bin/env node
import 'source-map-support/register';

import * as cdk from 'aws-cdk-lib';

import { BaselineStack } from '../stacks/BaselineStack';
import { InventoryServiceStack } from '../stacks/InventoryServiceStack';
import { NotificationServiceStack } from '../stacks/NotificationServiceStack';
import { OrderServiceStack } from '../stacks/OrderServiceStack';
import { SharedStack } from '../stacks/SharedStack';
import { HelpdeskStack } from '../stacks/HelpdeskStack';
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

/** us-east-1 environment — SharedStack must be deployed here (Route 53 requirement). */
const usEast1Env: cdk.Environment = {
    account: envConfig.account,
    region: 'us-east-1',
};

// ---------------------------------------------------------------------------
// Baseline / Shared Stack (primary region)
// Provisions SSM parameters and tags all resources at App level.
// ---------------------------------------------------------------------------
new BaselineStack(app, `BaselineStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    primaryRegion: envConfig.region,
    secondaryRegion: envConfig.secondaryRegion,
    owner: envConfig.owner,
    description: `Baseline shared parameters and tagging — ${envConfig.env}`,
});

// ---------------------------------------------------------------------------
// Shared Stack (us-east-1)
// Route 53 hosted zone, health checks, and latency-based routing.
//
// NOTE: `primaryApiGatewayDomainName` and `secondaryApiGatewayDomainName`
// will be replaced with real API Gateway domain names once OrderServiceStack
// (US-1.1) is deployed. Use placeholder values for `cdk diff` / `cdk synth`
// during Milestone 0.
// ---------------------------------------------------------------------------
new SharedStack(app, `SharedStack-us-east-1-${envName}`, {
    env: usEast1Env,
    envName: envConfig.env,
    domainName: envConfig.domainName ?? 'spkumarorder.com',
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
// Order Service Stack (primary region — ap-south-1)
//
// Phase 1: DynamoDB Orders table, SNS fan-out, SQS queues, HTTP API Gateway,
//          EventBridge custom bus, Order Lambda.
//
// NOTE: The secondary region (us-east-1) OrderServiceStack is added in US-6.1
//       (Multi-Region Deployment) along with DynamoDB Global Table replication.
// ---------------------------------------------------------------------------
new OrderServiceStack(app, `OrderServiceStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Order Service — Phase 1 infrastructure (${envConfig.region}, ${envConfig.env})`,
    // Reserved concurrency is left undefined for dev; set via CDK context for staging/prod.
    // Example: --context orderLambdaReservedConcurrency=2000
    ...(app.node.tryGetContext('orderLambdaReservedConcurrency') !== undefined && {
        orderLambdaReservedConcurrency: Number(app.node.tryGetContext('orderLambdaReservedConcurrency')),
    }),
});

// ---------------------------------------------------------------------------
// Notification Service Stack (primary region)
// ---------------------------------------------------------------------------
new NotificationServiceStack(app, `NotificationServiceStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Notification Service — Phase 1 infrastructure (${envConfig.region}, ${envConfig.env})`,
});

// ---------------------------------------------------------------------------
// Inventory Service Stack (primary region)
// ---------------------------------------------------------------------------
new InventoryServiceStack(app, `InventoryServiceStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Inventory Service — Phase 1 infrastructure (${envConfig.region}, ${envConfig.env})`,
});

// ---------------------------------------------------------------------------
// Helpdesk Service Stack (primary region)
// ---------------------------------------------------------------------------
new HelpdeskStack(app, `HelpdeskStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    owner: envConfig.owner,
    description: `Helpdesk Service — Phase 1 & 2 infrastructure (${envConfig.region}, ${envConfig.env})`,
});

app.synth();
