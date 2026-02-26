import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { TaggingAspect } from '../../aspects/TaggingAspect';
import { BaselineStack } from '../../stacks/BaselineStack';

describe('BaselineStack', () => {
    let app: cdk.App;
    let stack: BaselineStack;
    let template: Template;

    beforeEach(() => {
        app = new cdk.App();
        cdk.Aspects.of(app).add(
            new TaggingAspect({ env: 'dev', service: 'shared', owner: 'platform-team' }),
        );
        stack = new BaselineStack(app, 'BaselineStack-ap-south-1-dev', {
            env: { account: '123456789012', region: 'ap-south-1' },
            envName: 'dev',
            primaryRegion: 'ap-south-1',
            secondaryRegion: 'us-east-1',
            owner: 'platform-team',
        });
        template = Template.fromStack(stack);
    });

    it('should synthesise without errors', () => {
        expect(() => app.synth()).not.toThrow();
    });

    it('should create primary-region SSM parameter', () => {
        template.hasResourceProperties('AWS::SSM::Parameter', {
            Name: '/shared/dev/primary-region',
            Value: 'ap-south-1',
            Type: 'String',
        });
    });

    it('should create secondary-region SSM parameter', () => {
        template.hasResourceProperties('AWS::SSM::Parameter', {
            Name: '/shared/dev/secondary-region',
            Value: 'us-east-1',
        });
    });

    it('should create env-name SSM parameter', () => {
        template.hasResourceProperties('AWS::SSM::Parameter', {
            Name: '/shared/dev/env-name',
            Value: 'dev',
        });
    });

    it('should create ops-email SSM parameter', () => {
        template.hasResourceProperties('AWS::SSM::Parameter', {
            Name: '/shared/dev/ops-email',
        });
    });

    it('should have CloudFormation outputs for EnvName, PrimaryRegion, SecondaryRegion', () => {
        template.hasOutput('EnvName', { Value: 'dev' });
        template.hasOutput('PrimaryRegion', { Value: 'ap-south-1' });
        template.hasOutput('SecondaryRegion', { Value: 'us-east-1' });
    });
});
