import { ExpectedResult, IntegTest, Match } from '@aws-cdk/integ-tests-alpha';
import { App, RemovalPolicies, Stack, StackProps } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { SecretWatcher, WatchTarget } from '../src';

// Watches a parameter and a secret, and checks that each consumer's Description ends in a 32-hex hash.

class TestStack extends Stack {
  /** Uses the parameter watcher's hash in its description. */
  public readonly ssmConsumer: lambda.IFunction;
  /** Uses the secret watcher's hash in its description. */
  public readonly secretConsumer: lambda.IFunction;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const parameter = new ssm.StringParameter(this, 'Parameter', {
      stringValue: 'integ-value',
    });
    const secret = new secretsmanager.Secret(this, 'Secret');

    // Fixed so the snapshot is stable; the test is a single deployment.
    const ssmWatcher = new SecretWatcher(this, 'SsmWatcher', {
      target: WatchTarget.fromParameter(parameter),
      nonce: 'integ',
    });
    const secretWatcher = new SecretWatcher(this, 'SecretWatcher', {
      target: WatchTarget.fromSecret(secret),
      nonce: 'integ',
    });

    this.ssmConsumer = new lambda.Function(this, 'SsmConsumer', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
      description: `ssm-hash:${ssmWatcher.hash()}`,
    });
    this.secretConsumer = new lambda.Function(this, 'SecretConsumer', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
      description: `secret-hash:${secretWatcher.hash()}`,
    });
  }
}

const app = new App();
const stack = new TestStack(app, 'SecretWatcherInteg');
// Log groups and everything else go with the stack.
RemovalPolicies.of(stack).destroy();

const integ = new IntegTest(app, 'SecretWatcherIntegTest', {
  testCases: [stack],
});

integ.assertions
  .awsApiCall('Lambda', 'getFunctionConfiguration', {
    FunctionName: stack.ssmConsumer.functionName,
  })
  .expect(
    ExpectedResult.objectLike({
      Description: Match.stringLikeRegexp('^ssm-hash:[0-9a-f]{32}$'),
    }),
  );

integ.assertions
  .awsApiCall('Lambda', 'getFunctionConfiguration', {
    FunctionName: stack.secretConsumer.functionName,
  })
  .expect(
    ExpectedResult.objectLike({
      Description: Match.stringLikeRegexp('^secret-hash:[0-9a-f]{32}$'),
    }),
  );
