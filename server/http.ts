import { AuthorizationError } from './auth.ts';

export type FieldErrors = Record<string, string[]>;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: FieldErrors;

  constructor(status: number, code: string, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function requestIdFrom(request?: Request): string {
  const existing = request?.headers.get('x-request-id');
  if (existing && existing.length <= 128) return existing;

  const cryptoApi = globalThis.crypto;
  return cryptoApi?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
  request?: Request,
  requestId = requestIdFrom(request),
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-request-id', requestId);
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function privateJson(
  body: unknown,
  init: ResponseInit = {},
  request?: Request,
  requestId = requestIdFrom(request),
): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'private, no-store');
  return jsonResponse(body, { ...init, headers }, request, requestId);
}

export function errorResponse(error: unknown, request?: Request): Response {
  const normalized =
    error instanceof HttpError || error instanceof AuthorizationError
      ? error
      : {
          status: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          fieldErrors: undefined,
        };
  const requestId = requestIdFrom(request);

  const payload: {
    error: {
      code: string;
      message: string;
      fieldErrors?: FieldErrors;
      requestId: string;
    };
  } = {
    error: {
      code: normalized.code,
      message: normalized.message,
      requestId,
    },
  };

  if (normalized instanceof HttpError && normalized.fieldErrors) {
    payload.error.fieldErrors = normalized.fieldErrors;
  }

  return privateJson(payload, { status: normalized.status }, request, requestId);
}
