import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AuthorizationError,
  createCapabilityGuard,
  type Capability,
} from '../server/auth.ts';

const userId = '00000000-0000-0000-0000-000000000101';

function request(token?: string): Request {
  return new Request('https://cms.example.test/api/private', {
    headers: token ? { authorization: 'Bearer ' + token } : {},
  });
}

function guardFor(grants: Set<Capability>) {
  return createCapabilityGuard({
    auth: {
      async verifyBearer(token) {
        return token === 'valid-token' || token === 'revoked-token' ? { userId } : null;
      },
    },
    grants: {
      async hasActiveCapability(token, verifiedUserId, capability) {
        return token !== 'revoked-token' && verifiedUserId === userId && grants.has(capability);
      },
    },
  });
}

describe('requireCapability', () => {
  it('returns 401 when a bearer token is missing', async () => {
    await assert.rejects(
      () => guardFor(new Set())(request(), 'content.read'),
      (error: unknown) =>
        error instanceof AuthorizationError &&
        error.status === 401 &&
        error.code === 'UNAUTHENTICATED',
    );
  });

  it('returns 401 when Supabase Auth rejects the token', async () => {
    await assert.rejects(
      () => guardFor(new Set())(request('bad-token'), 'content.read'),
      (error: unknown) => error instanceof AuthorizationError && error.status === 401,
    );
  });

  it('allows a verified user with a current database grant', async () => {
    const result = await guardFor(new Set<Capability>(['content.read']))(
      request('valid-token'),
      'content.read',
    );
    assert.deepEqual(result, { userId });
  });

  it('returns 403 when the verified user lacks the requested capability', async () => {
    await assert.rejects(
      () => guardFor(new Set<Capability>(['content.read']))(
        request('valid-token'),
        'content.publish',
      ),
      (error: unknown) =>
        error instanceof AuthorizationError &&
        error.status === 403 &&
        error.code === 'FORBIDDEN',
    );
  });

  it('observes revoked grants on the next request', async () => {
    const grants = new Set<Capability>(['content.publish']);
    const guard = guardFor(grants);

    await guard(request('valid-token'), 'content.publish');
    grants.delete('content.publish');

    await assert.rejects(
      () => guard(request('valid-token'), 'content.publish'),
      (error: unknown) => error instanceof AuthorizationError && error.status === 403,
    );
  });
});
