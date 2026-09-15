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
  createFinalizationGrant(assetId: string, expiresAt: string): Promise<void>;
  claimFinalizationGrant(assetId: string, now: string): Promise<boolean>;
  getAsset(id: string): Promise<MediaAsset | null>;
  markReady(id: string, patch: Pick<MediaAsset, 'byteSize' | 'mimeType' | 'sha256'>): Promise<void>;
  setPublicKey(id: string, publicKey: string): Promise<void>;
  findPublishedReadyAsset(id: string): Promise<MediaAsset | null>;
};

export type MediaStorage = {
  createUploadGrant(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<{ url: string; token: string; expiresInSeconds?: number }>;
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
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
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
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let frame = false;
  let sos = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && sos && offset === bytes.length;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 8 || !saneDimensions((bytes[offset + 5] << 8) | bytes[offset + 6], (bytes[offset + 3] << 8) | bytes[offset + 4])) return false;
      frame = true;
    }
    offset += length;
    if (marker === 0xda) {
      sos = true;
      while (offset < bytes.length - 1) {
        if (bytes[offset++] !== 0xff) continue;
        const next = bytes[offset++];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue;
        if (next === 0xd9) return frame && offset === bytes.length;
        offset -= 2;
        break;
      }
    }
  }
  return false;
}

function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 14 || (new TextDecoder().decode(bytes.slice(0, 6)) !== 'GIF87a' && new TextDecoder().decode(bytes.slice(0, 6)) !== 'GIF89a') || !saneDimensions(bytes[6] | bytes[7] << 8, bytes[8] | bytes[9] << 8)) return false;
  let offset = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let image = false;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return image && offset === bytes.length;
    if (marker === 0x2c) {
      if (offset + 9 > bytes.length || !saneDimensions(bytes[offset + 4] | bytes[offset + 5] << 8, bytes[offset + 6] | bytes[offset + 7] << 8)) return false;
      offset += 9 + (bytes[offset + 8] & 0x80 ? 3 * (1 << ((bytes[offset + 8] & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset++] < 2) return false;
      image = true;
    } else if (marker !== 0x21 || offset >= bytes.length) return false;
    else offset += 1;
    while (offset < bytes.length) { const size = bytes[offset++]; if (size === 0) break; if (offset + size > bytes.length) return false; offset += size; }
  }
  return false;
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'RIFF' || readU32(bytes, 4, true) + 8 !== bytes.length || new TextDecoder().decode(bytes.slice(8, 12)) !== 'WEBP') return false;
  const type = new TextDecoder().decode(bytes.slice(12, 16));
  if (type === 'VP8X' && bytes.length >= 30) return saneDimensions(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
  if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) return saneDimensions(1 + ((bytes[21] | bytes[22] << 8) & 0x3fff), 1 + (((bytes[22] >> 6) | bytes[23] << 2 | (bytes[24] & 0x0f) << 10) & 0x3fff));
  return type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a && saneDimensions((bytes[26] | bytes[27] << 8) & 0x3fff, (bytes[28] | bytes[29] << 8) & 0x3fff);
}

function inspectImage(bytes: Uint8Array): { mimeType: string } | null {
  if (isPng(bytes)) return { mimeType: 'image/png' };
  if (isJpeg(bytes)) return { mimeType: 'image/jpeg' };
  if (isGif(bytes)) return { mimeType: 'image/gif' };
  if (isWebp(bytes)) return { mimeType: 'image/webp' };
  return null;
}

function validateGlb(bytes: Uint8Array): string | null {
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
  if (Array.isArray(buffers)) {
    for (const buffer of buffers) {
      if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) return 'GLB buffer is invalid.';
      const entry = buffer as Record<string, unknown>;
      if (!Number.isSafeInteger(entry.byteLength) || (entry.byteLength as number) < 0) return 'GLB buffer length is invalid.';
      if (entry.uri === undefined && (!bin || entry.byteLength > bin.byteLength)) return 'GLB BIN data is missing or short.';
      if (entry.uri !== undefined && !decodeEmbeddedDataUri(entry.uri, GLB_LIMIT)) return 'GLB buffer URI is external or malformed.';
    }
  }
  const views = json.bufferViews;
  if (views !== undefined && !Array.isArray(views)) return 'GLB bufferViews must be an array.';
  if (Array.isArray(views)) for (const view of views) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return 'GLB bufferView is invalid.';
    const entry = view as Record<string, unknown>;
    const index = entry.buffer;
    const length = entry.byteLength;
    const begin = entry.byteOffset ?? 0;
    if (!Number.isInteger(index) || !Number.isSafeInteger(length) || !Number.isSafeInteger(begin) || index < 0 || length < 0 || begin < 0 || !Array.isArray(buffers) || !buffers[index] || typeof buffers[index] !== 'object' || begin + length > ((buffers[index] as Record<string, unknown>).byteLength as number)) return 'GLB bufferView is out of bounds.';
  }

  for (const collectionName of ['buffers', 'images'] as const) {
    const collection = json[collectionName];
    if (collection === undefined) continue;
    if (!Array.isArray(collection)) return 'GLB ' + collectionName + ' must be an array.';
    for (const item of collection) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'GLB ' + collectionName + ' entry is invalid.';
      const uri = (item as Record<string, unknown>).uri;
      if (uri !== undefined) {
        const embedded = decodeEmbeddedDataUri(uri, GLB_LIMIT);
        if (!embedded) return 'GLB may not reference external or malformed data URIs.';
        if (collectionName === 'images' && !inspectImage(embedded)) {
          return 'Embedded GLB images must be decodable supported images.';
        }
      }
    }
  }
  return null;
}

function inspectBytes(expectedType: MediaType, bytes: Uint8Array): { mimeType: string } | { error: string } {
  if (expectedType === 'glb') {
    const error = validateGlb(bytes);
    return error ? { error } : { mimeType: 'model/gltf-binary' };
  }
  const image = inspectImage(bytes);
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
          mime_type: asset.mimeType,
          byte_size: asset.byteSize,
          checksum_sha256: asset.sha256,
        }),
      });
      if (!response.ok) throw new Error('Could not create media asset.');
    },
    async createFinalizationGrant(assetId, expiresAt) {
      const response = await request('/rest/v1/media_upload_grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ asset_id: assetId, expires_at: expiresAt }),
      });
      if (!response.ok) throw new Error('Could not create finalization grant.');
    },
    async claimFinalizationGrant(assetId, now) {
      const response = await request(
        '/rest/v1/media_upload_grants?asset_id=eq.' + encodeURIComponent(assetId) +
          '&claimed_at=is.null&expires_at=gt.' + encodeURIComponent(now),
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', prefer: 'return=representation' },
          body: JSON.stringify({ claimed_at: now }),
        },
      );
      if (!response.ok) throw new Error('Could not claim finalization grant.');
      return ((await response.json()) as unknown[]).length === 1;
    },
    async getAsset(id) {
      const response = await request('/rest/v1/media_assets?id=eq.' + encodeURIComponent(id) + '&select=*');
      if (!response.ok) throw new Error('Could not load media asset.');
      const rows = (await response.json()) as unknown[];
      return rows.length === 1 && rows[0] && typeof rows[0] === 'object'
        ? mediaAssetFromRow(rows[0] as Record<string, unknown>)
        : null;
    },
    async markReady(id, patch) {
      const response = await request('/rest/v1/media_assets?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({
          lifecycle_status: 'ready',
          byte_size: patch.byteSize,
          mime_type: patch.mimeType,
          checksum_sha256: patch.sha256,
          finalized_at: new Date().toISOString(),
        }),
      });
      if (!response.ok) throw new Error('Could not finalize media asset.');
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
    async createUploadGrant(bucket, key, expiresInSeconds) {
      const response = await request('/storage/v1/object/upload/sign/' + encodeURIComponent(bucket) + '/' + key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error('Could not create upload grant.');
      const body = (await response.json()) as { url?: unknown; token?: unknown };
      if (typeof body.url !== 'string' || typeof body.token !== 'string') {
        throw new Error('Upload grant response was invalid.');
      }
      return {
        url: body.url.startsWith('http') ? body.url : url + '/storage/v1' + body.url,
        token: body.token,
        expiresInSeconds,
      };
    },
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
  ): Promise<MediaResult<{ asset: MediaAsset; uploadUrl: string; uploadToken: string; privateKey: string; expiresAt: string }>> {
    if (!isMediaType(input.type) || typeof input.bytes !== 'number' || !Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      return fail(400, 'INVALID_UPLOAD_REQUEST', 'Upload type and byte size are invalid.');
    }
    if (input.bytes > maxBytes(input.type)) {
      return fail(400, 'UPLOAD_TOO_LARGE', 'The requested upload exceeds its media type limit.');
    }

    const id = newId();
    if (!hasUuid(id)) throw new Error('UUID generator returned an invalid identifier.');
    const privateKey = 'private/' + id;
    let grant: { url: string; token: string; expiresInSeconds?: number };
    try {
      grant = await storage.createUploadGrant(privateBucket, privateKey, UPLOAD_GRANT_SECONDS);
    } catch {
      return fail(502, 'UPLOAD_GRANT_FAILED', 'Could not create a private upload grant.');
    }

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
    const expiresAt = new Date(now().getTime() + UPLOAD_GRANT_SECONDS * 1000).toISOString();
    try {
      await repository.createUploading(asset);
      await repository.createFinalizationGrant(asset.id, expiresAt);
    } catch {
      return fail(502, 'MEDIA_RECORD_FAILED', 'Could not create the media record.');
    }
    return { status: 201, data: { asset, uploadUrl: grant.url, uploadToken: grant.token, privateKey, expiresAt } };
  }

  async function finalizeUpload(userId: string, assetId: string): Promise<MediaResult<MediaAsset>> {
    const asset = await repository.getAsset(assetId);
    if (!asset) return fail(404, 'MEDIA_NOT_FOUND', 'Media asset was not found.');
    if (asset.status === 'ready') return { status: 200, data: asset };
    if (!(await repository.claimFinalizationGrant(asset.id, now().toISOString()))) {
      return fail(409, 'UPLOAD_GRANT_EXPIRED', 'The app finalization grant has expired or was already used.');
    }

    const bytes = await storage.getObject(asset.privateBucket, asset.privateKey);
    if (!bytes) return fail(400, 'UPLOAD_MISSING', 'No upload was found for this media asset.');
    if (bytes.byteLength > maxBytes(asset.type)) {
      return fail(400, 'UPLOAD_TOO_LARGE', 'Uploaded bytes exceed the media type limit.');
    }

    const inspection = inspectBytes(asset.type, bytes);
    if ('error' in inspection) return fail(400, 'INVALID_MEDIA_CONTENT', inspection.error);
    const sha256 = await sha256Hex(bytes);
    await repository.markReady(asset.id, { byteSize: bytes.byteLength, mimeType: inspection.mimeType, sha256 });

    const ready = await repository.getAsset(asset.id);
    if (!ready) throw new Error('Media asset disappeared after finalization.');
    return { status: 200, data: ready };
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
