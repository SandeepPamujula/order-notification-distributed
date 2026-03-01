#!/usr/bin/env node
import 'source-map-support/register';

import * as cdk from 'aws-cdk-lib';

import { BaselineStack } from '../stacks/BaselineStack';
import { SharedStack } from '../stacks/SharedStack';

// ---------------------------------------------------------------------------
// CDK App Entry Point
// ---------------------------------------------------------------------------
// Usage examples:
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
    domainName: envConfig.domainName ?? 'sporder.com',
    primaryApiGatewayDomainName:
        envConfig.primaryApiGatewayDomainName ??
        `placeholder-primary.execute-api.${envConfig.region}.amazonaws.com`,
    secondaryApiGatewayDomainName:
        envConfig.secondaryApiGatewayDomainName ??
        `placeholder-secondary.execute-api.us-east-1.amazonaws.com`,
    owner: envConfig.owner,
    description: `Route 53 hosted zone, health checks, and latency routing — ${envConfig.env}`,
});

app.synth();
