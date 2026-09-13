-- Directory MVP. Apply through the normal migration approval process only.
create table public.directory_profiles (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid references public.organizations(id) on delete cascade,
    owner_user_id uuid references auth.users(id) on delete cascade,
    slug text not null unique check (length(slug) between 3 and 80 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and slug <> 'mine' and slug !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    name text not null check (length(btrim(name)) between 1 and 200),
    company_name text not null default '' check (length(company_name) <= 200),
    description text not null default '' check (length(description) <= 5000),
    location text not null default '' check (length(location) <= 200),
    state text not null default '' check (state = '' or state ~ '^[A-Z]{2}$'),
    service_territories text[] not null default '{}',
    products text[] not null default '{}',
    categories text[] not null default '{}',
    logo_url text check (logo_url is null or (length(logo_url) <= 2048 and logo_url ~ '^https://[^/@?#[:space:]]+([/?#][^[:space:]]*)?$')),
    visibility text not null default 'private' check (visibility in ('private', 'public')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check ((organization_id is null) <> (owner_user_id is null)),
    unique (organization_id),
    unique (owner_user_id)
);

-- Reuse existing owner/admin membership helper; additionally require active org.
create function public.can_manage_directory(target_organization_id uuid, target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select case when target_organization_id is not null then
        public.is_organization_admin(target_organization_id) and exists (
            select 1 from public.organizations o where o.id = target_organization_id and o.status = 'active'
        )
    else target_user_id = (select auth.uid()) and exists (
        select 1 from public.user_profiles p where p.id = target_user_id and p.account_type = 'sales_rep'
    ) end;
$$;
revoke all on function public.can_manage_directory(uuid, uuid) from public, anon;
grant execute on function public.can_manage_directory(uuid, uuid) to authenticated;

alter table public.directory_profiles enable row level security;
revoke all on public.directory_profiles from public, anon, authenticated;
grant select, insert on public.directory_profiles to authenticated;
-- Identity, timestamps and derived classifications are not editable by clients.
grant update (slug, name, company_name, description, location, state, service_territories, products, categories, logo_url, visibility) on public.directory_profiles to authenticated;
create policy directory_select_managed on public.directory_profiles for select to authenticated
using (public.can_manage_directory(organization_id, owner_user_id));
create policy directory_insert_managed on public.directory_profiles for insert to authenticated
with check (public.can_manage_directory(organization_id, owner_user_id));
create policy directory_update_managed on public.directory_profiles for update to authenticated
using (public.can_manage_directory(organization_id, owner_user_id))
with check (public.can_manage_directory(organization_id, owner_user_id));

create function public.validate_directory_profile() returns trigger language plpgsql set search_path = '' as $$
begin
    if cardinality(new.service_territories) > 60 or exists (select 1 from unnest(new.service_territories) x where x is null or x !~ '^[A-Z]{2}$')
       or cardinality(new.products) > 30 or exists (select 1 from unnest(new.products) x where x is null or length(btrim(x)) not between 1 and 100)
       or cardinality(new.categories) > 30 or exists (select 1 from unnest(new.categories) x where x is null or length(btrim(x)) not between 1 and 100) then
        raise exception 'Invalid directory values' using errcode = '23514';
    end if;
    if tg_op = 'INSERT' then
        new.created_at = now();
        new.updated_at = now();
    else
        if new.id <> old.id or new.organization_id is distinct from old.organization_id or new.owner_user_id is distinct from old.owner_user_id then
            raise exception 'Directory ownership is immutable' using errcode = '23514';
        end if;
        new.updated_at = now();
    end if;
    return new;
end;
$$;
revoke all on function public.validate_directory_profile() from public, anon, authenticated;
create trigger directory_validate before insert or update on public.directory_profiles for each row execute function public.validate_directory_profile();
create index directory_profiles_public_state on public.directory_profiles(state, id) where visibility = 'public';

-- Intentional definer view: explicit safe columns and visibility predicate allow
-- anonymous reads without granting access to organizations, users or verification.
-- Never expose owner IDs, email, phone, EIN, case IDs, documents or review notes.
create view public.directory_profile_read with (security_barrier = true) as
select d.id, d.slug,
    case when d.organization_id is null then 'sales_rep' else o.organization_type::text end as role,
    d.name, d.company_name, d.description, d.location, d.state,
    d.service_territories, d.products, d.categories, d.logo_url, d.visibility,
    coalesce((
        select vc.status = 'approved' and b.status = 'active'
            and (select count(distinct vi.item_type) = 2
                from public.verification_items vi
                join public.user_platform_roles pr on pr.user_id = vi.reviewed_by_user_id and pr.role = 'admin'
                where vi.verification_case_id = vc.id
                  and vi.item_type in ('ein', 'cannabis_license')
                  and vi.status = 'verified' and vi.reviewed_at is not null
                  and (select h.new_status = 'verified' and h.actor_user_id = vi.reviewed_by_user_id
                       from public.verification_item_history h where h.verification_item_id = vi.id
                       order by h.created_at desc, h.id desc limit 1)
                  and exists (select 1 from public.audit_logs a
                       where a.entity_type = 'verification_item' and a.entity_id = vi.id
                         and a.organization_id = vc.organization_id and a.actor_user_id = vi.reviewed_by_user_id
                         and a.metadata->>'verification_case_id' = vc.id::text
                         and a.metadata->>'new_status' = 'verified'))
        from public.verification_cases vc
        join public.businesses b on b.id = vc.business_id and b.organization_id = vc.organization_id
        where vc.organization_id = d.organization_id
        order by vc.created_at desc, vc.id desc limit 1
    ), false) as verified,
    concat_ws(' ', d.name, d.company_name, d.description, d.location, d.state,
        array_to_string(d.products, ' '), array_to_string(d.categories, ' '), array_to_string(d.service_territories, ' ')) as search_text,
    d.created_at, d.updated_at
from public.directory_profiles d
left join public.organizations o on o.id = d.organization_id
where (d.organization_id is null or (o.status = 'active' and o.organization_type is not null))
  and (d.owner_user_id is null or exists (select 1 from public.user_profiles p where p.id = d.owner_user_id and p.account_type = 'sales_rep'))
  and (d.visibility = 'public' or (
      (select auth.uid()) is not null and (
          (d.owner_user_id = (select auth.uid())) or exists (
              select 1 from public.organization_members om
              where om.organization_id = d.organization_id and om.user_id = (select auth.uid())
                and om.status = 'active' and om.role in ('owner', 'admin')
          )
      )
  ));
revoke all on public.directory_profile_read from public, anon, authenticated;
grant select on public.directory_profile_read to anon, authenticated;
comment on view public.directory_profile_read is 'Safe directory projection. Verified means latest organization case approved plus EIN and cannabis license verified by platform admins. Personal verification is not modeled and remains false.';



