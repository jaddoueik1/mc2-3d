begin;

create extension if not exists pgcrypto;

create table public.geographic_scopes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  scope_type text not null,
  parent_id uuid references public.geographic_scopes(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.content_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('observation', 'metric', 'building', 'layer', 'dataset', 'story', 'tour')),
  slug text not null unique,
  title text not null,
  metric_key text,
  geographic_scope_id uuid references public.geographic_scopes(id) on delete restrict,
  period_start date,
  period_end date,
  building_entity_id uuid references public.content_entities(id) on delete restrict,
  latest_revision_id uuid,
  published_revision_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end is null or period_start is null or period_end >= period_start),
  check (
    (entity_type = 'observation'
      and metric_key is not null
      and geographic_scope_id is not null
      and period_start is not null
      and period_end is not null)
    or entity_type <> 'observation'
  )
);

create unique index content_entities_observation_identity_key
  on public.content_entities (metric_key, geographic_scope_id, period_start, period_end)
  where entity_type = 'observation';

create table public.content_revisions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.content_entities(id) on delete restrict,
  revision_number integer not null check (revision_number > 0),
  content jsonb not null,
  change_summary text,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (entity_id, id),
  unique (entity_id, revision_number)
);

alter table public.content_entities
  add constraint content_entities_latest_revision_fkey
    foreign key (id, latest_revision_id)
    references public.content_revisions (entity_id, id)
    deferrable initially deferred,
  add constraint content_entities_published_revision_fkey
    foreign key (id, published_revision_id)
    references public.content_revisions (entity_id, id)
    deferrable initially deferred;

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  storage_bucket text not null,
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  checksum_sha256 text,
  alt_text text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (storage_bucket, storage_path)
);

create table public.revision_dependencies (
  id uuid primary key default gen_random_uuid(),
  dependency_type text not null,
  source_entity_id uuid not null,
  source_revision_id uuid not null,
  target_entity_id uuid,
  target_revision_id uuid,
  target_media_asset_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  foreign key (source_entity_id, source_revision_id)
    references public.content_revisions(entity_id, id) on delete restrict,
  foreign key (target_entity_id, target_revision_id)
    references public.content_revisions(entity_id, id) on delete restrict,
  foreign key (target_media_asset_id)
    references public.media_assets(id) on delete restrict,
  check (
    (target_entity_id is not null and target_revision_id is not null and target_media_asset_id is null)
    or
    (target_entity_id is null and target_revision_id is null and target_media_asset_id is not null)
  )
);

create table public.publications (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null,
  revision_id uuid not null,
  status text not null check (status in ('draft', 'scheduled', 'published', 'withdrawn')),
  published_at timestamptz,
  unpublished_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  foreign key (entity_id, revision_id)
    references public.content_revisions(entity_id, id) on delete restrict,
  check (unpublished_at is null or published_at is null or unpublished_at >= published_at)
);

create unique index publications_one_active_per_entity_key
  on public.publications(entity_id)
  where status = 'published' and unpublished_at is null;

create table public.cms_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.cms_profiles(user_id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references public.cms_profiles(user_id) on delete set null,
  primary key (user_id, role_id)
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.cms_profiles(user_id) on delete set null,
  event_type text not null,
  entity_id uuid references public.content_entities(id) on delete set null,
  revision_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  check (revision_id is null or entity_id is not null),
  foreign key (entity_id, revision_id)
    references public.content_revisions(entity_id, id) on delete restrict
);

create index audit_events_entity_occurred_at_idx
  on public.audit_events(entity_id, occurred_at desc);

create function public.reject_content_revision_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'content revisions are immutable'
    using errcode = 'P0001';
end;
$$;

create trigger content_revisions_immutable
before update or delete on public.content_revisions
for each row execute function public.reject_content_revision_mutation();

create function public.reject_revision_dependency_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'revision dependencies are immutable'
    using errcode = 'P0001';
end;
$$;

create trigger revision_dependencies_immutable
before update or delete on public.revision_dependencies
for each row execute function public.reject_revision_dependency_mutation();

create function public.reject_content_identity_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
    or new.entity_type is distinct from old.entity_type
    or new.slug is distinct from old.slug
    or new.metric_key is distinct from old.metric_key
    or new.geographic_scope_id is distinct from old.geographic_scope_id
    or new.period_start is distinct from old.period_start
    or new.period_end is distinct from old.period_end then
    raise exception 'content entity identity fields are immutable'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger content_entities_identity_immutable
before update on public.content_entities
for each row execute function public.reject_content_identity_mutation();

create function public.assert_revision_media_is_active(candidate_entity_id uuid, candidate_revision_id uuid)
returns void
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.revision_dependencies dependency
    join public.media_assets asset on asset.id = dependency.target_media_asset_id
    where dependency.source_entity_id = candidate_entity_id
      and dependency.source_revision_id = candidate_revision_id
      and asset.archived_at is not null
  ) then
    raise exception 'published revisions cannot reference archived media assets'
      using errcode = 'P0001';
  end if;
end;
$$;

create function public.reject_archived_media_dependency()
returns trigger
language plpgsql
as $$
begin
  if new.target_media_asset_id is not null and exists (
    select 1 from public.media_assets
    where id = new.target_media_asset_id and archived_at is not null
  ) then
    raise exception 'revision dependencies cannot reference archived media assets'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger revision_dependencies_archived_media_guard
before insert on public.revision_dependencies
for each row execute function public.reject_archived_media_dependency();

create function public.validate_published_revision_pointer_media()
returns trigger
language plpgsql
as $$
begin
  if new.published_revision_id is not null
    and new.published_revision_id is distinct from old.published_revision_id then
    perform public.assert_revision_media_is_active(new.id, new.published_revision_id);
  end if;
  return new;
end;
$$;

create trigger content_entities_published_media_guard
before update of published_revision_id on public.content_entities
for each row execute function public.validate_published_revision_pointer_media();

create function public.validate_publication_media()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'published' and new.unpublished_at is null then
    perform public.assert_revision_media_is_active(new.entity_id, new.revision_id);
  end if;
  return new;
end;
$$;

create trigger publications_published_media_guard
before insert or update of status, revision_id, unpublished_at on public.publications
for each row execute function public.validate_publication_media();

create or replace function public.prevent_active_published_media_removal()
returns trigger
language plpgsql
as $$
declare
  asset_id uuid := old.id;
  becomes_archived boolean := tg_op = 'UPDATE'
    and old.archived_at is null
    and new.archived_at is not null;
begin
  if (tg_op = 'DELETE' or becomes_archived) and exists (
    select 1
    from public.revision_dependencies dependency
    left join public.publications publication
      on publication.entity_id = dependency.source_entity_id
     and publication.revision_id = dependency.source_revision_id
     and publication.status = 'published'
     and publication.unpublished_at is null
    left join public.content_entities entity
      on entity.id = dependency.source_entity_id
     and entity.published_revision_id = dependency.source_revision_id
    where dependency.target_media_asset_id = asset_id
      and (publication.id is not null or entity.id is not null)
  ) then
    raise exception 'media asset is referenced by an active published revision'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger media_assets_active_publication_guard
before update of archived_at or delete on public.media_assets
for each row execute function public.prevent_active_published_media_removal();

create function public.validate_published_revision_pointer_consistency()
returns trigger
language plpgsql
as $$
begin
  if new.published_revision_id is distinct from old.published_revision_id then
    if new.published_revision_id is null then
      if exists (
        select 1 from public.publications
        where entity_id = new.id
          and status = 'published'
          and unpublished_at is null
      ) then
        raise exception 'published revision pointer must match the active publication'
          using errcode = 'P0001';
      end if;
    elsif not exists (
      select 1 from public.publications
      where entity_id = new.id
        and revision_id = new.published_revision_id
        and status = 'published'
        and unpublished_at is null
    ) then
      raise exception 'published revision pointer must match the active publication'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger content_entities_published_pointer_consistency
before update of published_revision_id on public.content_entities
for each row execute function public.validate_published_revision_pointer_consistency();

create function public.sync_entity_published_revision_from_publication()
returns trigger
language plpgsql
as $$
declare
  affected_entity_id uuid := coalesce(new.entity_id, old.entity_id);
  active_revision_id uuid;
begin
  select revision_id
    into active_revision_id
    from public.publications
   where entity_id = affected_entity_id
     and status = 'published'
     and unpublished_at is null;

  update public.content_entities
     set published_revision_id = active_revision_id,
         updated_at = now()
   where id = affected_entity_id
     and published_revision_id is distinct from active_revision_id;

  return coalesce(new, old);
end;
$$;

create trigger publications_sync_entity_published_revision
after insert or update or delete on public.publications
for each row execute function public.sync_entity_published_revision_from_publication();

revoke all on table
  public.geographic_scopes,
  public.content_entities,
  public.content_revisions,
  public.revision_dependencies,
  public.publications,
  public.media_assets,
  public.cms_profiles,
  public.roles,
  public.permissions,
  public.user_roles,
  public.role_permissions,
  public.audit_events
from anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;

commit;
