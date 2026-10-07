import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { describe, expect, test } from 'vite-plus/test';
import { SecretWatcher, WatchTarget } from '../src';

const NONCE = 'fixed-nonce';
const handlerRole = { Ref: Match.stringLikeRegexp('^SecretWatcher[0-9a-f]{32}ServiceRole') };

// A watcher plus an L2 Function whose description uses hash().
function synth(makeTarget: (stack: Stack) => WatchTarget): Template {
  const stack = new Stack(new App(), 'Test');
  const watcher = new SecretWatcher(stack, 'Watcher', { target: makeTarget(stack), nonce: NONCE });
  new lambda.Function(stack, 'Consumer', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
    description: `hash:${watcher.hash()}`,
  });
  return Template.fromStack(stack);
}

const consumerDescription = {
  Description: {
    'Fn::Join': ['', ['hash:', { 'Fn::GetAtt': [Match.stringLikeRegexp('^Watcher'), 'Hash'] }]],
  },
};

describe('SecretWatcher', () => {
  describe('WatchTarget.fromParameter', () => {
    const t = synth((stack) =>
      WatchTarget.fromParameter(new ssm.StringParameter(stack, 'Param', { stringValue: 'v' })),
    );

    test('Custom::SecretWatcher has Kind, TargetId and Nonce', () => {
      t.resourceCountIs('Custom::SecretWatcher', 1);
      t.hasResourceProperties('Custom::SecretWatcher', {
        Kind: 'ssm',
        TargetId: { Ref: Match.stringLikeRegexp('^Param') },
        Nonce: NONCE,
      });
    });

    test('allows only ssm:GetParameter on the parameter', () => {
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'ssm:GetParameter',
              Effect: 'Allow',
              Resource: {
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([{ Ref: Match.stringLikeRegexp('^Param') }]),
                ]),
              },
            },
          ],
        },
        Roles: [handlerRole],
      });
      expect(JSON.stringify(t.toJSON())).not.toContain('secretsmanager:');
    });

    test('an L2 description using hash() becomes an Fn::Join over GetAtt Hash', () => {
      t.hasResourceProperties('AWS::Lambda::Function', consumerDescription);
    });
  });

  describe('WatchTarget.fromSecret', () => {
    const t = synth((stack) => WatchTarget.fromSecret(new secretsmanager.Secret(stack, 'Secret')));

    test('Custom::SecretWatcher has Kind, TargetId and Nonce', () => {
      t.resourceCountIs('Custom::SecretWatcher', 1);
      t.hasResourceProperties('Custom::SecretWatcher', {
        Kind: 'secretsmanager',
        TargetId: { Ref: Match.stringLikeRegexp('^Secret') },
        Nonce: NONCE,
      });
    });

    test('allows only secretsmanager:DescribeSecret on the secret, which cannot read the value', () => {
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'secretsmanager:DescribeSecret',
              Effect: 'Allow',
              Resource: { Ref: Match.stringLikeRegexp('^Secret') },
            },
          ],
        },
        Roles: [handlerRole],
      });
      expect(JSON.stringify(t.toJSON())).not.toContain('GetSecretValue');
      expect(JSON.stringify(t.toJSON())).not.toContain('ssm:');
    });

    test('an L2 description using hash() becomes an Fn::Join over GetAtt Hash', () => {
      t.hasResourceProperties('AWS::Lambda::Function', consumerDescription);
    });
  });

  describe('WatchTarget.fromSecret with a secret imported by name', () => {
    const t = synth((stack) =>
      WatchTarget.fromSecret(secretsmanager.Secret.fromSecretNameV2(stack, 'Secret', 'app/key')),
    );

    test('matches the ARN suffix IAM needs, since the imported ARN has none', () => {
      const policy = Object.values(t.findResources('AWS::IAM::Policy'))[0];
      const statement = policy.Properties.PolicyDocument.Statement[0];

      expect(statement.Action).toBe('secretsmanager:DescribeSecret');
      expect(JSON.stringify(statement.Resource)).toContain(':secret:app/key-??????');
    });
  });

  describe('two watchers in a stack', () => {
    const stack = new Stack(new App(), 'Test');
    const param = new ssm.StringParameter(stack, 'Param', { stringValue: 'v' });
    const secret = new secretsmanager.Secret(stack, 'Secret');
    new SecretWatcher(stack, 'ParamWatcher', { target: WatchTarget.fromParameter(param) });
    new SecretWatcher(stack, 'SecretWatcher', { target: WatchTarget.fromSecret(secret) });
    const t = Template.fromStack(stack);

    // CloudFormation cannot update a ServiceToken, so these logical IDs must not change after a release.
    test('share one Lambda function, whose ARN is every service token', () => {
      const fn = 'SecretWatchera580c4e78ff84c05929d3b7fe281d535';
      expect(Object.keys(t.findResources('AWS::Lambda::Function'))).toEqual([fn]);

      const watchers = t.findResources('Custom::SecretWatcher');
      expect(Object.keys(watchers).sort()).toEqual([
        'ParamWatcher47E31C45',
        'SecretWatcher8C03309F',
      ]);
      for (const watcher of Object.values(watchers)) {
        expect(watcher.Properties.ServiceToken).toEqual({ 'Fn::GetAtt': [fn, 'Arn'] });
      }
    });

    test('the shared role gets each target its own action only', () => {
      t.resourceCountIs('AWS::IAM::Policy', 1);
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'ssm:GetParameter',
              Effect: 'Allow',
              Resource: {
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([{ Ref: Match.stringLikeRegexp('^Param') }]),
                ]),
              },
            },
            {
              Action: 'secretsmanager:DescribeSecret',
              Effect: 'Allow',
              Resource: { Ref: Match.stringLikeRegexp('^Secret') },
            },
          ],
        },
        Roles: [handlerRole],
      });
    });
  });

  describe('WatchTarget._bind', () => {
    test('returns the kind and identifier', () => {
      const stack = new Stack(new App(), 'Test');
      const role = new iam.Role(stack, 'Role', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      const param = new ssm.StringParameter(stack, 'Param', { stringValue: 'v' });
      const secret = new secretsmanager.Secret(stack, 'Secret');

      expect(WatchTarget.fromParameter(param)._bind(stack, role)).toEqual({
        kind: 'ssm',
        targetId: param.parameterName,
      });
      expect(WatchTarget.fromSecret(secret)._bind(stack, role)).toEqual({
        kind: 'secretsmanager',
        targetId: secret.secretArn,
      });
    });
  });
});
