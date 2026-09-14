begin;

alter table public.cms_profiles
  add column if not exists disabled_at timestamptz;

insert into public.permissions (key, description)
values
  ('content.read', 'Read CMS content and published content metadata.'),
  ('content.edit', 'Create and edit CMS content.'),
  ('metrics.edit', 'Create and edit metric observations.'),
  ('media.manage', 'Upload, archive, and manage media.'),
  ('content.publish', 'Publish or withdraw CMS content.'),
  ('users.manage', 'Manage CMS users and role assignments.')
on conflict (key) do update
  set description = excluded.description;

insert into public.roles (key, name)
values
  ('administrator', 'Administrator'),
  ('editor', 'Editor'),
  ('metrics-manager', 'Metrics manager'),
  ('publisher', 'Publisher')
on conflict (key) do update
  set name = excluded.name;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
join public.permissions permission on
  role.key = 'administrator'
  or (role.key = 'editor' and permission.key in ('content.read', 'content.edit', 'media.manage'))
  or (role.key = 'metrics-manager' and permission.key in ('content.read', 'metrics.edit', 'media.manage'))
  or (role.key = 'publisher' and permission.key in ('content.read', 'content.publish'))
where role.key in ('administrator', 'editor', 'metrics-manager', 'publisher')
on conflict do nothing;

create or replace function public.has_current_capability(required_capability text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.cms_profiles profile
    join public.user_roles user_role on user_role.user_id = profile.user_id
    join public.role_permissions role_permission on role_permission.role_id = user_role.role_id
    join public.permissions permission on permission.id = role_permission.permission_id
    where profile.user_id = auth.uid()
      and profile.disabled_at is null
      and permission.key = required_capability
  );
$$;

create or replace function public.grant_role_to_user(target_user_id uuid, role_key text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  selected_role_id uuid;
begin
  if actor_user_id is null then
    raise exception 'authentication is required' using errcode = 'P0001';
  end if;

  if actor_user_id = target_user_id then
    raise exception 'users may not grant themselves roles' using errcode = 'P0001';
  end if;

  if not public.has_current_capability('users.manage') then
    raise exception 'users.manage capability is required' using errcode = 'P0001';
  end if;

  select id into selected_role_id from public.roles where key = role_key;
  if selected_role_id is null then
    raise exception 'unknown role' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.cms_profiles where user_id = target_user_id) then
    raise exception 'CMS profile does not exist' using errcode = 'P0001';
  end if;

  insert into public.user_roles (user_id, role_id, granted_by)
  values (target_user_id, selected_role_id, actor_user_id)
  on conflict do nothing;
end;
$$;

create or replace function public.revoke_role_from_user(target_user_id uuid, role_key text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  selected_role_id uuid;
begin
  if actor_user_id is null then
    raise exception 'authentication is required' using errcode = 'P0001';
  end if;

  if actor_user_id = target_user_id then
    raise exception 'users may not revoke their own roles' using errcode = 'P0001';
  end if;

  if not public.has_current_capability('users.manage') then
    raise exception 'users.manage capability is required' using errcode = 'P0001';
  end if;

  select id into selected_role_id from public.roles where key = role_key;
  if selected_role_id is null then
    raise exception 'unknown role' using errcode = 'P0001';
  end if;

  delete from public.user_roles
  where user_id = target_user_id and role_id = selected_role_id;
end;
$$;

alter table
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
enable row level security;

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

revoke execute on function public.has_current_capability(text) from public, anon, authenticated;
revoke execute on function public.grant_role_to_user(uuid, text) from public, anon, authenticated;
revoke execute on function public.revoke_role_from_user(uuid, text) from public, anon, authenticated;

grant execute on function public.has_current_capability(text) to authenticated;
grant execute on function public.grant_role_to_user(uuid, text) to authenticated;
grant execute on function public.revoke_role_from_user(uuid, text) to authenticated;

commit;
