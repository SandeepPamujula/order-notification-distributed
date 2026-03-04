import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { TaggingAspect } from '../aspects/TaggingAspect';
import { PowertoolsLambda } from '../constructs/PowertoolsLambda';

export interface HelpdeskStackProps extends cdk.StackProps {
    readonly envName: string;
    readonly owner: string;
    readonly lambdaCode?: lambda.Code;
}

/**
 * Helpdesk Service CDK stack — Phase 1 & 2.
 */
export class HelpdeskStack extends cdk.Stack {
    public readonly helpdeskLambda: lambda.Function;

    constructor(scope: Construct, id: string, props: HelpdeskStackProps) {
        super(scope, id, props);

        const { envName, owner, lambdaCode } = props;

        // 1. Store helpdesk email in SSM
        new ssm.StringParameter(this, 'SesHelpdeskAddressParam', {
            parameterName: `/helpdesk-service/${envName}/ses-helpdesk-address`,
            stringValue: 'helpdesk@spkumarorder.com',
            description: 'Helpdesk email address for SES',
        });

        // 2. Helpdesk Lambda
        const helpdeskLambdaConstruct = new PowertoolsLambda(this, 'HelpdeskLambda', {
            powertoolsServiceName: 'helpdesk-service',
            handler: 'handler.handler',
            code: lambdaCode ?? lambda.Code.fromAsset('../src/helpdesk-service/dist'),
            environment: {
                SES_HELPDESK_ADDRESS: 'helpdesk@spkumarorder.com',
            },
        });

        this.helpdeskLambda = helpdeskLambdaConstruct.function;

        // Lambda IAM: ses:SendEmail on verified identities
        this.helpdeskLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ses:SendEmail'],
                resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
            }),
        );

        // 3. Import EventBridge bus
        const eventBusName = ssm.StringParameter.valueForStringParameter(
            this,
            `/order-service/${envName}/order-events-bus-name`,
        );

        const orderEventsBus = events.EventBus.fromEventBusName(this, 'OrderEventsBus', eventBusName);

        // 4. Provision EventBridge rule on the bus
        const nonIndiaOrderRule = new events.Rule(this, 'NonIndiaOrderRule', {
            ruleName: `helpdesk-non-india-orders-${envName}`,
            description: 'Triggers Helpdesk Lambda for non-India orders',
            eventBus: orderEventsBus,
            eventPattern: {
                source: ['order-service'],
                detailType: ['OrderPlaced'],
                detail: {
                    country: [{ "anything-but": "IN" }],
                },
            },
        });

        nonIndiaOrderRule.addTarget(new targets.LambdaFunction(this.helpdeskLambda, {
            retryAttempts: 2, // Ensure it retries on failure
        }));

        // 5. Tagging
        cdk.Aspects.of(this).add(
            new TaggingAspect({ env: envName, service: 'helpdesk-service', owner }),
        );

        // 6. CloudFormation outputs
        new cdk.CfnOutput(this, 'HelpdeskLambdaFunctionName', {
            value: this.helpdeskLambda.functionName,
            description: 'Helpdesk Lambda function name',
            exportName: `HelpdeskStack-${envName}-HelpdeskLambdaFunctionName`,
        });
    }
}
