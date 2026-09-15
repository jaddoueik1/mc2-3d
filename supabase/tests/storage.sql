begin;

select plan(6);

select is(
  (select public from storage.buckets where id = 'cms-media-private'),
  false,
  'private media bucket is not public'
);

select ok(
  (select file_size_limit from storage.buckets where id = 'cms-media-private') = 26214400,
  'private bucket enforces the GLB size ceiling'
);

select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'media managers own private uploads'
      and cmd = 'INSERT'
  ),
  'private uploads require the media manager ownership policy'
);

select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and cmd in ('SELECT', 'ALL')
      and policyname like 'media managers%'
  ),
  'unauthorized callers have no direct private storage read policy'
);

insert into public.geographic_scopes (id, code, name, scope_type)
values ('00000000-0000-0000-0000-000000000201', 'MED', 'Media test scope', 'city');

insert into public.content_entities (id, entity_type, slug, title)
values ('00000000-0000-0000-0000-000000000202', 'building', 'media-test-building', 'Media test building');

insert into public.content_revisions (id, entity_id, revision_number, content)
values (
  '00000000-0000-0000-0000-000000000203',
  '00000000-0000-0000-0000-000000000202',
  1,
  '{}'::jsonb
);

insert into public.media_assets (
  id, storage_bucket, storage_path, mime_type, byte_size, checksum_sha256,
  asset_kind, lifecycle_status, private_bucket, private_path, public_bucket, public_key
) values (
  '00000000-0000-0000-0000-000000000204',
  'cms-media-private',
  'private/00000000-0000-0000-0000-000000000204',
  'model/gltf-binary',
  20,
  repeat('a', 64),
  'glb',
  'ready',
  'cms-media-private',
  'private/00000000-0000-0000-0000-000000000204',
  'cms-media-public',
  'assets/00000000-0000-0000-0000-000000000204/' || repeat('a', 64)
);

insert into public.revision_dependencies (
  dependency_type, source_entity_id, source_revision_id, target_media_asset_id
) values (
  'model',
  '00000000-0000-0000-0000-000000000202',
  '00000000-0000-0000-0000-000000000203',
  '00000000-0000-0000-0000-000000000204'
);

insert into public.publications (entity_id, revision_id, status, published_at)
values (
  '00000000-0000-0000-0000-000000000202',
  '00000000-0000-0000-0000-000000000203',
  'published',
  now()
);

select throws_ok(
  $$delete from public.media_assets
    where id = '00000000-0000-0000-0000-000000000204'$$,
  'P0001',
  'media asset is referenced by an active published revision',
  'referenced published media cannot be deleted'
);

select is(
  (
    select public_key
    from public.resolve_published_media_asset('00000000-0000-0000-0000-000000000204')
  ),
  'assets/00000000-0000-0000-0000-000000000204/' || repeat('a', 64),
  'public resolver returns only the immutable public key for an active published ready asset'
);

select * from finish();
rollback;
