import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { describe, expect, test } from 'vite-plus/test';
import { handler } from '../src/handler/secret-watcher';

function event(requestType: 'Create' | 'Delete', kind: string): CloudFormationCustomResourceEvent {
  const base = {
    ServiceToken: 'token',
    ResponseURL: 'https://example.com',
    StackId: 'stack',
    RequestId: 'req',
    LogicalResourceId: 'Watcher',
    ResourceType: 'Custom::SecretWatcher',
    ResourceProperties: { ServiceToken: 'token', Kind: kind, TargetId: 'target', Nonce: 'n' },
  };
  return requestType === 'Delete'
    ? { ...base, RequestType: 'Delete', PhysicalResourceId: 'target' }
    : { ...base, RequestType: 'Create' };
}

describe('secret-watcher handler', () => {
  test('an unknown Kind fails as unreachable', async () => {
    await expect(handler(event('Create', 'unknown'))).rejects.toThrow(
      'Unreachable: unexpected Kind "unknown"',
    );
  });

  test('Delete does nothing and returns {} regardless of Kind', async () => {
    await expect(handler(event('Delete', 'unknown'))).resolves.toEqual({});
  });
});
