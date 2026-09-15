import test from 'node:test';
import assert from 'node:assert/strict';
import * as contentModule from '../server/content.ts';
import * as publicationModule from '../server/publication.ts';
import type { PublishRequest } from '../shared/contracts.ts';

// These tests exercise the production repository through its HTTP boundary. The
// database transaction/locking assertions live in supabase/tests/publication.sql.
test('content and publication expose the transactional service factories', () => {
  assert.equal(typeof contentModule.createContentService, 'function');
  assert.equal(typeof publicationModule.createPublicationService, 'function');
});

const actor = { userId: '00000000-0000-4000-8000-000000000101' };
const buildingId = '00000000-0000-4000-8000-000000000201';
const mediaId = '00000000-0000-4000-8000-000000000301';
const payload = { name: 'Published name', categoryId: null, description: '', heightM: null, floorCount: 2, gfaM2: null, availability: '', tags: [], images: [], enquiryUrl: null };
const snapshot = (revision = 1, content: Record<string, unknown> = payload) => ({ entityId: buildingId, resource: 'building', revision, revisionId: '00000000-0000-4000-8000-000000000401', payload: content, scopeId: null, references: [] });

function fixture(respond: (name: string, body: Record<string, unknown>) => unknown = () => null) {
  const calls: Array<{ name: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const repository = contentModule.createSupabaseContentRepository(async (url, init) => {
    const name = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ name, body, headers: init?.headers as Record<string, string> });
    const reply = respond(name, body);
    return reply instanceof Response ? reply : Response.json(reply);
  }, 'https://database.example', 'server-secret');
  return { repository, calls, content: contentModule.createContentService({ repository }) };
}

test('save validates allowlisted payload before any privileged RPC and extracts media IDs server-side', async () => {
  const f = fixture((name) => name === 'save_content_draft' ? snapshot(2) : true);
  await assert.rejects(f.content.saveDraft(actor, { resource: 'building', entityId: buildingId, expectedRevision: 1, payload: { ...payload, published_revision_id: 'bad' } }), { status: 400 });
  assert.equal(f.calls.length, 0);
  await f.content.saveDraft(actor, { resource: 'building', entityId: buildingId, expectedRevision: 1, payload: { ...payload, images: [{ mediaId, alt: 'Facade' }] } });
  assert.equal(f.calls.at(-1)!.name, 'save_content_draft');
  assert.deepEqual(f.calls.at(-1)!.body, { verified_user_id: actor.userId, target_resource: 'building', target_entity_id: buildingId, expected_revision: 1, draft_payload: { ...payload, images: [{ mediaId, alt: 'Facade' }] }, extracted_references: [{ mediaId, mediaType: 'image' }] });
  assert.equal(f.calls.at(-1)!.headers.authorization, 'Bearer server-secret');
});

test('publicBuilding uses only the published projection RPC, never draft or base table queries', async () => {
  const f = fixture(name => name === 'read_published_content' ? snapshot() : snapshot(2, { ...payload, name: 'Draft name' }));
  assert.equal((await f.content.publicBuilding(buildingId))!.payload.name, 'Published name');
  await f.content.saveDraft(actor, { resource: 'building', entityId: buildingId, expectedRevision: 1, payload: { ...payload, name: 'Draft name' } });
  assert.equal((await f.content.publicBuilding(buildingId))!.payload.name, 'Published name');
  assert.deepEqual(f.calls.filter(c => c.name === 'read_published_content').map(c => c.body), [{ target_resource: 'building', target_entity_id: buildingId }, { target_resource: 'building', target_entity_id: buildingId }]);
});

test('database stale errors become 409 with latest revision; no retry silently overwrites', async () => {
  const f = fixture(() => Response.json({ code: 'PT409', message: 'Revision conflict', details: '3' }, { status: 409 }));
  await assert.rejects(f.content.saveDraft(actor, { resource: 'building', entityId: buildingId, expectedRevision: 1, payload }), e => (e as { status: number }).status === 409 && (e as { latestRevision: number }).latestRevision === 3);
  assert.equal(f.calls.length, 1);
});

test('concurrent save requests preserve the same expected revision and expose the losing conflict', async () => {
  let saves = 0;
  const f = fixture(() => ++saves === 1 ? snapshot(2) : Response.json({ code: 'PT409', message: 'Conflict', details: '2' }, { status: 409 }));
  const outcomes = await Promise.allSettled([1, 2].map(() => f.content.saveDraft(actor, { resource: 'building', entityId: buildingId, expectedRevision: 1, payload })));
  assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].status === 'rejected' && outcomes[1].reason.status, 409);
  assert.deepEqual(f.calls.map(c => c.body.expected_revision), [1, 1]);
});

test('publish prepares every asset then sends exact reviewed entries and immutable keys in one commit RPC', async () => {
  const events: string[] = [];
  const f = fixture((name) => { events.push(name); return name === 'read_content_revision' ? { ...snapshot(1, { ...payload, images: [{ mediaId, alt: 'Facade' }] }), references: [{ mediaId, mediaType: 'image' }] } : true; });
  const pub = publicationModule.createPublicationService({ repository: f.repository, media: { async copyReadyAssetToPublic(id) { events.push('copy:' + id); return { status: 200, data: { key: 'assets/' + id + '/' + 'a'.repeat(64) } }; } } });
  const entries: PublishRequest['entries'] = [{ resource: 'building', entityId: buildingId, revision: 1 }];
  await pub.publish(actor, { entries });
  assert.deepEqual(events, ['authorize_content_actor', 'read_content_revision', 'copy:' + mediaId, 'publish_content_revisions']);
  assert.deepEqual(f.calls.at(-1)!.body, { verified_user_id: actor.userId, requested_entries: entries, prepared_media: [{ mediaId, key: 'assets/' + mediaId + '/' + 'a'.repeat(64) }] });
});

test('copy failure leaves publication RPC untouched; a retry may reuse an orphan copy', async () => {
  const f = fixture(name => name === 'read_content_revision' ? { ...snapshot(1, { ...payload, images: [{ mediaId, alt: 'Facade' }] }), references: [{ mediaId, mediaType: 'image' }] } : true);
  let copies = 0;
  const pub = publicationModule.createPublicationService({ repository: f.repository, media: { async copyReadyAssetToPublic() { return ++copies === 1 ? { status: 502, error: { code: 'PUBLIC_COPY_FAILED', message: 'copy failed' } } : { status: 200, data: { key: 'assets/' + mediaId + '/' + 'a'.repeat(64) } }; } } });
  const input: PublishRequest = { entries: [{ resource: 'building', entityId: buildingId, revision: 1 }] };
  await assert.rejects(pub.publish(actor, input), { status: 502 });
  assert.equal(f.calls.some(c => c.name === 'publish_content_revisions'), false);
  await pub.publish(actor, input);
  assert.equal(f.calls.filter(c => c.name === 'publish_content_revisions').length, 1);
});

test('role denial occurs before media access, and stale multi-entry commit surfaces atomically', async () => {
  const denied = fixture(() => Response.json({ code: 'PT403', message: 'Denied' }, { status: 403 }));
  const pub = publicationModule.createPublicationService({ repository: denied.repository, media: { copyReadyAssetToPublic() { assert.fail('must not copy'); } } });
  await assert.rejects(pub.publish(actor, { entries: [{ resource: 'building', entityId: buildingId, revision: 1 }] }), { status: 403 });
  assert.equal(denied.calls.length, 1);
  const f = fixture((name, body) => name === 'read_content_revision' ? { ...snapshot(), entityId: body.target_entity_id } : name === 'publish_content_revisions' ? Response.json({ code: 'PT409', message: 'Stale revision' }, { status: 409 }) : true);
  const service = publicationModule.createPublicationService({ repository: f.repository, media: { copyReadyAssetToPublic() { assert.fail('no media'); } } });
  await assert.rejects(service.publish(actor, { entries: [{ resource: 'building', entityId: buildingId, revision: 1 }, { resource: 'building', entityId: '00000000-0000-4000-8000-000000000202', revision: 1 }] }), { status: 409 });
  assert.equal(f.calls.filter(c => c.name === 'publish_content_revisions').length, 1);
});

test('restore asks the actor-authorized database to clone exact history, while preview reads exact history', async () => {
  const f = fixture(name => name === 'read_content_revision' ? snapshot() : snapshot(4));
  assert.equal((await f.content.previewRevision(actor, 'building', buildingId, 1)).revision, 1);
  await f.content.restoreDraft(actor, { resource: 'building', entityId: buildingId, sourceRevision: 1, expectedRevision: 3 });
  assert.equal(f.calls.at(-1)!.name, 'restore_content_revision');
  assert.deepEqual(f.calls.at(-1)!.body, { verified_user_id: actor.userId, target_resource: 'building', target_entity_id: buildingId, source_revision: 1, expected_revision: 3 });
});

test('unpublish is one actor-bound RPC with exact expected revision, including scene consistency', async () => {
  const f = fixture(() => true);
  const pub = publicationModule.createPublicationService({ repository: f.repository, media: { async copyReadyAssetToPublic() { assert.fail('must not copy'); } } });
  await pub.unpublishBuilding(actor, buildingId, 3);
  assert.deepEqual(f.calls.map(({ name, body }) => ({ name, body })), [{ name: 'unpublish_content_building', body: { verified_user_id: actor.userId, target_entity_id: buildingId, expected_revision: 3 } }]);
});

test('publication derives required media from validated snapshot and rejects a mismatched revision response', async () => {
  const f = fixture(name => name === 'read_content_revision' ? snapshot(1, { ...payload, images: [{ mediaId, alt: 'Facade' }] }) : true);
  let copied = false;
  const pub = publicationModule.createPublicationService({ repository: f.repository, media: { async copyReadyAssetToPublic() { copied = true; return { status: 200, data: { key: 'assets/' + mediaId + '/' + 'a'.repeat(64) } }; } } });
  await pub.publish(actor, { entries: [{ resource: 'building', entityId: buildingId, revision: 1 }] });
  assert.equal(copied, true);
  const wrong = fixture(name => name === 'read_content_revision' ? snapshot(2) : true);
  const rejected = publicationModule.createPublicationService({ repository: wrong.repository, media: { async copyReadyAssetToPublic() { assert.fail('wrong revision must not release media'); } } });
  await assert.rejects(rejected.publish(actor, { entries: [{ resource: 'building', entityId: buildingId, revision: 1 }] }), { status: 409 });
  assert.equal(wrong.calls.some(c => c.name === 'publish_content_revisions'), false);
});
