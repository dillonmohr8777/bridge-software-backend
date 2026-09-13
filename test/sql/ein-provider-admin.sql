begin;
create function pg_temp.assert_ein(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'EIN assertion failed: %', label; end if; end $$;

insert into auth.users(id) values
('b1111111-1111-4111-8111-111111111111'),
('b2222222-2222-4222-8222-222222222222');
insert into public.user_platform_roles(user_id,role)
values ('b2222222-2222-4222-8222-222222222222','admin');
insert into public.organizations(id,name,status,organization_type)
values ('b3333333-3333-4333-8333-333333333333','EIN fixture','active','brand');
insert into public.organization_members(organization_id,user_id,role,status)
values ('b3333333-3333-4333-8333-333333333333','b1111111-1111-4111-8111-111111111111','owner','active');
insert into public.businesses(id,organization_id,legal_name,status,ein_last_four)
values ('b4444444-4444-4444-8444-444444444444','b3333333-3333-4333-8333-333333333333','EIN business','active','6789');
insert into public.verification_cases(id,organization_id,business_id)
values ('b5555555-5555-4555-8555-555555555555','b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444');
insert into public.verification_items(id,verification_case_id,item_type)
values ('b6666666-6666-4666-8666-666666666666','b5555555-5555-4555-8555-555555555555','ein');
insert into public.business_ein_secrets(
    business_id,ciphertext,iv,auth_tag,key_version,secret_version
) values (
    'b4444444-4444-4444-8444-444444444444','ciphertext','iv','tag',1,
    'b7777777-7777-4777-8777-777777777777'
);
insert into public.businesses(id,organization_id,legal_name,status,ein_last_four)
values ('b8444444-4444-4444-8444-444444444444','b3333333-3333-4333-8333-333333333333','Recovery business','active','4321');
insert into public.verification_cases(id,organization_id,business_id)
values ('b8555555-5555-4555-8555-555555555555','b3333333-3333-4333-8333-333333333333','b8444444-4444-4444-8444-444444444444');
insert into public.verification_items(id,verification_case_id,item_type)
values ('b8666666-6666-4666-8666-666666666666','b8555555-5555-4555-8555-555555555555','ein');
insert into public.business_ein_secrets(
    business_id,ciphertext,iv,auth_tag,key_version,secret_version
) values (
    'b8444444-4444-4444-8444-444444444444','ciphertext-2','iv-2','tag-2',1,
    'b8777777-7777-4777-8777-777777777777'
);

set local role authenticated;
select set_config('request.jwt.claim.sub','b1111111-1111-4111-8111-111111111111',true);
do $$ begin
  begin
    perform public.request_ein_verification(
      'b6666666-6666-4666-8666-666666666666','6789','tincomply',
      'b7777777-7777-4777-8777-777777777777'
    );
    raise exception 'organization owner triggered provider request';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub','b2222222-2222-4222-8222-222222222222',true);
select * from public.request_ein_verification(
    'b6666666-6666-4666-8666-666666666666','6789','TINCOMPLY',
    'b7777777-7777-4777-8777-777777777777'
);
select * from public.request_ein_verification(
    'b8666666-6666-4666-8666-666666666666','4321','tincomply',
    'b8777777-7777-4777-8777-777777777777'
);
do $$ begin
  begin
    perform public.request_ein_verification(
      'b6666666-6666-4666-8666-666666666666','6789','tincomply',
      'b7777777-7777-4777-8777-777777777777'
    );
    raise exception 'duplicate provider request started';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
reset role;

set local role service_role;
do $$ begin
  begin
    perform public.review_admin_verification_item(
      'b2222222-2222-4222-8222-222222222222',
      'b6666666-6666-4666-8666-666666666666','verified',null
    );
    raise exception 'admin reviewed before provider completed';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    update public.business_ein_secrets set ciphertext='replacement'
    where business_id='b4444444-4444-4444-8444-444444444444';
    raise exception 'EIN changed during provider request';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;

select public.complete_ein_provider_evidence(
  (select id from public.ein_verifications
   where verification_item_id='b6666666-6666-4666-8666-666666666666'),
  'provider-request-1','verified','TIN and name match EIN records'
);
select pg_temp.assert_ein(
  (select status='verification_requested' from public.verification_items
   where id='b6666666-6666-4666-8666-666666666666'),
  'provider evidence does not mutate trusted item state'
);
select * from public.review_admin_verification_item(
  'b2222222-2222-4222-8222-222222222222',
  'b6666666-6666-4666-8666-666666666666','verified',null
);

select public.abandon_ein_provider_attempt(
  'b2222222-2222-4222-8222-222222222222',
  (select id from public.ein_verifications
   where verification_item_id='b8666666-6666-4666-8666-666666666666'),
  'Worker stopped before the provider response was persisted.'
);
select pg_temp.assert_ein(
  (select completed_at is not null and result_status='abandoned'
   from public.ein_verifications
   where verification_item_id='b8666666-6666-4666-8666-666666666666'),
  'admin recovery closes the uncertain attempt without retrying'
);
select * from public.review_admin_verification_item(
  'b2222222-2222-4222-8222-222222222222',
  'b8666666-6666-4666-8666-666666666666','correction_required',
  'Provider result was not received; submit EIN again before retrying.'
);
reset role;

select pg_temp.assert_ein(
    (select count(*) = 2 and min(provider) = 'tincomply' and max(provider) = 'tincomply'
     from public.ein_verifications),
    'one normalized provider attempt exists per item'
);
select pg_temp.assert_ein(
    (select status = 'verified' from public.verification_items where id = 'b6666666-6666-4666-8666-666666666666'),
    'trusted admin review remains the only verification decision'
);
rollback;
