import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { TaggingAspect } from '../aspects/TaggingAspect';
import { PowertoolsLambda } from '../constructs/PowertoolsLambda';
import { StandardAlarms } from '../constructs/StandardAlarms';

export interface InventoryServiceStackProps extends cdk.StackProps {
    readonly envName: string;
    readonly owner: string;
    readonly lambdaCode?: lambda.Code;
}

/**
 * Inventory Service CDK stack — Phase 1.
 */
export class InventoryServiceStack extends cdk.Stack {
    public readonly inventoryLambda: lambda.Function;

    constructor(scope: Construct, id: string, props: InventoryServiceStackProps) {
        super(scope, id, props);

        const { envName, owner, lambdaCode } = props;

        // 1. Import SQS queues from SSM
        const inventoryQueueArn = ssm.StringParameter.valueForStringParameter(
            this,
            `/order-service/${envName}/inventory-queue-arn`,
        );

        const inventoryDlqArn = ssm.StringParameter.valueForStringParameter(
            this,
            `/order-service/${envName}/inventory-dlq-arn`,
        );

        const inventoryQueue = sqs.Queue.fromQueueArn(this, 'InventoryQueue', inventoryQueueArn);
        const inventoryDlq = sqs.Queue.fromQueueArn(this, 'InventoryDLQ', inventoryDlqArn);

        // 2. Inventory Lambda
        const inventoryLambdaConstruct = new PowertoolsLambda(this, 'InventoryLambda', {
            powertoolsServiceName: 'inventory-service',
            handler: 'handler.handler',
            code: lambdaCode ?? lambda.Code.fromAsset('../src/inventory-service/dist'),
        });

        this.inventoryLambda = inventoryLambdaConstruct.function;

        // 3. SQS Event Source Mapping
        this.inventoryLambda.addEventSource(
            new lambdaEventSources.SqsEventSource(inventoryQueue, {
                batchSize: 10,
                reportBatchItemFailures: true, // "bisect on error: true" corresponds to reportBatchItemFailures in SQS semantics
            })
        );

        // 4. Standard Alarms
        new StandardAlarms(this, 'InventoryAlarms', {
            lambdaFunction: this.inventoryLambda,
            serviceName: 'inventory-service',
            envName,
            dlq: inventoryDlq,
            errorRateThresholdPercent: 1,
            throttleCountThreshold: 0,
        });

        // 5. Tagging
        cdk.Aspects.of(this).add(
            new TaggingAspect({ env: envName, service: 'inventory-service', owner }),
        );

        // 6. CloudFormation outputs
        new cdk.CfnOutput(this, 'InventoryLambdaFunctionName', {
            value: this.inventoryLambda.functionName,
            description: 'Inventory Lambda function name',
            exportName: `InventoryServiceStack-${envName}-InventoryLambdaFunctionName`,
        });
    }
}
