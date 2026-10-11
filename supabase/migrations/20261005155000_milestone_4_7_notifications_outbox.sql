-- BRIDGE M4.7: private notifications, preferences, and transactional email outbox
begin;

create type public.notification_type as enum (
  'profile_correction_requested','profile_approved','profile_rejected','profile_suspended',
  'contact_request_received','contact_request_responded','contact_request_closed',
  'ein_verified','ein_failed','ein_correction_required'
);
create type public.notification_category as enum ('profile','contact','verification');
create type public.email_outbox_status as enum ('pending','processing','sent','failed');

create table public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_in_app boolean not null default true, profile_email boolean not null default true,
  contact_in_app boolean not null default true, contact_email boolean not null default true,
  verification_in_app boolean not null default true, verification_email boolean not null default true,
  updated_at timestamptz not null default timezone('utc',now())
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), recipient_user_id uuid not null references auth.users(id) on delete cascade,
  type public.notification_type not null, category public.notification_category not null,
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 500),
  resource_type text, resource_id uuid, source_event_type text not null, source_event_id uuid not null,
  created_at timestamptz not null default timezone('utc',now()), read_at timestamptz,
  unique(source_event_type,source_event_id,recipient_user_id,type)
);
create index notifications_recipient_created_idx on public.notifications(recipient_user_id,created_at desc,id desc);
create index notifications_recipient_unread_idx on public.notifications(recipient_user_id,created_at desc) where read_at is null;

create table public.transactional_email_outbox (
  id uuid primary key default gen_random_uuid(), recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null, template_key text not null, template_variables jsonb not null default '{}'::jsonb,
  source_event_type text not null, source_event_id uuid not null,
  status public.email_outbox_status not null default 'pending', attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default timezone('utc',now()), provider_message_id text,
  last_error text, created_at timestamptz not null default timezone('utc',now()), sent_at timestamptz,
  unique(source_event_type,source_event_id,recipient_user_id,template_key),
  check (jsonb_typeof(template_variables)='object'), check (attempt_count >= 0)
);
create index email_outbox_pending_idx on public.transactional_email_outbox(status,next_attempt_at,created_at) where status in ('pending','failed');

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.transactional_email_outbox enable row level security;
create policy notifications_select_own on public.notifications for select to authenticated using (recipient_user_id=(select auth.uid()));
create policy preferences_select_own on public.notification_preferences for select to authenticated using (user_id=(select auth.uid()));
revoke all on public.notifications,public.notification_preferences,public.transactional_email_outbox from public,anon,authenticated;
grant select on public.notifications,public.notification_preferences to authenticated;

create or replace function public.enqueue_user_notification(
 p_recipient uuid,p_type public.notification_type,p_category public.notification_category,
 p_title text,p_body text,p_resource_type text,p_resource_id uuid,p_source_type text,p_source_id uuid,p_email boolean
) returns void language plpgsql security definer set search_path='' as $$
declare pref_in_app boolean; pref_email boolean; recipient_email text;
begin
 select case p_category when 'profile' then coalesce(np.profile_in_app,true) when 'contact' then coalesce(np.contact_in_app,true) else coalesce(np.verification_in_app,true) end,
        case p_category when 'profile' then coalesce(np.profile_email,true) when 'contact' then coalesce(np.contact_email,true) else coalesce(np.verification_email,true) end
 into pref_in_app,pref_email from (select 1) x left join public.notification_preferences np on np.user_id=p_recipient;
 if pref_in_app then insert into public.notifications(recipient_user_id,type,category,title,body,resource_type,resource_id,source_event_type,source_event_id)
 values(p_recipient,p_type,p_category,p_title,p_body,p_resource_type,p_resource_id,p_source_type,p_source_id) on conflict do nothing; end if;
 if p_email and pref_email then
   select email into recipient_email from auth.users where id=p_recipient;
   if recipient_email is not null then insert into public.transactional_email_outbox(recipient_user_id,recipient_email,template_key,template_variables,source_event_type,source_event_id)
   values(p_recipient,recipient_email,p_type::text,jsonb_build_object('resourceType',p_resource_type,'resourceId',p_resource_id),p_source_type,p_source_id) on conflict do nothing; end if;
 end if;
end $$;
revoke all on function public.enqueue_user_notification(uuid,public.notification_type,public.notification_category,text,text,text,uuid,text,uuid,boolean) from public,anon,authenticated;

create or replace function public.notify_directory_history() returns trigger language plpgsql security definer set search_path='' as $$
declare r record; nt public.notification_type; ttl text; msg text; send_email boolean;
begin
 if new.action not in ('correction_requested','approved','rejected','suspended') then return new; end if;
 nt:=case new.action when 'correction_requested' then 'profile_correction_requested' when 'approved' then 'profile_approved' when 'rejected' then 'profile_rejected' else 'profile_suspended' end;
 ttl:=case new.action when 'correction_requested' then 'Profile correction requested' when 'approved' then 'Profile approved' when 'rejected' then 'Profile rejected' else 'Profile suspended' end;
 msg:=case new.action when 'correction_requested' then 'Your Directory profile needs corrections.' when 'approved' then 'Your Directory profile was approved.' when 'rejected' then 'Your Directory profile was rejected.' else 'Your Directory profile was suspended.' end;
 send_email:=new.action in ('correction_requested','approved','rejected');
 for r in select distinct om.user_id from public.organization_members om where om.organization_id=new.organization_id and om.status='active' and om.role in ('owner','admin') loop
  perform public.enqueue_user_notification(r.user_id,nt,'profile',ttl,msg,'directory_profile',new.profile_id,'directory_profile_history',new.id,send_email);
 end loop; return new;
end $$;
create trigger directory_history_notify after insert on public.directory_profile_history for each row execute function public.notify_directory_history();

create or replace function public.notify_contact_history() returns trigger language plpgsql security definer set search_path='' as $$
declare cr public.contact_requests%rowtype; recipient uuid; nt public.notification_type; ttl text; msg text; send_email boolean;
begin
 select * into cr from public.contact_requests where id=new.contact_request_id;
 if new.action='routed' then select om.user_id into recipient from public.organization_members om where om.id=cr.routed_recipient_membership_id and om.status='active'; nt:='contact_request_received'; ttl:='New contact request'; msg:='Your organization received a new contact request.'; send_email:=true;
 elsif new.action='responded' then recipient:=cr.sender_user_id; nt:='contact_request_responded'; ttl:='Contact request responded'; msg:='The business marked your contact request as responded.'; send_email:=true;
 elsif new.action='closed' then recipient:=cr.sender_user_id; nt:='contact_request_closed'; ttl:='Contact request closed'; msg:='The business closed your contact request.'; send_email:=false;
 else return new; end if;
 if recipient is not null then perform public.enqueue_user_notification(recipient,nt,'contact',ttl,msg,'contact_request',cr.id,'contact_request_history',new.id,send_email); end if;
 return new;
end $$;
create trigger contact_history_notify after insert on public.contact_request_history for each row execute function public.notify_contact_history();

create or replace function public.notify_ein_history() returns trigger language plpgsql security definer set search_path='' as $$
declare org_id uuid; r record; nt public.notification_type; ttl text; msg text;
begin
 if new.new_status not in ('verified','rejected','correction_required') then return new; end if;
 select vc.organization_id into org_id from public.verification_items vi join public.verification_cases vc on vc.id=vi.verification_case_id where vi.id=new.verification_item_id and vi.item_type='ein';
 if org_id is null then return new; end if;
 nt:=case new.new_status when 'verified' then 'ein_verified' when 'rejected' then 'ein_failed' else 'ein_correction_required' end;
 ttl:=case new.new_status when 'verified' then 'EIN verified' when 'rejected' then 'EIN verification failed' else 'EIN correction required' end; msg:=ttl||'.';
 for r in select distinct om.user_id from public.organization_members om where om.organization_id=org_id and om.status='active' and om.role in ('owner','admin') loop
  perform public.enqueue_user_notification(r.user_id,nt,'verification',ttl,msg,'verification_item',new.verification_item_id,'verification_item_history',new.id,true);
 end loop; return new;
end $$;
create trigger verification_history_notify after insert on public.verification_item_history for each row execute function public.notify_ein_history();

create or replace function public.mark_notification_read(p_notification_id uuid) returns timestamptz language plpgsql security definer set search_path='' as $$ declare t timestamptz:=timezone('utc',now()); begin update public.notifications set read_at=coalesce(read_at,t) where id=p_notification_id and recipient_user_id=auth.uid(); if not found then raise no_data_found using message='Notification not found.'; end if; return t; end $$;
create or replace function public.mark_all_notifications_read() returns integer language plpgsql security definer set search_path='' as $$ declare n integer; begin update public.notifications set read_at=timezone('utc',now()) where recipient_user_id=auth.uid() and read_at is null; get diagnostics n=row_count; return n; end $$;
create or replace function public.upsert_notification_preferences(p_profile_in_app boolean,p_profile_email boolean,p_contact_in_app boolean,p_contact_email boolean,p_verification_in_app boolean,p_verification_email boolean) returns void language sql security definer set search_path='' as $$ insert into public.notification_preferences values(auth.uid(),p_profile_in_app,p_profile_email,p_contact_in_app,p_contact_email,p_verification_in_app,p_verification_email,timezone('utc',now())) on conflict(user_id) do update set profile_in_app=excluded.profile_in_app,profile_email=excluded.profile_email,contact_in_app=excluded.contact_in_app,contact_email=excluded.contact_email,verification_in_app=excluded.verification_in_app,verification_email=excluded.verification_email,updated_at=excluded.updated_at $$;
revoke all on function public.mark_notification_read(uuid),public.mark_all_notifications_read(),public.upsert_notification_preferences(boolean,boolean,boolean,boolean,boolean,boolean) from public,anon,authenticated;
grant execute on function public.mark_notification_read(uuid),public.mark_all_notifications_read(),public.upsert_notification_preferences(boolean,boolean,boolean,boolean,boolean,boolean) to authenticated;
commit;
