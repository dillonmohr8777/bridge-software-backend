-- ============================================================================
-- BRIDGE — MILESTONE 4.0
-- Trusted verification mutation hardening
--
-- Verification decisions are backend-owned. Organization users retain the
-- existing read policies, but may no longer create or directly update workflow
-- state. Controlled SECURITY DEFINER functions remain the only write boundary.
-- ============================================================================

begin;

-- A member could previously insert a case with any enum status, or an
-- owner/admin/reviewer could directly promote an existing case. Cases are now
-- created and advanced only by controlled backend functions.
drop policy if exists verification_cases_insert_member
on public.verification_cases;

drop policy if exists verification_cases_update_reviewer
on public.verification_cases;

revoke insert, update, delete, truncate on table public.verification_cases
from public, anon, authenticated;

-- Item status, verification method, reviewer attribution, and decision notes
-- are trusted state. The existing select policy is intentionally preserved.
drop policy if exists verification_items_update_reviewer
on public.verification_items;

revoke insert, update, delete, truncate on table public.verification_items
from public, anon, authenticated;

-- Provider attempts and registry lookup results have no organization-user RLS
-- write policies. Explicit privilege revocation makes that boundary durable if
-- default grants change later.
revoke insert, update, delete, truncate on table public.ein_verifications
from public, anon, authenticated;

revoke insert, update, delete, truncate on table public.cannabis_license_verifications
from public, anon, authenticated;

-- Verification history is append-only from controlled backend functions.
revoke insert, update, delete, truncate on table public.verification_item_history
from public, anon, authenticated;

-- Evidence attachments may still be created under the existing tenant-scoped
-- insert policy, but removing an attachment is now a controlled backend action.
drop policy if exists verification_item_documents_delete_admin
on public.verification_item_documents;

revoke delete, truncate on table public.verification_item_documents
from public, anon, authenticated;

-- Members may still upload evidence, but they cannot self-approve it or forge
-- reviewer attribution. The business and case must belong to the same tenant.
drop policy if exists documents_insert_member
on public.documents;

create policy documents_insert_member_pending
on public.documents
for insert
to authenticated
with check (
    public.is_organization_member(documents.organization_id)
    and documents.uploaded_by_user_id = (select auth.uid())
    and documents.review_status = 'pending'::public.document_review_status
    and documents.reviewed_by_user_id is null
    and documents.reviewed_at is null
    and documents.review_notes is null
    and exists (
        select 1
        from public.businesses b
        where b.id = documents.business_id
          and b.organization_id = documents.organization_id
    )
    and exists (
        select 1
        from public.verification_cases vc
        where vc.id = documents.verification_case_id
          and vc.organization_id = documents.organization_id
          and vc.business_id = documents.business_id
    )
);

drop policy if exists documents_update_reviewer
on public.documents;

revoke update, delete, truncate on table public.documents
from public, anon, authenticated;

comment on policy documents_insert_member_pending on public.documents is
    'Organization members may upload pending evidence only; trusted review fields are backend-owned.';

commit;
