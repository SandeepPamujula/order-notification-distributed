import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

import { TaggingAspect } from '../../aspects/TaggingAspect';

describe('TaggingAspect', () => {
    it('should tag all CfnResource nodes with env, service, owner', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'TestStack', {
            env: { account: '123456789012', region: 'ap-south-1' },
        });

        cdk.Aspects.of(app).add(
            new TaggingAspect({ env: 'dev', service: 'test-service', owner: 'platform-team' }),
        );

        // Add at least one resource to the stack
        new StringParameter(stack, 'TestParam', {
            parameterName: '/test/param',
            stringValue: 'hello',
        });

        app.synth();

        const template = Template.fromStack(stack);
        template.hasResourceProperties('AWS::SSM::Parameter', {
            Tags: {
                env: 'dev',
                service: 'test-service',
                owner: 'platform-team',
            },
        });
    });
});
