-- BRIDGE Milestone 4 client alignment: B2B fields, page managers, routing,
-- upload completion, admin queue, and stable frontend list contracts.

alter type public.organization_role add value if not exists 'page_manager';

begin;

create type public.directory_profile_link_type as enum (
    'website', 'menu', 'product', 'other'
);

alter table public.directory_profiles
    add column story text,
    add column business_type public.organization_type,
    add column city text,
    add column state text,
    add column region text,
    add column public_email text,
    add column public_phone text,
    add column license_type text,
    add column license_number text,
    add constraint directory_profiles_story_length check (story is null or char_length(story) <= 5000),
    add constraint directory_profiles_location_length check (
        (city is null or char_length(city) between 1 and 100) and
        (state is null or char_length(state) between 1 and 100) and
        (region is null or char_length(region) between 1 and 100)
    ),
    add constraint directory_profiles_public_contact_length check (
        (public_email is null or char_length(public_email) <= 320) and
        (public_phone is null or char_length(public_phone) between 7 and 32)
    ),
    add constraint directory_profiles_license_length check (
        (license_type is null or char_length(license_type) between 1 and 100) and
        (license_number is null or char_length(license_number) between 1 and 200)
    );

update public.directory_profiles dp
set business_type = o.organization_type
from public.organizations o
where o.id = dp.organization_id;

create table public.directory_profile_categories (
    profile_id uuid not null references public.directory_profiles(id) on delete cascade,
    category text not null,
    sort_order integer not null,
    primary key (profile_id, category),
    unique (profile_id, sort_order),
    check (char_length(category) between 1 and 100),
    check (sort_order between 0 and 19)
);

create table public.directory_profile_links (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null references public.directory_profiles(id) on delete cascade,
    link_type public.directory_profile_link_type not null,
    label text not null,
    url text not null,
    sort_order integer not null,
    unique (profile_id, sort_order),
    check (char_length(label) between 1 and 100),
    check (char_length(url) <= 2048 and url ~* '^https?://'),
    check (sort_order between 0 and 1000)
);

alter table public.directory_profile_versions
    add column story text,
    add column business_type public.organization_type,
    add column city text,
    add column state text,
    add column region text,
    add column public_email text,
    add column public_phone text,
    add column license_type text,
    add column license_number text,
    add column legal_name text,
    add column dba_name text;

-- Backfill already-published snapshots without copying new working-only
-- content into them. A legacy null organization type stays explicit rather
-- than being silently misclassified.
update public.directory_profile_versions v
set business_type=o.organization_type,legal_name=b.legal_name,dba_name=b.dba_name
from public.directory_profiles p,public.organizations o,public.businesses b
where p.id=v.profile_id and o.id=p.organization_id and b.id=v.business_id;

create table public.directory_profile_version_categories (
    version_id uuid not null references public.directory_profile_versions(id) on delete cascade,
    category text not null,
    sort_order integer not null,
    primary key (version_id, category),
    unique (version_id, sort_order)
);

create table public.directory_profile_version_links (
    id uuid primary key default gen_random_uuid(),
    version_id uuid not null references public.directory_profile_versions(id) on delete cascade,
    link_type public.directory_profile_link_type not null,
    label text not null,
    url text not null,
    sort_order integer not null,
    unique (version_id, sort_order)
);

create or replace function public.copy_directory_profile_snapshot_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source_profile public.directory_profiles%rowtype; source_business public.businesses%rowtype;
begin
    select * into source_profile from public.directory_profiles where id = new.profile_id;
    select * into source_business from public.businesses where id = new.business_id;
    new.story := source_profile.story;
    new.business_type := source_profile.business_type;
    new.city := source_profile.city; new.state := source_profile.state; new.region := source_profile.region;
    new.public_email := source_profile.public_email; new.public_phone := source_profile.public_phone;
    new.license_type := source_profile.license_type; new.license_number := source_profile.license_number;
    new.legal_name := source_business.legal_name; new.dba_name := source_business.dba_name;
    return new;
end $$;

create trigger directory_profile_versions_copy_client_fields
before insert on public.directory_profile_versions
for each row execute function public.copy_directory_profile_snapshot_fields();

create or replace function public.copy_directory_profile_snapshot_children()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    insert into public.directory_profile_version_categories(version_id, category, sort_order)
    select new.id, category, sort_order from public.directory_profile_categories where profile_id = new.profile_id;
    insert into public.directory_profile_version_links(version_id, link_type, label, url, sort_order)
    select new.id, link_type, label, url, sort_order from public.directory_profile_links where profile_id = new.profile_id;
    return new;
end $$;

create trigger directory_profile_versions_copy_client_children
after insert on public.directory_profile_versions
for each row execute function public.copy_directory_profile_snapshot_children();

alter table public.directory_profile_categories enable row level security;
alter table public.directory_profile_links enable row level security;
create policy directory_profile_categories_select_member on public.directory_profile_categories
for select to authenticated using (exists(
    select 1 from public.directory_profiles p
    where p.id=profile_id and public.is_organization_member(p.organization_id)
));
create policy directory_profile_links_select_member on public.directory_profile_links
for select to authenticated using (exists(
    select 1 from public.directory_profiles p
    where p.id=profile_id and public.is_organization_member(p.organization_id)
));
revoke all on public.directory_profile_categories, public.directory_profile_links,
    public.directory_profile_version_categories, public.directory_profile_version_links
from public, anon, authenticated;
grant select on public.directory_profile_categories, public.directory_profile_links to authenticated;

create or replace function public.upsert_directory_profile(
    p_organization_id uuid, p_business_id uuid, p_slug text, p_display_name text,
    p_summary text, p_story text, p_business_type public.organization_type,
    p_categories jsonb, p_city text, p_state text, p_region text,
    p_public_email text, p_public_phone text, p_license_type text,
    p_license_number text, p_links jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := auth.uid(); target public.directory_profiles%rowtype; actor_role text; item jsonb; position integer := 0;
begin
    if actor_id is null then raise insufficient_privilege using message='Authentication is required.'; end if;
    select om.role::text into actor_role from public.organization_members om
    where om.organization_id=p_organization_id and om.user_id=actor_id and om.status='active' limit 1;
    if actor_role is null or actor_role not in ('owner','admin','page_manager') then
        raise insufficient_privilege using message='Directory content permission is required.';
    end if;
    if not exists(select 1 from public.businesses where id=p_business_id and organization_id=p_organization_id) then
        raise foreign_key_violation using message='The business does not belong to the organization.';
    end if;
    if not exists(select 1 from public.organizations where id=p_organization_id and organization_type=p_business_type) then
        raise check_violation using message='Business type must match the organization type.';
    end if;
    select * into target from public.directory_profiles where organization_id=p_organization_id for update;
    if actor_role='page_manager' and (not found or target.business_id is distinct from p_business_id) then
        raise insufficient_privilege using message='Page managers cannot create profiles or change business association.';
    end if;
    if found and target.published_version_id is not null and target.business_id is distinct from p_business_id then
        raise object_not_in_prerequisite_state using message='The business association cannot change after publication.';
    end if;
    if found then
        update public.directory_profiles set business_id=p_business_id,slug=p_slug,display_name=p_display_name,
            summary=p_summary,story=p_story,business_type=p_business_type,city=p_city,state=p_state,region=p_region,
            public_email=p_public_email,public_phone=p_public_phone,license_type=p_license_type,
            license_number=p_license_number,updated_by_user_id=actor_id,
            status=case when status in ('approved','pending_review') then 'draft' else status end,
            submitted_by_user_id=case when status in ('approved','pending_review') then null else submitted_by_user_id end,
            submitted_at=case when status in ('approved','pending_review') then null else submitted_at end
        where id=target.id;
    else
        insert into public.directory_profiles(organization_id,business_id,slug,display_name,summary,story,business_type,
            city,state,region,public_email,public_phone,license_type,license_number,created_by_user_id,updated_by_user_id)
        values(p_organization_id,p_business_id,p_slug,p_display_name,p_summary,p_story,p_business_type,
            p_city,p_state,p_region,p_public_email,p_public_phone,p_license_type,p_license_number,actor_id,actor_id)
        returning * into target;
    end if;
    delete from public.directory_profile_categories where profile_id=target.id;
    for item in select value from jsonb_array_elements(coalesce(p_categories,'[]'::jsonb)) loop
        insert into public.directory_profile_categories(profile_id,category,sort_order)
        values(target.id,btrim(item#>>'{}'),position); position:=position+1;
    end loop;
    delete from public.directory_profile_links where profile_id=target.id; position:=0;
    for item in select value from jsonb_array_elements(coalesce(p_links,'[]'::jsonb)) loop
        insert into public.directory_profile_links(profile_id,link_type,label,url,sort_order)
        values(target.id,(item->>'type')::public.directory_profile_link_type,btrim(item->>'label'),btrim(item->>'url'),(item->>'sortOrder')::integer);
        position:=position+1;
    end loop;
end $$;

revoke all on function public.upsert_directory_profile(uuid,uuid,text,text,text,text,public.organization_type,jsonb,text,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.upsert_directory_profile(uuid,uuid,text,text,text,text,public.organization_type,jsonb,text,text,text,text,text,text,text,jsonb) to authenticated;

create table public.directory_profile_pending_uploads (
    id uuid primary key,
    profile_id uuid not null references public.directory_profiles(id) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    storage_path text not null unique,
    content_type text not null,
    file_size integer not null check(file_size between 1 and 2097152),
    expires_at timestamptz not null default timezone('utc',now()) + interval '2 hours',
    completed_at timestamptz
);
alter table public.directory_profile_pending_uploads enable row level security;
revoke all on public.directory_profile_pending_uploads from public,anon,authenticated;

create or replace function public.set_directory_profile_logo(p_organization_id uuid,p_logo_storage_path text)
returns void language plpgsql security definer set search_path='' as $$
declare target_profile public.directory_profiles%rowtype; expected_prefix text;
begin
 if auth.uid() is null or not exists(select 1 from public.organization_members om where om.organization_id=p_organization_id and om.user_id=auth.uid() and om.status='active' and om.role::text in ('owner','admin','page_manager')) then
  raise insufficient_privilege using message='Directory content permission is required.';
 end if;
 select * into target_profile from public.directory_profiles where organization_id=p_organization_id for update;
 if not found then raise no_data_found using message='Directory profile not found.'; end if;
 expected_prefix:=p_organization_id::text||'/'||target_profile.id::text||'/logo/';
 if p_logo_storage_path is not null and (p_logo_storage_path not like expected_prefix||'%' or
  p_logo_storage_path !~ ('^'||expected_prefix||'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$')) then
  raise invalid_parameter_value using message='Directory logo path is invalid.';
 end if;
 update public.directory_profiles set logo_storage_path=p_logo_storage_path,updated_by_user_id=auth.uid() where id=target_profile.id;
end $$;

create or replace function public.complete_directory_profile_logo_upload(p_organization_id uuid,p_upload_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare pending public.directory_profile_pending_uploads%rowtype;
begin
 if auth.uid() is null or not exists(select 1 from public.organization_members om where om.organization_id=p_organization_id and om.user_id=auth.uid() and om.status='active' and om.role::text in ('owner','admin','page_manager')) then raise insufficient_privilege; end if;
 select * into pending from public.directory_profile_pending_uploads where id=p_upload_id and organization_id=p_organization_id and completed_at is null and expires_at>timezone('utc',now()) for update;
 if not found then raise no_data_found; end if;
 update public.directory_profiles set logo_storage_path=pending.storage_path,updated_by_user_id=auth.uid() where id=pending.profile_id and organization_id=p_organization_id;
 update public.directory_profile_pending_uploads set completed_at=timezone('utc',now()) where id=p_upload_id;
end $$;
revoke all on function public.complete_directory_profile_logo_upload(uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_directory_profile_logo_upload(uuid,uuid) to authenticated;

create table public.directory_profile_contact_routing (
    profile_id uuid primary key references public.directory_profiles(id) on delete cascade,
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    sales_representative_membership_id uuid references public.organization_members(id) on delete set null,
    bridge_admin_user_id uuid references auth.users(id) on delete set null,
    updated_by_user_id uuid not null references auth.users(id) on delete restrict,
    updated_at timestamptz not null default timezone('utc',now())
);
alter table public.directory_profile_contact_routing enable row level security;
revoke all on public.directory_profile_contact_routing from public,anon,authenticated;

create or replace function public.get_directory_profile_contact_routing(p_organization_id uuid)
returns table(sales_representative_membership_id uuid,sales_representative_user_id uuid,sales_representative_display_name text,bridge_admin_user_id uuid,bridge_admin_display_name text)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.is_organization_admin(p_organization_id) then raise insufficient_privilege; end if;
 return query select r.sales_representative_membership_id,om.user_id,srp.display_name,r.bridge_admin_user_id,bap.display_name
 from public.directory_profiles dp left join public.directory_profile_contact_routing r on r.profile_id=dp.id
 left join public.organization_members om on om.id=r.sales_representative_membership_id
 left join public.user_profiles srp on srp.id=om.user_id left join public.user_profiles bap on bap.id=r.bridge_admin_user_id
 where dp.organization_id=p_organization_id;
end $$;

create or replace function public.set_directory_profile_contact_routing(p_organization_id uuid,p_sales_representative_membership_id uuid,p_bridge_admin_user_id uuid)
returns table(sales_representative_membership_id uuid,sales_representative_user_id uuid,sales_representative_display_name text,bridge_admin_user_id uuid,bridge_admin_display_name text)
language plpgsql security definer set search_path='' as $$
declare profile_id uuid;
begin
 if auth.uid() is null or not public.is_organization_admin(p_organization_id) then raise insufficient_privilege; end if;
 select id into profile_id from public.directory_profiles where organization_id=p_organization_id;
 if profile_id is null then raise no_data_found; end if;
 if p_sales_representative_membership_id is not null and not exists(
   select 1 from public.organization_members om join public.user_profiles up on up.id=om.user_id
   where om.id=p_sales_representative_membership_id and om.organization_id=p_organization_id and om.status='active' and up.account_type='sales_rep'
 ) then raise object_not_in_prerequisite_state using message='Sales representative must be an active sales_rep member.'; end if;
 if p_bridge_admin_user_id is not null and not exists(select 1 from public.user_platform_roles where user_id=p_bridge_admin_user_id and role='admin') then
   raise object_not_in_prerequisite_state using message='Bridge routing target must be a platform admin.'; end if;
 insert into public.directory_profile_contact_routing(profile_id,organization_id,sales_representative_membership_id,bridge_admin_user_id,updated_by_user_id)
 values(profile_id,p_organization_id,p_sales_representative_membership_id,p_bridge_admin_user_id,auth.uid())
 on conflict(profile_id) do update set sales_representative_membership_id=excluded.sales_representative_membership_id,
 bridge_admin_user_id=excluded.bridge_admin_user_id,updated_by_user_id=excluded.updated_by_user_id,updated_at=timezone('utc',now());
 return query select * from public.get_directory_profile_contact_routing(p_organization_id);
end $$;
revoke all on function public.get_directory_profile_contact_routing(uuid),public.set_directory_profile_contact_routing(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_directory_profile_contact_routing(uuid),public.set_directory_profile_contact_routing(uuid,uuid,uuid) to authenticated;

alter table public.contact_requests add column routed_recipient_user_id uuid references auth.users(id) on delete set null;
alter table public.contact_requests drop constraint contact_requests_preference_check;
alter table public.contact_requests add constraint contact_requests_preference_check check(contact_preference in ('email','phone','either'));

create or replace function public.route_contact_request_recipient()
returns trigger language plpgsql security definer set search_path='' as $$
declare route public.directory_profile_contact_routing%rowtype; recipient_membership uuid; recipient_user uuid;
begin
 select * into route from public.directory_profile_contact_routing where profile_id=new.target_profile_id;
 if route.sales_representative_membership_id is not null then
   select om.id,om.user_id into recipient_membership,recipient_user from public.organization_members om join public.user_profiles up on up.id=om.user_id
   where om.id=route.sales_representative_membership_id and om.organization_id=new.target_organization_id and om.status='active' and up.account_type='sales_rep';
 end if;
 if recipient_user is null and route.bridge_admin_user_id is not null and exists(select 1 from public.user_platform_roles where user_id=route.bridge_admin_user_id and role='admin') then
   recipient_user:=route.bridge_admin_user_id; recipient_membership:=null;
 end if;
 if recipient_user is null then
   select om.id,om.user_id into recipient_membership,recipient_user from public.organization_members om
   where om.organization_id=new.target_organization_id and om.status='active' and om.role='owner'
   order by om.created_at,om.user_id limit 1;
 end if;
 new.routed_recipient_membership_id:=recipient_membership;
 new.routed_recipient_user_id:=recipient_user;
 new.routing_status:=case when recipient_user is null then 'needs_assignment' else 'routed' end;
 return new;
end $$;
create trigger contact_requests_apply_configured_route before insert on public.contact_requests
for each row execute function public.route_contact_request_recipient();

-- Replaces the earlier admin-first function. The explicit configuration is
-- authoritative and owner is only the final fallback.
create or replace function public.create_contact_request(
    p_target_slug text,p_first_name text,p_work_email text,p_phone_number text,
    p_years_of_service integer,p_contact_preference text,p_message text default null
) returns table(request_id uuid,request_status public.contact_request_status,
    routing_status public.contact_request_routing_status,created_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare actor_id uuid:=auth.uid(); sender_org_id uuid; sender_org_ids uuid[]; sender_count integer;
 target_profile public.directory_profiles%rowtype; recipient_membership_id uuid; recipient_user_id uuid;
 route_status public.contact_request_routing_status; new_request_id uuid; event_time timestamptz:=timezone('utc',now());
 route public.directory_profile_contact_routing%rowtype;
begin
 if actor_id is null then raise insufficient_privilege using message='Authentication is required.'; end if;
 select count(*),array_agg(e.organization_id order by e.organization_id) into sender_count,sender_org_ids from(
  select distinct om.organization_id from public.organization_members om
  join public.organizations o on o.id=om.organization_id join public.directory_profiles dp on dp.organization_id=om.organization_id
  join public.directory_profile_versions v on v.id=dp.published_version_id and v.is_published
  join public.businesses b on b.id=v.business_id and b.organization_id=om.organization_id
  where om.user_id=actor_id and om.status='active' and dp.status<>'suspended' and o.status='active' and b.status='active'
  and public.is_business_ein_verified(b.id)) e;
 if sender_count<>1 then raise object_not_in_prerequisite_state using message='Sender Directory eligibility is not satisfied or is ambiguous.'; end if;
 sender_org_id:=sender_org_ids[1];
 select dp.* into target_profile from public.directory_profiles dp
 join public.directory_profile_versions v on v.id=dp.published_version_id and v.is_published
 join public.organizations o on o.id=dp.organization_id join public.businesses b on b.id=v.business_id and b.organization_id=dp.organization_id
 where v.slug=lower(btrim(p_target_slug)) and dp.status<>'suspended' and o.status='active' and b.status='active'
 and public.is_business_ein_verified(b.id) limit 1;
 if not found then raise no_data_found using message='Contactable Directory profile not found.'; end if;
 select * into route from public.directory_profile_contact_routing where profile_id=target_profile.id;
 if route.sales_representative_membership_id is not null then
  select om.id,om.user_id into recipient_membership_id,recipient_user_id from public.organization_members om
  join public.user_profiles up on up.id=om.user_id where om.id=route.sales_representative_membership_id
  and om.organization_id=target_profile.organization_id and om.status='active' and up.account_type='sales_rep';
 end if;
 if recipient_user_id is null and route.bridge_admin_user_id is not null
 and exists(select 1 from public.user_platform_roles where user_id=route.bridge_admin_user_id and role='admin') then
  recipient_user_id:=route.bridge_admin_user_id; recipient_membership_id:=null;
 end if;
 if recipient_user_id is null then
  select om.id,om.user_id into recipient_membership_id,recipient_user_id from public.organization_members om
  where om.organization_id=target_profile.organization_id and om.status='active' and om.role='owner'
  order by om.created_at,om.user_id limit 1;
 end if;
 route_status:=case when recipient_user_id is null then 'needs_assignment' else 'routed' end;
 insert into public.contact_requests(sender_user_id,sender_organization_id,target_profile_id,target_organization_id,
  target_slug,target_display_name,routed_recipient_membership_id,routed_recipient_user_id,routing_status,
  first_name,work_email,phone_number,years_of_service,contact_preference,message,created_at,updated_at)
 values(actor_id,sender_org_id,target_profile.id,target_profile.organization_id,lower(btrim(p_target_slug)),
  (select display_name from public.directory_profile_versions where id=target_profile.published_version_id),
  recipient_membership_id,recipient_user_id,route_status,btrim(p_first_name),lower(btrim(p_work_email)),btrim(p_phone_number),
  p_years_of_service,p_contact_preference,nullif(btrim(p_message),''),event_time,event_time) returning id into new_request_id;
 insert into public.contact_request_history(contact_request_id,actor_user_id,action,new_status,created_at) values
  (new_request_id,actor_id,'created','new',event_time),
  (new_request_id,actor_id,case when recipient_user_id is null then 'manual_assignment_needed' else 'routed' end,'new',event_time);
 insert into public.audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
 values(target_profile.organization_id,actor_id,'create','contact_request',new_request_id,jsonb_build_object('routing_status',route_status));
 return query select new_request_id,'new'::public.contact_request_status,route_status,event_time;
end $$;

create or replace function public.notify_contact_history() returns trigger language plpgsql security definer set search_path='' as $$
declare cr public.contact_requests%rowtype; recipient uuid; nt public.notification_type; ttl text; msg text; send_email boolean;
begin
 select * into cr from public.contact_requests where id=new.contact_request_id;
 if new.action='routed' then recipient:=cr.routed_recipient_user_id; nt:='contact_request_received'; ttl:='New contact request'; msg:='Your organization received a new contact request.'; send_email:=true;
 elsif new.action='responded' then recipient:=cr.sender_user_id; nt:='contact_request_responded'; ttl:='Contact request responded'; msg:='The business marked your contact request as responded.'; send_email:=true;
 elsif new.action='closed' then recipient:=cr.sender_user_id; nt:='contact_request_closed'; ttl:='Contact request closed'; msg:='The business closed your contact request.'; send_email:=false;
 else return new; end if;
 if recipient is not null then perform public.enqueue_user_notification(recipient,nt,'contact',ttl,msg,'contact_request',cr.id,'contact_request_history',new.id,send_email); end if;
 return new;
end $$;

drop function public.get_public_directory_profile(text);
create function public.get_public_directory_profile(p_slug text)
returns table(slug text,display_name text,summary text,story text,business_type public.organization_type,categories jsonb,
 city text,state text,region text,public_email text,public_phone text,license_type text,license_number text,links jsonb,
 legal_name text,dba_name text,business_name text,verified boolean,has_logo boolean)
language sql stable security definer set search_path='' as $$
select v.slug,v.display_name,v.summary,v.story,v.business_type,
 coalesce((select jsonb_agg(c.category order by c.sort_order) from public.directory_profile_version_categories c where c.version_id=v.id),'[]'::jsonb),
 v.city,v.state,v.region,v.public_email,v.public_phone,v.license_type,v.license_number,
 coalesce((select jsonb_agg(jsonb_build_object('type',l.link_type,'label',l.label,'url',l.url,'sortOrder',l.sort_order) order by l.sort_order) from public.directory_profile_version_links l where l.version_id=v.id),'[]'::jsonb),
 v.legal_name,v.dba_name,coalesce(v.dba_name,v.legal_name),true,v.logo_storage_path is not null
from public.directory_profiles p join public.directory_profile_versions v on v.id=p.published_version_id and v.is_published
join public.organizations o on o.id=p.organization_id join public.businesses b on b.id=v.business_id
where v.slug=lower(btrim(p_slug)) and p.status<>'suspended' and o.status='active' and b.status='active' and public.is_business_ein_verified(b.id) limit 1 $$;
grant execute on function public.get_public_directory_profile(text) to anon,authenticated,service_role;

drop function public.list_public_directory_profiles(text,public.organization_type,text,text,text,integer);
create function public.list_public_directory_profiles(p_query text default null,p_organization_type public.organization_type default null,
 p_category text default null,p_state text default null,p_city text default null,p_region text default null,p_verified boolean default null,
 p_sort text default 'name_asc',p_cursor_name text default null,p_cursor_slug text default null,p_limit integer default 21)
returns table(slug text,display_name text,summary text,story text,business_type public.organization_type,categories jsonb,
 city text,state text,region text,public_email text,public_phone text,license_type text,license_number text,links jsonb,
 legal_name text,dba_name text,business_name text,verified boolean,has_logo boolean,cursor_name text)
language plpgsql stable security definer set search_path='' as $$
declare normalized text:=nullif(btrim(p_query),''); escaped text;
begin
 if p_sort not in('name_asc','name_desc') or p_limit<1 or p_limit>51 then raise invalid_parameter_value; end if;
 if p_verified=false then return; end if;
 escaped:=replace(replace(replace(normalized,E'\\',E'\\\\'),E'%',E'\\%'),E'_',E'\\_');
 return query select v.slug,v.display_name,v.summary,v.story,v.business_type,
  coalesce((select jsonb_agg(c.category order by c.sort_order) from public.directory_profile_version_categories c where c.version_id=v.id),'[]'::jsonb),
  v.city,v.state,v.region,v.public_email,v.public_phone,v.license_type,v.license_number,
  coalesce((select jsonb_agg(jsonb_build_object('type',l.link_type,'label',l.label,'url',l.url,'sortOrder',l.sort_order) order by l.sort_order) from public.directory_profile_version_links l where l.version_id=v.id),'[]'::jsonb),
  v.legal_name,v.dba_name,coalesce(v.dba_name,v.legal_name),true,v.logo_storage_path is not null,lower(v.display_name)
 from public.directory_profiles p join public.directory_profile_versions v on v.id=p.published_version_id and v.is_published
 join public.organizations o on o.id=p.organization_id join public.businesses b on b.id=v.business_id
 where p.status<>'suspended' and o.status='active' and b.status='active' and public.is_business_ein_verified(b.id)
 and (p_organization_type is null or v.business_type=p_organization_type)
 and (p_category is null or exists(select 1 from public.directory_profile_version_categories c where c.version_id=v.id and lower(c.category)=lower(p_category)))
 and (p_state is null or lower(v.state)=lower(p_state)) and (p_city is null or lower(v.city)=lower(p_city)) and (p_region is null or lower(v.region)=lower(p_region))
 and (normalized is null or v.display_name ilike '%'||escaped||'%' escape E'\\' or v.legal_name ilike '%'||escaped||'%' escape E'\\'
      or coalesce(v.dba_name,'') ilike '%'||escaped||'%' escape E'\\' or coalesce(v.city,'') ilike '%'||escaped||'%' escape E'\\'
      or coalesce(v.state,'') ilike '%'||escaped||'%' escape E'\\' or exists(select 1 from public.directory_profile_version_categories c where c.version_id=v.id and c.category ilike '%'||escaped||'%' escape E'\\'))
 and (p_cursor_name is null or (p_sort='name_asc' and (lower(v.display_name),lower(v.slug))>(p_cursor_name,p_cursor_slug)) or (p_sort='name_desc' and (lower(v.display_name),lower(v.slug))<(p_cursor_name,p_cursor_slug)))
 order by case when p_sort='name_asc' then lower(v.display_name) end asc,case when p_sort='name_asc' then lower(v.slug) end asc,
 case when p_sort='name_desc' then lower(v.display_name) end desc,case when p_sort='name_desc' then lower(v.slug) end desc limit p_limit;
end $$;
grant execute on function public.list_public_directory_profiles(text,public.organization_type,text,text,text,text,boolean,text,text,text,integer) to anon,authenticated,service_role;

create function public.list_admin_directory_profiles(p_status public.directory_profile_status default null,p_limit integer default 21,p_offset integer default 0)
returns table(profile_id uuid,organization_id uuid,organization_name text,business_id uuid,legal_name text,dba_name text,
 display_name text,slug text,summary text,story text,business_type public.organization_type,categories jsonb,
 city text,state text,region text,public_email text,public_phone text,license_type text,license_number text,links jsonb,has_logo boolean,
 status public.directory_profile_status,submitted_at timestamptz,has_published_version boolean,
 ein_verified boolean,organization_active boolean,business_active boolean)
language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit<1 or p_limit>51 or p_offset<0 or p_offset>10000 then raise invalid_parameter_value; end if;
 return query select p.id,p.organization_id,o.name,p.business_id,b.legal_name,b.dba_name,p.display_name,p.slug,p.summary,p.story,p.business_type,
 coalesce((select jsonb_agg(c.category order by c.sort_order) from public.directory_profile_categories c where c.profile_id=p.id),'[]'::jsonb),
 p.city,p.state,p.region,p.public_email,p.public_phone,p.license_type,p.license_number,
 coalesce((select jsonb_agg(jsonb_build_object('type',l.link_type,'label',l.label,'url',l.url,'sortOrder',l.sort_order) order by l.sort_order) from public.directory_profile_links l where l.profile_id=p.id),'[]'::jsonb),
 p.logo_storage_path is not null,p.status,p.submitted_at,
 p.published_version_id is not null,public.is_business_ein_verified(b.id),o.status='active',b.status='active'
 from public.directory_profiles p join public.organizations o on o.id=p.organization_id join public.businesses b on b.id=p.business_id
 where p_status is null or p.status=p_status order by p.submitted_at desc nulls last,p.id desc limit p_limit offset p_offset;
end $$;
revoke all on function public.list_admin_directory_profiles(public.directory_profile_status,integer,integer) from public,anon,authenticated;
grant execute on function public.list_admin_directory_profiles(public.directory_profile_status,integer,integer) to service_role;

-- API asks for one look-ahead row to produce hasMore without an expensive count.
create or replace function public.list_inbound_contact_requests(p_organization_id uuid,p_status public.contact_request_status default null,p_limit integer default 20,p_offset integer default 0)
returns table(request_id uuid,request_status public.contact_request_status,routing_status public.contact_request_routing_status,first_name text,work_email text,phone_number text,years_of_service integer,contact_preference text,message text,created_at timestamptz,updated_at timestamptz)
language plpgsql stable security definer set search_path='' as $$ begin
 if auth.uid() is null or not public.is_organization_admin(p_organization_id) then raise insufficient_privilege; end if;
 if p_limit<1 or p_limit>51 or p_offset<0 or p_offset>10000 then raise invalid_parameter_value; end if;
 return query select cr.id,cr.status,cr.routing_status,cr.first_name,cr.work_email,cr.phone_number,cr.years_of_service,cr.contact_preference,cr.message,cr.created_at,cr.updated_at
 from public.contact_requests cr where cr.target_organization_id=p_organization_id and (p_status is null or cr.status=p_status)
 order by cr.created_at desc,cr.id desc limit p_limit offset p_offset; end $$;
create or replace function public.list_sent_contact_requests(p_limit integer default 20,p_offset integer default 0)
returns table(request_id uuid,target_slug text,target_display_name text,request_status public.contact_request_status,created_at timestamptz,updated_at timestamptz)
language plpgsql stable security definer set search_path='' as $$ begin
 if auth.uid() is null then raise insufficient_privilege; end if;
 if p_limit<1 or p_limit>51 or p_offset<0 or p_offset>10000 then raise invalid_parameter_value; end if;
 return query select cr.id,cr.target_slug,cr.target_display_name,cr.status,cr.created_at,cr.updated_at from public.contact_requests cr
 where cr.sender_user_id=auth.uid() order by cr.created_at desc,cr.id desc limit p_limit offset p_offset; end $$;

commit;
