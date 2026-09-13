-- Early Engagement foundation. Apply only after directory_mvp through approved migration workflow.
create function public.can_manage_engagement_profile(profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.directory_profiles d where d.id = profile_id
        and public.can_manage_directory(d.organization_id, d.owner_user_id));
$$;
revoke all on function public.can_manage_engagement_profile(uuid) from public, anon;
grant execute on function public.can_manage_engagement_profile(uuid) to authenticated;

create table public.engagement_posts (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null references public.directory_profiles(id) on delete cascade,
    type text not null check (type in ('announcement', 'news')),
    title text not null check (length(btrim(title)) between 1 and 200),
    body text not null check (length(btrim(body)) between 1 and 10000),
    status text not null default 'draft' check (status in ('draft', 'published')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
alter table public.engagement_posts enable row level security;
revoke all on public.engagement_posts from public, anon, authenticated;
grant select on public.engagement_posts to authenticated;
grant insert (profile_id, type, title, body, status) on public.engagement_posts to authenticated;
grant update (type, title, body, status) on public.engagement_posts to authenticated;
create policy posts_managed_read on public.engagement_posts for select to authenticated using (public.can_manage_engagement_profile(profile_id));
create policy posts_managed_insert on public.engagement_posts for insert to authenticated with check (public.can_manage_engagement_profile(profile_id));
create policy posts_managed_update on public.engagement_posts for update to authenticated using (public.can_manage_engagement_profile(profile_id)) with check (public.can_manage_engagement_profile(profile_id));
create function public.validate_engagement_post() returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'UPDATE' and (new.id <> old.id or new.profile_id <> old.profile_id) then
        raise exception 'Post identity is immutable' using errcode = '42501';
    end if;
    if new.status = 'published' and not exists (
        select 1 from public.directory_profile_read d where d.id = new.profile_id and d.visibility = 'public' and d.verified
    ) then raise exception 'Verified public profile required' using errcode = '42501'; end if;
    if tg_op = 'INSERT' then new.created_at = now(); else new.created_at = old.created_at; end if;
    new.updated_at = now();
    return new;
end;
$$;
revoke all on function public.validate_engagement_post() from public, anon, authenticated;
create trigger engagement_post_validate before insert or update on public.engagement_posts for each row execute function public.validate_engagement_post();
create index engagement_posts_profile_date on public.engagement_posts(profile_id, created_at desc, id);
create view public.engagement_public_posts with (security_barrier = true) as
select p.id, p.profile_id, p.type, p.title, p.body, p.status, p.created_at, p.updated_at
from public.engagement_posts p join public.directory_profile_read d on d.id = p.profile_id
where p.status = 'published' and d.visibility = 'public' and d.verified;
revoke all on public.engagement_public_posts from public, anon, authenticated;
grant select on public.engagement_public_posts to anon, authenticated;

create table public.engagement_saved_profiles (
    user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
    profile_id uuid not null references public.directory_profiles(id) on delete cascade,
    saved_at timestamptz not null default now(),
    primary key (user_id, profile_id)
);
alter table public.engagement_saved_profiles enable row level security;
revoke all on public.engagement_saved_profiles from public, anon, authenticated;
grant select, delete on public.engagement_saved_profiles to authenticated;
grant insert (user_id, profile_id) on public.engagement_saved_profiles to authenticated;
create policy saved_own_read on public.engagement_saved_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy saved_own_delete on public.engagement_saved_profiles for delete to authenticated using (user_id = (select auth.uid()));
create policy saved_own_insert on public.engagement_saved_profiles for insert to authenticated with check (
    user_id = (select auth.uid()) and exists (select 1 from public.directory_profile_read d where d.id = profile_id and d.visibility = 'public')
);
create view public.engagement_saved_profile_read with (security_barrier = true) as
select s.profile_id, s.saved_at from public.engagement_saved_profiles s
join public.directory_profile_read d on d.id = s.profile_id
where s.user_id = (select auth.uid()) and d.visibility = 'public';
revoke all on public.engagement_saved_profile_read from public, anon, authenticated;
grant select on public.engagement_saved_profile_read to authenticated;

-- Internal trusted producers only. No user-facing creation endpoint or INSERT grant.
create table public.engagement_notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    type text not null default 'system' check (type = 'system'),
    title text not null check (length(btrim(title)) between 1 and 200),
    body text not null check (length(body) <= 5000),
    created_at timestamptz not null default now(),
    read_at timestamptz
);
alter table public.engagement_notifications enable row level security;
revoke all on public.engagement_notifications from public, anon, authenticated;
grant select on public.engagement_notifications to authenticated;
grant update (read_at) on public.engagement_notifications to authenticated;
create policy notifications_own_read on public.engagement_notifications for select to authenticated using (user_id = (select auth.uid()));
create policy notifications_own_update on public.engagement_notifications for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create index engagement_notifications_user_date on public.engagement_notifications(user_id, created_at desc, id);
