begin;
create function pg_temp.assert_provenance(condition boolean, message text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Verification assertion failed: %', message; end if; end;
$$;
insert into auth.users(id) values ('f1111111-1111-4111-8111-111111111111'),('f2222222-2222-4222-8222-222222222222');
insert into public.user_platform_roles(user_id,role) values ('f2222222-2222-4222-8222-222222222222','admin');
insert into public.organizations(id,name,organization_type) values ('f3333333-3333-4333-8333-333333333333','Provenance fixture','brand');
insert into public.organization_members(organization_id,user_id,role,status) values ('f3333333-3333-4333-8333-333333333333','f1111111-1111-4111-8111-111111111111','owner','active');
insert into public.businesses(id,organization_id,legal_name) values ('f4444444-4444-4444-8444-444444444444','f3333333-3333-4333-8333-333333333333','Reviewed business');
insert into public.verification_cases(id,organization_id,business_id) values ('f5555555-5555-4555-8555-555555555555','f3333333-3333-4333-8333-333333333333','f4444444-4444-4444-8444-444444444444');
insert into public.verification_items(id,verification_case_id,item_type) values ('f6666666-6666-4666-8666-666666666666','f5555555-5555-4555-8555-555555555555','document');
set local role authenticated;
select set_config('request.jwt.claim.sub','f1111111-1111-4111-8111-111111111111',true);
do $$ begin
  begin update public.verification_items set item_type='ein' where id='f6666666-6666-4666-8666-666666666666'; raise exception 'requirement identity writable'; exception when insufficient_privilege then null; end;
  begin update public.verification_items set status='verified',reviewed_by_user_id='f2222222-2222-4222-8222-222222222222'; raise exception 'review evidence writable'; exception when insufficient_privilege then null; end;
  begin update public.verification_cases set business_id='f4444444-4444-4444-8444-444444444444'; raise exception 'case business writable'; exception when insufficient_privilege then null; end;
  begin update public.verification_cases set status='approved',completed_at=now(); raise exception 'case approval writable'; exception when insufficient_privilege then null; end;
  begin update public.businesses set legal_name='Replacement identity'; raise exception 'legal identity writable'; exception when insufficient_privilege then null; end;
  begin insert into public.verification_items(verification_case_id,item_type,status) values ('f5555555-5555-4555-8555-555555555555','ein','verified'); raise exception 'preapproved insert allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
-- Existing trusted intake and review operations retain their write authority.
insert into public.verification_items(verification_case_id,item_type) values ('f5555555-5555-4555-8555-555555555555','ein');
select * from public.review_admin_verification_item('f2222222-2222-4222-8222-222222222222','f6666666-6666-4666-8666-666666666666','verified',null);
reset role;
select pg_temp.assert_provenance((select status='verified' and item_type='document' from public.verification_items where id='f6666666-6666-4666-8666-666666666666'),'trusted admin RPC preserves requirement and updates review');
select pg_temp.assert_provenance((select count(*)=1 from public.verification_item_history where verification_item_id='f6666666-6666-4666-8666-666666666666'),'trusted RPC appends evidence');
rollback;
