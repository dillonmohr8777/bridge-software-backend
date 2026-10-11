-- ============================================================================
-- BRIDGE — MILESTONE 4.3B
-- Directory submission, review, immutable publication snapshots, and history
-- ============================================================================

begin;

create type public.directory_profile_history_action as enum (
    'submitted',
    'resubmitted',
    'correction_requested',
    'approved',
    'rejected',
    'suspended',
    'published_revision_replaced'
);

alter table public.directory_profiles
    add column submitted_by_user_id uuid
        references auth.users(id)
        on delete set null,
    add column submitted_at timestamptz,
    add column reviewed_by_user_id uuid
        references auth.users(id)
        on delete set null,
    add column reviewed_at timestamptz,
    add column workflow_reason text,
    add column published_version_id uuid;

create table public.directory_profile_versions (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null
        references public.directory_profiles(id)
        on delete cascade,
    revision_number integer not null,
    business_id uuid not null
        references public.businesses(id)
        on delete restrict,
    slug text not null,
    display_name text not null,
    summary text,
    website_url text,
    approved_by_user_id uuid not null
        references auth.users(id)
        on delete restrict,
    approved_at timestamptz not null,
    is_published boolean not null default false,
    published_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),

    constraint directory_profile_versions_revision_positive
        check (revision_number > 0),
    constraint directory_profile_versions_profile_revision_unique
        unique (profile_id, revision_number),
    constraint directory_profile_versions_publish_time
        check (not is_published or published_at is not null)
);

create unique index directory_profile_versions_one_published_idx
    on public.directory_profile_versions(profile_id)
    where is_published;

create unique index directory_profile_versions_published_slug_idx
    on public.directory_profile_versions(lower(slug))
    where is_published;

create index directory_profile_versions_business_id_idx
    on public.directory_profile_versions(business_id);

alter table public.directory_profiles
    add constraint directory_profiles_published_version_fk
    foreign key (published_version_id)
    references public.directory_profile_versions(id)
    on delete set null;

create table public.directory_profile_history (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null
        references public.directory_profiles(id)
        on delete cascade,
    organization_id uuid not null
        references public.organizations(id)
        on delete cascade,
    actor_user_id uuid
        references auth.users(id)
        on delete set null,
    action public.directory_profile_history_action not null,
    previous_status public.directory_profile_status,
    new_status public.directory_profile_status,
    reason text,
    version_id uuid
        references public.directory_profile_versions(id)
        on delete set null,
    created_at timestamptz not null default timezone('utc', now())
);

create index directory_profile_history_profile_created_idx
    on public.directory_profile_history(profile_id, created_at desc);

alter table public.directory_profile_versions enable row level security;
alter table public.directory_profile_history enable row level security;

-- Snapshots and workflow history are backend-owned. Organization users receive
-- the necessary workflow summary through the protected profile projection.
revoke all on table public.directory_profile_versions
from public, anon, authenticated;

revoke all on table public.directory_profile_history
from public, anon, authenticated;

-- Replace the first-slice update trigger. An approved snapshot remains intact;
-- editing its working profile begins a new draft. Pending content changed during
-- review also returns to draft and must be submitted again.
create or replace function public.prepare_directory_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.organization_id is distinct from old.organization_id then
        raise insufficient_privilege using
            message = 'A directory profile cannot change organizations.';
    end if;

    if old.published_version_id is not null
       and new.business_id is distinct from old.business_id then
        raise object_not_in_prerequisite_state using
            message = 'The business association cannot change after publication.';
    end if;

    if (
        new.slug is distinct from old.slug
        or new.display_name is distinct from old.display_name
        or new.summary is distinct from old.summary
        or new.website_url is distinct from old.website_url
    ) then
        if old.status in (
            'approved'::public.directory_profile_status,
            'pending_review'::public.directory_profile_status
        ) then
            new.status := 'draft'::public.directory_profile_status;
            new.submitted_by_user_id := null;
            new.submitted_at := null;
            new.reviewed_by_user_id := null;
            new.reviewed_at := null;
            new.workflow_reason := null;
        end if;

        new.approved_by_user_id := null;
        new.approved_at := null;
    end if;

    new.updated_at := timezone('utc', now());
    return new;
end;
$$;

-- Replace the first-slice upsert so publication, submission, and review columns
-- remain untouched and a published profile can never switch verification
-- subjects through a second edit after its working status changed.
create or replace function public.upsert_directory_profile(
    p_organization_id uuid,
    p_business_id uuid,
    p_slug text,
    p_display_name text,
    p_summary text,
    p_website_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_id uuid := auth.uid();
    existing_profile public.directory_profiles%rowtype;
begin
    if actor_id is null then
        raise insufficient_privilege using message = 'Authentication is required.';
    end if;

    if not public.is_organization_admin(p_organization_id) then
        raise insufficient_privilege using
            message = 'Organization owner or admin permission is required.';
    end if;

    if not exists (
        select 1
        from public.businesses b
        where b.id = p_business_id
          and b.organization_id = p_organization_id
    ) then
        raise foreign_key_violation using
            message = 'The business does not belong to the organization.';
    end if;

    select dp.*
    into existing_profile
    from public.directory_profiles dp
    where dp.organization_id = p_organization_id
    for update;

    if found then
        if existing_profile.published_version_id is not null
           and existing_profile.business_id is distinct from p_business_id then
            raise object_not_in_prerequisite_state using
                message = 'The business association cannot change after publication.';
        end if;

        update public.directory_profiles dp
        set business_id = p_business_id,
            slug = p_slug,
            display_name = p_display_name,
            summary = p_summary,
            website_url = p_website_url,
            updated_by_user_id = actor_id
        where dp.id = existing_profile.id;
    else
        insert into public.directory_profiles (
            organization_id,
            business_id,
            slug,
            display_name,
            summary,
            website_url,
            created_by_user_id,
            updated_by_user_id
        ) values (
            p_organization_id,
            p_business_id,
            p_slug,
            p_display_name,
            p_summary,
            p_website_url,
            actor_id,
            actor_id
        );
    end if;
end;
$$;

create or replace function public.submit_directory_profile(
    p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_id uuid := auth.uid();
    target_profile public.directory_profiles%rowtype;
    submission_time timestamptz := timezone('utc', now());
    history_action public.directory_profile_history_action;
begin
    if actor_id is null then
        raise insufficient_privilege using message = 'Authentication is required.';
    end if;

    if not public.is_organization_admin(p_organization_id) then
        raise insufficient_privilege using
            message = 'Organization owner or admin permission is required.';
    end if;

    select dp.*
    into target_profile
    from public.directory_profiles dp
    where dp.organization_id = p_organization_id
    for update;

    if not found then
        raise no_data_found using message = 'Directory profile not found.';
    end if;

    if target_profile.status not in (
        'draft'::public.directory_profile_status,
        'correction_requested'::public.directory_profile_status
    ) then
        raise object_not_in_prerequisite_state using
            message = 'Directory profile cannot be submitted from its current status.';
    end if;

    -- Stable first-slice completeness only. Category/contact/media requirements
    -- remain deliberately outside this workflow until client confirmation.
    if target_profile.business_id is null
       or nullif(btrim(target_profile.slug), '') is null
       or nullif(btrim(target_profile.display_name), '') is null then
        raise check_violation using message = 'Directory profile is incomplete.';
    end if;

    history_action := case target_profile.status
        when 'correction_requested'::public.directory_profile_status
            then 'resubmitted'::public.directory_profile_history_action
        else 'submitted'::public.directory_profile_history_action
    end;

    update public.directory_profiles as profile
    set status = 'pending_review'::public.directory_profile_status,
        submitted_by_user_id = actor_id,
        submitted_at = submission_time,
        reviewed_by_user_id = null,
        reviewed_at = null,
        updated_by_user_id = actor_id
    where profile.id = target_profile.id;

    insert into public.directory_profile_history (
        profile_id,
        organization_id,
        actor_user_id,
        action,
        previous_status,
        new_status,
        reason
    ) values (
        target_profile.id,
        p_organization_id,
        actor_id,
        history_action,
        target_profile.status,
        'pending_review'::public.directory_profile_status,
        target_profile.workflow_reason
    );

    insert into public.audit_logs (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        p_organization_id,
        actor_id,
        'submit'::public.audit_action,
        'directory_profile',
        target_profile.id,
        jsonb_build_object(
            'workflow_action', history_action,
            'published_version_preserved', target_profile.published_version_id is not null
        )
    );
end;
$$;

revoke all on function public.submit_directory_profile(uuid)
from public, anon, authenticated;

grant execute on function public.submit_directory_profile(uuid)
to authenticated;

create or replace function public.review_directory_profile(
    p_actor_user_id uuid,
    p_profile_id uuid,
    p_action text,
    p_reason text default null
)
returns table (
    profile_id uuid,
    status public.directory_profile_status,
    published_version_id uuid,
    reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_profile public.directory_profiles%rowtype;
    target_organization_status public.organization_status;
    target_business_status public.business_status;
    normalized_reason text := nullif(btrim(p_reason), '');
    review_time timestamptz := timezone('utc', now());
    next_status public.directory_profile_status;
    history_action public.directory_profile_history_action;
    audit_action public.audit_action;
    new_version_id uuid;
    previous_published_version_id uuid;
    next_revision integer;
begin
    if p_actor_user_id is null or not exists (
        select 1 from auth.users u where u.id = p_actor_user_id
    ) then
        raise insufficient_privilege using message = 'A valid actor is required.';
    end if;

    if not exists (
        select 1
        from public.user_platform_roles upr
        where upr.user_id = p_actor_user_id
          and upr.role = 'admin'::public.platform_role
    ) then
        raise insufficient_privilege using
            message = 'Platform administrator permission is required.';
    end if;

    if p_action not in ('approve', 'request_correction', 'reject', 'suspend') then
        raise invalid_parameter_value using message = 'Invalid review action.';
    end if;

    if p_action in ('request_correction', 'reject', 'suspend')
       and normalized_reason is null then
        raise invalid_parameter_value using message = 'A reason is required.';
    end if;

    select dp.*
    into target_profile
    from public.directory_profiles dp
    where dp.id = p_profile_id
    for update;

    if not found then
        raise no_data_found using message = 'Directory profile not found.';
    end if;

    select o.status, b.status
    into target_organization_status, target_business_status
    from public.organizations o
    join public.businesses b
      on b.id = target_profile.business_id
     and b.organization_id = o.id
    where o.id = target_profile.organization_id;

    if p_action = 'approve' and exists (
        select 1
        from public.organization_members om
        where om.organization_id = target_profile.organization_id
          and om.user_id = p_actor_user_id
          and om.status = 'active'::public.membership_status
    ) then
        raise insufficient_privilege using
            message = 'An organization member cannot approve their own profile.';
    end if;

    if p_action = 'suspend' then
        if target_profile.status = 'suspended'::public.directory_profile_status then
            raise object_not_in_prerequisite_state using
                message = 'Directory profile is already suspended.';
        end if;
        next_status := 'suspended'::public.directory_profile_status;
        history_action := 'suspended'::public.directory_profile_history_action;
        audit_action := 'update'::public.audit_action;
    else
        if target_profile.status <> 'pending_review'::public.directory_profile_status then
            raise object_not_in_prerequisite_state using
                message = 'Directory profile is not pending review.';
        end if;

        next_status := case p_action
            when 'approve' then 'approved'::public.directory_profile_status
            when 'request_correction' then 'correction_requested'::public.directory_profile_status
            else 'rejected'::public.directory_profile_status
        end;
        history_action := case p_action
            when 'approve' then 'approved'::public.directory_profile_history_action
            when 'request_correction' then 'correction_requested'::public.directory_profile_history_action
            else 'rejected'::public.directory_profile_history_action
        end;
        audit_action := case p_action
            when 'approve' then 'approve'::public.audit_action
            when 'request_correction' then 'request_correction'::public.audit_action
            else 'reject'::public.audit_action
        end;
    end if;

    previous_published_version_id := target_profile.published_version_id;

    if p_action = 'approve' then
        if target_organization_status <> 'active'::public.organization_status
           or target_business_status <> 'active'::public.business_status
           or not public.is_business_ein_verified(target_profile.business_id) then
            raise object_not_in_prerequisite_state using
                message = 'Directory publication eligibility is not satisfied.';
        end if;

        select coalesce(max(dpv.revision_number), 0) + 1
        into next_revision
        from public.directory_profile_versions dpv
        where dpv.profile_id = target_profile.id;

        update public.directory_profile_versions
        set is_published = false
        where profile_id = target_profile.id
          and is_published;

        insert into public.directory_profile_versions (
            profile_id,
            revision_number,
            business_id,
            slug,
            display_name,
            summary,
            website_url,
            approved_by_user_id,
            approved_at,
            is_published,
            published_at
        ) values (
            target_profile.id,
            next_revision,
            target_profile.business_id,
            target_profile.slug,
            target_profile.display_name,
            target_profile.summary,
            target_profile.website_url,
            p_actor_user_id,
            review_time,
            true,
            review_time
        ) returning id into new_version_id;
    end if;

    update public.directory_profiles as profile
    set status = next_status,
        reviewed_by_user_id = p_actor_user_id,
        reviewed_at = review_time,
        workflow_reason = normalized_reason,
        approved_by_user_id = case
            when p_action = 'approve' then p_actor_user_id
            else approved_by_user_id
        end,
        approved_at = case
            when p_action = 'approve' then review_time
            else approved_at
        end,
        published_version_id = case
            when p_action = 'approve' then new_version_id
            else profile.published_version_id
        end
    where profile.id = target_profile.id;

    insert into public.directory_profile_history (
        profile_id,
        organization_id,
        actor_user_id,
        action,
        previous_status,
        new_status,
        reason,
        version_id
    ) values (
        target_profile.id,
        target_profile.organization_id,
        p_actor_user_id,
        history_action,
        target_profile.status,
        next_status,
        normalized_reason,
        new_version_id
    );

    if p_action = 'approve' and previous_published_version_id is not null then
        insert into public.directory_profile_history (
            profile_id,
            organization_id,
            actor_user_id,
            action,
            previous_status,
            new_status,
            version_id
        ) values (
            target_profile.id,
            target_profile.organization_id,
            p_actor_user_id,
            'published_revision_replaced'::public.directory_profile_history_action,
            target_profile.status,
            next_status,
            new_version_id
        );
    end if;

    insert into public.audit_logs (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        target_profile.organization_id,
        p_actor_user_id,
        audit_action,
        'directory_profile',
        target_profile.id,
        jsonb_build_object(
            'workflow_action', p_action,
            'previous_status', target_profile.status,
            'new_status', next_status,
            'published_version_id', new_version_id,
            'replaced_published_version_id', previous_published_version_id,
            'reason', normalized_reason
        )
    );

    return query
    select
        target_profile.id,
        next_status,
        case
            when p_action = 'approve' then new_version_id
            else previous_published_version_id
        end,
        review_time;
end;
$$;

revoke all on function public.review_directory_profile(uuid, uuid, text, text)
from public, anon, authenticated;

grant execute on function public.review_directory_profile(uuid, uuid, text, text)
to service_role;

-- Replace public lookup: it now reads the immutable published snapshot while
-- applying current suspension, tenant/business activity, and EIN eligibility.
create or replace function public.get_public_directory_profile(
    p_slug text
)
returns table (
    slug text,
    display_name text,
    summary text,
    website_url text,
    business_name text,
    verified boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        dpv.slug,
        dpv.display_name,
        dpv.summary,
        dpv.website_url,
        coalesce(b.dba_name, b.legal_name) as business_name,
        true as verified
    from public.directory_profiles dp
    join public.directory_profile_versions dpv
      on dpv.id = dp.published_version_id
     and dpv.profile_id = dp.id
     and dpv.is_published
    join public.organizations o
      on o.id = dp.organization_id
    join public.businesses b
      on b.id = dpv.business_id
     and b.organization_id = dp.organization_id
    where dpv.slug = lower(btrim(p_slug))
      and dp.status <> 'suspended'::public.directory_profile_status
      and o.status = 'active'::public.organization_status
      and b.status = 'active'::public.business_status
      and public.is_business_ein_verified(b.id)
    limit 1;
$$;

comment on table public.directory_profile_versions is
    'Immutable approved Directory snapshots; exactly one may be published per profile.';

comment on table public.directory_profile_history is
    'Append-only Directory workflow history written only by trusted RPCs.';

comment on function public.submit_directory_profile(uuid) is
    'Owner/admin submission or resubmission preserving any existing published snapshot.';

comment on function public.review_directory_profile(uuid, uuid, text, text) is
    'Service-role-only atomic Directory review, publication, suspension, history, and audit boundary.';

commit;
