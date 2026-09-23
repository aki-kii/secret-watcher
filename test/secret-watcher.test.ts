import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { describe, expect, test } from 'vite-plus/test';
import { SecretWatcher, WatchTarget } from '../src';

const NONCE = 'fixed-nonce';

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
        Roles: [{ Ref: Match.stringLikeRegexp('^WatcherHandlerServiceRole') }],
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
        Roles: [{ Ref: Match.stringLikeRegexp('^WatcherHandlerServiceRole') }],
      });
      expect(JSON.stringify(t.toJSON())).not.toContain('GetSecretValue');
      expect(JSON.stringify(t.toJSON())).not.toContain('ssm:');
    });

    test('an L2 description using hash() becomes an Fn::Join over GetAtt Hash', () => {
      t.hasResourceProperties('AWS::Lambda::Function', consumerDescription);
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
