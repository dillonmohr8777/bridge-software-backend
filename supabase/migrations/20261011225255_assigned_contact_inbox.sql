-- Assigned-recipient inbox access; owner/admin scope remains unchanged.
begin;
create schema if not exists bridge_private;
revoke all on schema bridge_private from public, anon;
grant usage on schema bridge_private to authenticated;

create or replace function bridge_private.can_manage_contact_request(
 p_organization_id uuid, p_recipient_user_id uuid, p_recipient_membership_id uuid
) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
   public.is_organization_admin(p_organization_id)
   or (
     p_recipient_user_id=auth.uid()
     and exists(select 1 from public.organizations o where o.id=p_organization_id and o.status='active')
     and (
       (p_recipient_membership_id is not null and exists(
         select 1 from public.organization_members om join public.user_profiles up on up.id=om.user_id
         where om.id=p_recipient_membership_id and om.organization_id=p_organization_id
         and om.user_id=auth.uid() and om.status='active' and up.account_type='sales_rep'
       ))
       or (p_recipient_membership_id is null and exists(
         select 1 from public.user_platform_roles pr where pr.user_id=auth.uid() and pr.role='admin'
       ))
     )
   )
 );
$$;
revoke all on function bridge_private.can_manage_contact_request(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function bridge_private.can_manage_contact_request(uuid,uuid,uuid) to authenticated;

create policy contact_requests_select_assigned_recipient on public.contact_requests
for select to authenticated using (
 bridge_private.can_manage_contact_request(target_organization_id,routed_recipient_user_id,routed_recipient_membership_id)
);

create or replace function public.list_inbound_contact_requests(
 p_organization_id uuid,p_status public.contact_request_status default null,p_limit integer default 20,p_offset integer default 0
) returns table(request_id uuid,request_status public.contact_request_status,routing_status public.contact_request_routing_status,first_name text,work_email text,phone_number text,years_of_service integer,contact_preference text,message text,created_at timestamptz,updated_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not (
   public.is_organization_admin(p_organization_id)
   or exists(select 1 from public.contact_requests cr where cr.target_organization_id=p_organization_id
     and bridge_private.can_manage_contact_request(cr.target_organization_id,cr.routed_recipient_user_id,cr.routed_recipient_membership_id))
 ) then raise insufficient_privilege; end if;
 if p_limit is null or p_limit<1 or p_limit>51 or p_offset is null or p_offset<0 or p_offset>10000 then raise invalid_parameter_value; end if;
 return query select cr.id,cr.status,cr.routing_status,cr.first_name,cr.work_email,cr.phone_number,cr.years_of_service,cr.contact_preference,cr.message,cr.created_at,cr.updated_at
 from public.contact_requests cr where cr.target_organization_id=p_organization_id
 and bridge_private.can_manage_contact_request(cr.target_organization_id,cr.routed_recipient_user_id,cr.routed_recipient_membership_id)
 and (p_status is null or cr.status=p_status)
 order by cr.created_at desc,cr.id desc limit p_limit offset p_offset;
end $$;

create or replace function public.transition_contact_request(
 p_organization_id uuid,p_request_id uuid,p_status public.contact_request_status
) returns table(request_id uuid,request_status public.contact_request_status,updated_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare target public.contact_requests%rowtype; actor_id uuid:=auth.uid(); event_time timestamptz:=timezone('utc',now());
begin
 if actor_id is null then raise insufficient_privilege; end if;
 select cr.* into target from public.contact_requests cr
 where cr.id=p_request_id and cr.target_organization_id=p_organization_id
 and bridge_private.can_manage_contact_request(cr.target_organization_id,cr.routed_recipient_user_id,cr.routed_recipient_membership_id)
 for update;
 -- Do not distinguish nonexistent requests from requests outside the actor's scope.
 if not found then raise no_data_found using message='Contact request not found.'; end if;
 if p_status is null or not (
   (target.status='new' and p_status in ('viewed','responded','closed'))
   or (target.status='viewed' and p_status in ('responded','closed'))
   or (target.status='responded' and p_status='closed')
 ) then raise object_not_in_prerequisite_state using message='Invalid contact request transition.'; end if;
 update public.contact_requests cr set status=p_status,
 viewed_at=case when p_status='viewed' then event_time else cr.viewed_at end,
 responded_at=case when p_status='responded' then event_time else cr.responded_at end,
 closed_at=case when p_status='closed' then event_time else cr.closed_at end,updated_at=event_time where cr.id=target.id;
 insert into public.contact_request_history(contact_request_id,actor_user_id,action,previous_status,new_status,created_at)
 values(target.id,actor_id,p_status::text::public.contact_request_history_action,target.status,p_status,event_time);
 insert into public.audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
 values(p_organization_id,actor_id,'update','contact_request',target.id,jsonb_build_object('previous_status',target.status,'new_status',p_status));
 return query select target.id,p_status,event_time;
end $$;

-- Discover only organizations with owner/admin access or an assigned request.
-- Platform admin status alone does not grant any inbox.
create or replace function public.list_contact_inbox_organizations()
returns table(organization_id uuid,organization_name text)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise insufficient_privilege; end if;
 return query select o.id,o.name from public.organizations o
 where public.is_organization_admin(o.id) or exists(
   select 1 from public.contact_requests cr where cr.target_organization_id=o.id
   and bridge_private.can_manage_contact_request(cr.target_organization_id,cr.routed_recipient_user_id,cr.routed_recipient_membership_id)
 ) order by o.name,o.id;
end $$;
revoke all on function public.list_contact_inbox_organizations() from public,anon,authenticated;
grant execute on function public.list_contact_inbox_organizations() to authenticated;
revoke all on function public.list_inbound_contact_requests(uuid,public.contact_request_status,integer,integer),
 public.transition_contact_request(uuid,uuid,public.contact_request_status) from public,anon,authenticated;
grant execute on function public.list_inbound_contact_requests(uuid,public.contact_request_status,integer,integer),
 public.transition_contact_request(uuid,uuid,public.contact_request_status) to authenticated;

create or replace function public.list_contact_routing_candidates(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $
declare profile_id uuid;
begin
 if auth.uid() is null or not public.is_organization_admin(p_organization_id) then raise insufficient_privilege; end if;
 select dp.id into profile_id from public.directory_profiles dp where dp.organization_id=p_organization_id;
 if profile_id is null then raise no_data_found; end if;
 return jsonb_build_object(
   'salesRepresentatives',coalesce((
     select jsonb_agg(jsonb_build_object('membershipId',om.id,'userId',om.user_id,'displayName',up.display_name) order by up.display_name nulls last,om.id)
     from public.organization_members om join public.user_profiles up on up.id=om.user_id
     where om.organization_id=p_organization_id and om.status='active' and up.account_type='sales_rep'
   ),'[]'::jsonb),
   'bridgeAdmin',(
     select jsonb_build_object('userId',r.bridge_admin_user_id,'displayName',up.display_name)
     from public.directory_profile_contact_routing r join public.user_profiles up on up.id=r.bridge_admin_user_id
     where r.profile_id=profile_id and exists(select 1 from public.user_platform_roles pr where pr.user_id=r.bridge_admin_user_id and pr.role='admin')
   )
 );
end $;
revoke all on function public.list_contact_routing_candidates(uuid) from public,anon,authenticated;
grant execute on function public.list_contact_routing_candidates(uuid) to authenticated;

commit;
