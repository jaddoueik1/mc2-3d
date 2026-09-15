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

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'cms-media-private',
    'cms-media-private',
    false,
    26214400,
    array['model/gltf-binary', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']::text[]
  ),
  (
    'cms-media-public',
    'cms-media-public',
    true,
    26214400,
    array['model/gltf-binary', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']::text[]
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
  and owner_id = auth.uid()
  and public.has_current_capability('media.manage')
);

drop policy if exists "media managers own private object changes" on storage.objects;
create policy "media managers own private object changes"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'cms-media-private'
  and owner_id = auth.uid()
  and public.has_current_capability('media.manage')
)
with check (
  bucket_id = 'cms-media-private'
  and owner_id = auth.uid()
  and public.has_current_capability('media.manage')
);

drop policy if exists "media managers own private object deletes" on storage.objects;
create policy "media managers own private object deletes"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'cms-media-private'
  and owner_id = auth.uid()
  and public.has_current_capability('media.manage')
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

revoke all on function public.resolve_published_media_asset(uuid) from public;
grant execute on function public.resolve_published_media_asset(uuid) to anon, authenticated;

commit;
