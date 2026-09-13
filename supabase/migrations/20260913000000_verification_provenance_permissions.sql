-- Trusted review evidence must remain attached to the entity and requirement
-- actually reviewed. Use the existing service-role RPCs for review and EIN intake.
-- The application has no direct client mutations of these trusted fields.
revoke insert, update, delete on public.verification_cases from public, anon, authenticated;
revoke insert, update, delete on public.verification_items from public, anon, authenticated;
grant insert (organization_id, business_id) on public.verification_cases to authenticated;

-- Prevent reusing a verified business's evidence after replacing its legal identity.
-- Public directory display fields remain editable through directory_profiles.
revoke update on public.businesses from public, anon, authenticated;
grant update (dba_name, status) on public.businesses to authenticated;

comment on table public.verification_items is 'Review state, requirement type and case identity are writable only through trusted backend operations. Authenticated users retain tenant-scoped read access.';
