\set ON_ERROR_STOP on
begin;
create schema test_support;
create function test_support.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; raise notice 'PASS: %',label; end $$;
create function test_support.throws(command text,expected text,label text) returns void language plpgsql as $$
begin
 begin execute command;
 exception when others then
   if sqlstate=expected then raise notice 'PASS: %',label; return; end if;
   raise exception 'FAILED: % expected %, got %: %',label,expected,sqlstate,sqlerrm;
 end;
 raise exception 'FAILED: % expected error %',label,expected;
end $$;
grant usage on schema test_support to authenticated,anon;
grant execute on all functions in schema test_support to authenticated,anon;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-000000000001','fixture1@example.test'),
('00000000-0000-4000-8000-000000000002','fixture2@example.test'),
('00000000-0000-4000-8000-000000000003','fixture3@example.test'),
('00000000-0000-4000-8000-000000000004','fixture4@example.test'),
('00000000-0000-4000-8000-000000000005','fixture5@example.test'),
('00000000-0000-4000-8000-000000000006','fixture6@example.test'),
('00000000-0000-4000-8000-000000000007','fixture7@example.test'),
('00000000-0000-4000-8000-000000000008','fixture8@example.test');
update public.user_profiles set account_type='sales_rep' where id in ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002');
insert into public.user_platform_roles(user_id,role) values ('00000000-0000-4000-8000-000000000006','admin'),('00000000-0000-4000-8000-000000000007','admin');
insert into public.organizations(id,name,organization_type) values
('00000000-0000-4000-8000-000000000011','First org','brand'),('00000000-0000-4000-8000-000000000012','Other org','brand'),('00000000-0000-4000-8000-000000000013','Sender org','retailer');
insert into public.organization_members(id,organization_id,user_id,role) values
('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','member'),
('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000002','member'),
('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000003','page_manager'),
('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000004','owner'),
('00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000005','owner'),
('00000000-0000-4000-8000-000000000108','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000008','owner');
insert into public.businesses(id,organization_id,legal_name) values
('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000011','First LLC'),('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000012','Other LLC');
insert into public.directory_profiles(id,organization_id,business_id,slug,display_name,created_by_user_id,updated_by_user_id) values
('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000021','first-business','First','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000004'),
('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000022','other-business','Other','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000005');
insert into public.directory_profile_contact_routing(profile_id,organization_id,sales_representative_membership_id,bridge_admin_user_id,updated_by_user_id)
values('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000004');
insert into public.contact_requests(id,sender_user_id,sender_organization_id,target_profile_id,target_organization_id,target_slug,target_display_name,routing_status,first_name,work_email,phone_number,years_of_service,contact_preference)
values
('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','first-business','Example','routed','Fixture','sender@example.test','+15555550100',1,'email'),
('00000000-0000-4000-8000-000000000042','00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','first-business','Example','routed','Fixture','sender@example.test','+15555550100',1,'email'),
('00000000-0000-4000-8000-000000000043','00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','first-business','Example','routed','Fixture','sender@example.test','+15555550100',1,'email'),
('00000000-0000-4000-8000-000000000044','00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','first-business','Example','routed','Fixture','sender@example.test','+15555550100',1,'email'),
('00000000-0000-4000-8000-000000000045','00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','first-business','Example','routed','Fixture','sender@example.test','+15555550100',1,'email'),
('00000000-0000-4000-8000-000000000046','00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000012','other-business','Example','routed','Fixture','sender@example.test','+15555550100',1,'email');
select test_support.ok((select routed_recipient_user_id='00000000-0000-4000-8000-000000000001' from public.contact_requests where id='00000000-0000-4000-8000-000000000041'),'configured rep is routed first');
update public.contact_requests set routed_recipient_user_id='00000000-0000-4000-8000-000000000002',routed_recipient_membership_id='00000000-0000-4000-8000-000000000102' where id='00000000-0000-4000-8000-000000000042';
update public.contact_requests set routed_recipient_user_id='00000000-0000-4000-8000-000000000006',routed_recipient_membership_id=null where id='00000000-0000-4000-8000-000000000043';
update public.contact_requests set routed_recipient_user_id='00000000-0000-4000-8000-000000000004',routed_recipient_membership_id='00000000-0000-4000-8000-000000000104' where id='00000000-0000-4000-8000-000000000044';
update public.contact_requests set routed_recipient_user_id=null,routed_recipient_membership_id=null,routing_status='needs_assignment' where id='00000000-0000-4000-8000-000000000045';

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select test_support.ok((select count(*)=1 from public.contact_requests),'assigned rep reads only its request through RLS');
select test_support.ok((select count(*)=1 from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000011')),'assigned rep inbox is row scoped');
select test_support.ok((select count(*)=1 from public.list_contact_inbox_organizations()),'rep discovers assigned org only');
select test_support.throws($q$select * from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000012')$q$,'42501','rep cannot list other tenant');
select test_support.throws($q$select * from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000042','viewed')$q$,'P0002','rep cannot mutate another rep request');
select test_support.throws($q$select * from public.transition_contact_request('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000041','viewed')$q$,'P0002','wrong organization/request pair denied');
select test_support.throws($q$update public.contact_requests set routed_recipient_user_id='00000000-0000-4000-8000-000000000001' where id='00000000-0000-4000-8000-000000000042'$q$,'42501','recipient cannot self assign through direct update');
select test_support.ok((select request_status='viewed' from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000041','viewed')),'assigned rep transitions own request');
select test_support.throws($q$select * from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000041','new')$q$,'55000','backward lifecycle transition denied');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000006',true);
select test_support.ok((select count(*)=1 from public.contact_requests),'assigned Bridge admin reads only assigned request');
select test_support.ok((select count(*)=1 from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000011')),'assigned Bridge admin inbox row scoped');
select test_support.ok((select count(*)=1 from public.list_contact_inbox_organizations()),'assigned Bridge admin discovers org without membership');
select test_support.throws($q$select * from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000041','closed')$q$,'P0002','Bridge admin cannot mutate unassigned request');
select test_support.ok((select request_status='responded' from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000043','responded')),'assigned Bridge admin transitions its request');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000007',true);
select test_support.ok((select count(*)=0 from public.contact_requests),'unrelated platform admin has no blanket RLS access');
select test_support.ok((select count(*)=0 from public.list_contact_inbox_organizations()),'unrelated platform admin sees no inbox orgs');
select test_support.throws($q$select * from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000011')$q$,'42501','unrelated platform admin cannot list org');
select test_support.throws($q$select * from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000043','closed')$q$,'P0002','unrelated platform admin cannot mutate request');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
select test_support.ok((select count(*)=0 from public.contact_requests),'page manager has no unassigned inbox access');
select test_support.throws($q$select * from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000011')$q$,'42501','page manager cannot list inbox');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
select test_support.ok((select count(*)=5 from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000011')),'owner retains full organization inbox including unassigned');
select test_support.ok((select request_status='closed' from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000045','closed')),'owner handles unassigned fallback');
select test_support.throws($q$select * from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000012')$q$,'42501','owner cannot list another tenant');
select test_support.throws($q$select * from public.list_inbound_contact_requests('00000000-0000-4000-8000-000000000011',null,52,0)$q$,'22023','lookahead pagination remains bounded');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000008',true);
select test_support.ok((select count(*)=6 from public.list_sent_contact_requests()),'sender retains own sent requests');
select test_support.throws($q$select * from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000041','closed')$q$,'P0002','sender cannot transition an inbound request');
reset role;

-- Membership, account type, and platform-role revocation are checked afresh.
update public.organization_members set status='suspended' where id='00000000-0000-4000-8000-000000000101';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select test_support.ok((select count(*)=0 from public.contact_requests),'suspended assigned rep loses RLS access');
select test_support.ok((select count(*)=0 from public.list_contact_inbox_organizations()),'suspended rep loses inbox discovery');
select test_support.throws($q$select * from public.transition_contact_request('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000041','closed')$q$,'P0002','suspended rep cannot transition');
reset role;
update public.organization_members set status='active' where id='00000000-0000-4000-8000-000000000101';
update public.user_profiles set account_type='standard' where id='00000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select test_support.ok((select count(*)=0 from public.contact_requests),'former sales rep loses recipient access');
reset role;
delete from public.user_platform_roles where user_id='00000000-0000-4000-8000-000000000006';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000006',true);
select test_support.ok((select count(*)=0 from public.contact_requests),'revoked platform admin loses assigned access');
reset role;

select test_support.ok((select count(*)=3 from public.contact_request_history),'only successful transitions append history');
select test_support.ok((select count(*)=3 from public.audit_logs where entity_type='contact_request'),'only successful transitions append audit');
select test_support.ok(not has_table_privilege('authenticated','public.contact_requests','update'),'direct request mutation not granted');
select test_support.ok(not has_function_privilege('anon','public.list_contact_inbox_organizations()','execute'),'anon cannot call discovery');
select test_support.ok(not has_function_privilege('anon','bridge_private.can_manage_contact_request(uuid,uuid,uuid)','execute'),'private helper not executable anonymously');

set local role anon;
select set_config('request.jwt.claim.sub','',true);
select test_support.throws($q$select * from public.contact_requests$q$,'42501','anonymous table read denied');
select test_support.throws($q$select * from public.list_contact_inbox_organizations()$q$,'42501','anonymous RPC denied');
reset role;
rollback;
