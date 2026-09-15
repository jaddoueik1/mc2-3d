begin;

alter table public.media_assets
  add column if not exists asset_kind text not null default 'image'
    check (asset_kind in ('glb', 'image')),
  add column if not exists lifecycle_status text not null default 'uploading'
    check (lifecycle_status in ('uploading', 'ready')),
  add column if not exists private_bucket text,
  add column if not exists private_path text,
  add column if not exists public_bucket text,
  add column if not exists public_key text,
  add column if not exists finalized_at timestamptz;

update public.media_assets
set private_bucket = coalesce(private_bucket, storage_bucket),
    private_path = coalesce(private_path, storage_path),
    public_bucket = coalesce(public_bucket, 'cms-media-public'),
    lifecycle_status = coalesce(lifecycle_status, 'uploading');

alter table public.media_assets
  alter column private_bucket set not null,
  alter column private_path set not null,
  alter column public_bucket set not null,
  add constraint media_assets_ready_metadata_check check (
    lifecycle_status = 'uploading'
    or (mime_type is not null and byte_size is not null and checksum_sha256 ~ '^[a-f0-9]{64}$')
  ),
  add constraint media_assets_public_key_immutable_shape_check check (
    public_key is null
    or public_key = 'assets/' || id::text || '/' || checksum_sha256
  );

create or replace function public.reject_ready_media_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.lifecycle_status = 'ready'
    and (
      new.private_bucket is distinct from old.private_bucket
      or new.private_path is distinct from old.private_path
      or new.checksum_sha256 is distinct from old.checksum_sha256
      or new.mime_type is distinct from old.mime_type
      or new.byte_size is distinct from old.byte_size
    ) then
    raise exception 'ready media bytes and private location are immutable'
      using errcode = 'P0001';
  end if;
  if old.public_key is not null and new.public_key is distinct from old.public_key then
    raise exception 'public media keys are immutable'
      using errcode = 'P0001';
  end if;
  if new.lifecycle_status = 'ready' and old.lifecycle_status = 'uploading'
    and (new.mime_type is null or new.byte_size is null or new.checksum_sha256 is null) then
    raise exception 'ready media requires verified metadata'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger media_assets_ready_immutable
before update on public.media_assets
for each row execute function public.reject_ready_media_mutation();

create table public.media_upload_grants (
  asset_id uuid primary key references public.media_assets(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  bucket_id text not null check (bucket_id = 'cms-media-private'),
  object_path text not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (bucket_id, object_path),
  check (object_path = 'private/' || asset_id::text),
  check (expires_at = created_at + interval '10 minutes')
);

alter table public.media_upload_grants enable row level security;
revoke all on public.media_upload_grants from public, anon, authenticated;
grant all on public.media_upload_grants to service_role;

-- Only answers whether the current signed user owns this exact live grant;
-- it does not expose grant records or permit the caller to choose another user.
create function public.has_live_media_upload_grant(target_bucket text, target_path text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.media_upload_grants upload_grant
    join public.media_assets asset on asset.id = upload_grant.asset_id
    where upload_grant.owner_id = auth.uid()
      and upload_grant.bucket_id = target_bucket
      and upload_grant.bucket_id = 'cms-media-private'
      and upload_grant.object_path = target_path
      and upload_grant.expires_at > now()
      and upload_grant.finalized_at is null
      and asset.created_by = upload_grant.owner_id
      and asset.private_bucket = upload_grant.bucket_id
      and asset.private_path = upload_grant.object_path
      and asset.lifecycle_status = 'uploading'
  );
$$;
revoke all on function public.has_live_media_upload_grant(text, text) from public, anon;
grant execute on function public.has_live_media_upload_grant(text, text) to authenticated;

-- Called only by the server after reading and decoding the object. Database errors
-- roll back BOTH updates, leaving the grant retryable; no pre-validation claim exists.
create function public.finalize_media_upload(
  target_asset_id uuid,
  verified_user_id uuid,
  expected_bucket text,
  expected_path text,
  validated_byte_size bigint,
  validated_mime_type text,
  validated_sha256 text
)
returns setof public.media_assets
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  upload_grant public.media_upload_grants%rowtype;
  asset public.media_assets%rowtype;
  finalized_time timestamptz;
begin
  select * into upload_grant from public.media_upload_grants
  where asset_id = target_asset_id for update;
  if not found then return; end if;
  select * into asset from public.media_assets
  where id = target_asset_id for update;
  if not found then return; end if;
  finalized_time := clock_timestamp();
  if verified_user_id is null
    or upload_grant.owner_id is distinct from verified_user_id
    or asset.created_by is distinct from verified_user_id
    or expected_bucket is distinct from 'cms-media-private'
    or upload_grant.bucket_id is distinct from expected_bucket
    or asset.private_bucket is distinct from expected_bucket
    or expected_path is distinct from ('private/' || target_asset_id::text)
    or upload_grant.object_path is distinct from expected_path
    or asset.private_path is distinct from expected_path
    or upload_grant.expires_at <= finalized_time
    or upload_grant.finalized_at is not null
    or asset.lifecycle_status <> 'uploading' then
    return;
  end if;
  if validated_byte_size is null or validated_byte_size <= 0
    or validated_byte_size > (case when asset.asset_kind = 'glb' then 26214400 else 10485760 end)
    or validated_sha256 is null or validated_sha256 !~ '^[a-f0-9]{64}$'
    or validated_mime_type is null
    or (asset.asset_kind = 'glb' and validated_mime_type <> 'model/gltf-binary')
    or (asset.asset_kind = 'image' and validated_mime_type not in ('image/png', 'image/jpeg', 'image/webp')) then
    raise exception 'invalid validated media metadata' using errcode = '22023';
  end if;
  update public.media_upload_grants set finalized_at = finalized_time
  where asset_id = target_asset_id;
  return query
    update public.media_assets set lifecycle_status = 'ready',
      byte_size = validated_byte_size, mime_type = validated_mime_type,
      checksum_sha256 = validated_sha256, finalized_at = finalized_time
    where id = target_asset_id returning *;
end;
$$;
-- No browser can spoof verified_user_id or digest/size/MIME parameters.
revoke all on function public.finalize_media_upload(uuid, uuid, text, text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_media_upload(uuid, uuid, text, text, bigint, text, text)
  to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'cms-media-private',
    'cms-media-private',
    false,
    26214400,
    array['model/gltf-binary', 'image/png', 'image/jpeg', 'image/webp']::text[]
  ),
  (
    'cms-media-public',
    'cms-media-public',
    true,
    26214400,
    array['model/gltf-binary', 'image/png', 'image/jpeg', 'image/webp']::text[]
  )
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media managers own private uploads" on storage.objects;
create policy "media managers own private uploads"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'cms-media-private'
  and owner_id = auth.uid()::text
  and public.has_current_capability('media.manage')
  and public.has_live_media_upload_grant(bucket_id, name)
);

drop policy if exists "media managers own private object changes" on storage.objects;
create policy "media managers own private object changes"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'cms-media-private'
  and owner_id = auth.uid()::text
  and public.has_current_capability('media.manage')
  and public.has_live_media_upload_grant(bucket_id, name)
)
with check (
  bucket_id = 'cms-media-private'
  and owner_id = auth.uid()::text
  and public.has_current_capability('media.manage')
  and public.has_live_media_upload_grant(bucket_id, name)
);

drop policy if exists "media managers own private object deletes" on storage.objects;
create policy "media managers own private object deletes"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'cms-media-private'
  and owner_id = auth.uid()::text
  and public.has_current_capability('media.manage')
  and public.has_live_media_upload_grant(bucket_id, name)
);

create or replace function public.resolve_published_media_asset(asset_id uuid)
returns table (
  id uuid,
  created_by uuid,
  asset_kind text,
  lifecycle_status text,
  private_bucket text,
  private_path text,
  public_bucket text,
  public_key text,
  mime_type text,
  byte_size bigint,
  checksum_sha256 text,
  finalized_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    asset.id,
    asset.created_by,
    asset.asset_kind,
    asset.lifecycle_status,
    asset.private_bucket,
    asset.private_path,
    asset.public_bucket,
    asset.public_key,
    asset.mime_type,
    asset.byte_size,
    asset.checksum_sha256,
    asset.finalized_at
  from public.media_assets asset
  where asset.id = asset_id
    and asset.lifecycle_status = 'ready'
    and asset.public_key = 'assets/' || asset.id::text || '/' || asset.checksum_sha256
    and exists (
      select 1
      from public.revision_dependencies dependency
      join public.content_entities entity
        on entity.id = dependency.source_entity_id
       and entity.published_revision_id = dependency.source_revision_id
      join public.publications publication
        on publication.entity_id = dependency.source_entity_id
       and publication.revision_id = dependency.source_revision_id
       and publication.status = 'published'
       and publication.unpublished_at is null
      where dependency.target_media_asset_id = asset.id
    );
$$;

revoke all on function public.resolve_published_media_asset(uuid) from public, anon, authenticated;
grant execute on function public.resolve_published_media_asset(uuid) to service_role;

commit;
