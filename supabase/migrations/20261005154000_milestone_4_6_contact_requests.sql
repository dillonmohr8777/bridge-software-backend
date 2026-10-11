-- ============================================================================
-- BRIDGE — MILESTONE 4.6
-- Private Directory contact requests, deterministic routing, and lifecycle
-- ============================================================================

begin;

create type public.contact_request_status as enum (
    'new', 'viewed', 'responded', 'closed'
);

create type public.contact_request_routing_status as enum (
    'routed', 'needs_assignment'
);

create type public.contact_request_history_action as enum (
    'created', 'routed', 'manual_assignment_needed',
    'viewed', 'responded', 'closed'
);

create table public.contact_requests (
    id uuid primary key default gen_random_uuid(),
    sender_user_id uuid not null references auth.users(id) on delete restrict,
    sender_organization_id uuid not null references public.organizations(id) on delete restrict,
    target_profile_id uuid not null references public.directory_profiles(id) on delete restrict,
    target_organization_id uuid not null references public.organizations(id) on delete restrict,
    target_slug text not null,
    target_display_name text not null,
    routed_recipient_membership_id uuid references public.organization_members(id) on delete set null,
    routing_status public.contact_request_routing_status not null,
    status public.contact_request_status not null default 'new',
    first_name text not null,
    work_email text not null,
    phone_number text not null,
    years_of_service integer not null,
    contact_preference text not null,
    message text,
    viewed_at timestamptz,
    responded_at timestamptz,
    closed_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint contact_requests_first_name_length check (char_length(first_name) between 1 and 100),
    constraint contact_requests_work_email_length check (char_length(work_email) between 3 and 320),
    constraint contact_requests_phone_length check (char_length(phone_number) between 7 and 32),
    constraint contact_requests_work_email_format check (
        work_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
    constraint contact_requests_phone_format check (phone_number ~ '^\+?[0-9 ()-]+$'),
    constraint contact_requests_years_range check (years_of_service between 0 and 80),
    constraint contact_requests_preference_check check (contact_preference in ('email', 'phone')),
    constraint contact_requests_message_length check (message is null or char_length(message) <= 2000)
);

create index contact_requests_sender_created_idx
    on public.contact_requests(sender_user_id, created_at desc, id desc);
create index contact_requests_target_created_idx
    on public.contact_requests(target_organization_id, created_at desc, id desc);
create index contact_requests_target_status_idx
    on public.contact_requests(target_organization_id, status, created_at desc);

create table public.contact_request_history (
    id uuid primary key default gen_random_uuid(),
    contact_request_id uuid not null references public.contact_requests(id) on delete cascade,
    actor_user_id uuid references auth.users(id) on delete set null,
    action public.contact_request_history_action not null,
    previous_status public.contact_request_status,
    new_status public.contact_request_status,
    created_at timestamptz not null default timezone('utc', now())
);

create index contact_request_history_request_created_idx
    on public.contact_request_history(contact_request_id, created_at asc, id asc);

alter table public.contact_requests enable row level security;
alter table public.contact_request_history enable row level security;

create policy contact_requests_select_sender
on public.contact_requests for select to authenticated
using (sender_user_id = (select auth.uid()));

create policy contact_requests_select_target_admin
on public.contact_requests for select to authenticated
using (public.is_organization_admin(target_organization_id));

-- History remains an internal append-only workflow/event seam. Clients receive
-- the current status through narrow request RPCs.
revoke all on table public.contact_requests from public, anon, authenticated;
grant select on table public.contact_requests to authenticated;
revoke all on table public.contact_request_history from public, anon, authenticated;

create or replace function public.create_contact_request(
    p_target_slug text,
    p_first_name text,
    p_work_email text,
    p_phone_number text,
    p_years_of_service integer,
    p_contact_preference text,
    p_message text default null
)
returns table (
    request_id uuid,
    request_status public.contact_request_status,
    routing_status public.contact_request_routing_status,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_id uuid := auth.uid();
    sender_org_id uuid;
    sender_org_ids uuid[];
    sender_count integer;
    target_profile public.directory_profiles%rowtype;
    recipient_membership_id uuid;
    route_status public.contact_request_routing_status;
    new_request_id uuid;
    event_time timestamptz := timezone('utc', now());
begin
    if actor_id is null then
        raise insufficient_privilege using message = 'Authentication is required.';
    end if;

    select count(*), array_agg(eligible.organization_id order by eligible.organization_id)
    into sender_count, sender_org_ids
    from (
        select distinct om.organization_id
        from public.organization_members om
        join public.organizations o on o.id = om.organization_id
        join public.directory_profiles dp on dp.organization_id = om.organization_id
        join public.directory_profile_versions dpv
          on dpv.id = dp.published_version_id and dpv.profile_id = dp.id and dpv.is_published
        join public.businesses b
          on b.id = dpv.business_id and b.organization_id = om.organization_id
        where om.user_id = actor_id
          and om.status = 'active'::public.membership_status
          and dp.status <> 'suspended'::public.directory_profile_status
          and o.status = 'active'::public.organization_status
          and b.status = 'active'::public.business_status
          and public.is_business_ein_verified(b.id)
    ) eligible;

    if sender_count <> 1 then
        raise object_not_in_prerequisite_state using message = 'Sender Directory eligibility is not satisfied or is ambiguous.';
    end if;
    sender_org_id := sender_org_ids[1];

    select dp.* into target_profile
    from public.directory_profiles dp
    join public.directory_profile_versions dpv
      on dpv.id = dp.published_version_id and dpv.profile_id = dp.id and dpv.is_published
    join public.organizations o on o.id = dp.organization_id
    join public.businesses b
      on b.id = dpv.business_id and b.organization_id = dp.organization_id
    where dpv.slug = lower(btrim(p_target_slug))
      and dp.status <> 'suspended'::public.directory_profile_status
      and o.status = 'active'::public.organization_status
      and b.status = 'active'::public.business_status
      and public.is_business_ein_verified(b.id)
    limit 1;

    if not found then
        raise no_data_found using message = 'Contactable Directory profile not found.';
    end if;

    select om.id into recipient_membership_id
    from public.organization_members om
    where om.organization_id = target_profile.organization_id
      and om.status = 'active'::public.membership_status
      and om.role in ('admin'::public.organization_role, 'owner'::public.organization_role)
    order by
      case om.role when 'admin'::public.organization_role then 0 else 1 end,
      om.created_at asc,
      om.user_id asc
    limit 1;

    route_status := case when recipient_membership_id is null
        then 'needs_assignment'::public.contact_request_routing_status
        else 'routed'::public.contact_request_routing_status end;

    insert into public.contact_requests (
        sender_user_id, sender_organization_id, target_profile_id,
        target_organization_id, target_slug, target_display_name,
        routed_recipient_membership_id, routing_status,
        first_name, work_email, phone_number, years_of_service,
        contact_preference, message, created_at, updated_at
    ) values (
        actor_id, sender_org_id, target_profile.id,
        target_profile.organization_id, lower(btrim(p_target_slug)),
        (select dpv.display_name from public.directory_profile_versions dpv
         where dpv.id = target_profile.published_version_id),
        recipient_membership_id, route_status,
        btrim(p_first_name), lower(btrim(p_work_email)), btrim(p_phone_number),
        p_years_of_service, p_contact_preference, nullif(btrim(p_message), ''),
        event_time, event_time
    ) returning id into new_request_id;

    insert into public.contact_request_history
        (contact_request_id, actor_user_id, action, new_status, created_at)
    values
        (new_request_id, actor_id, 'created', 'new', event_time),
        (new_request_id, actor_id,
         case when recipient_membership_id is null then 'manual_assignment_needed'
              else 'routed' end,
         'new', event_time);

    insert into public.audit_logs
        (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
    values (
        target_profile.organization_id, actor_id, 'create',
        'contact_request', new_request_id,
        jsonb_build_object('routing_status', route_status)
    );

    return query select new_request_id, 'new'::public.contact_request_status, route_status, event_time;
end;
$$;

revoke all on function public.create_contact_request(text, text, text, text, integer, text, text)
from public, anon, authenticated;
grant execute on function public.create_contact_request(text, text, text, text, integer, text, text)
to authenticated;

create or replace function public.transition_contact_request(
    p_organization_id uuid,
    p_request_id uuid,
    p_status public.contact_request_status
)
returns table (request_id uuid, request_status public.contact_request_status, updated_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
    target public.contact_requests%rowtype;
    actor_id uuid := auth.uid();
    event_time timestamptz := timezone('utc', now());
begin
    if actor_id is null or not public.is_organization_admin(p_organization_id) then
        raise insufficient_privilege using message = 'Organization owner or admin permission is required.';
    end if;
    select cr.* into target from public.contact_requests cr
    where cr.id = p_request_id and cr.target_organization_id = p_organization_id
    for update;
    if not found then raise no_data_found using message = 'Contact request not found.'; end if;

    if not (
        (target.status = 'new' and p_status in ('viewed', 'responded', 'closed'))
        or (target.status = 'viewed' and p_status in ('responded', 'closed'))
        or (target.status = 'responded' and p_status = 'closed')
    ) then
        raise object_not_in_prerequisite_state using message = 'Invalid contact request transition.';
    end if;

    update public.contact_requests cr set
        status = p_status,
        viewed_at = case when p_status = 'viewed' then event_time else cr.viewed_at end,
        responded_at = case when p_status = 'responded' then event_time else cr.responded_at end,
        closed_at = case when p_status = 'closed' then event_time else cr.closed_at end,
        updated_at = event_time
    where cr.id = target.id;

    insert into public.contact_request_history
        (contact_request_id, actor_user_id, action, previous_status, new_status, created_at)
    values (target.id, actor_id, p_status::text::public.contact_request_history_action,
        target.status, p_status, event_time);
    insert into public.audit_logs
        (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
    values (p_organization_id, actor_id, 'update', 'contact_request', target.id,
        jsonb_build_object('previous_status', target.status, 'new_status', p_status));

    return query select target.id, p_status, event_time;
end;
$$;

revoke all on function public.transition_contact_request(uuid, uuid, public.contact_request_status)
from public, anon, authenticated;
grant execute on function public.transition_contact_request(uuid, uuid, public.contact_request_status)
to authenticated;

create or replace function public.list_inbound_contact_requests(
    p_organization_id uuid,
    p_status public.contact_request_status default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    request_id uuid, request_status public.contact_request_status,
    routing_status public.contact_request_routing_status,
    first_name text, work_email text, phone_number text,
    years_of_service integer, contact_preference text, message text,
    created_at timestamptz, updated_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if auth.uid() is null or not public.is_organization_admin(p_organization_id) then
        raise insufficient_privilege using message = 'Organization owner or admin permission is required.';
    end if;
    if p_limit < 1 or p_limit > 50 then
        raise invalid_parameter_value using message = 'Contact request limit is invalid.';
    end if;
    if p_offset < 0 or p_offset > 10000 then
        raise invalid_parameter_value using message = 'Contact request offset is invalid.';
    end if;
    return query
    select cr.id, cr.status, cr.routing_status, cr.first_name, cr.work_email,
        cr.phone_number, cr.years_of_service, cr.contact_preference, cr.message,
        cr.created_at, cr.updated_at
    from public.contact_requests cr
    where cr.target_organization_id = p_organization_id
      and (p_status is null or cr.status = p_status)
    order by cr.created_at desc, cr.id desc
    limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_inbound_contact_requests(uuid, public.contact_request_status, integer, integer)
from public, anon, authenticated;
grant execute on function public.list_inbound_contact_requests(uuid, public.contact_request_status, integer, integer)
to authenticated;

create or replace function public.list_sent_contact_requests(
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    request_id uuid, target_slug text, target_display_name text,
    request_status public.contact_request_status,
    created_at timestamptz, updated_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise insufficient_privilege using message = 'Authentication is required.';
    end if;
    if p_limit < 1 or p_limit > 50 then
        raise invalid_parameter_value using message = 'Contact request limit is invalid.';
    end if;
    if p_offset < 0 or p_offset > 10000 then
        raise invalid_parameter_value using message = 'Contact request offset is invalid.';
    end if;
    return query
    select cr.id, cr.target_slug, cr.target_display_name, cr.status,
        cr.created_at, cr.updated_at
    from public.contact_requests cr
    where cr.sender_user_id = auth.uid()
    order by cr.created_at desc, cr.id desc
    limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_sent_contact_requests(integer, integer)
from public, anon, authenticated;
grant execute on function public.list_sent_contact_requests(integer, integer)
to authenticated;

comment on table public.contact_request_history is
    'Append-only private workflow history and notification-event seam for contact requests.';

commit;
