import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AuthorizationError,
  createCapabilityGuard,
  type Capability,
} from '../server/auth.ts';
import { errorResponse, HttpError } from '../server/http.ts';

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

describe('errorResponse', () => {
  it('serializes an authentication failure as the standardized 401 response', async () => {
    const response = errorResponse(
      new AuthorizationError(401, 'UNAUTHENTICATED', 'A bearer token is required.'),
      request(),
    );
    const body = (await response.json()) as { error: { code: string; requestId: string } };

    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-request-id'), body.error.requestId);
    assert.ok(body.error.requestId.length > 0);
  });

  it('serializes authorization failures and reuses an inbound request ID', async () => {
    const upstreamRequest = new Request('https://cms.example.test/api/private', {
      headers: { 'x-request-id': 'gateway-request-123' },
    });
    const response = errorResponse(
      new AuthorizationError(403, 'FORBIDDEN', 'You do not have this capability.'),
      upstreamRequest,
    );
    const body = (await response.json()) as { error: { code: string; requestId: string } };

    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
    assert.equal(body.error.requestId, 'gateway-request-123');
    assert.equal(response.headers.get('x-request-id'), 'gateway-request-123');
  });

  it('keeps field errors in the standardized response envelope', async () => {
    const response = errorResponse(
      new HttpError(422, 'VALIDATION_ERROR', 'Input is invalid.', { title: ['Required'] }),
    );
    const body = (await response.json()) as {
      error: { code: string; fieldErrors?: Record<string, string[]>; requestId: string };
    };

    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(body.error.fieldErrors, { title: ['Required'] });
    assert.equal(response.headers.get('x-request-id'), body.error.requestId);
  });
});
