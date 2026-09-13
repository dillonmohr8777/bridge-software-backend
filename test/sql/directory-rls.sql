-- Execute only against an isolated database after all migrations; always rolls back.
begin;
create function pg_temp.assert_directory(condition boolean, message text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Directory assertion failed: %', message; end if; end;
$$;
insert into auth.users(id) values ('d1111111-1111-4111-8111-111111111111'), ('d2222222-2222-4222-8222-222222222222'), ('d3333333-3333-4333-8333-333333333333');
update public.user_profiles set account_type = 'sales_rep' where id = 'd3333333-3333-4333-8333-333333333333';
insert into public.organizations(id,name,status,organization_type) values ('d4444444-4444-4444-8444-444444444444','Directory test org','active','brand');
insert into public.organization_members(organization_id,user_id,role,status) values
('d4444444-4444-4444-8444-444444444444','d1111111-1111-4111-8111-111111111111','owner','active'),
('d4444444-4444-4444-8444-444444444444','d2222222-2222-4222-8222-222222222222','member','active');
set local role authenticated;
select set_config('request.jwt.claim.sub','d1111111-1111-4111-8111-111111111111',true);
insert into public.directory_profiles(id,organization_id,slug,name) values
('d5555555-5555-4555-8555-555555555555','d4444444-4444-4444-8444-444444444444','directory-rls-test','Directory test');
select pg_temp.assert_directory((select visibility = 'private' from public.directory_profiles where id='d5555555-5555-4555-8555-555555555555'),'private default');
select pg_temp.assert_directory((select count(*)=1 from public.directory_profile_read where id='d5555555-5555-4555-8555-555555555555'),'owner sees draft');
select set_config('request.jwt.claim.sub','d2222222-2222-4222-8222-222222222222',true);
select pg_temp.assert_directory((select count(*)=0 from public.directory_profiles where id='d5555555-5555-4555-8555-555555555555'),'member cannot read managed base row');
select pg_temp.assert_directory((select count(*)=0 from public.directory_profile_read where id='d5555555-5555-4555-8555-555555555555'),'member cannot see draft');
with changed as (update public.directory_profiles set name='Hijacked' where id='d5555555-5555-4555-8555-555555555555' returning id)
select pg_temp.assert_directory((select count(*)=0 from changed),'member cannot update');
do $$ begin
    begin
        insert into public.directory_profiles(organization_id,slug,name) values ('d4444444-4444-4444-8444-444444444444','forbidden-profile','Forbidden');
        raise exception 'member insert unexpectedly allowed';
    exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','d1111111-1111-4111-8111-111111111111',true);
update public.directory_profiles set visibility='public' where id='d5555555-5555-4555-8555-555555555555';
do $$ begin
    begin
        update public.directory_profiles set owner_user_id='d1111111-1111-4111-8111-111111111111' where id='d5555555-5555-4555-8555-555555555555';
        raise exception 'ownership mutation unexpectedly allowed';
    exception when insufficient_privilege then null; end;
end $$;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.assert_directory((select count(*)=1 from public.directory_profile_read where id='d5555555-5555-4555-8555-555555555555' and visibility='public' and verified=false),'anon sees published unverified projection');
do $$ begin
    begin perform * from public.directory_profiles; raise exception 'anon base read unexpectedly allowed';
    exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','d3333333-3333-4333-8333-333333333333',true);
insert into public.directory_profiles(owner_user_id,slug,name,visibility) values ('d3333333-3333-4333-8333-333333333333','directory-rep-test','Rep test','public');
select pg_temp.assert_directory((select role='sales_rep' and verified=false from public.directory_profile_read where slug='directory-rep-test'),'sales rep role derived, unverified');
reset role;
update public.organization_members set status='suspended' where user_id='d1111111-1111-4111-8111-111111111111';
set local role authenticated;
select set_config('request.jwt.claim.sub','d1111111-1111-4111-8111-111111111111',true);
with changed as (update public.directory_profiles set name='Suspended update' where id='d5555555-5555-4555-8555-555555555555' returning id)
select pg_temp.assert_directory((select count(*)=0 from changed),'suspended owner cannot update');
reset role;
update public.organizations set status='suspended' where id='d4444444-4444-4444-8444-444444444444';
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.assert_directory((select count(*)=0 from public.directory_profile_read where id='d5555555-5555-4555-8555-555555555555'),'suspended org no longer public');
rollback;
