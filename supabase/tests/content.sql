begin;

select plan(22);

insert into public.geographic_scopes (id, code, name, scope_type)
values ('00000000-0000-0000-0000-000000000001', 'BEY', 'Beirut', 'city');

insert into public.content_entities (
  id, entity_type, slug, title, metric_key, geographic_scope_id, period_start, period_end
) values (
  '00000000-0000-0000-0000-000000000010',
  'observation',
  'population-beirut-2025',
  'Population, Beirut 2025',
  'population',
  '00000000-0000-0000-0000-000000000001',
  date '2025-01-01',
  date '2025-12-31'
);

select throws_like(
  $$insert into public.content_entities (
      id, entity_type, slug, title, metric_key, geographic_scope_id, period_start, period_end
    ) values (
      '00000000-0000-0000-0000-000000000011',
      'observation',
      'population-beirut-2025-copy',
      'Duplicate population observation',
      'population',
      '00000000-0000-0000-0000-000000000001',
      date '2025-01-01',
      date '2025-12-31'
    )$$,
  '23505',
  'duplicate key value.*',
  'duplicate observation stable identity is rejected'
);

insert into public.content_revisions (id, entity_id, revision_number, content)
values ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010', 1, '{"value": 100}');

select lives_ok(
  $$insert into public.content_revisions (id, entity_id, revision_number, content)
    values ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000010', 2, '{"value": 110}')$$,
  'a second revision for the same stable entity is allowed'
);

select throws_like(
  $$update public.content_entities
    set slug = 'population-beirut-renamed'
    where id = '00000000-0000-0000-0000-000000000010'$$,
  'P0001',
  'content entity identity fields are immutable',
  'stable entity slug cannot be mutated'
);

select throws_like(
  $$insert into public.content_entities (id, entity_type, slug, title, building_entity_id)
    values (
      '00000000-0000-0000-0000-000000000012',
      'tour',
      'missing-building',
      'Missing building reference',
      'ffffffff-ffff-ffff-ffff-ffffffffffff'
    )$$,
  '23503',
  'violates foreign key constraint.*',
  'missing building reference is rejected'
);

select throws_like(
  $$insert into public.revision_dependencies (
      dependency_type, source_entity_id, source_revision_id, target_entity_id, target_revision_id
    ) values (
      'source',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000020',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    )$$,
  '23503',
  'violates foreign key constraint.*',
  'missing dependency target revision is rejected'
);

select throws_like(
  $$update public.content_revisions
    set content = '{"value": 999}'
    where id = '00000000-0000-0000-0000-000000000020'$$,
  'P0001',
  'content revisions are immutable',
  'historical revision updates are denied'
);

select throws_like(
  $$delete from public.content_revisions
    where id = '00000000-0000-0000-0000-000000000020'$$,
  'P0001',
  'content revisions are immutable',
  'historical revision deletes are denied'
);

insert into public.media_assets (id, storage_bucket, storage_path, mime_type, byte_size)
values ('00000000-0000-0000-0000-000000000030', 'media', 'building.glb', 'model/gltf-binary', 42);

insert into public.revision_dependencies (
  id, dependency_type, source_entity_id, source_revision_id, target_media_asset_id
) values (
  '00000000-0000-0000-0000-000000000040',
  'model',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000020',
  '00000000-0000-0000-0000-000000000030'
);

select throws_like(
  $$update public.revision_dependencies
    set dependency_type = 'changed'
    where id = '00000000-0000-0000-0000-000000000040'$$,
  'P0001',
  'revision dependencies are immutable',
  'historical dependency updates are denied'
);

select throws_like(
  $$delete from public.revision_dependencies
    where id = '00000000-0000-0000-0000-000000000040'$$,
  'P0001',
  'revision dependencies are immutable',
  'historical dependency deletes are denied'
);

select throws_like(
  $$insert into public.content_entities (
      id, entity_type, slug, title, metric_key, geographic_scope_id, period_start, period_end
    ) values (
      '00000000-0000-0000-0000-000000000013',
      'observation',
      'invalid-period',
      'Invalid period',
      'rainfall',
      '00000000-0000-0000-0000-000000000001',
      date '2025-12-31',
      date '2025-01-01'
    )$$,
  '23514',
  'violates check constraint.*',
  'observation period end cannot precede period start'
);

insert into public.content_entities (id, entity_type, slug, title)
values ('00000000-0000-0000-0000-000000000014', 'metric', 'another-metric', 'Another metric');

insert into public.content_revisions (id, entity_id, revision_number, content)
values ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000014', 1, '{"value": 1}');

set constraints all immediate;

select throws_like(
  $$insert into public.audit_events (event_type, entity_id, revision_id)
    values (
      'revision.check',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000022'
    )$$,
  '23503',
  'violates foreign key constraint.*',
  'audit revision must belong to its entity'
);

select throws_like(
  $$update public.content_entities
    set latest_revision_id = '00000000-0000-0000-0000-000000000022'
    where id = '00000000-0000-0000-0000-000000000010'$$,
  '23503',
  'violates foreign key constraint.*',
  'latest revision pointer must reference a revision of the same entity'
);

select throws_like(
  $$update public.content_entities
    set published_revision_id = '00000000-0000-0000-0000-000000000022'
    where id = '00000000-0000-0000-0000-000000000010'$$,
  '23503',
  'violates foreign key constraint.*',
  'published revision pointer must reference a revision of the same entity'
);

select throws_like(
  $$insert into public.publications (entity_id, revision_id, status, published_at)
    values (
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000022',
      'published',
      now()
    )$$,
  '23503',
  'violates foreign key constraint.*',
  'publication revision must belong to its entity'
);

insert into public.media_assets (id, storage_bucket, storage_path, mime_type, byte_size, archived_at)
values ('00000000-0000-0000-0000-000000000031', 'media', 'archived.glb', 'model/gltf-binary', 42, now());

select throws_like(
  $$insert into public.revision_dependencies (
      dependency_type, source_entity_id, source_revision_id, target_media_asset_id
    ) values (
      'model',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000021',
      '00000000-0000-0000-0000-000000000031'
    )$$,
  'P0001',
  'revision dependencies cannot reference archived media assets',
  'revision dependencies cannot attach archived media'
);

insert into public.media_assets (id, storage_bucket, storage_path, mime_type, byte_size)
values ('00000000-0000-0000-0000-000000000032', 'media', 'draft-only.glb', 'model/gltf-binary', 42);

insert into public.revision_dependencies (
  id, dependency_type, source_entity_id, source_revision_id, target_media_asset_id
) values (
  '00000000-0000-0000-0000-000000000041',
  'model',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000021',
  '00000000-0000-0000-0000-000000000032'
);

update public.media_assets
set archived_at = now()
where id = '00000000-0000-0000-0000-000000000032';

select throws_like(
  $$update public.content_entities
    set published_revision_id = '00000000-0000-0000-0000-000000000021'
    where id = '00000000-0000-0000-0000-000000000010'$$,
  'P0001',
  'published revisions cannot reference archived media assets',
  'published revision pointer cannot select archived media'
);

select throws_like(
  $$insert into public.publications (entity_id, revision_id, status, published_at)
    values (
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000021',
      'published',
      now()
    )$$,
  'P0001',
  'published revisions cannot reference archived media assets',
  'publication cannot select a revision with archived media'
);

select throws_like(
  $$update public.content_entities
    set published_revision_id = '00000000-0000-0000-0000-000000000020'
    where id = '00000000-0000-0000-0000-000000000010'$$,
  'P0001',
  'published revision pointer must match the active publication',
  'directly setting a divergent published pointer is denied'
);

insert into public.publications (entity_id, revision_id, status, published_at)
values (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000020',
  'published',
  now()
);

select is(
  (select published_revision_id from public.content_entities
    where id = '00000000-0000-0000-0000-000000000010'),
  '00000000-0000-0000-0000-000000000020'::uuid,
  'active publication synchronizes the published revision pointer'
);

update public.publications
set status = 'withdrawn', unpublished_at = now()
where entity_id = '00000000-0000-0000-0000-000000000010'
  and revision_id = '00000000-0000-0000-0000-000000000020';

select is(
  (select published_revision_id from public.content_entities
    where id = '00000000-0000-0000-0000-000000000010'),
  null::uuid,
  'withdrawing the active publication clears the published revision pointer'
);

insert into public.publications (entity_id, revision_id, status, published_at)
values (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000020',
  'published',
  now()
);

select throws_like(
  $$update public.media_assets
    set archived_at = now()
    where id = '00000000-0000-0000-0000-000000000030'$$,
  'P0001',
  'media asset is referenced by an active published revision',
  'media referenced by the active published pointer cannot be archived'
);

select throws_like(
  $$delete from public.media_assets
    where id = '00000000-0000-0000-0000-000000000030'$$,
  'P0001',
  'media asset is referenced by an active published revision',
  'media referenced by an active published pointer cannot be deleted'
);

select * from finish();
rollback;
