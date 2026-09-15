import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthorizationError } from '../server/auth.ts';
import {
  createMediaAdminHandler,
  createMediaService,
  type MediaAsset,
  type MediaRepository,
  type MediaStorage,
} from '../server/media.ts';

const editor = '00000000-0000-0000-0000-000000000101';
const outsider = '00000000-0000-0000-0000-000000000102';

function validGlb(): Uint8Array {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"buffers":[],"images":[]}');
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4);
  padded.set(json);
  padded.fill(0x20, json.length);
  const bytes = new Uint8Array(12 + 8 + padded.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(padded, 20);
  return bytes;
}

function validPng(): Uint8Array {
  return Uint8Array.from(globalThis.atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqXQAAAABJRU5ErkJggg=='), (part) => part.charCodeAt(0));
}

class MemoryRepository implements MediaRepository {
  readonly assets = new Map<string, MediaAsset>();
  readonly published = new Set<string>();
  readonly grants = new Map<string, { expiresAt: string; claimed: boolean }>();

  async createUploading(asset: MediaAsset): Promise<void> {
    this.assets.set(asset.id, asset);
  }

  async createFinalizationGrant(assetId: string, expiresAt: string): Promise<void> {
    this.grants.set(assetId, { expiresAt, claimed: false });
  }

  async claimFinalizationGrant(assetId: string, now: string): Promise<boolean> {
    const grant = this.grants.get(assetId);
    if (!grant || grant.claimed || grant.expiresAt <= now) return false;
    grant.claimed = true;
    return true;
  }

  async getAsset(id: string): Promise<MediaAsset | null> {
    return this.assets.get(id) ?? null;
  }

  async markReady(id: string, patch: Pick<MediaAsset, 'byteSize' | 'mimeType' | 'sha256'>): Promise<void> {
    const asset = this.assets.get(id);
    if (!asset) throw new Error('missing asset');
    this.assets.set(id, { ...asset, ...patch, status: 'ready', finalizedAt: '2026-09-15T00:00:00.000Z' });
  }

  async setPublicKey(id: string, publicKey: string): Promise<void> {
    const asset = this.assets.get(id);
    if (!asset) throw new Error('missing asset');
    this.assets.set(id, { ...asset, publicKey });
  }

  async findPublishedReadyAsset(id: string): Promise<MediaAsset | null> {
    const asset = this.assets.get(id);
    return asset && asset.status === 'ready' && asset.publicKey && this.published.has(id) ? asset : null;
  }
}

class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly copied: Array<{ sourceKey: string; destinationKey: string }> = [];
  failCopy = false;

  async createUploadGrant(bucket: string, key: string, expiresInSeconds: number) {
    return { url: 'https://upload.example.test/' + bucket + '/' + key, token: 'upload-token', expiresInSeconds };
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array | null> {
    return this.objects.get(bucket + '/' + key) ?? null;
  }

  async createSignedUrl(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    return 'https://preview.example.test/' + bucket + '/' + key + '?ttl=' + expiresInSeconds;
  }

  async copyObject(
    sourceBucket: string,
    sourceKey: string,
    destinationBucket: string,
    destinationKey: string,
  ): Promise<void> {
    if (this.failCopy) throw new Error('copy failed');
    const bytes = this.objects.get(sourceBucket + '/' + sourceKey);
    if (!bytes) throw new Error('missing source');
    this.objects.set(destinationBucket + '/' + destinationKey, bytes);
    this.copied.push({ sourceKey, destinationKey });
  }

  publicUrl(bucket: string, key: string): string {
    return 'https://public.example.test/' + bucket + '/' + key;
  }
}

function fixture() {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  let number = 1;
  const service = createMediaService({
    repository,
    storage,
    newId: () => '00000000-0000-4000-8000-' + String(number++).padStart(12, '0'),
    now: () => new Date('2026-09-15T00:00:00.000Z'),
  });
  return { repository, storage, service };
}

function request(path: string, method = 'GET', token?: string, body?: unknown): Request {
  return new Request('https://cms.example.test' + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('media lifecycle', () => {
  it('rejects oversized authorization requests before creating a grant', async () => {
    const { service } = fixture();
    const result = await service.authorizeUpload(editor, { type: 'glb', bytes: 26 * 1024 * 1024 });

    assert.equal(result.status, 400);
  });

  it('rejects renamed non-GLB bytes during finalization', async () => {
    const { service, storage } = fixture();
    const upload = await service.authorizeUpload(editor, { type: 'glb', bytes: 16 });
    assert.equal(upload.status, 201);
    if (upload.status !== 201) return;
    storage.objects.set('cms-media-private/' + upload.data.privateKey, new TextEncoder().encode('script'));

    const result = await service.finalizeUpload(editor, upload.data.asset.id);
    assert.equal(result.status, 400);
  });

  it('does not issue grants or permit admin routes without media.manage', async () => {
    const { service } = fixture();
    const handler = createMediaAdminHandler({
      service,
      requireCapability: async () => {
        throw new AuthorizationError(403, 'FORBIDDEN', 'You do not have this capability.');
      },
    });

    const response = await handler(request('/api/admin/media/upload', 'POST', 'no-media-grant', {
      type: 'image',
      bytes: 1024,
    }));
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { requestId: string } };
    assert.equal(response.headers.get('x-request-id'), body.error.requestId);
  });

  it('returns a private, ten-minute signed preview URL only to media managers', async () => {
    const { service, storage } = fixture();
    const upload = await service.authorizeUpload(editor, { type: 'image', bytes: validPng().length });
    assert.equal(upload.status, 201);
    if (upload.status !== 201) return;
    storage.objects.set('cms-media-private/' + upload.data.privateKey, validPng());
    assert.equal((await service.finalizeUpload(editor, upload.data.asset.id)).status, 200);

    const handler = createMediaAdminHandler({
      service,
      requireCapability: async (incoming) => {
        if (incoming.headers.get('authorization') !== 'Bearer media-manager') {
          throw new AuthorizationError(403, 'FORBIDDEN', 'You do not have this capability.');
        }
        return { userId: editor };
      },
    });
    const denied = await handler(request('/api/admin/media/' + upload.data.asset.id + '/preview', 'GET', 'bad'));
    const allowed = await handler(
      request('/api/admin/media/' + upload.data.asset.id + '/preview', 'GET', 'media-manager'),
    );

    assert.equal(denied.status, 403);
    assert.equal(allowed.status, 200);
    assert.match((await allowed.json() as { data: { url: string } }).data.url, /^https:\/\/preview/);
    assert.match(allowed.headers.get('cache-control') ?? '', /private/);
  });

  it('leaves an asset without a public key when copy to immutable storage fails', async () => {
    const { service, storage, repository } = fixture();
    const upload = await service.authorizeUpload(editor, { type: 'glb', bytes: validGlb().length });
    assert.equal(upload.status, 201);
    if (upload.status !== 201) return;
    storage.objects.set('cms-media-private/' + upload.data.privateKey, validGlb());
    assert.equal((await service.finalizeUpload(editor, upload.data.asset.id)).status, 200);
    storage.failCopy = true;

    const result = await service.copyReadyAssetToPublic(upload.data.asset.id);
    assert.equal(result.status, 502);
    assert.equal((await repository.getAsset(upload.data.asset.id))?.publicKey, null);
  });

  it('resolves only immutable, ready assets referenced by an active published revision', async () => {
    const { service, storage, repository } = fixture();
    const upload = await service.authorizeUpload(editor, { type: 'image', bytes: validPng().length });
    assert.equal(upload.status, 201);
    if (upload.status !== 201) return;
    storage.objects.set('cms-media-private/' + upload.data.privateKey, validPng());
    assert.equal((await service.finalizeUpload(editor, upload.data.asset.id)).status, 200);

    assert.equal((await service.copyReadyAssetToPublic(upload.data.asset.id)).status, 200);
    assert.equal((await service.resolvePublishedMedia(upload.data.asset.id)).status, 404);
    repository.published.add(upload.data.asset.id);

    const resolved = await service.resolvePublishedMedia(upload.data.asset.id);
    assert.equal(resolved.status, 200);
    if (resolved.status === 200) {
      assert.match(resolved.data.key, /^assets\/[0-9a-f-]{36}\/[a-f0-9]{64}$/);
      assert.match(resolved.data.url, /^https:\/\/public/);
    }
  });

  it('does not expose private storage paths through public resolution', async () => {
    const { service, storage, repository } = fixture();
    const upload = await service.authorizeUpload(outsider, { type: 'image', bytes: validPng().length });
    assert.equal(upload.status, 201);
    if (upload.status !== 201) return;
    storage.objects.set('cms-media-private/' + upload.data.privateKey, validPng());
    assert.equal((await service.finalizeUpload(outsider, upload.data.asset.id)).status, 200);
    repository.published.add(upload.data.asset.id);

    const result = await service.resolvePublishedMedia(upload.data.asset.id);
    assert.equal(result.status, 404);
  });
});
