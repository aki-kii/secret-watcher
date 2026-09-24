import { createHash } from 'node:crypto';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { handler } from '../src/handler/secret-watcher';

function event(
  requestType: 'Create' | 'Update' | 'Delete',
  kind: string,
): CloudFormationCustomResourceEvent {
  const base = {
    ServiceToken: 'token',
    ResponseURL: 'https://example.com',
    StackId: 'stack',
    RequestId: 'req',
    LogicalResourceId: 'Watcher',
    ResourceType: 'Custom::SecretWatcher',
    ResourceProperties: { ServiceToken: 'token', Kind: kind, TargetId: 'target', Nonce: 'n' },
  };
  switch (requestType) {
    case 'Create':
      return { ...base, RequestType: 'Create' };
    case 'Update':
      return {
        ...base,
        RequestType: 'Update',
        PhysicalResourceId: 'target',
        OldResourceProperties: base.ResourceProperties,
      };
    case 'Delete':
      return { ...base, RequestType: 'Delete', PhysicalResourceId: 'target' };
  }
}

const hashOf = (version: string) =>
  createHash('sha256').update(`target:${version}`).digest('hex').slice(0, 32);

// The handler's clients are created at import time, so stub the method they share.
function stubSsm(...versions: (number | undefined)[]) {
  const send = vi.spyOn(SSMClient.prototype, 'send');
  for (const Version of versions) {
    send.mockResolvedValueOnce({ Parameter: { Version } } as never);
  }
  return send;
}

function stubSecret(...stagesList: Record<string, string[]>[]) {
  const send = vi.spyOn(SecretsManagerClient.prototype, 'send');
  for (const VersionIdsToStages of stagesList) {
    send.mockResolvedValueOnce({ VersionIdsToStages } as never);
  }
  return send;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('secret-watcher handler', () => {
  test('hashes the parameter version, read without decryption', async () => {
    const send = stubSsm(3);

    const result = await handler(event('Create', 'ssm'));

    expect(result).toEqual({ PhysicalResourceId: 'target', Data: { Hash: hashOf('3') } });
    expect(send.mock.calls[0][0].input).toEqual({ Name: 'target', WithDecryption: false });
  });

  test('the hash stays for the same version and changes for a new one', async () => {
    stubSsm(3, 3, 4);

    const first = await handler(event('Create', 'ssm'));
    const same = await handler(event('Update', 'ssm'));
    const next = await handler(event('Update', 'ssm'));

    expect(same.Data).toEqual(first.Data);
    expect(next.Data).not.toEqual(first.Data);
  });

  test('a parameter without a version fails', async () => {
    stubSsm(undefined);

    await expect(handler(event('Create', 'ssm'))).rejects.toThrow('Parameter version not found');
  });

  test('hashes the secret version staged AWSCURRENT, not the others', async () => {
    stubSecret({ old: ['AWSPREVIOUS'], cur: ['AWSPENDING', 'AWSCURRENT'], next: ['AWSPENDING'] });

    const result = await handler(event('Update', 'secretsmanager'));

    expect(result).toEqual({ PhysicalResourceId: 'target', Data: { Hash: hashOf('cur') } });
  });

  test('a secret without an AWSCURRENT version fails', async () => {
    stubSecret({ old: ['AWSPREVIOUS'] });

    await expect(handler(event('Create', 'secretsmanager'))).rejects.toThrow(
      'AWSCURRENT version not found: target',
    );
  });

  test('an unknown Kind fails as unreachable', async () => {
    await expect(handler(event('Create', 'unknown'))).rejects.toThrow(
      'Unreachable: unexpected Kind "unknown"',
    );
  });

  test('Delete does nothing and returns {} regardless of Kind', async () => {
    await expect(handler(event('Delete', 'unknown'))).resolves.toEqual({});
  });
});
