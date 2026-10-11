-- ============================================================================
-- BRIDGE — MILESTONE 4.2
-- Persistent Directory business profiles and safe public projection
-- ============================================================================

begin;

create type public.directory_profile_status as enum (
    'draft',
    'pending_review',
    'approved',
    'suspended'
);

-- PostgreSQL requires a matching unique key for the composite foreign key
-- below. The business id remains globally unique; this additionally guarantees
-- that a profile cannot pair a business with a different organization.
alter table public.businesses
    add constraint businesses_id_organization_id_unique
    unique (id, organization_id);

create table public.directory_profiles (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null
        references public.organizations(id)
        on delete cascade,
    business_id uuid not null,
    slug text not null,
    display_name text not null,
    summary text,
    website_url text,
    status public.directory_profile_status not null default 'draft',
    created_by_user_id uuid not null
        references auth.users(id)
        on delete restrict,
    updated_by_user_id uuid not null
        references auth.users(id)
        on delete restrict,
    approved_by_user_id uuid
        references auth.users(id)
        on delete set null,
    approved_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),

    constraint directory_profiles_organization_unique
        unique (organization_id),
    constraint directory_profiles_business_organization_fk
        foreign key (business_id, organization_id)
        references public.businesses(id, organization_id)
        on delete restrict,
    constraint directory_profiles_slug_format
        check (
            char_length(slug) between 3 and 100
            and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        ),
    constraint directory_profiles_display_name_length
        check (char_length(display_name) between 1 and 200),
    constraint directory_profiles_summary_length
        check (summary is null or char_length(summary) <= 1000),
    constraint directory_profiles_website_url_format
        check (
            website_url is null
            or (
                char_length(website_url) <= 2048
                and website_url ~* '^https?://'
            )
        ),
    constraint directory_profiles_approval_metadata
        check (
            status <> 'approved'::public.directory_profile_status
            or (approved_by_user_id is not null and approved_at is not null)
        )
);

create unique index directory_profiles_slug_unique_idx
    on public.directory_profiles(lower(slug));

create index directory_profiles_business_id_idx
    on public.directory_profiles(business_id);

create index directory_profiles_status_idx
    on public.directory_profiles(status);

alter table public.directory_profiles enable row level security;

create policy directory_profiles_select_member
on public.directory_profiles
for select
to authenticated
using (
    public.is_organization_member(organization_id)
);

create policy directory_profiles_insert_admin
on public.directory_profiles
for insert
to authenticated
with check (
    public.is_organization_admin(organization_id)
    and created_by_user_id = (select auth.uid())
    and updated_by_user_id = (select auth.uid())
    and status = 'draft'::public.directory_profile_status
    and approved_by_user_id is null
    and approved_at is null
);

create policy directory_profiles_update_admin
on public.directory_profiles
for update
to authenticated
using (
    public.is_organization_admin(organization_id)
)
with check (
    public.is_organization_admin(organization_id)
    and updated_by_user_id = (select auth.uid())
);

-- Anonymous callers receive no direct table privileges. Authenticated users get
-- only the row/column operations needed for protected reads and owner/admin
-- editing; publication and approval fields remain backend-owned.
revoke all on table public.directory_profiles
from public, anon, authenticated;

grant select on table public.directory_profiles to authenticated;

grant insert (
    organization_id,
    business_id,
    slug,
    display_name,
    summary,
    website_url,
    created_by_user_id,
    updated_by_user_id
) on public.directory_profiles to authenticated;

grant update (
    business_id,
    slug,
    display_name,
    summary,
    website_url,
    updated_by_user_id
) on public.directory_profiles to authenticated;

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

    if old.status = 'approved'::public.directory_profile_status
       and new.business_id is distinct from old.business_id then
        raise object_not_in_prerequisite_state using
            message = 'The business association cannot change after approval.';
    end if;

    if old.status = 'approved'::public.directory_profile_status
       and (
           new.slug is distinct from old.slug
           or new.display_name is distinct from old.display_name
           or new.summary is distinct from old.summary
           or new.website_url is distinct from old.website_url
       ) then
        new.status := 'pending_review'::public.directory_profile_status;
        new.approved_by_user_id := null;
        new.approved_at := null;
    end if;

    new.updated_at := timezone('utc', now());
    return new;
end;
$$;

revoke all on function public.prepare_directory_profile_update()
from public, anon, authenticated;

create trigger directory_profiles_prepare_update
before update on public.directory_profiles
for each row
execute function public.prepare_directory_profile_update();

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
        if existing_profile.status = 'approved'::public.directory_profile_status
           and existing_profile.business_id is distinct from p_business_id then
            raise object_not_in_prerequisite_state using
                message = 'The business association cannot change after approval.';
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

revoke all on function public.upsert_directory_profile(
    uuid, uuid, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.upsert_directory_profile(
    uuid, uuid, text, text, text, text
) to authenticated;

-- The current trusted workflow permits both provider-backed EIN completion and
-- legitimate platform-admin manual review. The latest EIN item is therefore the
-- authoritative state; a provider-attempt row is deliberately not required.
create or replace function public.is_business_ein_verified(
    p_business_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce((
        select vi.status = 'verified'::public.verification_item_status
        from public.verification_cases vc
        join public.verification_items vi
          on vi.verification_case_id = vc.id
        where vc.business_id = p_business_id
          and vi.item_type = 'ein'::public.verification_item_type
        order by vc.created_at desc, vi.created_at desc, vi.id desc
        limit 1
    ), false);
$$;

revoke all on function public.is_business_ein_verified(uuid)
from public, anon, authenticated;

grant execute on function public.is_business_ein_verified(uuid)
to service_role;

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
        dp.slug,
        dp.display_name,
        dp.summary,
        dp.website_url,
        coalesce(b.dba_name, b.legal_name) as business_name,
        true as verified
    from public.directory_profiles dp
    join public.organizations o
      on o.id = dp.organization_id
    join public.businesses b
      on b.id = dp.business_id
     and b.organization_id = dp.organization_id
    where dp.slug = lower(btrim(p_slug))
      and dp.status = 'approved'::public.directory_profile_status
      and o.status = 'active'::public.organization_status
      and b.status = 'active'::public.business_status
      and public.is_business_ein_verified(b.id)
    limit 1;
$$;

revoke all on function public.get_public_directory_profile(text)
from public, anon, authenticated;

grant execute on function public.get_public_directory_profile(text)
to anon, authenticated, service_role;

comment on table public.directory_profiles is
    'Organization-owned Directory profile referencing an existing business verification subject.';

comment on function public.is_business_ein_verified(uuid) is
    'Central trusted EIN eligibility predicate using the latest business-scoped EIN verification item.';

comment on function public.get_public_directory_profile(text) is
    'Fixed safe public Directory projection gated by approval, active records, and trusted EIN verification.';

commit;
