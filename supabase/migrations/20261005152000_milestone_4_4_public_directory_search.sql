-- ============================================================================
-- BRIDGE — MILESTONE 4.4
-- Public Directory search with safe published snapshots and keyset pagination
-- ============================================================================

begin;

create index directory_profile_versions_published_name_cursor_idx
    on public.directory_profile_versions(lower(display_name), lower(slug))
    where is_published;

create or replace function public.list_public_directory_profiles(
    p_query text default null,
    p_organization_type public.organization_type default null,
    p_sort text default 'name_asc',
    p_cursor_name text default null,
    p_cursor_slug text default null,
    p_limit integer default 21
)
returns table (
    slug text,
    display_name text,
    summary text,
    website_url text,
    business_name text,
    verified boolean,
    cursor_name text
)
language plpgsql
stable
security definer
set search_path = ''
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

    -- Treat %, _, and backslash as text rather than caller-controlled LIKE syntax.
    escaped_query := replace(
        replace(replace(normalized_query, E'\\', E'\\\\'), '%', E'\\%'),
        '_',
        E'\\_'
    );

    return query
    select
        dpv.slug,
        dpv.display_name,
        dpv.summary,
        dpv.website_url,
        coalesce(b.dba_name, b.legal_name) as business_name,
        true as verified,
        lower(dpv.display_name) as cursor_name
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
    where dp.status <> 'suspended'::public.directory_profile_status
      and o.status = 'active'::public.organization_status
      and b.status = 'active'::public.business_status
      and public.is_business_ein_verified(b.id)
      and (p_organization_type is null or o.organization_type = p_organization_type)
      and (
          normalized_query is null
          or dpv.display_name ilike '%' || escaped_query || '%' escape E'\\'
          or coalesce(dpv.summary, '') ilike '%' || escaped_query || '%' escape E'\\'
          or b.legal_name ilike '%' || escaped_query || '%' escape E'\\'
          or coalesce(b.dba_name, '') ilike '%' || escaped_query || '%' escape E'\\'
      )
      and (
          p_cursor_name is null
          or (
              p_sort = 'name_asc'
              and (lower(dpv.display_name), lower(dpv.slug))
                  > (p_cursor_name, p_cursor_slug)
          )
          or (
              p_sort = 'name_desc'
              and (lower(dpv.display_name), lower(dpv.slug))
                  < (p_cursor_name, p_cursor_slug)
          )
      )
    order by
        case when p_sort = 'name_asc' then lower(dpv.display_name) end asc,
        case when p_sort = 'name_asc' then lower(dpv.slug) end asc,
        case when p_sort = 'name_desc' then lower(dpv.display_name) end desc,
        case when p_sort = 'name_desc' then lower(dpv.slug) end desc
    limit p_limit;
end;
$$;

revoke all on function public.list_public_directory_profiles(
    text,
    public.organization_type,
    text,
    text,
    text,
    integer
) from public;

grant execute on function public.list_public_directory_profiles(
    text,
    public.organization_type,
    text,
    text,
    text,
    integer
) to anon, authenticated;

comment on function public.list_public_directory_profiles(
    text,
    public.organization_type,
    text,
    text,
    text,
    integer
) is 'Safe public Directory listing over eligible immutable published snapshots.';

commit;
