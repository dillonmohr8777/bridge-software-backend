begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','owner-a@example.test'),
 ('22222222-2222-4222-8222-222222222222','owner-b@example.test'),
 ('33333333-3333-4333-8333-333333333333','outsider@example.test'),
 ('44444444-4444-4444-8444-444444444444','manager@example.test');
insert into public.organizations(id,name,organization_type) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Fixture A','brand'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture B','brand');
insert into public.organization_members(organization_id,user_id,role,status) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner','active'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','owner','active'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444','page_manager','active');
insert into public.businesses(id,organization_id,legal_name) values
 ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Fixture A LLC'),
 ('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture B LLC');
insert into public.directory_profiles(id,organization_id,business_id,slug,display_name,business_type,created_by_user_id,updated_by_user_id) values
 ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','fixture-a','Fixture A','brand','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb','fixture-b','Fixture B','brand','22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222');
insert into public.contact_requests(id,sender_user_id,sender_organization_id,target_profile_id,target_organization_id,target_slug,target_display_name,routing_status,first_name,work_email,phone_number,years_of_service,contact_preference) values
 ('cccccccc-1111-4111-8111-cccccccccccc','22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture-a','Fixture A','routed','Synthetic','sender@example.test','555-010-1000',2,'email');
select ok((select relrowsecurity from pg_class where oid='public.contact_requests'::regclass),'contact requests have RLS');
select ok(not has_table_privilege('authenticated','public.contact_requests','UPDATE'),'authenticated cannot directly mutate contact requests');
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select is((select count(*) from public.contact_requests),1::bigint,'target owner reads inbound row through RLS');
select is((select count(*) from public.list_inbound_contact_requests('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),1::bigint,'target owner reads own inbox RPC');
select throws_ok($$select * from public.list_inbound_contact_requests('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')$$,'42501',null,'owner cannot read another organization inbox');
set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
select is((select count(*) from public.contact_requests),0::bigint,'unrelated authenticated user reads no contact data');
select throws_ok($$select * from public.transition_contact_request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-1111-4111-8111-cccccccccccc','responded')$$,'42501',null,'unrelated user cannot transition contact request');
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select is((select count(*) from public.list_sent_contact_requests()),1::bigint,'sender reads sent projection');
select throws_ok($$select * from public.transition_contact_request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-1111-4111-8111-cccccccccccc','closed')$$,'42501',null,'sender cannot close another organization request');
set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
select lives_ok($$select public.upsert_directory_profile('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','fixture-a','Edited by manager',null,null,'brand','[]',null,null,null,null,null,null,null,'[]')$$,'page manager edits own existing profile');
select throws_ok($$select public.upsert_directory_profile('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb','fixture-b','Cross tenant',null,null,'brand','[]',null,null,null,null,null,null,null,'[]')$$,'42501',null,'page manager cannot edit another tenant profile');
reset role;
select is((select display_name from public.directory_profiles where id='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'),'Fixture B','other tenant profile remains unchanged');
select * from finish();
rollback;
