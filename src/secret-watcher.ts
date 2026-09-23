import * as path from 'path';
import { CustomResource, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { WatchTargetKind } from './handler/secret-watcher';

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
      resourceArns: [this.secret.secretArn],
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
 * **Note**: the watcher itself runs on every deployment, so `cdk diff` always shows a change to it.
 */
export class SecretWatcher extends Construct {
  private readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: SecretWatcherProps) {
    super(scope, id);

    const onEvent = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      // Built by projen's bundle task from src/handler/secret-watcher.ts.
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'assets', 'handler', 'secret-watcher'),
      ),
      timeout: Duration.seconds(30),
    });
    const target = props.target._bind(this, onEvent);

    const provider = new Provider(this, 'Provider', { onEventHandler: onEvent });

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
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
