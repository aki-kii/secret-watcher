import { createHash } from 'node:crypto';
import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';
import type { WatchTargetKind } from './kind';

const ssm = new SSMClient({});
const sm = new SecretsManagerClient({});

type Response = Partial<Pick<CloudFormationCustomResourceResponse, 'PhysicalResourceId' | 'Data'>>;

function assertNever(x: never): never {
  throw new Error(`Unreachable: unexpected Kind ${JSON.stringify(x)}`);
}

/** Returns the target's current version without reading its value. */
async function resolveVersion(kind: WatchTargetKind, targetId: string): Promise<string> {
  switch (kind) {
    case 'ssm': {
      const res = await ssm.send(
        new GetParameterCommand({ Name: targetId, WithDecryption: false }),
      );
      const version = res.Parameter?.Version;
      if (version === undefined) throw new Error(`Parameter version not found: ${targetId}`);
      return String(version);
    }
    case 'secretsmanager': {
      const res = await sm.send(new DescribeSecretCommand({ SecretId: targetId }));
      const current = Object.entries(res.VersionIdsToStages ?? {}).find(([, stages]) =>
        stages.includes('AWSCURRENT'),
      );
      if (!current) throw new Error(`AWSCURRENT version not found: ${targetId}`);
      return current[0];
    }
    default:
      return assertNever(kind);
  }
}

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<Response> => {
  const props = event.ResourceProperties;
  // Parameter name or secret ARN.
  const physicalResourceId: string = props.TargetId;

  if (event.RequestType === 'Delete') {
    console.log(JSON.stringify({ RequestType: event.RequestType, physicalResourceId }));
    return {};
  }

  // CloudFormation sends an untyped string; the switch default rejects unknown values.
  const version = await resolveVersion(props.Kind as WatchTargetKind, props.TargetId);

  // Expose a hash of the ID and version, never the raw version.
  const hash = createHash('sha256')
    .update(`${physicalResourceId}:${version}`)
    .digest('hex')
    .slice(0, 32);

  console.log(
    JSON.stringify({
      RequestType: event.RequestType,
      physicalResourceId,
      Nonce: props.Nonce,
      hash,
    }),
  );
  return { PhysicalResourceId: physicalResourceId, Data: { Hash: hash } };
};
