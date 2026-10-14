import * as path from 'path';
import { CustomResource, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import type { WatchTargetKind } from './handler/kind';

/** The result of binding a `WatchTarget`: the values passed to the custom resource. */
interface WatchTargetConfig {
  readonly kind: WatchTargetKind;
  /** Parameter name or secret ARN. */
  readonly targetId: string;
}

/**
 * The SSM parameter or Secrets Manager secret a `SecretWatcher` watches.
 */
export abstract class WatchTarget {
  /**
   * Watch an SSM parameter.
   *
   * The watcher is granted `ssm:GetParameter` on the parameter and reads only its version.
   */
  public static fromParameter(parameter: ssm.IParameter): WatchTarget {
    return new ParameterWatchTarget(parameter);
  }

  /**
   * Watch a Secrets Manager secret.
   *
   * The watcher is granted `secretsmanager:DescribeSecret` on the secret, which cannot read the secret value.
   */
  public static fromSecret(secret: secretsmanager.ISecret): WatchTarget {
    return new SecretWatchTarget(secret);
  }

  /**
   * Grants `grantee` the least privilege needed to read the target's version, and returns the
   * values for the custom resource.
   * @internal
   */
  public abstract _bind(scope: Construct, grantee: iam.IGrantable): WatchTargetConfig;
}

class ParameterWatchTarget extends WatchTarget {
  constructor(private readonly parameter: ssm.IParameter) {
    super();
  }

  public _bind(_scope: Construct, grantee: iam.IGrantable): WatchTargetConfig {
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ssm:GetParameter'],
      resourceArns: [this.parameter.parameterArn],
    });
    return { kind: 'ssm', targetId: this.parameter.parameterName };
  }
}

class SecretWatchTarget extends WatchTarget {
  constructor(private readonly secret: secretsmanager.ISecret) {
    super();
  }

  public _bind(_scope: Construct, grantee: iam.IGrantable): WatchTargetConfig {
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['secretsmanager:DescribeSecret'],
      // A secret imported by name has a partial ARN; IAM needs the 6-character suffix matched.
      resourceArns: [this.secret.secretFullArn ?? `${this.secret.secretArn}-??????`],
    });
    return { kind: 'secretsmanager', targetId: this.secret.secretArn };
  }
}

/**
 * Properties for `SecretWatcher`.
 */
export interface SecretWatcherProps {
  /**
   * The parameter or secret to watch.
   */
  readonly target: WatchTarget;

  /**
   * A value that changes on every deployment, so that CloudFormation runs the watcher each time.
   *
   * Set a fixed value only where a stable template matters, such as a snapshot test.
   *
   * @default Date.now().toString()
   */
  readonly nonce?: string;
}

/**
 * Exposes a hash of the current version of an SSM parameter or Secrets Manager secret,
 * read at deploy time.
 *
 * Pass `hash()` to a property of another resource in the same stack. CloudFormation updates that
 * resource only when the target has a new version since the last deployment, including a version
 * created outside CDK.
 *
 * All watchers in a stack share one Lambda function. Each watcher grants its role access to its
 * own target only.
 *
 * **Note**: the watcher itself runs on every deployment, so `cdk diff` always shows a change to it.
 */
export class SecretWatcher extends Construct {
  private readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: SecretWatcherProps) {
    super(scope, id);

    // One function per stack, shared by every watcher in it.
    const handler = new lambda.SingletonFunction(this, 'Handler', {
      // Changing the uuid renames the function's logical ID, which changes every watcher's ServiceToken.
      uuid: 'a580c4e7-8ff8-4c05-929d-3b7fe281d535',
      lambdaPurpose: 'SecretWatcher',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      // Built by projen's bundle task from src/handler/secret-watcher.ts.
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'assets', 'handler', 'secret-watcher'),
      ),
      timeout: Duration.seconds(30),
    });
    const target = props.target._bind(this, handler);

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: handler.functionArn,
      // Without Provider, a crash before the handler responds otherwise leaves CloudFormation waiting an hour.
      serviceTimeout: Duration.minutes(2),
      resourceType: 'Custom::SecretWatcher',
      properties: {
        Kind: target.kind,
        TargetId: target.targetId,
        Nonce: props.nonce ?? Date.now().toString(),
      },
    });
  }

  /**
   * A hash of the target's current version: the first 32 hex characters of
   * sha256(`<parameter name or secret ARN>:<version>`).
   *
   * It changes only when the target has a new version.
   */
  public hash(): string {
    return this.resource.getAttString('Hash');
  }
}
