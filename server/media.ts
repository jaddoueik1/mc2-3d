import sharp from 'sharp';
import { errorResponse, HttpError, jsonResponse, privateJson } from './http.ts';

export type MediaType = 'glb' | 'image';
export type MediaStatus = 'uploading' | 'ready';

export type MediaAsset = {
  id: string;
  ownerId: string;
  type: MediaType;
  status: MediaStatus;
  privateBucket: string;
  privateKey: string;
  publicBucket: string;
  publicKey: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  finalizedAt: string | null;
};

export type MediaRepository = {
  createUploading(asset: MediaAsset): Promise<void>;
  createUploadGrant(asset: MediaAsset): Promise<{ expiresAt: string }>;
  getAsset(id: string): Promise<MediaAsset | null>;
  finalizeValidatedAsset(asset: MediaAsset, patch: { byteSize: number; mimeType: string; sha256: string }): Promise<MediaAsset | null>;
  setPublicKey(id: string, publicKey: string): Promise<void>;
  findPublishedReadyAsset(id: string): Promise<MediaAsset | null>;
};

export type MediaStorage = {
  getObject(bucket: string, key: string): Promise<Uint8Array | null>;
  createSignedUrl(bucket: string, key: string, expiresInSeconds: number): Promise<string>;
  copyObject(
    sourceBucket: string,
    sourceKey: string,
    destinationBucket: string,
    destinationKey: string,
  ): Promise<void>;
  publicUrl(bucket: string, key: string): string;
};

export type MediaDependencies = {
  repository: MediaRepository;
  storage: MediaStorage;
  newId?: () => string;
  now?: () => Date;
  privateBucket?: string;
  publicBucket?: string;
};

export type RequireCapability = (
  request: Request,
  capability: 'media.manage',
) => Promise<{ userId: string }>;

type MediaResult<T> =
  | { status: 200 | 201; data: T }
  | { status: 400 | 404 | 409 | 502; error: { code: string; message: string } };

const GLB_LIMIT = 25 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const UPLOAD_GRANT_SECONDS = 10 * 60;
const PRIVATE_BUCKET = 'cms-media-private';
const PUBLIC_BUCKET = 'cms-media-public';

function fail(
  status: 400 | 404 | 409 | 502,
  code: string,
  message: string,
): MediaResult<never> {
  return { status, error: { code, message } };
}

function defaultNewId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error('Secure UUID generation is unavailable.');
  return id;
}

function isMediaType(value: unknown): value is MediaType {
  return value === 'glb' || value === 'image';
}

function maxBytes(type: MediaType): number {
  return type === 'glb' ? GLB_LIMIT : IMAGE_LIMIT;
}

function hasUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function publicKeyFor(asset: MediaAsset): string {
  if (!asset.sha256) throw new Error('A ready asset must have a checksum.');
  return 'assets/' + asset.id + '/' + asset.sha256;
}

function isImmutablePublicKey(asset: MediaAsset): boolean {
  return (
    typeof asset.publicKey === 'string' &&
    typeof asset.sha256 === 'string' &&
    asset.publicKey === publicKeyFor(asset) &&
    /^assets\/[0-9a-f-]{36}\/[a-f0-9]{64}$/.test(asset.publicKey)
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}

function base64Bytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const decoded = globalThis.atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function decodeEmbeddedDataUri(value: unknown, limit: number): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) return null;
  const bytes = base64Bytes(match[2]);
  return bytes && bytes.length <= limit ? bytes : null;
}

function readU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, littleEndian);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function saneDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 100000 && height <= 100000 && width * height <= 100_000_000;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((part, index) => bytes[index] === part)) return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset, false);
    if (length > bytes.length - offset - 12) return false;
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const bodyEnd = offset + 8 + length;
    if (readU32(bytes, bodyEnd, false) !== crc32(bytes.slice(offset + 4, bodyEnd))) return false;
    if (!sawIhdr && (type !== 'IHDR' || length !== 13 || !saneDimensions(readU32(bytes, offset + 8, false), readU32(bytes, offset + 12, false)))) return false;
    sawIhdr ||= type === 'IHDR';
    if (type === 'IDAT') sawIdat = true;
    offset = bodyEnd + 4;
    if (type === 'IEND') return sawIhdr && sawIdat && length === 0 && offset === bytes.length;
  }
  return false;
}

function isJpeg(bytes: Uint8Array): boolean {
  // Sharp performs the authoritative marker walk and full pixel decode below.
  // This preflight deliberately checks only the JPEG signature and terminator;
  // duplicating a decoder here risks rejecting valid entropy-coded streams.
  return bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9;
}


function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'RIFF' || readU32(bytes, 4, true) + 8 !== bytes.length || new TextDecoder().decode(bytes.slice(8, 12)) !== 'WEBP') return false;
  const type = new TextDecoder().decode(bytes.slice(12, 16));
  if (type === 'VP8X' && bytes.length >= 30) return saneDimensions(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
  if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) return saneDimensions(1 + ((bytes[21] | bytes[22] << 8) & 0x3fff), 1 + (((bytes[22] >> 6) | bytes[23] << 2 | (bytes[24] & 0x0f) << 10) & 0x3fff));
  return type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a && saneDimensions((bytes[26] | bytes[27] << 8) & 0x3fff, (bytes[28] | bytes[29] << 8) & 0x3fff);
}

async function inspectImage(bytes: Uint8Array): Promise<{ mimeType: string } | null> {
  if (!bytes.length || bytes.length > IMAGE_LIMIT) return null;
  const format = isPng(bytes) ? 'png' : isJpeg(bytes) ? 'jpeg' : isWebp(bytes) ? 'webp' : null;
  if (!format) return null;
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 100_000_000 });
    const metadata = await decoder.metadata();
    // Metadata alone does not decode pixels. Reject animations/multipage inputs and
    // force a complete raw decode before any ready state can be persisted.
    if (metadata.format !== format || typeof metadata.width !== 'number' || typeof metadata.height !== 'number'
      || !saneDimensions(metadata.width, metadata.height) || (metadata.pages ?? 1) !== 1) return null;
    const { data, info } = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (info.width !== metadata.width || info.height !== metadata.height
      || data.length !== info.width * info.height * info.channels) return null;
    return { mimeType: 'image/' + format };
  } catch {
    return null;
  }
}

async function validateGlb(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length < 20 || bytes.length % 4 !== 0) return 'GLB data is not four-byte aligned.';
  const magic = readU32(bytes, 0, true);
  const version = readU32(bytes, 4, true);
  const declaredLength = readU32(bytes, 8, true);
  if (magic !== 0x46546c67 || version !== 2 || declaredLength !== bytes.length) {
    return 'GLB header is invalid.';
  }

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let chunkCount = 0;
  let bin: Uint8Array | null = null;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return 'GLB chunk header is truncated.';
    const length = readU32(bytes, offset, true);
    const type = readU32(bytes, offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || length > bytes.length - offset) return 'GLB chunk exceeds declared length.';
    if (chunkCount === 0) {
      if (type !== 0x4e4f534a) return 'The first GLB chunk must be JSON.';
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(offset, offset + length)).trim());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'GLB JSON must be an object.';
        json = parsed as Record<string, unknown>;
      } catch {
        return 'GLB JSON is invalid.';
      }
    } else {
      if (type !== 0x004e4942 || bin) return 'GLB may contain only one BIN chunk after JSON.';
      bin = bytes.slice(offset, offset + length);
    }
    offset += length;
    chunkCount += 1;
  }
  if (offset !== bytes.length || !json || chunkCount === 0) return 'GLB chunks are invalid.';

  const asset = json.asset;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || (asset as Record<string, unknown>).version !== '2.0') {
    return 'GLB asset version must be 2.0.';
  }

  const buffers = json.buffers;
  if (buffers !== undefined && !Array.isArray(buffers)) return 'GLB buffers must be an array.';
  const resolvedBuffers: Uint8Array[] = [];
  if (Array.isArray(buffers)) {
    for (const [index, buffer] of buffers.entries()) {
      if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) return 'GLB buffer is invalid.';
      const entry = buffer as Record<string, unknown>;
      const length = entry.byteLength;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0) return 'GLB buffer length is invalid.';
      let actual: Uint8Array | null;
      if (entry.uri === undefined) {
        if (index !== 0 || !bin || length > bin.length || bin.length - length > 3) return 'GLB BIN data is missing or short.';
        actual = bin;
      } else {
        actual = decodeEmbeddedDataUri(entry.uri, GLB_LIMIT);
      }
      if (!actual || actual.length < length) return 'GLB buffer URI is external, malformed, or shorter than byteLength.';
      // Exclude BIN padding/unused URI bytes from all bufferView bounds.
      resolvedBuffers.push(actual.subarray(0, length));
    }
  }
  if (bin && (!Array.isArray(buffers) || !buffers.length || (buffers[0] as Record<string, unknown>).uri !== undefined)) return 'GLB BIN chunk has no matching buffer.';
  const views = json.bufferViews;
  if (views !== undefined && !Array.isArray(views)) return 'GLB bufferViews must be an array.';
  const resolvedViews: Uint8Array[] = [];
  if (Array.isArray(views)) for (const view of views) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return 'GLB bufferView is invalid.';
    const entry = view as Record<string, unknown>;
    const index = entry.buffer;
    const length = entry.byteLength;
    const begin = entry.byteOffset === undefined ? 0 : entry.byteOffset;
    if (typeof index !== 'number' || typeof length !== 'number' || typeof begin !== 'number'
      || !Number.isSafeInteger(index) || !Number.isSafeInteger(length) || !Number.isSafeInteger(begin)
      || index < 0 || length <= 0 || begin < 0) return 'GLB bufferView is out of bounds.';
    const buffer = resolvedBuffers[index];
    if (!buffer || begin > buffer.length || length > buffer.length - begin) return 'GLB bufferView is out of bounds.';
    resolvedViews.push(buffer.subarray(begin, begin + length));
  }

  const images = json.images;
  if (images !== undefined && !Array.isArray(images)) return 'GLB images must be an array.';
  if (Array.isArray(images)) for (const item of images) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'GLB image is invalid.';
    const entry = item as Record<string, unknown>;
    let embedded: Uint8Array | null;
    let declaredMime: unknown = entry.mimeType;
    if (entry.uri !== undefined) {
      if (entry.bufferView !== undefined || typeof entry.uri !== 'string') return 'GLB image must have exactly one source.';
      embedded = decodeEmbeddedDataUri(entry.uri, IMAGE_LIMIT);
      const uriMime = /^data:([^;]+);base64,/i.exec(entry.uri)?.[1].toLowerCase();
      if (declaredMime !== undefined && declaredMime !== uriMime) return 'GLB image MIME does not match its data URI.';
      declaredMime = uriMime;
    } else {
      const index = entry.bufferView;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return 'GLB image bufferView is missing or invalid.';
      embedded = resolvedViews[index] ?? null;
    }
    if (!embedded) return 'GLB image source is external, malformed, or unresolved.';
    const image = await inspectImage(embedded);
    if (!image || declaredMime !== image.mimeType) return 'Embedded GLB image must decode completely and match its MIME type.';
  }
  return null;
}

async function inspectBytes(expectedType: MediaType, bytes: Uint8Array): Promise<{ mimeType: string } | { error: string }> {
  if (expectedType === 'glb') {
    const error = await validateGlb(bytes);
    return error ? { error } : { mimeType: 'model/gltf-binary' };
  }
  const image = await inspectImage(bytes);
  return image ?? { error: 'File bytes are not a supported decodable image.' };
}


function requiredEnvironment(name: string): string {
  const globals = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  const value = globals.process?.env?.[name];
  if (!value) throw new Error(name + ' is required for Supabase media access.');
  return value.replace(/\/$/, '');
}

function mediaAssetFromRow(row: Record<string, unknown>): MediaAsset {
  return {
    id: String(row.id),
    ownerId: String(row.created_by ?? ''),
    type: row.asset_kind === 'glb' ? 'glb' : 'image',
    status: row.lifecycle_status === 'ready' ? 'ready' : 'uploading',
    privateBucket: String(row.private_bucket),
    privateKey: String(row.private_path),
    publicBucket: String(row.public_bucket),
    publicKey: typeof row.public_key === 'string' ? row.public_key : null,
    mimeType: typeof row.mime_type === 'string' ? row.mime_type : null,
    byteSize: typeof row.byte_size === 'number' ? row.byte_size : null,
    sha256: typeof row.checksum_sha256 === 'string' ? row.checksum_sha256 : null,
    finalizedAt: typeof row.finalized_at === 'string' ? row.finalized_at : null,
  };
}

export function createSupabaseMediaDependencies(
  fetcher: typeof fetch = fetch,
  url = requiredEnvironment('SUPABASE_URL'),
  serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
): MediaDependencies {
  const headers = { apikey: serviceRoleKey, authorization: 'Bearer ' + serviceRoleKey };

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetcher(url + path, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
  }

  const repository: MediaRepository = {
    async createUploading(asset) {
      const response = await request('/rest/v1/media_assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({
          id: asset.id,
          storage_bucket: asset.privateBucket,
          storage_path: asset.privateKey,
          mime_type: 'application/octet-stream',
          byte_size: 0,
          created_by: asset.ownerId,
          asset_kind: asset.type,
          lifecycle_status: asset.status,
          private_bucket: asset.privateBucket,
          private_path: asset.privateKey,
          public_bucket: asset.publicBucket,
          public_key: asset.publicKey,
          checksum_sha256: asset.sha256,
        }),
      });
      if (!response.ok) throw new Error('Could not create media asset.');
    },
    async createUploadGrant(asset) {
      const response = await request('/rest/v1/media_upload_grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json', prefer: 'return=representation' },
        // Expiry is assigned by the database (now() + 10 minutes), never the browser.
        body: JSON.stringify({ asset_id: asset.id, owner_id: asset.ownerId, bucket_id: asset.privateBucket, object_path: asset.privateKey }),
      });
      if (!response.ok) throw new Error('Could not create upload grant.');
      const rows = await response.json() as Array<{ expires_at?: unknown }>;
      if (rows.length !== 1 || typeof rows[0].expires_at !== 'string') throw new Error('Invalid upload grant response.');
      return { expiresAt: rows[0].expires_at };
    },
    async getAsset(id) {
      const response = await request('/rest/v1/media_assets?id=eq.' + encodeURIComponent(id) + '&select=*');
      if (!response.ok) throw new Error('Could not load media asset.');
      const rows = (await response.json()) as unknown[];
      return rows.length === 1 && rows[0] && typeof rows[0] === 'object'
        ? mediaAssetFromRow(rows[0] as Record<string, unknown>)
        : null;
    },
    async finalizeValidatedAsset(asset, patch) {
      const response = await request('/rest/v1/rpc/finalize_media_upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_asset_id: asset.id,
          verified_user_id: asset.ownerId,
          expected_bucket: asset.privateBucket,
          expected_path: asset.privateKey,
          validated_byte_size: patch.byteSize,
          validated_mime_type: patch.mimeType,
          validated_sha256: patch.sha256,
        }),
      });
      if (!response.ok) throw new Error('Could not finalize media asset.');
      const rows = await response.json() as Record<string, unknown>[];
      return rows.length === 1 ? mediaAssetFromRow(rows[0]) : null;
    },
    async setPublicKey(id, publicKey) {
      const response = await request('/rest/v1/media_assets?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ public_key: publicKey }),
      });
      if (!response.ok) throw new Error('Could not record public media key.');
    },
    async findPublishedReadyAsset(id) {
      const response = await request('/rest/v1/rpc/resolve_published_media_asset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asset_id: id }),
      });
      if (!response.ok) throw new Error('Could not resolve published media.');
      const rows = (await response.json()) as unknown[];
      return rows.length === 1 && rows[0] && typeof rows[0] === 'object'
        ? mediaAssetFromRow(rows[0] as Record<string, unknown>)
        : null;
    },
  };

  const storage: MediaStorage = {
    async getObject(bucket, key) {
      const response = await request('/storage/v1/object/' + encodeURIComponent(bucket) + '/' + key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Could not read private media object.');
      return new Uint8Array(await response.arrayBuffer());
    },
    async createSignedUrl(bucket, key, expiresInSeconds) {
      const response = await request('/storage/v1/object/sign/' + encodeURIComponent(bucket) + '/' + key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!response.ok) throw new Error('Could not create preview URL.');
      const body = (await response.json()) as { signedURL?: unknown };
      if (typeof body.signedURL !== 'string') throw new Error('Preview URL response was invalid.');
      return body.signedURL.startsWith('http') ? body.signedURL : url + '/storage/v1' + body.signedURL;
    },
    async copyObject(sourceBucket, sourceKey, destinationBucket, destinationKey) {
      const response = await request('/storage/v1/object/copy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bucketId: sourceBucket, sourceKey, destinationBucket, destinationKey }),
      });
      if (!response.ok) throw new Error('Could not copy media object.');
    },
    publicUrl(bucket, key) {
      return url + '/storage/v1/object/public/' + encodeURIComponent(bucket) + '/' + key;
    },
  };

  return { repository, storage };
}

export function createMediaService(dependencies: MediaDependencies) {
  const repository = dependencies.repository;
  const storage = dependencies.storage;
  const newId = dependencies.newId ?? defaultNewId;
  const now = dependencies.now ?? (() => new Date());
  const privateBucket = dependencies.privateBucket ?? PRIVATE_BUCKET;
  const publicBucket = dependencies.publicBucket ?? PUBLIC_BUCKET;

  async function authorizeUpload(
    userId: string,
    input: { type: unknown; bytes: unknown },
  ): Promise<MediaResult<{ asset: MediaAsset; privateBucket: string; privateKey: string; expiresAt: string }>> {
    if (!isMediaType(input.type) || typeof input.bytes !== 'number' || !Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      return fail(400, 'INVALID_UPLOAD_REQUEST', 'Upload type and byte size are invalid.');
    }
    if (input.bytes > maxBytes(input.type)) {
      return fail(400, 'UPLOAD_TOO_LARGE', 'The requested upload exceeds its media type limit.');
    }

    const id = newId();
    if (!hasUuid(id)) throw new Error('UUID generator returned an invalid identifier.');
    const privateKey = 'private/' + id;

    const asset: MediaAsset = {
      id,
      ownerId: userId,
      type: input.type,
      status: 'uploading',
      privateBucket,
      privateKey,
      publicBucket,
      publicKey: null,
      mimeType: null,
      byteSize: null,
      sha256: null,
      finalizedAt: null,
    };
    try {
      await repository.createUploading(asset);
      const { expiresAt } = await repository.createUploadGrant(asset);
      return { status: 201, data: { asset, privateBucket, privateKey, expiresAt } };
    } catch {
      return fail(502, 'MEDIA_RECORD_FAILED', 'Could not create the media record.');
    }
  }

  async function finalizeUpload(userId: string, assetId: string): Promise<MediaResult<MediaAsset>> {
    const asset = await repository.getAsset(assetId);
    if (!asset || asset.ownerId !== userId) return fail(404, 'MEDIA_NOT_FOUND', 'Media asset was not found.');
    if (asset.status === 'ready') return { status: 200, data: asset };
    let bytes: Uint8Array | null;
    try {
      bytes = await storage.getObject(asset.privateBucket, asset.privateKey);
    } catch {
      return fail(502, 'MEDIA_READ_FAILED', 'Could not read the upload. Finalization can be retried.');
    }
    if (!bytes) return fail(400, 'UPLOAD_MISSING', 'No upload was found for this media asset.');
    if (bytes.byteLength > maxBytes(asset.type)) {
      return fail(400, 'UPLOAD_TOO_LARGE', 'Uploaded bytes exceed the media type limit.');
    }

    const inspection = await inspectBytes(asset.type, bytes);
    if ('error' in inspection) return fail(400, 'INVALID_MEDIA_CONTENT', inspection.error);
    const sha256 = await sha256Hex(bytes);
    try {
      // No grant state changes before the external read and full validation.
      // The service-only RPC locks/rechecks the grant and media row, then updates both atomically.
      const ready = await repository.finalizeValidatedAsset(asset, { byteSize: bytes.byteLength, mimeType: inspection.mimeType, sha256 });
      if (!ready) return fail(409, 'UPLOAD_GRANT_EXPIRED', 'The upload grant expired or was already finalized.');
      return { status: 200, data: ready };
    } catch {
      return fail(502, 'MEDIA_FINALIZE_FAILED', 'Could not finalize the upload. Finalization can be retried.');
    }
  }

  async function createPrivatePreview(assetId: string): Promise<MediaResult<{ url: string; expiresAt: string }>> {
    const asset = await repository.getAsset(assetId);
    if (!asset || asset.status !== 'ready') return fail(404, 'MEDIA_NOT_FOUND', 'Ready media asset was not found.');
    const url = await storage.createSignedUrl(asset.privateBucket, asset.privateKey, UPLOAD_GRANT_SECONDS);
    return {
      status: 200,
      data: {
        url,
        expiresAt: new Date(now().getTime() + UPLOAD_GRANT_SECONDS * 1000).toISOString(),
      },
    };
  }

  async function copyReadyAssetToPublic(assetId: string): Promise<MediaResult<{ key: string }>> {
    const asset = await repository.getAsset(assetId);
    if (!asset || asset.status !== 'ready' || !asset.sha256) {
      return fail(409, 'MEDIA_NOT_READY', 'Media must be ready before it can be copied to public storage.');
    }
    const key = publicKeyFor(asset);
    if (asset.publicKey === key) return { status: 200, data: { key } };

    try {
      await storage.copyObject(asset.privateBucket, asset.privateKey, asset.publicBucket, key);
    } catch {
      const existing = await storage.getObject(asset.publicBucket, key);
      if (!existing || existing.byteLength !== asset.byteSize || (await sha256Hex(existing)) !== asset.sha256) {
        return fail(502, 'PUBLIC_COPY_FAILED', 'Copying media to public storage failed.');
      }
    }
    await repository.setPublicKey(asset.id, key);
    return { status: 200, data: { key } };
  }

  async function resolvePublishedMedia(assetId: string): Promise<MediaResult<{ key: string; url: string; mimeType: string }>> {
    const asset = await repository.findPublishedReadyAsset(assetId);
    const key = asset?.publicKey;
    if (!asset || !asset.mimeType || !key || !isImmutablePublicKey(asset)) {
      return fail(404, 'MEDIA_NOT_FOUND', 'Published media was not found.');
    }
    return {
      status: 200,
      data: {
        key,
        url: storage.publicUrl(asset.publicBucket, key),
        mimeType: asset.mimeType,
      },
    };
  }

  return {
    authorizeUpload,
    finalizeUpload,
    createPrivatePreview,
    copyReadyAssetToPublic,
    resolvePublishedMedia,
  };
}

export type MediaService = ReturnType<typeof createMediaService>;

function resultResponse(result: MediaResult<unknown>, request: Request): Response {
  if ('error' in result) {
    return errorResponse(new HttpError(result.status, result.error.code, result.error.message), request);
  }
  return privateJson({ data: result.data }, { status: result.status }, request);
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
}

export function createMediaAdminHandler(dependencies: {
  service: MediaService;
  requireCapability: RequireCapability;
}) {
  return async function handleAdminMedia(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upload = /^\/api\/admin\/media\/upload\/?$/i.test(url.pathname);
    const match = /^\/api\/admin\/media\/([0-9a-f-]+)\/(finalize|preview)\/?$/i.exec(url.pathname);
    if (!upload && !match) {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Route was not found.' } }, { status: 404 }, request);
    }

    const assetId = match?.[1];
    const action = match?.[2];
    try {
      const user = await dependencies.requireCapability(request, 'media.manage');
      if (request.method === 'POST' && upload) {
        const body = await requestJson(request);
        return resultResponse(
          await dependencies.service.authorizeUpload(user.userId, { type: body.type, bytes: body.bytes }),
          request,
        );
      }
      if (request.method === 'POST' && assetId && action === 'finalize') {
        return resultResponse(await dependencies.service.finalizeUpload(user.userId, assetId), request);
      }
      if (request.method === 'GET' && assetId && action === 'preview') {
        return resultResponse(await dependencies.service.createPrivatePreview(assetId), request);
      }
      return jsonResponse({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method is not allowed.' } }, { status: 405 }, request);
    } catch (error) {
      return errorResponse(error, request);
    }
  };
}
