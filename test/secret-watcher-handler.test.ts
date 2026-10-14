import { createHash } from 'node:crypto';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { handler } from '../src/handler/secret-watcher';

const RESPONSE_URL = 'https://example.com/response';

function event(
  requestType: 'Create' | 'Update' | 'Delete',
  kind: string,
): CloudFormationCustomResourceEvent {
  const base = {
    ServiceToken: 'token',
    ResponseURL: RESPONSE_URL,
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

const fetchMock = vi.fn<typeof fetch>();

/** Runs the handler and returns the response it sent to CloudFormation. */
async function run(
  e: CloudFormationCustomResourceEvent,
): Promise<CloudFormationCustomResourceResponse> {
  fetchMock.mockClear();
  await handler(e);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(RESPONSE_URL);
  expect(init?.method).toBe('PUT');
  return JSON.parse(init?.body as string);
}

const request = { StackId: 'stack', RequestId: 'req', LogicalResourceId: 'Watcher' };

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('secret-watcher handler', () => {
  test('hashes the parameter version, read without decryption', async () => {
    const send = stubSsm(3);

    const response = await run(event('Create', 'ssm'));

    expect(response).toEqual({
      ...request,
      Status: 'SUCCESS',
      PhysicalResourceId: 'target',
      Data: { Hash: hashOf('3') },
    });
    expect(send.mock.calls[0][0].input).toEqual({ Name: 'target', WithDecryption: false });
  });

  test('the hash stays for the same version and changes for a new one', async () => {
    stubSsm(3, 3, 4);

    const first = await run(event('Create', 'ssm'));
    const same = await run(event('Update', 'ssm'));
    const next = await run(event('Update', 'ssm'));

    expect(same.Data).toEqual(first.Data);
    expect(next.Data).not.toEqual(first.Data);
  });

  test('a parameter without a version fails', async () => {
    stubSsm(undefined);

    const response = await run(event('Update', 'ssm'));

    expect(response).toEqual({
      ...request,
      Status: 'FAILED',
      Reason: 'Parameter version not found: target',
      PhysicalResourceId: 'target',
    });
  });

  test('hashes the secret version staged AWSCURRENT, not the others', async () => {
    stubSecret({ old: ['AWSPREVIOUS'], cur: ['AWSPENDING', 'AWSCURRENT'], next: ['AWSPENDING'] });

    const response = await run(event('Update', 'secretsmanager'));

    expect(response).toMatchObject({
      Status: 'SUCCESS',
      PhysicalResourceId: 'target',
      Data: { Hash: hashOf('cur') },
    });
  });

  test('a secret without an AWSCURRENT version fails', async () => {
    stubSecret({ old: ['AWSPREVIOUS'] });

    const response = await run(event('Create', 'secretsmanager'));

    expect(response).toMatchObject({
      Status: 'FAILED',
      Reason: 'AWSCURRENT version not found: target',
    });
  });

  test('a failed Create still sends a physical ID, which CloudFormation requires', async () => {
    vi.spyOn(SSMClient.prototype, 'send').mockRejectedValueOnce(new Error('AccessDenied') as never);

    const response = await run(event('Create', 'ssm'));

    expect(response).toMatchObject({ Status: 'FAILED', Reason: 'AccessDenied' });
    expect(response.PhysicalResourceId).toBeTruthy();
  });

  test('an unknown Kind fails as unreachable', async () => {
    const response = await run(event('Create', 'unknown'));

    expect(response).toMatchObject({
      Status: 'FAILED',
      Reason: 'Unreachable: unexpected Kind "unknown"',
    });
  });

  test('Delete succeeds with the same physical ID regardless of Kind', async () => {
    const response = await run(event('Delete', 'unknown'));

    expect(response).toEqual({ ...request, Status: 'SUCCESS', PhysicalResourceId: 'target' });
  });

  test('a rejected response throws, so the invocation is retried', async () => {
    stubSsm(3);
    fetchMock.mockResolvedValue(new Response(null, { status: 403, statusText: 'Forbidden' }));

    await expect(handler(event('Create', 'ssm'))).rejects.toThrow(
      'Failed to send the response: 403 Forbidden',
    );
  });
});
