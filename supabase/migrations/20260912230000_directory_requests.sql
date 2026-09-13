-- Private directory contact/claim/correction requests; no ownership or email-delivery authority.
create table public.directory_requests (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null references public.directory_profiles(id) on delete cascade,
    requester_id uuid not null references auth.users(id) on delete cascade,
    kind text not null check (kind in ('contact','claim','correction')),
    message text not null check (length(btrim(message)) between 1 and 5000),
    share_email boolean not null default false,
    reply_email text,
    idempotency_key uuid not null,
    status text not null default 'pending' check (status in ('pending','resolved','rejected')),
    reviewed_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(requester_id,kind,idempotency_key),
    check (share_email or reply_email is null)
);
create function public.can_review_directory_request(request_kind text, target_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select case when request_kind = 'contact' then public.can_manage_engagement_profile(target_profile_id)
        when request_kind in ('claim','correction') then exists (
            select 1 from public.user_platform_roles r where r.user_id = (select auth.uid()) and r.role = 'admin'
        ) else false end;
$$;
revoke all on function public.can_review_directory_request(text,uuid) from public, anon;
grant execute on function public.can_review_directory_request(text,uuid) to authenticated;
alter table public.directory_requests enable row level security;
revoke all on public.directory_requests from public, anon, authenticated;
grant select on public.directory_requests to authenticated;
create policy directory_requests_participant_read on public.directory_requests for select to authenticated
using (requester_id = (select auth.uid()) or public.can_review_directory_request(kind,profile_id));
create index directory_requests_requester_date on public.directory_requests(requester_id,created_at desc,id);
create index directory_requests_profile_date on public.directory_requests(profile_id,created_at desc,id);
create view public.directory_request_read with (security_invoker=true,security_barrier=true) as
select id,profile_id,kind,message,reply_email,status,created_at,updated_at,
    public.can_review_directory_request(kind,profile_id) as can_review
from public.directory_requests;
revoke all on public.directory_request_read from public, anon, authenticated;
grant select on public.directory_request_read to authenticated;

create function public.submit_directory_request(p_profile_id uuid,p_kind text,p_message text,p_share_email boolean,p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
    actor uuid := auth.uid();
    existing public.directory_requests;
    request_id uuid;
    normalized_message text := btrim(p_message);
    email_address text;
begin
    if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
    if p_profile_id is null or p_idempotency_key is null or p_kind is null or p_kind not in ('contact','claim','correction')
       or normalized_message is null or length(normalized_message) not between 1 and 5000 or p_share_email is null then
        raise exception 'Invalid request' using errcode='22023';
    end if;
    -- Serialize retries of exactly this sender/kind/key; unrelated requests proceed independently.
    perform pg_advisory_xact_lock(hashtextextended(actor::text || ':' || p_kind || ':' || p_idempotency_key::text,0));
    select * into existing from public.directory_requests r where r.requester_id=actor and r.kind=p_kind and r.idempotency_key=p_idempotency_key;
    if found then
        if existing.profile_id<>p_profile_id or existing.message<>normalized_message or existing.share_email<>p_share_email then
            raise exception 'Idempotency key reused for different request' using errcode='23505';
        end if;
        return existing.id;
    end if;
    if not exists (select 1 from public.directory_profile_read d where d.id=p_profile_id and d.visibility='public') then
        raise exception 'Public profile required' using errcode='P0002';
    end if;
    if p_share_email then select u.email into email_address from auth.users u where u.id=actor; end if;
    insert into public.directory_requests(profile_id,requester_id,kind,message,share_email,reply_email,idempotency_key)
    values(p_profile_id,actor,p_kind,normalized_message,p_share_email,email_address,p_idempotency_key) returning id into request_id;
    insert into public.engagement_notifications(user_id,type,title,body)
    select distinct recipient_id,'system','Directory request received','A directory request is ready for review in your requests inbox.'
    from (
        select d.owner_user_id as recipient_id from public.directory_profiles d
            where p_kind='contact' and d.id=p_profile_id and d.owner_user_id is not null
        union
        select m.user_id from public.directory_profiles d join public.organizations o on o.id=d.organization_id
            join public.organization_members m on m.organization_id=d.organization_id
            where p_kind='contact' and d.id=p_profile_id and o.status='active' and m.status='active' and m.role in ('owner','admin')
        union
        select r.user_id from public.user_platform_roles r where p_kind in ('claim','correction') and r.role='admin'
    ) recipients where recipient_id is not null;
    return request_id;
end;
$$;
revoke all on function public.submit_directory_request(uuid,text,text,boolean,uuid) from public,anon;
grant execute on function public.submit_directory_request(uuid,text,text,boolean,uuid) to authenticated;

create function public.review_directory_request(p_request_id uuid,p_status text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare existing public.directory_requests;
begin
    if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
    if p_status is null or p_status not in ('resolved','rejected') then raise exception 'Invalid status' using errcode='22023'; end if;
    select * into existing from public.directory_requests where id=p_request_id for update;
    if not found or not public.can_review_directory_request(existing.kind,existing.profile_id) then
        raise exception 'Request not found' using errcode='P0002';
    end if;
    if existing.status=p_status then return existing.id; end if;
    if existing.status<>'pending' then raise exception 'Request already reviewed' using errcode='23505'; end if;
    update public.directory_requests set status=p_status,reviewed_by=auth.uid(),updated_at=now() where id=p_request_id;
    insert into public.engagement_notifications(user_id,type,title,body)
    values(existing.requester_id,'system','Directory request updated','Your directory request has been reviewed. Check your requests inbox for its status.');
    return existing.id;
end;
$$;
revoke all on function public.review_directory_request(uuid,text) from public,anon;
grant execute on function public.review_directory_request(uuid,text) to authenticated;
comment on table public.directory_requests is 'Private requests. Claims/corrections require platform-admin review and never transfer ownership. In-app notifications are atomic; no email provider is configured or delivery claimed.';
