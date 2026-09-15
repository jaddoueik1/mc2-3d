begin;
select plan(24);

insert into auth.users(id, email) values ('00000000-0000-4000-8000-000000000101', 'publication-admin@example.test'), ('00000000-0000-4000-8000-000000000102', 'publication-editor@example.test');
insert into public.cms_profiles(user_id) values ('00000000-0000-4000-8000-000000000101'), ('00000000-0000-4000-8000-000000000102');
insert into public.user_roles(user_id, role_id) select '00000000-0000-4000-8000-000000000101', id from public.roles where key = 'administrator';
insert into public.user_roles(user_id, role_id) select '00000000-0000-4000-8000-000000000102', id from public.roles where key = 'editor';
insert into public.geographic_scopes(id,code,name,scope_type) values ('00000000-0000-4000-8000-000000000501','pub-test','Test','development');
insert into public.content_entities(id, entity_type, slug, title, geographic_scope_id) values
('00000000-0000-4000-8000-000000000201','building','pub-b','Building','00000000-0000-4000-8000-000000000501'),
('00000000-0000-4000-8000-000000000202','building','pub-c','Other','00000000-0000-4000-8000-000000000501'),
('00000000-0000-4000-8000-000000000203','scene','pub-s','Scene','00000000-0000-4000-8000-000000000501');
insert into public.media_assets(id,storage_bucket,storage_path,mime_type,byte_size,checksum_sha256,asset_kind,lifecycle_status,private_bucket,private_path,public_bucket,public_key,finalized_at) values
('00000000-0000-4000-8000-000000000301','cms-media-private','private/00000000-0000-4000-8000-000000000301','image/png',1,repeat('a',64),'image','ready','cms-media-private','private/00000000-0000-4000-8000-000000000301','cms-media-public','assets/00000000-0000-4000-8000-000000000301/'||repeat('a',64),now()),
('00000000-0000-4000-8000-000000000302','cms-media-private','private/00000000-0000-4000-8000-000000000302','model/gltf-binary',1,repeat('b',64),'glb','ready','cms-media-private','private/00000000-0000-4000-8000-000000000302','cms-media-public','assets/00000000-0000-4000-8000-000000000302/'||repeat('b',64),now());

-- Stable helpers call the real RPCs; no test-owned public pointer is involved.
create function pg_temp.save_building(entity uuid, expected integer, name text) returns jsonb language sql as $$
  select public.save_content_draft('00000000-0000-4000-8000-000000000101','building',entity,expected,
  jsonb_build_object('name',name,'categoryId',null,'description','','heightM',null,'floorCount',2,'gfaM2',null,'availability','','tags','[]'::jsonb,'images','[]'::jsonb,'enquiryUrl',null),'[]');
$$;
select is((pg_temp.save_building('00000000-0000-4000-8000-000000000201',0,'Published name')->>'revision')::int,1,'first immutable revision');
select lives_ok($$select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[{"resource":"building","entityId":"00000000-0000-4000-8000-000000000201","revision":1}]','[]')$$,'publish exact revision');
select is(public.read_published_content('building','00000000-0000-4000-8000-000000000201')->'payload'->>'name','Published name','published projection reads active pointer');
select is((pg_temp.save_building('00000000-0000-4000-8000-000000000201',1,'Draft name')->>'revision')::int,2,'draft increments revision');
select is(public.read_published_content('building','00000000-0000-4000-8000-000000000201')->'payload'->>'name','Published name','draft does not change projection');
select throws_ok($$select pg_temp.save_building('00000000-0000-4000-8000-000000000201',1,'Lost edit')$$,'PT409',null,'stale save conflicts');
select throws_ok($$select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[{"resource":"building","entityId":"00000000-0000-4000-8000-000000000201","revision":1}]','[]')$$,'PT409',null,'stale publish does not publish latest accidentally');
select throws_ok($$select public.publish_content_revisions('00000000-0000-4000-8000-000000000102','[{"resource":"building","entityId":"00000000-0000-4000-8000-000000000201","revision":2}]','[]')$$,'PT403',null,'editor cannot publish even with server invocation');
select pg_temp.save_building('00000000-0000-4000-8000-000000000202',0,'Other');
select throws_ok($$select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[{"resource":"building","entityId":"00000000-0000-4000-8000-000000000201","revision":2},{"resource":"building","entityId":"00000000-0000-4000-8000-000000000202","revision":8}]','[]')$$,'PT409',null,'invalid second entry rolls back batch');
select is(public.read_published_content('building','00000000-0000-4000-8000-000000000201')->'payload'->>'name','Published name','failed batch leaves first pointer unchanged');
select is((select count(*)::int from public.audit_events where event_type='content.publish'),1,'failed batch adds no publication audit');
select is((public.read_content_revision('00000000-0000-4000-8000-000000000101','building','00000000-0000-4000-8000-000000000201',1)->'payload'->>'name'),'Published name','preview reads exact history');
select is((public.restore_content_revision('00000000-0000-4000-8000-000000000101','building','00000000-0000-4000-8000-000000000201',1,2)->>'revision')::int,3,'restore clones into a new monotonic draft');
select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[{"resource":"building","entityId":"00000000-0000-4000-8000-000000000201","revision":3}]','[]');
select public.save_content_draft('00000000-0000-4000-8000-000000000101','scene','00000000-0000-4000-8000-000000000203',0,
'{"scopeId":"00000000-0000-4000-8000-000000000501","masterplanMediaId":"00000000-0000-4000-8000-000000000301","width":100,"depth":100,"camera":{"target":[0,0,0],"radius":100,"theta":0,"phi":1},"placements":[{"buildingId":"00000000-0000-4000-8000-000000000201","modelMediaId":"00000000-0000-4000-8000-000000000302","u":0.5,"v":0.5,"targetWidth":1,"rotationDegrees":[0,0,0],"verticalOffset":0,"order":0,"visible":true}]}',
'[{"mediaId":"00000000-0000-4000-8000-000000000301","mediaType":"image"},{"entityId":"00000000-0000-4000-8000-000000000201","resource":"building"},{"mediaId":"00000000-0000-4000-8000-000000000302","mediaType":"glb"}]');
select throws_ok($$select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[{"resource":"scene","entityId":"00000000-0000-4000-8000-000000000203","revision":1}]','[]')$$,'PT409',null,'missing prepared immutable media rejects publication');
select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[{"resource":"scene","entityId":"00000000-0000-4000-8000-000000000203","revision":1}]',jsonb_build_array(jsonb_build_object('mediaId','00000000-0000-4000-8000-000000000301','key','assets/00000000-0000-4000-8000-000000000301/'||repeat('a',64)),jsonb_build_object('mediaId','00000000-0000-4000-8000-000000000302','key','assets/00000000-0000-4000-8000-000000000302/'||repeat('b',64))));
select is(jsonb_array_length(public.read_published_content('scene','00000000-0000-4000-8000-000000000203')->'payload'->'placements'),1,'scene placement is active');
select public.unpublish_content_building('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',3);
select is(public.read_published_content('building','00000000-0000-4000-8000-000000000201'),null::jsonb,'unpublished building is unavailable');
select is(jsonb_array_length(public.read_published_content('scene','00000000-0000-4000-8000-000000000203')->'payload'->'placements'),0,'unpublish removes active scene placement in same transaction');
select is((select count(*)::int from public.content_revisions where entity_id='00000000-0000-4000-8000-000000000201'),3,'unpublish and restore retain immutable history');
select throws_ok($$select public.save_content_draft('00000000-0000-4000-8000-000000000101','building','00000000-0000-4000-8000-000000000202',1,
'{"name":"With media","categoryId":null,"description":"","heightM":null,"floorCount":2,"gfaM2":null,"availability":"","tags":[],"images":[{"mediaId":"00000000-0000-4000-8000-000000000301","alt":"Test"}],"enquiryUrl":null}','[]')$$,'PT400',null,'server cannot omit extracted media dependency');
-- Historical seed/import mistakes must not bypass publication dependency checks.
insert into public.content_revisions(entity_id,revision_number,content) select '00000000-0000-4000-8000-000000000202',2,
jsonb_set(content,'{images}','[{"mediaId":"00000000-0000-4000-8000-000000000301","alt":"Test"}]') from public.content_revisions where entity_id='00000000-0000-4000-8000-000000000202' and revision_number=1;
update public.content_entities set latest_revision_id=(select id from public.content_revisions where entity_id='00000000-0000-4000-8000-000000000202' and revision_number=2) where id='00000000-0000-4000-8000-000000000202';
select throws_ok($$select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[{"resource":"building","entityId":"00000000-0000-4000-8000-000000000202","revision":2}]','[]')$$,'PT409',null,'missing stored dependency rejects seeded snapshot');
delete from public.user_roles where user_id='00000000-0000-4000-8000-000000000102';
insert into public.user_roles(user_id,role_id) select '00000000-0000-4000-8000-000000000102',id from public.roles where key='publisher';
select is((public.restore_content_revision('00000000-0000-4000-8000-000000000102','building','00000000-0000-4000-8000-000000000201',1,3)->>'revision')::int,4,'publisher can clone history without arbitrary draft edit permission');
select is((select revision_number from public.content_revisions where id=(select published_revision_id from public.content_entities where id='00000000-0000-4000-8000-000000000201')),null::integer,'restore never republishes or repoints backward');
set local role authenticated;
select throws_ok($$insert into public.content_revisions(entity_id,revision_number,content) values('00000000-0000-4000-8000-000000000201',4,'{}')$$,'42501',null,'browser cannot bypass revision RPC');
select throws_ok($$select public.publish_content_revisions('00000000-0000-4000-8000-000000000101','[]','[]')$$,'42501',null,'browser cannot spoof verified actor');
reset role;
select * from finish();
rollback;
