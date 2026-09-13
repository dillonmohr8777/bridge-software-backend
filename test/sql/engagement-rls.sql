-- Isolated database only; run after all migrations as migration owner. Always rolls back.
begin;
create function pg_temp.assert_engagement(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Engagement assertion failed: %', label; end if; end $$;
insert into auth.users(id) values ('e1111111-1111-4111-8111-111111111111'),('e2222222-2222-4222-8222-222222222222'),('e3333333-3333-4333-8333-333333333333');
insert into public.user_platform_roles(user_id,role) values ('e3333333-3333-4333-8333-333333333333','admin');
insert into public.organizations(id,name,status,organization_type) values ('e4444444-4444-4444-8444-444444444444','Engagement org','active','brand');
insert into public.organization_members(organization_id,user_id,role,status) values ('e4444444-4444-4444-8444-444444444444','e1111111-1111-4111-8111-111111111111','owner','active');
insert into public.directory_profiles(id,organization_id,slug,name,visibility) values ('e5555555-5555-4555-8555-555555555555','e4444444-4444-4444-8444-444444444444','engagement-test','Engagement','public');
set local role authenticated;
select set_config('request.jwt.claim.sub','e1111111-1111-4111-8111-111111111111',true);
insert into public.engagement_posts(profile_id,type,title,body) values ('e5555555-5555-4555-8555-555555555555','news','Draft','Draft body');
do $$ begin
    begin update public.engagement_posts set status='published'; raise exception 'unverified publication allowed';
    exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','e2222222-2222-4222-8222-222222222222',true);
select pg_temp.assert_engagement((select count(*)=0 from public.engagement_posts),'foreign user cannot read drafts');
with changed as (update public.engagement_posts set title='Hijacked' returning id)
select pg_temp.assert_engagement((select count(*)=0 from changed),'foreign user cannot edit');
reset role;
insert into public.businesses(id,organization_id,legal_name) values ('e6666666-6666-4666-8666-666666666666','e4444444-4444-4444-8444-444444444444','Engagement business');
insert into public.verification_cases(id,organization_id,business_id,status,completed_at) values ('e7777777-7777-4777-8777-777777777777','e4444444-4444-4444-8444-444444444444','e6666666-6666-4666-8666-666666666666','approved',now());
insert into public.verification_items(verification_case_id,item_type,status,reviewed_by_user_id,reviewed_at)
values ('e7777777-7777-4777-8777-777777777777','ein','verified','e3333333-3333-4333-8333-333333333333',now()),('e7777777-7777-4777-8777-777777777777','cannabis_license','verified','e3333333-3333-4333-8333-333333333333',now());
insert into public.verification_item_history(verification_item_id,new_status,action,actor_user_id)
select id,'verified','approved','e3333333-3333-4333-8333-333333333333' from public.verification_items where verification_case_id='e7777777-7777-4777-8777-777777777777';
insert into public.audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
select 'e4444444-4444-4444-8444-444444444444','e3333333-3333-4333-8333-333333333333','approve','verification_item',id,'{"verification_case_id":"e7777777-7777-4777-8777-777777777777","new_status":"verified"}'::jsonb from public.verification_items where verification_case_id='e7777777-7777-4777-8777-777777777777';
set local role authenticated;
select set_config('request.jwt.claim.sub','e1111111-1111-4111-8111-111111111111',true);
select pg_temp.assert_engagement((select verified from public.directory_profile_read where id='e5555555-5555-4555-8555-555555555555'),'fixture has full trusted verification');
update public.engagement_posts set status='published';
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.assert_engagement((select count(*)=1 from public.engagement_public_posts),'verified post is public');
reset role;
update public.verification_cases set status='draft' where id='e7777777-7777-4777-8777-777777777777';
set local role anon;
select pg_temp.assert_engagement((select count(*)=0 from public.engagement_public_posts),'revoked verification hides existing post');
reset role;
update public.verification_cases set status='approved' where id='e7777777-7777-4777-8777-777777777777';
set local role authenticated;
select set_config('request.jwt.claim.sub','e2222222-2222-4222-8222-222222222222',true);
insert into public.engagement_saved_profiles(user_id,profile_id) values ('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555') on conflict (user_id,profile_id) do nothing;
insert into public.engagement_saved_profiles(user_id,profile_id) values ('e2222222-2222-4222-8222-222222222222','e5555555-5555-4555-8555-555555555555') on conflict (user_id,profile_id) do nothing;
select pg_temp.assert_engagement((select count(*)=1 from public.engagement_saved_profile_read),'duplicate save persists once');
do $$ begin
    begin insert into public.engagement_saved_profiles(user_id,profile_id) values ('e1111111-1111-4111-8111-111111111111','e5555555-5555-4555-8555-555555555555'); raise exception 'foreign save allowed';
    exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','e1111111-1111-4111-8111-111111111111',true);
select pg_temp.assert_engagement((select count(*)=0 from public.engagement_saved_profile_read),'saves private per user');
update public.directory_profiles set visibility='private' where id='e5555555-5555-4555-8555-555555555555';
select set_config('request.jwt.claim.sub','e2222222-2222-4222-8222-222222222222',true);
select pg_temp.assert_engagement((select count(*)=0 from public.engagement_saved_profile_read),'private profile disappears from saves');
select pg_temp.assert_engagement((select count(*)=0 from public.engagement_public_posts),'private profile hides published post');
delete from public.engagement_saved_profiles where profile_id='e5555555-5555-4555-8555-555555555555';
delete from public.engagement_saved_profiles where profile_id='e5555555-5555-4555-8555-555555555555';
reset role;
insert into public.engagement_notifications(id,user_id,title,body) values ('e8888888-8888-4888-8888-888888888888','e1111111-1111-4111-8111-111111111111','Trusted producer','Private body');
set local role authenticated;
select set_config('request.jwt.claim.sub','e2222222-2222-4222-8222-222222222222',true);
select pg_temp.assert_engagement((select count(*)=0 from public.engagement_notifications),'foreign notifications hidden');
with changed as (update public.engagement_notifications set read_at=now() returning id)
select pg_temp.assert_engagement((select count(*)=0 from changed),'foreign notification update denied');
do $$ begin
    begin insert into public.engagement_notifications(user_id,title,body) values ('e2222222-2222-4222-8222-222222222222','Forged','Body'); raise exception 'user notification creation allowed';
    exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','e1111111-1111-4111-8111-111111111111',true);
update public.engagement_notifications set read_at=now() where id='e8888888-8888-4888-8888-888888888888';
select pg_temp.assert_engagement((select read_at is not null from public.engagement_notifications where id='e8888888-8888-4888-8888-888888888888'),'owner marks read');
do $$ begin
    begin update public.engagement_notifications set body='Forged'; raise exception 'notification content writable';
    exception when insufficient_privilege then null; end;
end $$;
rollback;
