import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL =
    "https://frontend.example.test/login?verified=true";
process.env.PASSWORD_RESET_REDIRECT_URL = "http://localhost:5173/reset-password";

const { hasPermission } = await import("../src/middleware/authorization.js");
const { putDirectoryProfileSchema } = await import(
    "../src/schemas/directory-profiles.js"
);
const {
    projectProtectedDirectoryProfile,
    projectPublicDirectoryProfile
} = await import("../src/services/directory-profiles.js");
const {
    createGetDirectoryProfileHandler,
    createPutDirectoryProfileHandler
} = await import("../src/routes/v1/directory-profiles.js");

const migration = readFileSync(
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

const identityWithRole = (role: "owner" | "admin" | "reviewer" | "member") => ({
    userId,
    email: "user@example.com",
    accountType: "standard" as const,
    platformRoles: [],
    profile: { displayName: "Example User", phone: null },
    memberships: [{
        organizationId,
        organizationName: "Example Organization",
        organizationType: "brand" as const,
        role,
        status: "active" as const
    }]
});

const input = {
    businessId,
    slug: "example-business",
    displayName: "Example Business",
    summary: "A concise public summary.",
    story: "Our story.", businessType: "brand" as const,
    categories: ["Cultivation"], city: "Portland", state: "Oregon", region: "Willamette Valley",
    publicEmail: "hello@example.com", publicPhone: "+1 503 555 0100",
    licenseType: "METRC", licenseNumber: "LIC-100",
    links: [{ type: "website" as const, label: "Website", url: "https://example.com", sortOrder: 0 }]
};

const protectedProfile = {
    id: profileId,
    organizationId,
    businessId,
    slug: input.slug,
    displayName: input.displayName,
    summary: input.summary,
    story: input.story, businessType: input.businessType, categories: input.categories,
    city: input.city, state: input.state, region: input.region,
    publicContact: { email: input.publicEmail, phone: input.publicPhone },
    license: { type: input.licenseType, number: input.licenseNumber }, links: input.links,
    logoUrl: null,
    status: "draft" as const,
    hasPublishedVersion: false,
    submittedAt: null,
    reviewedAt: null,
    workflowReason: null,
    approvedAt: null,
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z",
    business: {
        id: businessId,
        legalName: "Example Business LLC",
        dbaName: "Example Business",
        status: "active" as const
    }
};

test("owner can create or update an organization Directory profile", () => {
    assert.equal(
        hasPermission(identityWithRole("owner"), "business:update", organizationId),
        true
    );
});

test("admin can create or update an organization Directory profile", () => {
    assert.equal(
        hasPermission(identityWithRole("admin"), "business:update", organizationId),
        true
    );
});

test("member and reviewer cannot mutate an organization Directory profile", () => {
    for (const role of ["member", "reviewer"] as const) {
        assert.equal(
            hasPermission(identityWithRole(role), "business:update", organizationId),
            false,
            `${role} must not have profile mutation permission`
        );
    }
});

test("unrelated organization user cannot read or mutate a Directory profile", () => {
    const identity = identityWithRole("owner");
    assert.equal(
        hasPermission(identity, "business:read", otherOrganizationId),
        false
    );
    assert.equal(
        hasPermission(identity, "business:update", otherOrganizationId),
        false
    );
});

test("active organization member can read the protected Directory profile", () => {
    assert.equal(
        hasPermission(identityWithRole("member"), "business:read", organizationId),
        true
    );
});

test("unauthenticated protected profile access is denied", async () => {
    let status = 0;
    let body: unknown;
    await createGetDirectoryProfileHandler(async () => protectedProfile)(
        { params: { organizationId } } as never,
        {
            status(value: number) { status = value; return this; },
            json(value: unknown) { body = value; return this; }
        } as never,
        (() => assert.fail("next must not be called")) as never
    );

    assert.equal(status, 401);
    assert.deepEqual(body, {
        error: "UNAUTHORIZED",
        message: "A valid authentication credential is required."
    });
});

test("PUT profile handler scopes the upsert to the requested organization", async () => {
    let status = 0;
    let body: unknown;
    await createPutDirectoryProfileHandler(async (
        accessToken,
        requestedOrganizationId,
        receivedInput
    ) => {
        assert.equal(accessToken, "access-token");
        assert.equal(requestedOrganizationId, organizationId);
        assert.deepEqual(receivedInput, input);
        return protectedProfile;
    })(
        {
            authentication: { accessToken: "access-token" },
            params: { organizationId },
            body: input
        } as never,
        {
            status(value: number) { status = value; return this; },
            json(value: unknown) { body = value; return this; }
        } as never,
        (() => undefined) as never
    );

    assert.equal(status, 200);
    assert.deepEqual(body, { profile: protectedProfile });
});

test("profile schema rejects protected fields and organization identifiers", () => {
    for (const field of [
        "organizationId",
        "status",
        "approvedAt",
        "approvedByUserId",
        "createdByUserId",
        "updatedByUserId",
        "createdAt",
        "updatedAt",
        "verified",
        "verificationStatus"
    ]) {
        const result = putDirectoryProfileSchema.safeParse({
            ...input,
            [field]: "forged"
        });
        assert.equal(result.success, false, `${field} must be rejected`);
    }
});

test("profile schema validates slug and link URL formats", () => {
    for (const slug of ["Upper-Case", "has spaces", "double--hyphen", "-leading"] ) {
        assert.equal(
            putDirectoryProfileSchema.safeParse({ ...input, slug }).success,
            false
        );
    }
    assert.equal(
        putDirectoryProfileSchema.safeParse({
            ...input,
            links: [{ type: "website", label: "Bad", url: "javascript:alert(1)", sortOrder: 0 }]
        }).success,
        false
    );
    assert.equal(putDirectoryProfileSchema.safeParse(input).success, true);
});

test("database enforces one profile per organization and unique slugs", () => {
    assert.match(
        migration,
        /constraint directory_profiles_organization_unique unique \(organization_id\)/
    );
    assert.match(
        migration,
        /create unique index directory_profiles_slug_unique_idx on public\.directory_profiles\(lower\(slug\)\)/
    );
});

test("database enforces profile business and organization linkage", () => {
    assert.match(
        migration,
        /foreign key \(business_id, organization_id\) references public\.businesses\(id, organization_id\)/
    );
    assert.match(
        migration,
        /where b\.id = p_business_id and b\.organization_id = p_organization_id/
    );
});

test("approved profile cannot switch its verification business", () => {
    assert.match(
        migration,
        /old\.status = 'approved'::public\.directory_profile_status and new\.business_id is distinct from old\.business_id/
    );
    assert.match(
        migration,
        /existing_profile\.status = 'approved'::public\.directory_profile_status and existing_profile\.business_id is distinct from p_business_id/
    );
});

for (const hiddenStatus of ["draft", "pending_review", "suspended"] as const) {
    test(`${hiddenStatus} profile is not publicly visible`, () => {
        assert.match(
            migration,
            /dp\.status = 'approved'::public\.directory_profile_status/
        );
        assert.notEqual(hiddenStatus, "approved");
    });
}

test("approved but unverified profile is not publicly visible", () => {
    assert.match(
        migration,
        /and public\.is_business_ein_verified\(b\.id\)/
    );
    assert.match(
        migration,
        /select vi\.status = 'verified'::public\.verification_item_status/
    );
});

test("approved, trusted-verified, active profile satisfies public eligibility", () => {
    for (const requiredPredicate of [
        "dp.status = 'approved'::public.directory_profile_status",
        "o.status = 'active'::public.organization_status",
        "b.status = 'active'::public.business_status",
        "public.is_business_ein_verified(b.id)"
    ]) {
        assert.equal(migration.includes(requiredPredicate), true);
    }
    assert.match(
        migration,
        /order by vc\.created_at desc, vi\.created_at desc, vi\.id desc limit 1/
    );
});

test("public projection contains only explicitly safe fields", () => {
    const projected = projectPublicDirectoryProfile({
        slug: input.slug,
        display_name: input.displayName,
        summary: input.summary,
        story: input.story, business_type: "brand", categories: input.categories,
        city: input.city, state: input.state, region: input.region,
        public_email: input.publicEmail, public_phone: input.publicPhone,
        license_type: input.licenseType, license_number: input.licenseNumber,
        links: input.links, legal_name: "Example Business LLC", dba_name: "Example Business",
        logo_storage_path: null,
        business_name: "Example Business",
        verified: true,
        has_logo: false,
        organization_id: organizationId,
        business_id: businessId,
        approved_by_user_id: userId,
        ein_last_four: "1234",
        provider_response: { secret: true }
    });

    assert.deepEqual(projected, {
        slug: input.slug,
        displayName: input.displayName,
        summary: input.summary,
        story: input.story, businessType: "brand", categories: input.categories,
        city: input.city, state: input.state, region: input.region,
        publicContact: { email: input.publicEmail, phone: input.publicPhone },
        license: { type: input.licenseType, number: input.licenseNumber }, links: input.links,
        legalName: "Example Business LLC", dbaName: "Example Business",
        businessName: "Example Business",
        verified: true,
        logoUrl: null
    });
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
        "organizationId",
        "businessId",
        "approvedByUserId",
        "1234",
        "provider"
    ]) {
        assert.equal(serialized.includes(forbidden), false);
    }
});

test("protected projection excludes EIN, provider, evidence, and internal notes", () => {
    const projected = projectProtectedDirectoryProfile({
        id: profileId,
        organization_id: organizationId,
        business_id: businessId,
        slug: input.slug,
        display_name: input.displayName,
        summary: input.summary,
        story: input.story, business_type: "brand", city: input.city, state: input.state, region: input.region,
        public_email: input.publicEmail, public_phone: input.publicPhone,
        license_type: input.licenseType, license_number: input.licenseNumber,
        logo_storage_path: null,
        status: "draft",
        submitted_at: null,
        reviewed_at: null,
        workflow_reason: null,
        published_version_id: null,
        approved_at: null,
        created_at: protectedProfile.createdAt,
        updated_at: protectedProfile.updatedAt,
        businesses: {
            id: businessId,
            legal_name: protectedProfile.business.legalName,
            dba_name: protectedProfile.business.dbaName,
            status: "active",
            ein_last_four: "1234",
            cannabis_license_number: "private-license"
        },
        directory_profile_categories: [{ category: "Cultivation", sort_order: 0 }],
        directory_profile_links: [{ link_type: "website", label: "Website", url: "https://example.com", sort_order: 0 }],
        provider_response: { private: true },
        review_notes: "internal",
        documents: ["private-evidence"]
    });

    assert.deepEqual(projected, protectedProfile);
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
        "1234",
        "private-license",
        "provider",
        "internal",
        "private-evidence"
    ]) {
        assert.equal(serialized.includes(forbidden), false);
    }
});

test("RLS preserves member reads and restricts writes to owner/admin", () => {
    assert.match(
        migration,
        /create policy directory_profiles_select_member on public\.directory_profiles for select to authenticated using \( public\.is_organization_member\(organization_id\) \)/
    );
    assert.match(
        migration,
        /create policy directory_profiles_insert_admin on public\.directory_profiles for insert to authenticated with check \( public\.is_organization_admin\(organization_id\)/
    );
    assert.match(
        migration,
        /create policy directory_profiles_update_admin on public\.directory_profiles for update to authenticated using \( public\.is_organization_admin\(organization_id\)/
    );
    assert.match(
        migration,
        /revoke all on table public\.directory_profiles from public, anon, authenticated/
    );
});

test("organization users cannot directly write approval fields", () => {
    const updateGrant = migration.match(
        /grant update \((.*?)\) on public\.directory_profiles to authenticated/
    )?.[1];
    assert.ok(updateGrant);
    for (const protectedColumn of [
        "status",
        "approved_by_user_id",
        "approved_at",
        "organization_id",
        "created_by_user_id"
    ]) {
        assert.equal(updateGrant.includes(protectedColumn), false);
    }
});

test("first-slice migration protected approved edits before versioning", () => {
    assert.match(
        migration,
        /new\.status := 'pending_review'::public\.directory_profile_status/
    );
    assert.match(migration, /new\.approved_by_user_id := null/);
    assert.match(migration, /new\.approved_at := null/);
});
