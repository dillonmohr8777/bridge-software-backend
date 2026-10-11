-- ============================================================================
-- BRIDGE — MILESTONE 4.5
-- Private Directory logo storage with working/published version separation
-- ============================================================================

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'directory-media',
    'directory-media',
    false,
    2097152,
    array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.directory_profiles
    add column logo_storage_path text;

alter table public.directory_profile_versions
    add column logo_storage_path text;

-- Direct table mutation remains unavailable because authenticated users have
-- only the explicit column grants established by the profile migration.
create or replace function public.set_directory_profile_logo(
    p_organization_id uuid,
    p_logo_storage_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_profile public.directory_profiles%rowtype;
    expected_prefix text;
begin
    if auth.uid() is null or not public.is_organization_admin(p_organization_id) then
        raise insufficient_privilege using message = 'Organization owner or admin permission is required.';
    end if;

    select dp.* into target_profile
    from public.directory_profiles dp
    where dp.organization_id = p_organization_id
    for update;

    if not found then
        raise no_data_found using message = 'Directory profile not found.';
    end if;

    expected_prefix := p_organization_id::text || '/' || target_profile.id::text || '/logo/';
    if p_logo_storage_path is not null and (
        p_logo_storage_path not like expected_prefix || '%'
        or p_logo_storage_path !~ ('^' || expected_prefix ||
            '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$')
    ) then
        raise invalid_parameter_value using message = 'Directory logo path is invalid.';
    end if;

    update public.directory_profiles dp
    set logo_storage_path = p_logo_storage_path,
        updated_by_user_id = auth.uid()
    where dp.id = target_profile.id;
end;
$$;

revoke all on function public.set_directory_profile_logo(uuid, text)
from public, anon, authenticated;
grant execute on function public.set_directory_profile_logo(uuid, text)
to authenticated;

create or replace function public.prepare_directory_logo_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.logo_storage_path is distinct from old.logo_storage_path then
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
    return new;
end;
$$;

create trigger directory_profiles_prepare_logo_update
before update of logo_storage_path on public.directory_profiles
for each row execute function public.prepare_directory_logo_update();

-- The trusted approval RPC already inserts the snapshot atomically. This
-- trigger copies the working logo into that immutable snapshot in the same
-- transaction without widening the RPC's caller permissions.
create or replace function public.copy_directory_logo_to_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    select dp.logo_storage_path into new.logo_storage_path
    from public.directory_profiles dp
    where dp.id = new.profile_id;
    return new;
end;
$$;

create trigger directory_profile_versions_copy_logo
before insert on public.directory_profile_versions
for each row execute function public.copy_directory_logo_to_snapshot();

create or replace function public.get_directory_profile_logo_path(
    p_organization_id uuid
)
returns table (logo_storage_path text)
language sql
stable
security definer
set search_path = ''
as $$
    select dp.logo_storage_path
    from public.directory_profiles dp
    where dp.organization_id = p_organization_id
      and dp.logo_storage_path is not null
      and public.is_organization_member(p_organization_id)
    limit 1;
$$;

revoke all on function public.get_directory_profile_logo_path(uuid)
from public, anon, authenticated;
grant execute on function public.get_directory_profile_logo_path(uuid)
to authenticated;

create or replace function public.get_public_directory_profile_logo_path(
    p_slug text
)
returns table (logo_storage_path text)
language sql
stable
security definer
set search_path = ''
as $$
    select dpv.logo_storage_path
    from public.directory_profiles dp
    join public.directory_profile_versions dpv
      on dpv.id = dp.published_version_id
     and dpv.profile_id = dp.id
     and dpv.is_published
    join public.organizations o on o.id = dp.organization_id
    join public.businesses b
      on b.id = dpv.business_id
     and b.organization_id = dp.organization_id
    where dpv.slug = lower(btrim(p_slug))
      and dpv.logo_storage_path is not null
      and dp.status <> 'suspended'::public.directory_profile_status
      and o.status = 'active'::public.organization_status
      and b.status = 'active'::public.business_status
      and public.is_business_ein_verified(b.id)
    limit 1;
$$;

revoke all on function public.get_public_directory_profile_logo_path(text)
from public, anon, authenticated;
grant execute on function public.get_public_directory_profile_logo_path(text)
to service_role;

drop function public.get_public_directory_profile(text);
create function public.get_public_directory_profile(p_slug text)
returns table (
    slug text,
    display_name text,
    summary text,
    website_url text,
    business_name text,
    verified boolean,
    has_logo boolean
)
language sql stable security definer set search_path = ''
as $$
    select dpv.slug, dpv.display_name, dpv.summary, dpv.website_url,
        coalesce(b.dba_name, b.legal_name), true,
        dpv.logo_storage_path is not null
    from public.directory_profiles dp
    join public.directory_profile_versions dpv
      on dpv.id = dp.published_version_id and dpv.profile_id = dp.id and dpv.is_published
    join public.organizations o on o.id = dp.organization_id
    join public.businesses b on b.id = dpv.business_id and b.organization_id = dp.organization_id
    where dpv.slug = lower(btrim(p_slug))
      and dp.status <> 'suspended'::public.directory_profile_status
      and o.status = 'active'::public.organization_status
      and b.status = 'active'::public.business_status
      and public.is_business_ein_verified(b.id)
    limit 1;
$$;

grant execute on function public.get_public_directory_profile(text)
to anon, authenticated;

drop function public.list_public_directory_profiles(
    text, public.organization_type, text, text, text, integer
);
create function public.list_public_directory_profiles(
    p_query text default null,
    p_organization_type public.organization_type default null,
    p_sort text default 'name_asc',
    p_cursor_name text default null,
    p_cursor_slug text default null,
    p_limit integer default 21
)
returns table (
    slug text, display_name text, summary text, website_url text,
    business_name text, verified boolean, has_logo boolean, cursor_name text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
    normalized_query text := nullif(btrim(p_query), '');
    escaped_query text;
begin
    if p_sort not in ('name_asc', 'name_desc') then
        raise invalid_parameter_value using message = 'Unsupported Directory sort.';
    end if;
    if p_limit < 1 or p_limit > 51 then
        raise invalid_parameter_value using message = 'Directory page limit is invalid.';
    end if;
    if length(normalized_query) > 100 then
        raise invalid_parameter_value using message = 'Directory query is too long.';
    end if;
    if (p_cursor_name is null) <> (p_cursor_slug is null) then
        raise invalid_parameter_value using message = 'Directory cursor is incomplete.';
    end if;
    escaped_query := replace(replace(replace(normalized_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');

    return query
    select dpv.slug, dpv.display_name, dpv.summary, dpv.website_url,
        coalesce(b.dba_name, b.legal_name), true,
        dpv.logo_storage_path is not null, lower(dpv.display_name)
    from public.directory_profiles dp
    join public.directory_profile_versions dpv
      on dpv.id = dp.published_version_id and dpv.profile_id = dp.id and dpv.is_published
    join public.organizations o on o.id = dp.organization_id
    join public.businesses b on b.id = dpv.business_id and b.organization_id = dp.organization_id
    where dp.status <> 'suspended'::public.directory_profile_status
      and o.status = 'active'::public.organization_status
      and b.status = 'active'::public.business_status
      and public.is_business_ein_verified(b.id)
      and (p_organization_type is null or o.organization_type = p_organization_type)
      and (normalized_query is null
        or dpv.display_name ilike '%' || escaped_query || '%' escape E'\\'
        or coalesce(dpv.summary, '') ilike '%' || escaped_query || '%' escape E'\\'
        or b.legal_name ilike '%' || escaped_query || '%' escape E'\\'
        or coalesce(b.dba_name, '') ilike '%' || escaped_query || '%' escape E'\\')
      and (p_cursor_name is null
        or (p_sort = 'name_asc' and (lower(dpv.display_name), lower(dpv.slug)) > (p_cursor_name, p_cursor_slug))
        or (p_sort = 'name_desc' and (lower(dpv.display_name), lower(dpv.slug)) < (p_cursor_name, p_cursor_slug)))
    order by
      case when p_sort = 'name_asc' then lower(dpv.display_name) end asc,
      case when p_sort = 'name_asc' then lower(dpv.slug) end asc,
      case when p_sort = 'name_desc' then lower(dpv.display_name) end desc,
      case when p_sort = 'name_desc' then lower(dpv.slug) end desc
    limit p_limit;
end;
$$;

grant execute on function public.list_public_directory_profiles(
    text, public.organization_type, text, text, text, integer
) to anon, authenticated;

comment on column public.directory_profiles.logo_storage_path is
    'Private working logo object path; never returned by public Directory RPCs.';
comment on column public.directory_profile_versions.logo_storage_path is
    'Immutable approved logo object path copied at publication time.';

commit;
