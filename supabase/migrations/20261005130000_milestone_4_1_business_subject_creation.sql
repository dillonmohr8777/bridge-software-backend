-- ============================================================================
-- BRIDGE — MILESTONE 4.1
-- Organization-authorized business verification subject creation
-- ============================================================================

begin;

-- Business verification subjects are organization-administered. Reviewers and
-- ordinary members retain the existing tenant-scoped read policy but cannot
-- create subjects.
drop policy if exists businesses_insert_member
on public.businesses;

create policy businesses_insert_admin
on public.businesses
for insert
to authenticated
with check (
    public.is_organization_admin(organization_id)
    and status = 'active'::public.business_status
    and ein_last_four is null
    and cannabis_license_number is null
    and cannabis_license_state is null
);

comment on policy businesses_insert_admin on public.businesses is
    'Active organization owners/admins may create unverified business subjects; verification-owned fields must start empty.';

commit;
