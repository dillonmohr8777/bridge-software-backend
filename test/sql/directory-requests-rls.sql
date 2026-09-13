-- Isolated PostgreSQL/Supabase schema only. All fixtures rolled back.
begin;
create function pg_temp.assert_request(condition boolean,message text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Request assertion failed: %',message; end if; end;
$$;
create temp table request_test_ids(label text primary key,id uuid);
grant select,insert on request_test_ids to authenticated;
insert into auth.users(id,email) values
('e1111111-1111-4111-8111-111111111111','owner@example.test'),
('e2222222-2222-4222-8222-222222222222','sender@example.test'),
('e3333333-3333-4333-8333-333333333333','member@example.test'),
('e4444444-4444-4444-8444-444444444444','admin@example.test');
insert into public.organizations(id,name,organization_type) values
('e5555555-5555-4555-8555-555555555555','Request org','brand'),('e6666666-6666-4666-8666-666666666666','Private org','brand');
insert into public.organization_members(organization_id,user_id,role,status) values
('e5555555-5555-4555-8555-555555555555','e1111111-1111-4111-8111-111111111111','owner','active'),
('e5555555-5555-4555-8555-555555555555','e3333333-3333-4333-8333-333333333333','member','active');
insert into public.user_platform_roles(user_id,role) values ('e4444444-4444-4444-8444-444444444444','admin');
insert into public.directory_profiles(id,organization_id,name,slug,visibility) values
('e7777777-7777-4777-8777-777777777777','e5555555-5555-4555-8555-555555555555','Public profile','request-public-test','public'),
('e8888888-8888-4888-8888-888888888888','e6666666-6666-4666-8666-666666666666','Private profile','request-private-test','private');
set local role authenticated;
select set_config('request.jwt.claim.sub','e2222222-2222-4222-8222-222222222222',true);
insert into request_test_ids values ('contact',public.submit_directory_request('e7777777-7777-4777-8777-777777777777','contact','Private contact body',true,'e9999999-9999-4999-8999-999999999999'));
select pg_temp.assert_request(public.submit_directory_request('e7777777-7777-4777-8777-777777777777','contact','Private contact body',true,'e9999999-9999-4999-8999-999999999999')=(select id from request_test_ids where label='contact'),'exact retry same ID');
insert into request_test_ids values ('claim',public.submit_directory_request('e7777777-7777-4777-8777-777777777777','claim','Private ownership evidence',false,'e9999999-9999-4999-8999-999999999999'));
select pg_temp.assert_request((select count(*)=2 from public.directory_request_read),'sender sees both own requests');
select pg_temp.assert_request((select reply_email='sender@example.test' and not can_review from public.directory_request_read where kind='contact'),'server-derived optional reply email');
select pg_temp.assert_request((select reply_email is null from public.directory_request_read where kind='claim'),'email opt-out');
do $$ begin
    begin perform public.submit_directory_request('e7777777-7777-4777-8777-777777777777','contact','Changed body',true,'e9999999-9999-4999-8999-999999999999'); raise exception 'mismatch accepted';
    exception when unique_violation then null; end;
    begin perform public.submit_directory_request('e8888888-8888-4888-8888-888888888888','contact','Private target',false,'ea999999-9999-4999-8999-999999999999'); raise exception 'private target accepted';
    exception when no_data_found then null; end;
    begin perform public.review_directory_request((select id from request_test_ids where label='contact'),'resolved'); raise exception 'sender reviewed contact';
    exception when no_data_found then null; end;
    begin update public.directory_requests set status='resolved'; raise exception 'direct status update accepted';
    exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','e3333333-3333-4333-8333-333333333333',true);
select pg_temp.assert_request((select count(*)=0 from public.directory_request_read),'ordinary member sees no body or email');
select set_config('request.jwt.claim.sub','e1111111-1111-4111-8111-111111111111',true);
select pg_temp.assert_request((select count(*)=1 from public.directory_request_read),'owner sees contact only, not claim');
select pg_temp.assert_request((select can_review from public.directory_request_read),'owner can review contact');
select public.review_directory_request((select id from request_test_ids where label='contact'),'resolved');
select public.review_directory_request((select id from request_test_ids where label='contact'),'resolved');
do $$ begin
    begin perform public.review_directory_request((select id from request_test_ids where label='claim'),'resolved'); raise exception 'owner reviewed own claim';
    exception when no_data_found then null; end;
    begin perform public.review_directory_request((select id from request_test_ids where label='contact'),'rejected'); raise exception 'terminal status changed';
    exception when unique_violation then null; end;
end $$;
select set_config('request.jwt.claim.sub','e4444444-4444-4444-8444-444444444444',true);
select pg_temp.assert_request((select count(*)=1 from public.directory_request_read),'platform admin sees claim, not unrelated contact');
select public.review_directory_request((select id from request_test_ids where label='claim'),'rejected');
reset role;
select pg_temp.assert_request((select count(*)=2 from public.directory_requests where requester_id='e2222222-2222-4222-8222-222222222222'),'retry and rejected submissions add no records');
select pg_temp.assert_request((select count(*)=1 from public.engagement_notifications where user_id='e1111111-1111-4111-8111-111111111111'),'contact recipient notified once');
select pg_temp.assert_request((select count(*)=1 from public.engagement_notifications where user_id='e4444444-4444-4444-8444-444444444444'),'claim platform admin notified once');
select pg_temp.assert_request((select count(*)=2 from public.engagement_notifications where user_id='e2222222-2222-4222-8222-222222222222'),'each review notifies once');
select pg_temp.assert_request((select count(*)=0 from public.engagement_notifications where user_id='e3333333-3333-4333-8333-333333333333'),'member not notified');
select pg_temp.assert_request((select count(*)=0 from public.organization_members where user_id='e2222222-2222-4222-8222-222222222222'),'claim does not grant membership');
update public.organization_members set status='suspended' where user_id='e1111111-1111-4111-8111-111111111111';
set local role authenticated;
select set_config('request.jwt.claim.sub','e1111111-1111-4111-8111-111111111111',true);
select pg_temp.assert_request((select count(*)=0 from public.directory_request_read),'revoked owner loses private access');
set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
    begin perform * from public.directory_request_read; raise exception 'anon read accepted'; exception when insufficient_privilege then null; end;
    begin perform public.submit_directory_request('e7777777-7777-4777-8777-777777777777','contact','Anon',false,'eb999999-9999-4999-8999-999999999999'); raise exception 'anon RPC accepted'; exception when insufficient_privilege then null; end;
end $$;
rollback;
