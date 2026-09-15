begin;

alter table public.content_entities drop constraint content_entities_entity_type_check;
alter table public.content_entities add constraint content_entities_entity_type_check
  check (entity_type in ('observation','metric','building','layer','dataset','story','tour','scene','floor','category','dashboard'));

-- Publication-local placement state allows withdrawal without editing a snapshot.
create table public.published_scene_placements (
  publication_id uuid not null references public.publications(id),
  building_entity_id uuid not null references public.content_entities(id),
  placement jsonb not null,
  active boolean not null default true,
  primary key (publication_id, building_entity_id)
);
alter table public.published_scene_placements enable row level security;
revoke all on public.published_scene_placements from public, anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.content_entities, public.content_revisions,
  public.revision_dependencies, public.publications, public.audit_events from public, anon, authenticated, service_role;

create function public.authorize_content_actor(verified_user_id uuid, required_capability text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if verified_user_id is null then raise exception 'Authentication required' using errcode='PT401'; end if;
  if not exists (
    select 1 from public.cms_profiles p
    join public.user_roles ur on ur.user_id=p.user_id
    join public.role_permissions rp on rp.role_id=ur.role_id
    join public.permissions c on c.id=rp.permission_id
    where p.user_id=verified_user_id and p.disabled_at is null and c.key=required_capability
  ) then raise exception 'Capability denied' using errcode='PT403'; end if;
end;
$$;

-- The database derives this list too: a trusted server cannot accidentally omit
-- a dependency during save. Types are part of the reference identity.
create function public.content_payload_references(resource text, payload jsonb)
returns jsonb language plpgsql immutable set search_path = pg_catalog, public as $$
declare refs jsonb := '[]'; item jsonb; widget jsonb;
begin
  if resource in ('building','metric') and payload->>'categoryId' is not null then
    refs := refs || jsonb_build_array(jsonb_build_object('entityId',payload->>'categoryId','resource','category'));
  end if;
  if resource='building' then
    for item in select value from jsonb_array_elements(payload->'images') loop
      refs := refs || jsonb_build_array(jsonb_build_object('mediaId',item->>'mediaId','mediaType','image'));
    end loop;
  elsif resource='floor' then
    refs := refs || jsonb_build_array(jsonb_build_object('entityId',payload->>'buildingId','resource','building'));
    if payload->>'drawing' is not null then refs := refs || jsonb_build_array(jsonb_build_object('mediaId',payload->'drawing'->>'mediaId','mediaType','image')); end if;
  elsif resource='observation' then
    refs := refs || jsonb_build_array(jsonb_build_object('entityId',payload->>'metricId','resource','metric'));
  elsif resource='scene' then
    refs := refs || jsonb_build_array(jsonb_build_object('mediaId',payload->>'masterplanMediaId','mediaType','image'));
    for item in select value from jsonb_array_elements(payload->'placements') loop
      refs := refs || jsonb_build_array(jsonb_build_object('entityId',item->>'buildingId','resource','building'),jsonb_build_object('mediaId',item->>'modelMediaId','mediaType','glb'));
    end loop;
  elsif resource='dashboard' then
    for item in select value from jsonb_array_elements(payload->'categoryIds') loop
      refs := refs || jsonb_build_array(jsonb_build_object('entityId',item#>>'{}','resource','category'));
    end loop;
    for widget in select value from jsonb_array_elements(payload->'widgets') loop
      for item in select value from jsonb_array_elements(widget->'metricIds') loop refs := refs || jsonb_build_array(jsonb_build_object('entityId',item#>>'{}','resource','metric')); end loop;
      for item in select value from jsonb_array_elements(widget->'observationIds') loop refs := refs || jsonb_build_array(jsonb_build_object('entityId',item#>>'{}','resource','observation')); end loop;
      if widget->>'image' is not null then refs := refs || jsonb_build_array(jsonb_build_object('mediaId',widget->'image'->>'mediaId','mediaType','image')); end if;
    end loop;
  end if;
  return (select coalesce(jsonb_agg(value order by value::text),'[]') from (select distinct value from jsonb_array_elements(refs)) r);
end;
$$;

create function public.validate_content_snapshot(resource text, payload jsonb)
returns void language plpgsql immutable set search_path = pg_catalog, public as $$
declare keys text[]; item jsonb; w jsonb;
begin
  keys := case resource
    when 'building' then array['name','categoryId','description','heightM','floorCount','gfaM2','availability','tags','images','enquiryUrl']
    when 'floor' then array['buildingId','label','sortOrder','areaM2','use','description','drawing','isDefault']
    when 'category' then array['key','label','color','order']
    when 'metric' then array['key','label','categoryId','unit','precision','description','preferredDirection','denominator']
    when 'observation' then array['metricId','scopeId','periodStart','periodEnd','value','target','source','isSample']
    when 'scene' then array['scopeId','masterplanMediaId','width','depth','camera','placements']
    when 'dashboard' then array['scopeId','title','categoryIds','widgets'] end;
  if keys is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'Invalid resource payload' using errcode='PT400'; end if;
  if not (payload ?& keys) or exists(select 1 from jsonb_object_keys(payload) k where not k=any(keys)) then raise exception 'Invalid resource fields' using errcode='PT400'; end if;
  if resource='building' then
    if jsonb_typeof(payload->'name') is distinct from 'string' or length(btrim(payload->>'name'))=0
      or jsonb_typeof(payload->'images') is distinct from 'array' or jsonb_typeof(payload->'tags') is distinct from 'array'
      or jsonb_typeof(payload->'floorCount') is distinct from 'number' or (payload->>'floorCount')::numeric < 0
      or (payload->>'floorCount')::numeric > 1000 or (payload->>'floorCount')::numeric <> trunc((payload->>'floorCount')::numeric)
      or (payload->>'heightM')::numeric < 0 or (payload->>'gfaM2')::numeric < 0
      or (payload->>'enquiryUrl' is not null and payload->>'enquiryUrl' !~ '^(https://|mailto:|tel:)') then raise exception 'Invalid building fields' using errcode='PT400'; end if;
  elsif resource='floor' then
    if coalesce(length(btrim(payload->>'label')),0)=0 or (payload->>'areaM2')::numeric < 0 or jsonb_typeof(payload->'isDefault') is distinct from 'boolean' then raise exception 'Invalid floor fields' using errcode='PT400'; end if;
  elsif resource='category' then
    if coalesce(length(btrim(payload->>'key')),0)=0 or coalesce(length(btrim(payload->>'label')),0)=0 or coalesce(payload->>'color','') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Invalid category fields' using errcode='PT400'; end if;
  elsif resource='metric' then
    if coalesce(length(btrim(payload->>'key')),0)=0 or coalesce(length(btrim(payload->>'label')),0)=0 or coalesce(length(btrim(payload->>'unit')),0)=0
      or (payload->>'precision')::int not between 0 and 10 or payload->>'preferredDirection' not in ('higher','lower','neutral')
      or (lower(payload->>'unit') in ('%','percent','ratio') and coalesce(length(btrim(payload->>'denominator')),0)=0) then raise exception 'Invalid metric definition or denominator' using errcode='PT400'; end if;
  elsif resource='observation' then
    if (payload->>'periodEnd')::date < (payload->>'periodStart')::date or coalesce(length(btrim(payload->>'source')),0)=0
      or jsonb_typeof(payload->'isSample') is distinct from 'boolean'
      or jsonb_typeof(payload->'value') not in ('number','null') or jsonb_typeof(payload->'target') not in ('number','null') then raise exception 'Invalid observation fields' using errcode='PT400'; end if;
  elsif resource='scene' then
    if jsonb_typeof(payload->'placements') is distinct from 'array' or not ((payload->>'width')::numeric > 0) or not ((payload->>'depth')::numeric > 0)
      or not ((payload->'camera'->>'radius')::numeric > 0) then raise exception 'Invalid scene fields' using errcode='PT400'; end if;
    for item in select value from jsonb_array_elements(payload->'placements') loop
      if (item->>'u')::numeric not between 0 and 1 or (item->>'v')::numeric not between 0 and 1 or not ((item->>'targetWidth')::numeric > 0)
        or jsonb_typeof(item->'visible') is distinct from 'boolean' or jsonb_array_length(item->'rotationDegrees')<>3 then raise exception 'Invalid placement' using errcode='PT400'; end if;
    end loop;
    if (select count(*)<>count(distinct value->>'buildingId') from jsonb_array_elements(payload->'placements')) then raise exception 'Duplicate placement' using errcode='PT400'; end if;
  elsif resource='dashboard' then
    if coalesce(length(btrim(payload->>'title')),0)=0 or jsonb_typeof(payload->'widgets') is distinct from 'array' or jsonb_typeof(payload->'categoryIds') is distinct from 'array' then raise exception 'Invalid dashboard' using errcode='PT400'; end if;
    for w in select value from jsonb_array_elements(payload->'widgets') loop
      if w->>'type' not in ('kpi','line','bar','composition','target','image','table') or jsonb_typeof(w->'visible') is distinct from 'boolean'
        or jsonb_typeof(w->'metricIds') is distinct from 'array' or jsonb_typeof(w->'observationIds') is distinct from 'array'
        or (w->>'type'='image' and w->>'image' is null) or (w->>'type'<>'image' and jsonb_array_length(w->'metricIds')=0) then raise exception 'Invalid widget' using errcode='PT400'; end if;
    end loop;
  end if;
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
  raise exception 'Invalid field type' using errcode='PT400';
end;
$$;

create function public.content_revision_snapshot(target_revision_id uuid)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object('entityId',e.id,'resource',e.entity_type,'revision',r.revision_number,'revisionId',r.id,'scopeId',e.geographic_scope_id,'payload',r.content,
    'references',public.content_payload_references(e.entity_type,r.content))
  from public.content_revisions r join public.content_entities e on e.id=r.entity_id where r.id=target_revision_id;
$$;

create function public.read_content_revision(verified_user_id uuid, target_resource text, target_entity_id uuid, exact_revision integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare result jsonb;
begin
  perform public.authorize_content_actor(verified_user_id,'content.read');
  select public.content_revision_snapshot(r.id) into result from public.content_revisions r join public.content_entities e on e.id=r.entity_id
    where e.id=target_entity_id and e.entity_type=target_resource and r.revision_number=exact_revision;
  if result is null then raise exception 'Revision unavailable' using errcode='PT404'; end if;
  return result;
end;
$$;

-- Internal append primitive is never executable by service_role/browser roles.
create function public.append_content_draft(verified_user_id uuid, target_resource text, target_entity_id uuid, expected_revision integer, draft_payload jsonb, extracted_references jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare e public.content_entities%rowtype; ref jsonb; target public.content_entities%rowtype; asset public.media_assets%rowtype;
  current_revision integer; new_revision_id uuid; refs jsonb;
begin
  perform public.validate_content_snapshot(target_resource,draft_payload);
  refs := public.content_payload_references(target_resource,draft_payload);
  if jsonb_typeof(extracted_references) is distinct from 'array' or not (refs @> extracted_references and extracted_references @> refs) then raise exception 'Dependency list mismatch' using errcode='PT400'; end if;
  select * into e from public.content_entities where id=target_entity_id for update;
  if not found or e.entity_type<>target_resource or e.archived_at is not null then raise exception 'Entity unavailable' using errcode='PT404'; end if;
  select coalesce(max(revision_number),0) into current_revision from public.content_revisions where entity_id=e.id;
  if expected_revision is null or expected_revision<>current_revision then raise exception 'Revision conflict' using errcode='PT409', detail=current_revision::text; end if;
  if target_resource in ('scene','dashboard','observation') and (draft_payload->>'scopeId')::uuid is distinct from e.geographic_scope_id then raise exception 'Scope identity mismatch' using errcode='PT400'; end if;
  if target_resource='metric' and e.metric_key is not null and draft_payload->>'key' is distinct from e.metric_key then raise exception 'Metric identity mismatch' using errcode='PT400'; end if;
  if target_resource='floor' and (draft_payload->>'buildingId')::uuid is distinct from e.building_entity_id then raise exception 'Building identity mismatch' using errcode='PT400'; end if;
  if target_resource='observation' and ((draft_payload->>'periodStart')::date is distinct from e.period_start or (draft_payload->>'periodEnd')::date is distinct from e.period_end) then raise exception 'Observation period mismatch' using errcode='PT400'; end if;
  insert into public.content_revisions(entity_id,revision_number,content,created_by) values(e.id,current_revision+1,draft_payload,verified_user_id) returning id into new_revision_id;
  for ref in select value from jsonb_array_elements(refs) loop
    if ref ? 'mediaId' then
      select * into asset from public.media_assets where id=(ref->>'mediaId')::uuid;
      if not found or asset.archived_at is not null or asset.asset_kind<>ref->>'mediaType' then raise exception 'Invalid media reference' using errcode='PT400'; end if;
      insert into public.revision_dependencies(dependency_type,source_entity_id,source_revision_id,target_media_asset_id,created_by)
        values('media:'||(ref->>'mediaType'),e.id,new_revision_id,asset.id,verified_user_id);
    else
      select * into target from public.content_entities where id=(ref->>'entityId')::uuid;
      if not found or target.archived_at is not null or target.latest_revision_id is null or target.entity_type<>ref->>'resource'
        or (target.entity_type not in ('category','metric') and target.geographic_scope_id is distinct from e.geographic_scope_id)
        or (target.geographic_scope_id is not null and target.geographic_scope_id is distinct from e.geographic_scope_id)
        then raise exception 'Invalid entity reference or scope' using errcode='PT400'; end if;
      if target_resource='observation' and target.metric_key is distinct from e.metric_key then raise exception 'Observation metric mismatch' using errcode='PT400'; end if;
      insert into public.revision_dependencies(dependency_type,source_entity_id,source_revision_id,target_entity_id,target_revision_id,created_by)
        values('entity:'||target.entity_type,e.id,new_revision_id,target.id,target.latest_revision_id,verified_user_id);
    end if;
  end loop;
  update public.content_entities set latest_revision_id=new_revision_id,updated_at=now() where id=e.id;
  insert into public.audit_events(actor_user_id,event_type,entity_id,revision_id,metadata) values(verified_user_id,'content.save',e.id,new_revision_id,jsonb_build_object('previousRevision',current_revision,'fields',(select jsonb_agg(k) from jsonb_object_keys(draft_payload) k)));
  return public.content_revision_snapshot(new_revision_id);
end;
$$;

create function public.save_content_draft(verified_user_id uuid, target_resource text, target_entity_id uuid, expected_revision integer, draft_payload jsonb, extracted_references jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.authorize_content_actor(verified_user_id,case when target_resource in ('metric','observation','dashboard') then 'metrics.edit' else 'content.edit' end);
  return public.append_content_draft(verified_user_id,target_resource,target_entity_id,expected_revision,draft_payload,extracted_references);
end;
$$;

create function public.restore_content_revision(verified_user_id uuid, target_resource text, target_entity_id uuid, source_revision integer, expected_revision integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare source jsonb; result jsonb;
begin
  perform public.authorize_content_actor(verified_user_id,'content.read');
  begin
    perform public.authorize_content_actor(verified_user_id,case when target_resource in ('metric','observation','dashboard') then 'metrics.edit' else 'content.edit' end);
  exception when sqlstate 'PT403' then
    perform public.authorize_content_actor(verified_user_id,'content.publish');
  end;
  source := public.read_content_revision(verified_user_id,target_resource,target_entity_id,source_revision);
  result := public.append_content_draft(verified_user_id,target_resource,target_entity_id,expected_revision,source->'payload',public.content_payload_references(target_resource,source->'payload'));
  insert into public.audit_events(actor_user_id,event_type,entity_id,revision_id,metadata)
    values(verified_user_id,'content.restore',target_entity_id,(result->>'revisionId')::uuid,jsonb_build_object('sourceRevision',source_revision,'newRevision',result->'revision'));
  return result;
end;
$$;

create function public.read_published_content(target_resource text, target_entity_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare result jsonb; active_id uuid;
begin
  select public.content_revision_snapshot(r.id),p.id into result,active_id
    from public.content_entities e join public.content_revisions r on r.id=e.published_revision_id and r.entity_id=e.id
    join public.publications p on p.entity_id=e.id and p.revision_id=r.id and p.status='published' and p.unpublished_at is null
    where e.id=target_entity_id and e.entity_type=target_resource and e.archived_at is null;
  if result is not null and target_resource='scene' then
    result := jsonb_set(result,'{payload,placements}',(select coalesce(jsonb_agg(s.placement order by (s.placement->>'order')::int,s.building_entity_id),'[]')
      from public.published_scene_placements s join public.content_entities b on b.id=s.building_entity_id
      join public.publications bp on bp.entity_id=b.id and bp.revision_id=b.published_revision_id and bp.status='published' and bp.unpublished_at is null
      where s.publication_id=active_id and s.active and b.archived_at is null));
    result := jsonb_set(result,'{references}',public.content_payload_references('scene',result->'payload'));
  end if;
  return result;
end;
$$;

create function public.publish_content_revisions(verified_user_id uuid, requested_entries jsonb, prepared_media jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare entry jsonb; e public.content_entities%rowtype; r public.content_revisions%rowtype; dep record; target public.content_entities%rowtype;
  asset public.media_assets%rowtype; target_revision uuid; p_id uuid; placement jsonb; widget jsonb; units integer; observation_id jsonb; refs jsonb; stored_refs jsonb;
begin
  perform public.authorize_content_actor(verified_user_id,'content.publish');
  if jsonb_typeof(requested_entries) is distinct from 'array' or jsonb_array_length(requested_entries) not between 1 and 100
    or jsonb_typeof(prepared_media) is distinct from 'array' then raise exception 'Invalid publish request' using errcode='PT400'; end if;
  if (select count(*)<>count(distinct value->>'entityId') from jsonb_array_elements(requested_entries)) then raise exception 'Duplicate entries' using errcode='PT400'; end if;
  -- Publication and withdrawal share this lock. Entity locks additionally prevent
  -- saves racing exact revision validation; all participating IDs lock in order.
  perform pg_advisory_xact_lock(190915,4);
  perform 1 from public.content_entities ce where ce.id in (
    select (value->>'entityId')::uuid from jsonb_array_elements(requested_entries)
    union select d.target_entity_id from public.revision_dependencies d join public.content_revisions cr on cr.id=d.source_revision_id
      join jsonb_array_elements(requested_entries) x on (x->>'entityId')::uuid=cr.entity_id and (x->>'revision')::int=cr.revision_number
  ) order by ce.id for update;
  perform 1 from public.media_assets a where a.id in (
    select d.target_media_asset_id from public.revision_dependencies d join public.content_revisions cr on cr.id=d.source_revision_id
      join jsonb_array_elements(requested_entries) x on (x->>'entityId')::uuid=cr.entity_id and (x->>'revision')::int=cr.revision_number
  ) order by a.id for update;
  -- Validate the WHOLE set before any public pointer or audit is written.
  for entry in select value from jsonb_array_elements(requested_entries) order by value->>'entityId' loop
    select * into e from public.content_entities where id=(entry->>'entityId')::uuid;
    if not found or e.entity_type is distinct from entry->>'resource' or e.archived_at is not null then raise exception 'Entity unavailable' using errcode='PT404'; end if;
    select * into r from public.content_revisions where id=e.latest_revision_id;
    if not found or r.revision_number is distinct from (entry->>'revision')::int then raise exception 'Revision conflict' using errcode='PT409',detail=coalesce(r.revision_number,0)::text; end if;
    perform public.validate_content_snapshot(e.entity_type,r.content);
    refs := public.content_payload_references(e.entity_type,r.content);
    select coalesce(jsonb_agg(case when d.target_media_asset_id is not null
      then jsonb_build_object('mediaId',d.target_media_asset_id,'mediaType',split_part(d.dependency_type,':',2))
      else jsonb_build_object('entityId',d.target_entity_id,'resource',split_part(d.dependency_type,':',2)) end),'[]')
      into stored_refs from public.revision_dependencies d where d.source_revision_id=r.id and d.source_entity_id=e.id;
    if not (refs @> stored_refs and stored_refs @> refs) then raise exception 'Snapshot dependencies are incomplete' using errcode='PT409'; end if;
    for dep in select * from public.revision_dependencies where source_revision_id=r.id loop
      if dep.target_media_asset_id is not null then
        select * into asset from public.media_assets where id=dep.target_media_asset_id;
        if asset.archived_at is not null or asset.lifecycle_status<>'ready' or asset.finalized_at is null
          or asset.asset_kind is distinct from split_part(dep.dependency_type,':',2)
          or asset.public_bucket<>'cms-media-public' or asset.public_key is distinct from ('assets/'||asset.id::text||'/'||asset.checksum_sha256)
          or asset.public_key is null or not exists(select 1 from jsonb_array_elements(prepared_media) m where m->>'mediaId'=asset.id::text and m->>'key'=asset.public_key)
          then raise exception 'Media is not ready and prepared' using errcode='PT409'; end if;
      else
        select * into target from public.content_entities where id=dep.target_entity_id;
        select tr.id into target_revision from public.content_revisions tr join jsonb_array_elements(requested_entries) x on (x->>'entityId')::uuid=tr.entity_id and (x->>'revision')::int=tr.revision_number where tr.entity_id=target.id;
        if target_revision is null then
          select p.revision_id into target_revision from public.publications p where p.entity_id=target.id and p.revision_id=target.published_revision_id and p.status='published' and p.unpublished_at is null;
        end if;
        if target.archived_at is not null or target.entity_type is distinct from split_part(dep.dependency_type,':',2) or target_revision is distinct from dep.target_revision_id
          or (target.entity_type not in ('metric','category') and target.geographic_scope_id is distinct from e.geographic_scope_id)
          or (target.geographic_scope_id is not null and target.geographic_scope_id is distinct from e.geographic_scope_id)
          then raise exception 'Reference is not published at the reviewed revision or scope' using errcode='PT409'; end if;
      end if;
    end loop;
    -- Changing a referenced public snapshot requires its consumers in this batch.
    if exists(select 1 from public.revision_dependencies d join public.publications p on p.entity_id=d.source_entity_id and p.revision_id=d.source_revision_id and p.status='published' and p.unpublished_at is null
      where d.target_entity_id=e.id and d.target_revision_id<>r.id
      and not exists(select 1 from jsonb_array_elements(requested_entries) x where (x->>'entityId')::uuid=d.source_entity_id))
      then raise exception 'Publish dependent content together' using errcode='PT409'; end if;
    if e.entity_type='dashboard' then
      for widget in select value from jsonb_array_elements(r.content->'widgets') loop
        select count(distinct mr.content->>'unit') into units from public.revision_dependencies d join public.content_revisions mr on mr.id=d.target_revision_id
          where d.source_revision_id=r.id and d.dependency_type='entity:metric' and (widget->'metricIds') ? d.target_entity_id::text;
        if widget->>'type' in ('line','bar','composition','target') and units>1 then raise exception 'Incompatible widget units' using errcode='PT400'; end if;
        for observation_id in select value from jsonb_array_elements(widget->'observationIds') loop
          if not exists(select 1 from public.revision_dependencies d join public.content_revisions obs on obs.id=d.target_revision_id
            where d.source_revision_id=r.id and d.target_entity_id=(observation_id#>>'{}')::uuid and (widget->'metricIds') ? (obs.content->>'metricId'))
            then raise exception 'Observation metric does not match widget binding' using errcode='PT400'; end if;
        end loop;
      end loop;
    end if;
  end loop;
  for entry in select value from jsonb_array_elements(requested_entries) order by value->>'entityId' loop
    select * into e from public.content_entities where id=(entry->>'entityId')::uuid;
    select * into r from public.content_revisions where id=e.latest_revision_id;
    update public.published_scene_placements set active=false where publication_id in (select id from public.publications where entity_id=e.id and status='published' and unpublished_at is null);
    update public.publications set status='withdrawn',unpublished_at=now() where entity_id=e.id and status='published' and unpublished_at is null;
    insert into public.publications(entity_id,revision_id,status,published_at,created_by) values(e.id,r.id,'published',now(),verified_user_id) returning id into p_id;
    -- Core publication trigger sets published_revision_id inside this transaction.
    if e.entity_type='scene' then
      for placement in select value from jsonb_array_elements(r.content->'placements') where (value->>'visible')::boolean loop
        insert into public.published_scene_placements(publication_id,building_entity_id,placement) values(p_id,(placement->>'buildingId')::uuid,placement);
      end loop;
    end if;
    insert into public.audit_events(actor_user_id,event_type,entity_id,revision_id,metadata) values(verified_user_id,'content.publish',e.id,r.id,jsonb_build_object('revision',r.revision_number,'publicationId',p_id));
  end loop;
  return jsonb_build_object('entries',requested_entries);
end;
$$;

create function public.unpublish_content_building(verified_user_id uuid, target_entity_id uuid, expected_revision integer)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare e public.content_entities%rowtype; latest integer; p record;
begin
  perform public.authorize_content_actor(verified_user_id,'content.publish');
  perform pg_advisory_xact_lock(190915,4);
  -- Floors withdraw too: no public floor may outlive its parent building.
  perform 1 from public.content_entities ce where ce.id=target_entity_id or ce.building_entity_id=target_entity_id
    or ce.id in (select pub.entity_id from public.published_scene_placements s join public.publications pub on pub.id=s.publication_id where s.building_entity_id=target_entity_id and s.active)
    order by ce.id for update;
  select * into e from public.content_entities where id=target_entity_id and entity_type='building';
  if not found then raise exception 'Building unavailable' using errcode='PT404'; end if;
  select revision_number into latest from public.content_revisions where id=e.latest_revision_id;
  if expected_revision is null or expected_revision is distinct from latest then raise exception 'Revision conflict' using errcode='PT409',detail=coalesce(latest,0)::text; end if;
  update public.published_scene_placements set active=false where building_entity_id=e.id and active;
  for p in select pub.* from public.publications pub join public.content_entities ce on ce.id=pub.entity_id
    where (ce.id=e.id or (ce.entity_type='floor' and ce.building_entity_id=e.id)) and pub.status='published' and pub.unpublished_at is null order by pub.entity_id loop
    update public.publications set status='withdrawn',unpublished_at=now() where id=p.id;
    insert into public.audit_events(actor_user_id,event_type,entity_id,revision_id,metadata) values(verified_user_id,'content.unpublish',p.entity_id,p.revision_id,jsonb_build_object('buildingId',e.id));
  end loop;
end;
$$;

-- Generic roles have neither table writes nor callable helpers. Only the trusted
-- server can supply verified_user_id; each privileged RPC checks live grants.
revoke all on function public.authorize_content_actor(uuid,text), public.content_payload_references(text,jsonb),
  public.validate_content_snapshot(text,jsonb), public.content_revision_snapshot(uuid), public.read_content_revision(uuid,text,uuid,integer),
  public.append_content_draft(uuid,text,uuid,integer,jsonb,jsonb), public.save_content_draft(uuid,text,uuid,integer,jsonb,jsonb),
  public.restore_content_revision(uuid,text,uuid,integer,integer), public.read_published_content(text,uuid),
  public.publish_content_revisions(uuid,jsonb,jsonb), public.unpublish_content_building(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_content_actor(uuid,text), public.read_content_revision(uuid,text,uuid,integer),
  public.save_content_draft(uuid,text,uuid,integer,jsonb,jsonb), public.read_published_content(text,uuid),
  public.restore_content_revision(uuid,text,uuid,integer,integer),
  public.publish_content_revisions(uuid,jsonb,jsonb), public.unpublish_content_building(uuid,uuid,integer) to service_role;

commit;
