import type { AuthenticatedUser, Capability } from './auth.ts';
import type { PublishRequest, Resource, SaveDraft } from '../shared/contracts.ts';
import { HttpError } from './http.ts';

export type Actor = AuthenticatedUser;
export type ContentReference = { entityId: string; resource: Resource } | { mediaId: string; mediaType: 'glb' | 'image' };
export type RevisionSnapshot = {
  entityId: string; resource: Resource; revision: number; revisionId: string;
  scopeId: string | null; payload: Record<string, unknown>; references: ContentReference[];
};
export type PreparedMedia = { mediaId: string; key: string };
export type RestoreDraft = { resource: Resource; entityId: string; sourceRevision: number; expectedRevision: number };
export type ContentRepository = {
  authorize(actor: Actor, capability: Capability): Promise<void>;
  save(actor: Actor, input: SaveDraft, references: ContentReference[]): Promise<RevisionSnapshot>;
  restore(actor: Actor, input: RestoreDraft): Promise<RevisionSnapshot>;
  revision(actor: Actor, resource: Resource, entityId: string, revision: number): Promise<RevisionSnapshot>;
  published(resource: Resource, entityId: string): Promise<RevisionSnapshot | null>;
  publish(actor: Actor, input: PublishRequest, media: PreparedMedia[]): Promise<unknown>;
  unpublishBuilding(actor: Actor, entityId: string, expectedRevision: number): Promise<unknown>;
};

const resources = new Set(['scene', 'building', 'floor', 'category', 'metric', 'observation', 'dashboard']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function invalid(message = 'Content fields are invalid.'): never { throw new HttpError(400, 'INVALID_CONTENT', message); }
export function validateIdentity(resource: unknown, id: unknown, revision: unknown, minimum = 0): void {
  if (typeof resource !== 'string' || !resources.has(resource) || typeof id !== 'string' || !uuid.test(id)
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < minimum || revision > 2147483646) invalid();
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) invalid();
  return result;
}
function text(value: unknown, required = false): void {
  if (typeof value !== 'string' || value.length > 10000 || (required && !value.trim())) invalid();
}
function number(value: unknown, min = -Infinity, max = Infinity, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid();
}
function nullableNumber(value: unknown): void { if (value !== null) number(value, 0); }
function array(value: unknown, validate: (value: unknown) => void): void {
  if (!Array.isArray(value) || value.length > 1000) invalid();
  value.forEach(validate);
}
function boolean(value: unknown): void { if (typeof value !== 'boolean') invalid(); }
function id(value: unknown): string { if (typeof value !== 'string' || !uuid.test(value)) invalid(); return value; }
function vec(value: unknown): void { if (!Array.isArray(value) || value.length !== 3) invalid(); value.forEach(v => number(v)); }
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid();
  return value;
}

// Internal CMS snapshots contain stable IDs, never browser-supplied public URLs,
// arbitrary markup, query expressions, pointers, authors, or dependency lists.
export function validatePayload(resource: Resource, payload: unknown): ContentReference[] {
  const references: ContentReference[] = [];
  const entity = (value: unknown, target: Resource) => references.push({ entityId: id(value), resource: target });
  const media = (value: unknown, type: 'glb' | 'image') => references.push({ mediaId: id(value), mediaType: type });
  const image = (value: unknown) => { const p = object(value, ['mediaId', 'alt']); media(p.mediaId, 'image'); text(p.alt, true); };
  const category = (value: unknown) => { if (value !== null) entity(value, 'category'); };
  switch (resource) {
    case 'building': {
      const p = object(payload, ['name', 'categoryId', 'description', 'heightM', 'floorCount', 'gfaM2', 'availability', 'tags', 'images', 'enquiryUrl']);
      text(p.name, true); category(p.categoryId); text(p.description); nullableNumber(p.heightM); number(p.floorCount, 0, 1000, true); nullableNumber(p.gfaM2); text(p.availability);
      array(p.tags, v => text(v, true)); array(p.images, image);
      if (p.enquiryUrl !== null) {
        text(p.enquiryUrl, true);
        try { const url = new URL(p.enquiryUrl as string); if (!['https:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) invalid(); } catch { invalid('Enquiry URL is invalid.'); }
      }
      break;
    }
    case 'floor': {
      const p = object(payload, ['buildingId', 'label', 'sortOrder', 'areaM2', 'use', 'description', 'drawing', 'isDefault']);
      entity(p.buildingId, 'building'); text(p.label, true); number(p.sortOrder, -1000, 1000, true); nullableNumber(p.areaM2); text(p.use); text(p.description); boolean(p.isDefault);
      if (p.drawing !== null) image(p.drawing);
      break;
    }
    case 'category': {
      const p = object(payload, ['key', 'label', 'color', 'order']);
      text(p.key, true); text(p.label, true); number(p.order, 0, 1000, true);
      if (typeof p.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.color)) invalid();
      break;
    }
    case 'metric': {
      const p = object(payload, ['key', 'label', 'categoryId', 'unit', 'precision', 'description', 'preferredDirection', 'denominator']);
      text(p.key, true); text(p.label, true); category(p.categoryId); text(p.unit, true); number(p.precision, 0, 10, true); text(p.description);
      if (!['higher', 'lower', 'neutral'].includes(String(p.preferredDirection))) invalid();
      if (p.denominator !== null) text(p.denominator, true);
      if (['%', 'percent', 'ratio'].includes(String(p.unit).toLowerCase()) && p.denominator === null) invalid('Ratio metrics require a denominator.');
      break;
    }
    case 'observation': {
      const p = object(payload, ['metricId', 'scopeId', 'periodStart', 'periodEnd', 'value', 'target', 'source', 'isSample']);
      entity(p.metricId, 'metric'); id(p.scopeId); if (date(p.periodStart) > date(p.periodEnd)) invalid();
      if (p.value !== null) number(p.value); if (p.target !== null) number(p.target); text(p.source, true); boolean(p.isSample);
      break;
    }
    case 'scene': {
      const p = object(payload, ['scopeId', 'masterplanMediaId', 'width', 'depth', 'camera', 'placements']);
      id(p.scopeId); media(p.masterplanMediaId, 'image'); number(p.width, Number.MIN_VALUE); number(p.depth, Number.MIN_VALUE);
      const camera = object(p.camera, ['target', 'radius', 'theta', 'phi']); vec(camera.target); number(camera.radius, Number.MIN_VALUE); number(camera.theta); number(camera.phi, 0, Math.PI);
      const seen = new Set();
      array(p.placements, value => {
        const item = object(value, ['buildingId', 'modelMediaId', 'u', 'v', 'targetWidth', 'rotationDegrees', 'verticalOffset', 'order', 'visible']);
        entity(item.buildingId, 'building'); media(item.modelMediaId, 'glb'); number(item.u, 0, 1); number(item.v, 0, 1); number(item.targetWidth, Number.MIN_VALUE); vec(item.rotationDegrees); number(item.verticalOffset); number(item.order, 0, 1000, true); boolean(item.visible);
        if (seen.has(item.buildingId)) invalid('Duplicate placement.'); seen.add(item.buildingId);
      });
      break;
    }
    case 'dashboard': {
      const p = object(payload, ['scopeId', 'title', 'categoryIds', 'widgets']);
      id(p.scopeId); text(p.title, true); array(p.categoryIds, v => entity(v, 'category'));
      const seen = new Set();
      array(p.widgets, value => {
        const w = object(value, ['id', 'type', 'title', 'metricIds', 'observationIds', 'order', 'image', 'visible']);
        text(w.id, true); text(w.title, true); number(w.order, 0, 1000, true); boolean(w.visible);
        if (!['kpi', 'line', 'bar', 'composition', 'target', 'image', 'table'].includes(String(w.type))) invalid();
        array(w.metricIds, v => entity(v, 'metric')); array(w.observationIds, v => entity(v, 'observation'));
        if (w.image !== null) image(w.image);
        if (w.type === 'image' ? w.image === null : !(w.metricIds as unknown[]).length) invalid('Widget binding is required.');
        if (seen.has(w.id)) invalid('Duplicate widget.'); seen.add(w.id);
      });
      break;
    }
    default: invalid();
  }
  return references.filter((ref, index) => references.findIndex(r => JSON.stringify(r) === JSON.stringify(ref)) === index);
}

function environment(name: string): string {
  const value = (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env[name];
  if (!value) throw new Error(name + ' is required for content access.');
  return value.replace(/\/$/, '');
}

export function createSupabaseContentRepository(
  fetcher: typeof fetch = fetch, url = environment('SUPABASE_URL'), key = environment('SUPABASE_SERVICE_ROLE_KEY'),
): ContentRepository {
  async function rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetcher(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: string; details?: string };
      const status = ['PT400', 'PT401', 'PT403', 'PT404', 'PT409'].includes(error.code ?? '') ? Number(error.code?.slice(2)) : 502;
      const failure = new HttpError(status, status === 409 ? 'REVISION_CONFLICT' : 'CONTENT_REQUEST_FAILED', status === 409 ? 'Content changed. Reload the latest revision.' : 'Content operation was not permitted or could not be completed.');
      if (status === 409 && /^\d+$/.test(error.details ?? '')) Object.assign(failure, { latestRevision: Number(error.details) });
      throw failure;
    }
    return response.json() as Promise<T>;
  }
  return {
    async authorize(actor, capability) { await rpc('authorize_content_actor', { verified_user_id: actor.userId, required_capability: capability }); },
    save: (actor, input, references) => rpc('save_content_draft', { verified_user_id: actor.userId, target_resource: input.resource, target_entity_id: input.entityId, expected_revision: input.expectedRevision, draft_payload: input.payload, extracted_references: references }),
    restore: (actor, input) => rpc('restore_content_revision', { verified_user_id: actor.userId, target_resource: input.resource, target_entity_id: input.entityId, source_revision: input.sourceRevision, expected_revision: input.expectedRevision }),
    revision: (actor, resource, entityId, revision) => rpc('read_content_revision', { verified_user_id: actor.userId, target_resource: resource, target_entity_id: entityId, exact_revision: revision }),
    published: (resource, entityId) => rpc('read_published_content', { target_resource: resource, target_entity_id: entityId }),
    publish: (actor, input, media) => rpc('publish_content_revisions', { verified_user_id: actor.userId, requested_entries: input.entries, prepared_media: media }),
    unpublishBuilding: (actor, entityId, expectedRevision) => rpc('unpublish_content_building', { verified_user_id: actor.userId, target_entity_id: entityId, expected_revision: expectedRevision }),
  };
}

export function createContentService({ repository }: { repository: ContentRepository }) {
  async function saveDraft(actor: Actor, input: SaveDraft) {
    validateIdentity(input.resource, input.entityId, input.expectedRevision);
    const references = validatePayload(input.resource, input.payload);
    return repository.save(actor, input, references);
  }
  async function previewRevision(actor: Actor, resource: Resource, entityId: string, revision: number) {
    validateIdentity(resource, entityId, revision, 1);
    // Handler edge must wrap this exact private snapshot in privateJson/no-store.
    return repository.revision(actor, resource, entityId, revision);
  }
  async function restoreDraft(actor: Actor, input: RestoreDraft) {
    validateIdentity(input.resource, input.entityId, input.sourceRevision, 1);
    validateIdentity(input.resource, input.entityId, input.expectedRevision, 1);
    return repository.restore(actor, input);
  }
  async function publicBuilding(entityId: string) { validateIdentity('building', entityId, 0); return repository.published('building', entityId); }
  return { saveDraft, previewRevision, restoreDraft, publicBuilding };
}
