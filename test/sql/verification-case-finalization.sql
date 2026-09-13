-- Isolated database only; run after all migrations as migration owner. Always rolls back.
begin;
create function pg_temp.assert_finalization(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Finalization assertion failed: %', label; end if; end $$;

insert into auth.users(id) values
('a1111111-1111-4111-8111-111111111111'),
('a2222222-2222-4222-8222-222222222222');
insert into public.user_platform_roles(user_id,role)
values ('a2222222-2222-4222-8222-222222222222','admin');
insert into public.organizations(id,name,status,organization_type)
values ('a3333333-3333-4333-8333-333333333333','Finalization fixture','active','brand');
insert into public.organization_members(organization_id,user_id,role,status)
values ('a3333333-3333-4333-8333-333333333333','a1111111-1111-4111-8111-111111111111','owner','active');
insert into public.businesses(id,organization_id,legal_name,status)
values ('a4444444-4444-4444-8444-444444444444','a3333333-3333-4333-8333-333333333333','Finalized business','active');
insert into public.verification_cases(id,organization_id,business_id)
values ('a5555555-5555-4555-8555-555555555555','a3333333-3333-4333-8333-333333333333','a4444444-4444-4444-8444-444444444444');
insert into public.verification_items(id,verification_case_id,item_type) values
('a6666666-6666-4666-8666-666666666666','a5555555-5555-4555-8555-555555555555','ein'),
('a7777777-7777-4777-8777-777777777777','a5555555-5555-4555-8555-555555555555','cannabis_license');
insert into public.directory_profiles(id,organization_id,slug,name,visibility)
values ('a8888888-8888-4888-8888-888888888888','a3333333-3333-4333-8333-333333333333','finalization-fixture','Finalization fixture','public');
insert into public.engagement_posts(id,profile_id,type,title,body)
values ('a9999999-9999-4999-8999-999999999999','a8888888-8888-4888-8888-888888888888','news','Ready','Ready to publish');

set local role service_role;
select * from public.review_admin_verification_item(
    'a2222222-2222-4222-8222-222222222222',
    'a6666666-6666-4666-8666-666666666666',
    'verified', null
);
reset role;
select pg_temp.assert_finalization(
    (select status = 'draft' from public.verification_cases where id = 'a5555555-5555-4555-8555-555555555555'),
    'one required item does not approve the case'
);
select pg_temp.assert_finalization(
    not (select verified from public.directory_profile_read where id = 'a8888888-8888-4888-8888-888888888888'),
    'one required item does not grant a badge'
);

set local role service_role;
select * from public.review_admin_verification_item(
    'a2222222-2222-4222-8222-222222222222',
    'a7777777-7777-4777-8777-777777777777',
    'verified', null
);
reset role;
select pg_temp.assert_finalization(
    (select status = 'approved' and completed_at is not null from public.verification_cases where id = 'a5555555-5555-4555-8555-555555555555'),
    'second trusted approval completes the case'
);
select pg_temp.assert_finalization(
    (select verified from public.directory_profile_read where id = 'a8888888-8888-4888-8888-888888888888'),
    'completed case grants the verified badge'
);
select pg_temp.assert_finalization(
    (select count(*) = 1 from public.audit_logs where entity_type = 'verification_case' and entity_id = 'a5555555-5555-4555-8555-555555555555' and action = 'approve'),
    'case approval is audited once'
);

set local role authenticated;
select set_config('request.jwt.claim.sub','a1111111-1111-4111-8111-111111111111',true);
update public.engagement_posts set status = 'published'
where id = 'a9999999-9999-4999-8999-999999999999';
select pg_temp.assert_finalization(
    (select status = 'published' from public.engagement_posts where id = 'a9999999-9999-4999-8999-999999999999'),
    'verified owner can publish Phase 5 content'
);
rollback;
