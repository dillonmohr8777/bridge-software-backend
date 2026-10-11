import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL =
    "https://frontend.example.test/login?verified=true";
process.env.PASSWORD_RESET_REDIRECT_URL = "http://localhost:5173/reset-password";

const { hasPermission } = await import("../src/middleware/authorization.js");
const { directoryProfileReviewReasonSchema } = await import(
    "../src/schemas/directory-profiles.js"
);
const { createSubmitDirectoryProfileHandler } = await import(
    "../src/routes/v1/directory-profiles.js"
);
const { createAdminDirectoryReviewHandler } = await import(
    "../src/routes/v1/admin-directory-profiles.js"
);
const { projectPublicDirectoryProfile } = await import(
    "../src/services/directory-profiles.js"
);

const workflowMigration = readFileSync(
    new URL(
        "../supabase/migrations/20261005151000_milestone_4_3b_directory_review_workflow.sql",
        import.meta.url
    ),
    "utf8"
).replace(/\s+/g, " ").toLowerCase();
const profileMigration = readFileSync(
    new URL(
        "../supabase/migrations/20261005140000_milestone_4_2_directory_business_profiles.sql",
        import.meta.url
    ),
    "utf8"
).replace(/\s+/g, " ").toLowerCase();

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const otherOrganizationId = "33333333-3333-4333-8333-333333333333";
const businessId = "44444444-4444-4444-8444-444444444444";
const profileId = "55555555-5555-4555-8555-555555555555";
const versionId = "66666666-6666-4666-8666-666666666666";

const identityWithRole = (
    role: "owner" | "admin" | "reviewer" | "member",
    platformAdmin = false
) => ({
    userId,
    email: "user@example.com",
    accountType: "standard" as const,
    platformRoles: platformAdmin ? ["admin" as const] : [],
    profile: { displayName: "Example User", phone: null },
    memberships: [{
        organizationId,
        organizationName: "Example Organization",
        organizationType: "brand" as const,
        role,
        status: "active" as const
    }]
});

const pendingProfile = {
    id: profileId,
    organizationId,
    businessId,
    slug: "example-business",
    displayName: "Example Business",
    summary: "Pending summary",
    websiteUrl: "https://example.com",
    logoUrl: null,
    status: "pending_review" as const,
    hasPublishedVersion: true,
    submittedAt: "2026-10-05T11:00:00.000Z",
    reviewedAt: null,
    workflowReason: null,
    approvedAt: null,
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T11:00:00.000Z",
    business: {
        id: businessId,
        legalName: "Example Business LLC",
        dbaName: "Example Business",
        status: "active" as const
    }
};

for (const role of ["owner", "admin"] as const) {
    test(`${role} can submit a draft or corrected profile`, () => {
        assert.equal(
            hasPermission(identityWithRole(role), "business:update", organizationId),
            true
        );
    });
}

test("owner submission handler records the requested organization scope", async () => {
    let status = 0;
    let body: unknown;
    await createSubmitDirectoryProfileHandler(async (
        accessToken,
        requestedOrganizationId
    ) => {
        assert.equal(accessToken, "access-token");
        assert.equal(requestedOrganizationId, organizationId);
        return pendingProfile;
    })(
        {
            authentication: { accessToken: "access-token" },
            params: { organizationId }
        } as never,
        {
            status(value: number) { status = value; return this; },
            json(value: unknown) { body = value; return this; }
        } as never,
        (() => undefined) as never
    );

    assert.equal(status, 200);
    assert.deepEqual(body, { profile: pendingProfile });
});

test("member and reviewer cannot submit", () => {
    for (const role of ["member", "reviewer"] as const) {
        assert.equal(
            hasPermission(identityWithRole(role), "business:update", organizationId),
            false
        );
    }
});

test("cross-tenant submission is denied", () => {
    assert.equal(
        hasPermission(
            identityWithRole("owner"),
            "business:update",
            otherOrganizationId
        ),
        false
    );
});

test("submission supports draft and correction resubmission but not suspension", () => {
    assert.match(
        workflowMigration,
        /target_profile\.status not in \( 'draft'::public\.directory_profile_status, 'correction_requested'::public\.directory_profile_status \)/
    );
    assert.match(
        workflowMigration,
        /then 'resubmitted'::public\.directory_profile_history_action/
    );
    assert.equal(
        workflowMigration.includes("'suspended'::public.directory_profile_status") &&
            !workflowMigration.includes("target_profile.status not in ( 'suspended'"),
        true
    );
});

test("correction, rejection, and suspension require a bounded reason", () => {
    assert.equal(directoryProfileReviewReasonSchema.safeParse({ reason: "" }).success, false);
    assert.equal(
        directoryProfileReviewReasonSchema.safeParse({ reason: "x".repeat(2001) }).success,
        false
    );
    assert.deepEqual(
        directoryProfileReviewReasonSchema.parse({ reason: "  Fix the website URL.  " }),
        { reason: "Fix the website URL." }
    );
});

test("platform admin can request correction through trusted review handler", async () => {
    let status = 0;
    let body: unknown;
    await createAdminDirectoryReviewHandler(
        "request_correction",
        async (actorUserId, requestedProfileId, action, input) => {
            assert.equal(actorUserId, userId);
            assert.equal(requestedProfileId, profileId);
            assert.equal(action, "request_correction");
            assert.deepEqual(input, { reason: "Fix the website URL." });
            return {
                profileId,
                status: "correction_requested",
                hasPublishedVersion: true,
                reviewedAt: "2026-10-05T12:00:00.000Z"
            };
        }
    )(
        {
            authentication: { user: { id: userId } },
            params: { profileId },
            body: { reason: "Fix the website URL." }
        } as never,
        {
            status(value: number) { status = value; return this; },
            json(value: unknown) { body = value; return this; }
        } as never,
        (() => undefined) as never
    );

    assert.equal(status, 200);
    assert.deepEqual(body, {
        review: {
            profileId,
            status: "correction_requested",
            hasPublishedVersion: true,
            reviewedAt: "2026-10-05T12:00:00.000Z"
        }
    });
});

test("organization owner/admin cannot use the platform review permission", () => {
    assert.equal(
        hasPermission(identityWithRole("owner"), "admin:directory_review"),
        false
    );
    assert.equal(
        hasPermission(identityWithRole("admin"), "admin:directory_review"),
        false
    );
    assert.equal(
        hasPermission(
            { ...identityWithRole("member", true), memberships: [] },
            "admin:directory_review"
        ),
        true
    );
});

test("platform admin who belongs to the organization cannot self-approve", () => {
    assert.match(
        workflowMigration,
        /p_action = 'approve' and exists \( select 1 from public\.organization_members om where om\.organization_id = target_profile\.organization_id and om\.user_id = p_actor_user_id and om\.status = 'active'::public\.membership_status \)/
    );
    assert.match(
        workflowMigration,
        /an organization member cannot approve their own profile/
    );
});

test("approval requires pending review and current trusted eligibility", () => {
    assert.match(
        workflowMigration,
        /target_profile\.status <> 'pending_review'::public\.directory_profile_status/
    );
    assert.match(
        workflowMigration,
        /target_organization_status <> 'active'::public\.organization_status or target_business_status <> 'active'::public\.business_status or not public\.is_business_ein_verified\(target_profile\.business_id\)/
    );
});

test("first approval creates and publishes an immutable snapshot", () => {
    assert.match(
        workflowMigration,
        /insert into public\.directory_profile_versions \( profile_id, revision_number, business_id, slug, display_name, summary, website_url, approved_by_user_id, approved_at, is_published, published_at \)/
    );
    assert.match(
        workflowMigration,
        /published_version_id = case when p_action = 'approve' then new_version_id/
    );
});

test("editing after approval creates a working draft without replacing publication", () => {
    assert.match(
        workflowMigration,
        /old\.published_version_id is not null and new\.business_id is distinct from old\.business_id/
    );
    assert.match(
        workflowMigration,
        /new\.status := 'draft'::public\.directory_profile_status/
    );
    assert.doesNotMatch(
        workflowMigration,
        /new\.published_version_id := null/
    );
});

test("pending and correction-requested revisions leave old publication intact", () => {
    assert.match(
        workflowMigration,
        /published_version_id = case when p_action = 'approve' then new_version_id else profile\.published_version_id end/
    );
    assert.match(
        workflowMigration,
        /published_version_preserved', target_profile\.published_version_id is not null/
    );
});

test("rejected revision leaves an older published snapshot intact", () => {
    assert.match(
        workflowMigration,
        /when 'request_correction' then 'correction_requested'::public\.directory_profile_status else 'rejected'::public\.directory_profile_status/
    );
    assert.match(
        workflowMigration,
        /when p_action = 'approve' then new_version_id else profile\.published_version_id/
    );
});

test("revision approval atomically replaces the published snapshot", () => {
    const unpublishIndex = workflowMigration.indexOf(
        "update public.directory_profile_versions set is_published = false"
    );
    const insertIndex = workflowMigration.indexOf(
        "insert into public.directory_profile_versions"
    );
    const pointerIndex = workflowMigration.indexOf(
        "published_version_id = case"
    );
    assert.ok(unpublishIndex >= 0 && insertIndex > unpublishIndex);
    assert.ok(pointerIndex > insertIndex);
    assert.match(workflowMigration, /begin;/);
    assert.match(workflowMigration, /commit;/);
});

test("suspension immediately suppresses every published version", () => {
    assert.match(
        workflowMigration,
        /next_status := 'suspended'::public\.directory_profile_status/
    );
    assert.match(
        workflowMigration,
        /dp\.status <> 'suspended'::public\.directory_profile_status/
    );
});

test("public lookup reads only the current published snapshot", () => {
    assert.match(
        workflowMigration,
        /join public\.directory_profile_versions dpv on dpv\.id = dp\.published_version_id and dpv\.profile_id = dp\.id and dpv\.is_published/
    );
    assert.match(
        workflowMigration,
        /where dpv\.slug = lower\(btrim\(p_slug\)\)/
    );
});

test("organization users cannot mutate approval, versions, publication, or history", () => {
    const updateGrant = profileMigration.match(
        /grant update \((.*?)\) on public\.directory_profiles to authenticated/
    )?.[1];
    assert.ok(updateGrant);
    for (const field of [
        "status",
        "approved_by_user_id",
        "approved_at",
        "published_version_id"
    ]) {
        assert.equal(updateGrant.includes(field), false);
    }
    assert.match(
        workflowMigration,
        /revoke all on table public\.directory_profile_versions from public, anon, authenticated/
    );
    assert.match(
        workflowMigration,
        /revoke all on table public\.directory_profile_history from public, anon, authenticated/
    );
    assert.match(
        workflowMigration,
        /grant execute on function public\.review_directory_profile\(uuid, uuid, text, text\) to service_role/
    );
});

test("public response cannot expose workflow reason or audit data", () => {
    const projected = projectPublicDirectoryProfile({
        slug: "published-profile",
        display_name: "Published Profile",
        summary: "Approved summary",
        story:null,business_type:"brand",categories:[],city:null,state:null,region:null,
        public_email:null,public_phone:null,license_type:null,license_number:null,links:[],
        legal_name:"Published Business",dba_name:null,
        business_name: "Published Business",
        verified: true,
        has_logo: false,
        workflow_reason: "Internal correction reason",
        rejection_reason: "Internal rejection reason",
        reviewed_by_user_id: userId,
        audit_logs: [{ private: true }],
        version_id: versionId
    });
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
        "workflow",
        "correction",
        "rejection",
        "reviewed",
        "audit",
        "version"
    ]) {
        assert.equal(serialized.toLowerCase().includes(forbidden), false);
    }
});

test("submission, review, suspension, and publication replacement are audited", () => {
    for (const action of [
        "'submitted'",
        "'resubmitted'",
        "'correction_requested'",
        "'approved'",
        "'rejected'",
        "'suspended'",
        "'published_revision_replaced'"
    ]) {
        assert.equal(workflowMigration.includes(action), true);
    }
    assert.match(
        workflowMigration,
        /insert into public\.audit_logs/
    );
});

test("tenant isolation remains authoritative for protected profile rows", () => {
    assert.match(
        profileMigration,
        /public\.is_organization_member\(organization_id\)/
    );
    assert.match(
        profileMigration,
        /public\.is_organization_admin\(organization_id\)/
    );
});
