-- Isolated database only; run after all migrations as migration owner. Always rolls back.
begin;
create function pg_temp.assert_email(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Email assertion failed: %',label; end if; end $$;
insert into auth.users(id,email) values
('b1111111-1111-4111-8111-111111111111','requester@example.com'),
('b2222222-2222-4222-8222-222222222222','OWNER@EXAMPLE.COM');
insert into public.organizations(id,name,status,organization_type)
values ('b3333333-3333-4333-8333-333333333333','Email fixture','active','brand');
insert into public.organization_members(organization_id,user_id,role,status)
values ('b3333333-3333-4333-8333-333333333333','b2222222-2222-4222-8222-222222222222','owner','active');
insert into public.directory_profiles(id,organization_id,slug,name,visibility)
values ('b4444444-4444-4444-8444-444444444444','b3333333-3333-4333-8333-333333333333','email-fixture','Email fixture','public');
set local role authenticated;
select set_config('request.jwt.claim.sub','b1111111-1111-4111-8111-111111111111',true);
select public.submit_directory_request(
    'b4444444-4444-4444-8444-444444444444','contact','Private message',true,
    'b5555555-5555-4555-8555-555555555555'
);
reset role;
select pg_temp.assert_email(
    (select count(*)=1 and min(recipient_email)='owner@example.com' from public.directory_email_outbox),
    'submission queues only the derived reviewer email'
);
select pg_temp.assert_email(
    (select email_delivery='queued' from public.directory_requests limit 1),
    'request records queued delivery'
);
set local role authenticated;
select set_config('request.jwt.claim.sub','b1111111-1111-4111-8111-111111111111',true);
do $$ begin
    begin perform 1 from public.directory_email_outbox; raise exception 'private outbox readable';
    exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
select * from public.claim_directory_email_outbox(null,20);
select public.complete_directory_email_outbox(
    (select id from public.directory_email_outbox where event_type='submitted'),true,'provider-1',null
);
reset role;
select pg_temp.assert_email(
    (select email_delivery='sent' from public.directory_requests limit 1),
    'provider receipt marks submission sent'
);
set local role authenticated;
select set_config('request.jwt.claim.sub','b2222222-2222-4222-8222-222222222222',true);
select public.review_directory_request((select id from public.directory_requests limit 1),'resolved');
reset role;
select pg_temp.assert_email(
    (select count(*)=1 from public.directory_email_outbox where event_type='reviewed' and recipient_email='requester@example.com'),
    'review queues requester email'
);
set local role service_role;
select * from public.claim_directory_email_outbox(null,20);
select public.complete_directory_email_outbox(
    (select id from public.directory_email_outbox where event_type='reviewed'),true,'provider-2',null
);
reset role;
select pg_temp.assert_email(
    (select email_delivery='sent' from public.directory_requests limit 1),
    'all current events have provider receipts'
);
rollback;
