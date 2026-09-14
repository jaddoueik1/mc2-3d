export type Capability =
  | 'content.read'
  | 'content.edit'
  | 'metrics.edit'
  | 'media.manage'
  | 'content.publish'
  | 'users.manage';

export type AuthenticatedUser = { userId: string };

export type BearerVerifier = {
  verifyBearer(token: string): Promise<AuthenticatedUser | null>;
};

export type CapabilityGrantReader = {
  hasActiveCapability(token: string, userId: string, capability: Capability): Promise<boolean>;
};

export type CapabilityDependencies = {
  auth: BearerVerifier;
  grants: CapabilityGrantReader;
};

export class AuthorizationError extends Error {
  readonly status: 401 | 403 | 500;
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'AUTH_CONFIGURATION_ERROR';

  constructor(
    status: 401 | 403 | 500,
    code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'AUTH_CONFIGURATION_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
    this.code = code;
  }
}

function extractBearer(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;

  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function requiredEnvironment(name: string): string {
  const globals = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const value = globals.process?.env?.[name];
  if (!value) {
    throw new AuthorizationError(
      500,
      'AUTH_CONFIGURATION_ERROR',
      'Authentication is not configured.',
    );
  }
  return value.replace(/\/$/, '');
}

function supabaseFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export function createSupabaseDependencies(
  fetcher: typeof fetch = supabaseFetch,
  url = requiredEnvironment('SUPABASE_URL'),
  anonKey = requiredEnvironment('SUPABASE_ANON_KEY'),
): CapabilityDependencies {
  const commonHeaders = { apikey: anonKey };

  return {
    auth: {
      async verifyBearer(token) {
        const response = await fetcher(url + '/auth/v1/user', {
          headers: { ...commonHeaders, authorization: 'Bearer ' + token },
        });
        if (response.status === 401 || response.status === 403) return null;
        if (!response.ok) throw new Error('Supabase Auth user verification failed.');

        const body = (await response.json()) as { id?: unknown };
        return typeof body.id === 'string' && body.id.length > 0 ? { userId: body.id } : null;
      },
    },
    grants: {
      async hasActiveCapability(token, userId, capability) {
        const response = await fetcher(url + '/rest/v1/rpc/has_current_capability', {
          method: 'POST',
          headers: {
            ...commonHeaders,
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ required_capability: capability }),
        });
        if (response.status === 401 || response.status === 403) return false;
        if (!response.ok) throw new Error('Capability lookup failed.');

        return (await response.json()) === true && userId.length > 0;
      },
    },
  };
}

export function createCapabilityGuard(dependencies: CapabilityDependencies) {
  return async function requireCapability(
    request: Request,
    capability: Capability,
  ): Promise<{ userId: string }> {
    const token = extractBearer(request);
    if (!token) {
      throw new AuthorizationError(401, 'UNAUTHENTICATED', 'A bearer token is required.');
    }

    const user = await dependencies.auth.verifyBearer(token);
    if (!user) {
      throw new AuthorizationError(401, 'UNAUTHENTICATED', 'The bearer token is invalid or expired.');
    }

    const allowed = await dependencies.grants.hasActiveCapability(token, user.userId, capability);
    if (!allowed) {
      throw new AuthorizationError(403, 'FORBIDDEN', 'You do not have this capability.');
    }

    return { userId: user.userId };
  };
}

let defaultDependencies: CapabilityDependencies | undefined;

export async function requireCapability(
  request: Request,
  capability: Capability,
): Promise<{ userId: string }> {
  defaultDependencies ??= createSupabaseDependencies();
  return createCapabilityGuard(defaultDependencies)(request, capability);
}
