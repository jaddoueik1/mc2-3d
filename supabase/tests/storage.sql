begin;

select plan(18);

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

-- Seed an existing private object as the service/database owner. The unauthorized
-- SELECT below must hide a real object, not merely fail to find a rejected INSERT.
insert into storage.objects (bucket_id, name, owner_id)
values ('cms-media-private', 'private/service-seeded-secret', '00000000-0000-0000-0000-000000000298');
select is(
  (select count(*) from storage.objects where bucket_id = 'cms-media-private' and name = 'private/service-seeded-secret'),
  1::bigint, 'private read fixture exists before switching to unauthorized caller'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000299', true);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('cms-media-private', 'private/unauthorized', '00000000-0000-0000-0000-000000000299')$$,
  '42501',
  null,
  'unauthorized direct storage upload is rejected by RLS'
);
select is(
  (select count(*) from storage.objects where bucket_id = 'cms-media-private' and name = 'private/service-seeded-secret'),
  0::bigint,
  'unauthorized caller cannot read private storage objects'
);
reset role;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000297', '00000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'media-manager@example.test', 'not-used', now());
insert into public.cms_profiles (user_id, display_name)
values ('00000000-0000-0000-0000-000000000297', 'Storage test manager');
insert into public.user_roles (user_id, role_id)
select '00000000-0000-0000-0000-000000000297', id from public.roles where key = 'editor';

insert into public.media_assets (id, created_by, storage_bucket, storage_path, mime_type, byte_size,
  asset_kind, lifecycle_status, private_bucket, private_path, public_bucket)
select id, '00000000-0000-0000-0000-000000000297', 'cms-media-private', 'private/' || id::text,
  'application/octet-stream', 0, 'image', 'uploading', 'cms-media-private', 'private/' || id::text, 'cms-media-public'
from (values ('00000000-0000-4000-8000-000000000295'::uuid), ('00000000-0000-4000-8000-000000000296'::uuid)) as fixtures(id);
insert into public.media_upload_grants (asset_id, owner_id, bucket_id, object_path, created_at, expires_at)
values
  ('00000000-0000-4000-8000-000000000295', '00000000-0000-0000-0000-000000000297', 'cms-media-private',
   'private/00000000-0000-4000-8000-000000000295', now() - interval '11 minutes', now() - interval '1 minute'),
  ('00000000-0000-4000-8000-000000000296', '00000000-0000-0000-0000-000000000297', 'cms-media-private',
   'private/00000000-0000-4000-8000-000000000296', now(), now() + interval '10 minutes');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000297', true);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('cms-media-private', 'private/00000000-0000-4000-8000-000000000295', '00000000-0000-0000-0000-000000000297')$$,
  '42501', null, 'expired exact-path upload is denied even for its media-managing owner'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('cms-media-private', 'private/not-granted', '00000000-0000-0000-0000-000000000297')$$,
  '42501', null, 'media manager cannot upload outside the exact granted path'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('cms-media-private', 'private/00000000-0000-4000-8000-000000000296', '00000000-0000-0000-0000-000000000297')$$,
  'unexpired exact-path upload succeeds for the authenticated owner'
);
select throws_ok(
  $$select public.finalize_media_upload('00000000-0000-4000-8000-000000000296',
    '00000000-0000-0000-0000-000000000297', 'cms-media-private',
    'private/00000000-0000-4000-8000-000000000296', 100, 'image/png', repeat('b', 64))$$,
  '42501', null, 'authenticated clients cannot spoof verified finalization metadata'
);
reset role;
select throws_ok(
  $$select public.finalize_media_upload('00000000-0000-4000-8000-000000000296',
    '00000000-0000-0000-0000-000000000297', 'cms-media-private',
    'private/00000000-0000-4000-8000-000000000296', 100, 'image/png', 'not-a-digest')$$,
  '22023', 'invalid validated media metadata', 'invalid digest aborts the finalization transaction'
);
select ok(
  (select finalized_at is null from public.media_upload_grants where asset_id = '00000000-0000-4000-8000-000000000296')
  and (select lifecycle_status = 'uploading' from public.media_assets where id = '00000000-0000-4000-8000-000000000296'),
  'failed finalization preserves the unclaimed grant and uploading media state'
);
select is(
  (select count(*) from public.finalize_media_upload('00000000-0000-4000-8000-000000000296',
    '00000000-0000-0000-0000-000000000297', 'cms-media-private',
    'private/00000000-0000-4000-8000-000000000296', 100, 'image/png', repeat('b', 64))),
  1::bigint, 'server finalization succeeds after the failed attempt'
);
select ok(
  (select asset.lifecycle_status = 'ready' and asset.byte_size = 100 and asset.mime_type = 'image/png'
    and asset.checksum_sha256 = repeat('b', 64) and asset.finalized_at = upload_grant.finalized_at
    from public.media_assets asset join public.media_upload_grants upload_grant on asset.id = upload_grant.asset_id
    where asset.id = '00000000-0000-4000-8000-000000000296'),
  'grant finalization and ready metadata are committed together'
);
set local role authenticated;
select ok(
  not public.has_live_media_upload_grant('cms-media-private', 'private/00000000-0000-4000-8000-000000000296'),
  'finalized grant cannot authorize another object write'
);
reset role;

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
