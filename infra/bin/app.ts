#!/usr/bin/env node
import 'source-map-support/register';

import * as cdk from 'aws-cdk-lib';

import { BaselineStack } from '../stacks/BaselineStack';

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
}>(envName);

const primaryEnv: cdk.Environment = {
    account: envConfig.account,
    region: envConfig.region,
};

// ---------------------------------------------------------------------------
// Baseline / Shared Stack (primary region)
// Provisions SSM parameters and tags all resources at App level.
// Additional service stacks will be added in subsequent milestones.
// ---------------------------------------------------------------------------
new BaselineStack(app, `BaselineStack-${envConfig.region}-${envName}`, {
    env: primaryEnv,
    envName: envConfig.env,
    primaryRegion: envConfig.region,
    secondaryRegion: envConfig.secondaryRegion,
    owner: envConfig.owner,
    description: `Baseline shared parameters and tagging — ${envConfig.env}`,
});

app.synth();
