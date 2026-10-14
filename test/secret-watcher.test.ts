import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { describe, expect, test } from 'vite-plus/test';
import { SecretWatcher, WatchTarget } from '../src';

const NONCE = 'fixed-nonce';

// Asset hashes change with every change to the handler bundle.
expect.addSnapshotSerializer({
  test: (val) => typeof val === 'string' && /[0-9a-f]{64}/.test(val),
  serialize: (val: string) => JSON.stringify(val.replace(/[0-9a-f]{64}/g, 'hashed')),
});

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
    new SecretWatcher(stack, 'ParamWatcher', {
      target: WatchTarget.fromParameter(param),
      nonce: NONCE,
    });
    new SecretWatcher(stack, 'SecretWatcher', {
      target: WatchTarget.fromSecret(secret),
      nonce: NONCE,
    });
    const t = Template.fromStack(stack);

    test('share one Lambda function, whose ARN is every service token', () => {
      t.resourceCountIs('AWS::Lambda::Function', 1);
      const [fn] = Object.keys(t.findResources('AWS::Lambda::Function'));
      t.allResourcesProperties('Custom::SecretWatcher', {
        ServiceToken: { 'Fn::GetAtt': [fn, 'Arn'] },
      });
    });

    // CloudFormation cannot update a ServiceToken, so the logical IDs must not change after a release.
    test('template', () => {
      expect(t.toJSON()).toMatchSnapshot();
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
