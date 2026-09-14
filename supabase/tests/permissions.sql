begin;

select plan(12);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at
) values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'editor@example.test', 'not-used', now()),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'metrics@example.test', 'not-used', now()),
  ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'disabled@example.test', 'not-used', now()),
  ('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin@example.test', 'not-used', now())
on conflict (id) do nothing;

insert into public.cms_profiles (user_id, display_name, disabled_at)
values
  ('00000000-0000-0000-0000-000000000101', 'Editor', null),
  ('00000000-0000-0000-0000-000000000102', 'Metrics', null),
  ('00000000-0000-0000-0000-000000000103', 'Disabled', now()),
  ('00000000-0000-0000-0000-000000000104', 'Administrator', null)
on conflict (user_id) do update set disabled_at = excluded.disabled_at;

insert into public.user_roles (user_id, role_id)
select '00000000-0000-0000-0000-000000000101', id from public.roles where key = 'editor'
on conflict do nothing;

insert into public.user_roles (user_id, role_id)
select '00000000-0000-0000-0000-000000000102', id from public.roles where key = 'metrics-manager'
on conflict do nothing;

insert into public.user_roles (user_id, role_id)
select '00000000-0000-0000-0000-000000000103', id from public.roles where key = 'administrator'
on conflict do nothing;

insert into public.user_roles (user_id, role_id)
select '00000000-0000-0000-0000-000000000104', id from public.roles where key = 'administrator'
on conflict do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);

select ok(public.has_current_capability('content.edit'), 'editor can edit content');
select ok(not public.has_current_capability('content.publish'), 'editor cannot publish');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select ok(public.has_current_capability('metrics.edit'), 'metrics manager can edit metrics');
select ok(not public.has_current_capability('users.manage'), 'metrics manager cannot manage users');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000103', true);
select ok(not public.has_current_capability('content.edit'), 'disabled profile has no capabilities');
select throws_ok(
  $$select public.grant_role_to_user('00000000-0000-0000-0000-000000000101', 'publisher')$$,
  'P0001',
  'users.manage capability is required',
  'disabled user cannot mutate role assignments'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000104', true);
select throws_ok(
  $$select public.grant_role_to_user('00000000-0000-0000-0000-000000000104', 'publisher')$$,
  'P0001',
  'users may not grant themselves roles',
  'user cannot self-grant'
);
select lives_ok(
  $$select public.grant_role_to_user('00000000-0000-0000-0000-000000000101', 'publisher')$$,
  'administrator can add a second role'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select ok(
  public.has_current_capability('content.edit')
  and public.has_current_capability('content.publish'),
  'combined editor and publisher roles union their capabilities'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000104', true);
select lives_ok(
  $$select public.revoke_role_from_user('00000000-0000-0000-0000-000000000101', 'publisher')$$,
  'administrator can revoke a role'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select ok(
  not public.has_current_capability('content.publish')
  and public.has_current_capability('content.edit'),
  'current capability RPC reflects role revocation on the next call'
);

select set_config('request.jwt.claim.sub', '', true);
set local role anon;
select throws_ok(
  $$select * from public.content_entities$$,
  '42501',
  null,
  'anonymous callers cannot read base tables or drafts'
);

select * from finish();
rollback;
