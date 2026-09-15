import type { PublishRequest } from '../shared/contracts.ts';
import type { Actor, ContentRepository, PreparedMedia } from './content.ts';
import { invalid, validateIdentity, validatePayload } from './content.ts';
import { HttpError } from './http.ts';
import type { MediaService } from './media.ts';

export function createPublicationService({ repository, media }: {
  repository: ContentRepository;
  media: Pick<MediaService, 'copyReadyAssetToPublic'>;
}) {
  async function publish(actor: Actor, input: PublishRequest) {
    if (!input || !Array.isArray(input.entries) || !input.entries.length || input.entries.length > 100) invalid('Publish requires 1–100 exact revision entries.');
    const ids = new Set();
    for (const entry of input.entries) {
      validateIdentity(entry.resource, entry.entityId, entry.revision, 1);
      if (ids.has(entry.entityId)) invalid('Duplicate publication entry.');
      ids.add(entry.entityId);
    }
    // Check live grants before releasing any media. The commit RPC checks again.
    await repository.authorize(actor, 'content.publish');
    const assets = new Set<string>();
    for (const entry of input.entries) {
      const snapshot = await repository.revision(actor, entry.resource, entry.entityId, entry.revision);
      if (snapshot.entityId !== entry.entityId || snapshot.resource !== entry.resource || snapshot.revision !== entry.revision) {
        throw new HttpError(409, 'REVISION_CONFLICT', 'The exact reviewed revision was not returned.');
      }
      for (const reference of validatePayload(entry.resource, snapshot.payload)) if ('mediaId' in reference) assets.add(reference.mediaId);
    }
    const prepared: PreparedMedia[] = [];
    for (const mediaId of [...assets].sort()) {
      const result = await media.copyReadyAssetToPublic(mediaId);
      if ('error' in result) throw new HttpError(result.status, result.error.code, result.error.message);
      prepared.push({ mediaId, key: result.data.key });
    }
    // No pointer changes occur before this single transaction. Copies can become
    // harmless orphans when an intervening save or failed entry rejects commit.
    return repository.publish(actor, input, prepared);
  }
  async function unpublishBuilding(actor: Actor, id: string, expectedRevision: number) {
    validateIdentity('building', id, expectedRevision, 1);
    return repository.unpublishBuilding(actor, id, expectedRevision);
  }
  return { publish, unpublishBuilding };
}
