-- Transactional email routing for Directory MVP requests.
alter table public.directory_requests
add column email_delivery text not null default 'not_applicable'
check (email_delivery in ('not_applicable','queued','sent','partial','failed'));

create table public.directory_email_outbox (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null references public.directory_requests(id) on delete cascade,
    event_type text not null check (event_type in ('submitted','reviewed')),
    recipient_email text not null check (length(recipient_email) between 3 and 320),
    status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
    attempt_count integer not null default 0 check (attempt_count between 0 and 3),
    provider_message_id text,
    last_error text,
    attempted_at timestamptz,
    sent_at timestamptz,
    created_at timestamptz not null default now(),
    unique (request_id,event_type,recipient_email)
);
create index directory_email_outbox_pending
on public.directory_email_outbox(status,created_at,id)
where status in ('pending','failed');
alter table public.directory_email_outbox enable row level security;
revoke all on public.directory_email_outbox from public,anon,authenticated;
grant select,insert,update on public.directory_email_outbox to service_role;

create function public.queue_directory_request_email()
returns trigger language plpgsql security definer set search_path='' as $$
begin
    if tg_op = 'INSERT' then
        insert into public.directory_email_outbox(request_id,event_type,recipient_email)
        select distinct new.id,'submitted',lower(u.email)
        from (
            select d.owner_user_id as user_id
            from public.directory_profiles d
            where new.kind='contact' and d.id=new.profile_id and d.owner_user_id is not null
            union
            select m.user_id
            from public.directory_profiles d
            join public.organizations o on o.id=d.organization_id
            join public.organization_members m on m.organization_id=d.organization_id
            where new.kind='contact' and d.id=new.profile_id and o.status='active'
              and m.status='active' and m.role in ('owner','admin')
            union
            select r.user_id from public.user_platform_roles r
            where new.kind in ('claim','correction') and r.role='admin'
        ) recipients
        join auth.users u on u.id=recipients.user_id
        where u.email is not null and length(btrim(u.email)) between 3 and 320
        on conflict do nothing;
    elsif old.status='pending' and new.status in ('resolved','rejected') then
        insert into public.directory_email_outbox(request_id,event_type,recipient_email)
        select new.id,'reviewed',lower(u.email)
        from auth.users u
        where u.id=new.requester_id and u.email is not null
          and length(btrim(u.email)) between 3 and 320
        on conflict do nothing;
    end if;

    if exists (
        select 1 from public.directory_email_outbox o
        where o.request_id=new.id and o.status<>'sent'
    ) then
        update public.directory_requests set email_delivery='queued' where id=new.id;
    end if;
    return new;
end;
$$;
revoke all on function public.queue_directory_request_email() from public,anon,authenticated;
create trigger directory_request_queue_email_after_insert
after insert on public.directory_requests for each row execute function public.queue_directory_request_email();
create trigger directory_request_queue_email_after_review
after update of status on public.directory_requests for each row execute function public.queue_directory_request_email();

create function public.claim_directory_email_outbox(p_request_id uuid default null,p_limit integer default 20)
returns table(outbox_id uuid,request_id uuid,event_type text,recipient_email text,request_kind text,request_status text)
language sql security definer set search_path='' as $$
    with claimed as (
        select o.id
        from public.directory_email_outbox o
        where (p_request_id is null or o.request_id=p_request_id)
          and (
              o.status='pending'
              or (o.status='failed' and o.attempt_count<3)
              or (o.status='sending' and o.attempt_count<3 and o.attempted_at<now()-interval '5 minutes')
          )
        order by o.created_at,o.id
        for update skip locked
        limit greatest(1,least(coalesce(p_limit,20),100))
    ), updated as (
        update public.directory_email_outbox o
        set status='sending',attempt_count=o.attempt_count+1,attempted_at=now(),last_error=null
        from claimed c where o.id=c.id
        returning o.id,o.request_id,o.event_type,o.recipient_email
    )
    select u.id,u.request_id,u.event_type,u.recipient_email,r.kind,r.status
    from updated u join public.directory_requests r on r.id=u.request_id;
$$;
revoke all on function public.claim_directory_email_outbox(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_directory_email_outbox(uuid,integer) to service_role;

create function public.complete_directory_email_outbox(p_outbox_id uuid,p_sent boolean,p_provider_message_id text default null,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare target_request_id uuid;
begin
    update public.directory_email_outbox
    set status=case when p_sent then 'sent' else 'failed' end,
        provider_message_id=case when p_sent then left(p_provider_message_id,500) else null end,
        last_error=case when p_sent then null else left(coalesce(p_error,'Email provider failed'),500) end,
        sent_at=case when p_sent then now() else null end
    where id=p_outbox_id and status='sending'
    returning request_id into target_request_id;

    if target_request_id is null then
        raise exception 'Outbox item not found or not claimed' using errcode='P0002';
    end if;

    update public.directory_requests r set email_delivery=(
        select case
            when bool_and(o.status='sent') then 'sent'
            when bool_or(o.status in ('pending','sending') or (o.status='failed' and o.attempt_count<3)) then 'queued'
            when bool_or(o.status='sent') then 'partial'
            else 'failed'
        end
        from public.directory_email_outbox o where o.request_id=r.id
    ) where r.id=target_request_id;
end;
$$;
revoke all on function public.complete_directory_email_outbox(uuid,boolean,text,text) from public,anon,authenticated;
grant execute on function public.complete_directory_email_outbox(uuid,boolean,text,text) to service_role;

create or replace view public.directory_request_read with (security_invoker=true,security_barrier=true) as
select id,profile_id,kind,message,reply_email,status,created_at,updated_at,
    public.can_review_directory_request(kind,profile_id) as can_review,email_delivery
from public.directory_requests;
revoke all on public.directory_request_read from public,anon,authenticated;
grant select on public.directory_request_read to authenticated;

comment on table public.directory_email_outbox is 'Private transactional outbox. Only the service role may claim or complete delivery; recipient addresses never enter public request projections.';
