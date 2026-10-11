import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
process.env.CORS_ORIGINS = "http://localhost:3000,https://bridge-connected-signal.netlify.app";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://example.test/verify";
process.env.PASSWORD_RESET_REDIRECT_URL = "https://example.test/reset";

const { hasPermission } = await import("../src/middleware/authorization.js");
const {
    adminDirectoryProfilesQuerySchema,
    directoryProfileContactRoutingSchema,
    directoryProfileLogoCompleteSchema,
    publicDirectoryProfilesQuerySchema,
    putDirectoryProfileSchema
} = await import("../src/schemas/directory-profiles.js");
const { createContactRequestSchema } = await import("../src/schemas/contact-requests.js");
const { createListAdminDirectoryProfilesHandler } = await import("../src/routes/v1/admin-directory-profiles.js");
const { createDirectoryProfileLogoUploadHandler } = await import("../src/routes/v1/directory-profiles.js");
const { createInboundContactRequestsHandler, createSentContactRequestsHandler } = await import("../src/routes/v1/contact-requests.js");
const { createListNotificationsHandler } = await import("../src/routes/v1/notifications.js");

const migration = readFileSync(new URL(
    "../supabase/migrations/20261006120000_milestone_4_client_alignment.sql",
    import.meta.url
), "utf8").replace(/\s+/g, " ").toLowerCase();

const organizationId = "22222222-2222-4222-8222-222222222222";
const identity = (role: "owner" | "admin" | "page_manager" | "member") => ({
    userId: "11111111-1111-4111-8111-111111111111", email: "user@example.com",
    accountType: "standard" as const, platformRoles: [], profile: null,
    memberships: [{ organizationId, organizationName: "Org", organizationType: "brand" as const, role, status: "active" as const }]
});

test("page manager can edit ordinary Directory content but cannot publish or manage users", () => {
    const pageManager = identity("page_manager");
    assert.equal(hasPermission(pageManager, "directory_profile:content_update", organizationId), true);
    assert.equal(hasPermission(pageManager, "business:update", organizationId), false);
    assert.equal(hasPermission(pageManager, "organization:members_manage", organizationId), false);
    assert.equal(hasPermission(pageManager, "admin:directory_review"), false);
});

test("expanded B2B profile contract validates normalized fields and multiple links", () => {
    const result = putDirectoryProfileSchema.parse({
        businessId: "33333333-3333-4333-8333-333333333333", slug: "green-company",
        displayName: "Green Company", summary: "Summary", story: "Story", businessType: "brand",
        categories: ["Cultivation", "Wholesale"], city: "Portland", state: "Oregon", region: "Willamette Valley",
        publicEmail: "hello@green.example", publicPhone: "+1 503 555 0100",
        licenseType: "METRC", licenseNumber: "LIC-100",
        links: [
            { type: "website", label: "Website", url: "https://green.example", sortOrder: 0 },
            { type: "menu", label: "Menu", url: "https://green.example/menu", sortOrder: 1 }
        ]
    });
    assert.equal(result.links.length, 2);
    assert.deepEqual(result.categories, ["Cultivation", "Wholesale"]);
});

test("Directory search supports confirmed filters and verified=false explicitly", () => {
    assert.deepEqual(publicDirectoryProfilesQuerySchema.parse({
        organizationType: "brand", category: "Cultivation", state: "Oregon", city: "Portland",
        region: "Willamette Valley", verified: "false"
    }).verified, false);
    assert.match(migration, /if p_verified=false then return/);
});

test("contactPreference final enum is email, phone, either", () => {
    for (const contactPreference of ["email", "phone", "either"]) {
        assert.equal(createContactRequestSchema.safeParse({
            firstName: "A", workEmail: "a@example.com", phoneNumber: "+1 555 555 5555",
            yearsOfService: 2, contactPreference
        }).success, true);
    }
    assert.equal(createContactRequestSchema.safeParse({
        firstName: "A", workEmail: "a@example.com", phoneNumber: "+1 555 555 5555",
        yearsOfService: 2, contactPreference: "sms"
    }).success, false);
});

test("sales rep attachment and Bridge admin targets are explicit nullable IDs", () => {
    assert.equal(directoryProfileContactRoutingSchema.safeParse({
        salesRepresentativeMembershipId: null, bridgeAdminUserId: null
    }).success, true);
    assert.match(migration, /up\.account_type='sales_rep'/);
    assert.match(migration, /route\.sales_representative_membership_id/);
    assert.match(migration, /route\.bridge_admin_user_id/);
    assert.match(migration, /om\.role='owner'/);
});

test("logo completion requires a server-issued upload ID and verifies storage before mutation", () => {
    assert.equal(directoryProfileLogoCompleteSchema.safeParse({
        uploadId: "44444444-4444-4444-8444-444444444444"
    }).success, true);
    assert.match(migration, /directory_profile_pending_uploads/);
    assert.match(migration, /complete_directory_profile_logo_upload/);
});

test("signed upload response specifies PUT and every required Storage header", async () => {
    const upload = {
        uploadId: "44444444-4444-4444-8444-444444444444",
        signedUrl: "https://storage.example.test/signed",
        method: "PUT" as const,
        requiredHeaders: {
            "Content-Type": "image/png",
            "cache-control": "max-age=3600" as const,
            "x-upsert": "false" as const
        },
        expiresInSeconds: 7200 as const
    };
    let body: unknown;
    await createDirectoryProfileLogoUploadHandler(async () => upload)(
        { authentication: { accessToken: "token" }, params: { organizationId }, body: { contentType: "image/png", fileSize: 10 } } as never,
        { status() { return this; }, json(value: unknown) { body = value; return this; } } as never,
        (() => undefined) as never
    );
    assert.deepEqual(body, { upload });
});

test("admin queue supports bounded status filtering and stable page info", async () => {
    assert.deepEqual(adminDirectoryProfilesQuerySchema.parse({ status: "pending_review" }), {
        status: "pending_review", limit: 20, offset: 0
    });
    const expected = { profiles: [], pageInfo: { limit: 20, offset: 0, hasMore: false } };
    let body: unknown;
    await createListAdminDirectoryProfilesHandler(async () => expected)(
        {} as never,
        { locals: { validatedQuery: { limit: 20, offset: 0 } }, status() { return this; }, json(value: unknown) { body = value; return this; } } as never,
        (() => undefined) as never
    );
    assert.deepEqual(body, expected);
    assert.doesNotMatch(migration.slice(migration.indexOf("create function public.list_admin_directory_profiles")), /ein_last_four|provider_response|evidence/);
});

test("published categories and links use immutable version child tables", () => {
    assert.match(migration, /directory_profile_version_categories/);
    assert.match(migration, /directory_profile_version_links/);
    assert.match(migration, /directory_profile_versions_copy_client_children/);
});

test("inbound and sent contact lists preserve the same pagination wrapper", async () => {
    const expected = { requests: [], pageInfo: { limit: 20, offset: 0, hasMore: false } };
    for (const handler of [
        createInboundContactRequestsHandler(async () => expected),
        createSentContactRequestsHandler(async () => expected)
    ]) {
        let body: unknown;
        await handler(
            { authentication: { accessToken: "token" }, params: { organizationId } } as never,
            { locals: { validatedQuery: { limit: 20, offset: 0 } }, status() { return this; }, json(value: unknown) { body = value; return this; } } as never,
            (() => undefined) as never
        );
        assert.deepEqual(body, expected);
    }
});

test("notification list exposes stable pageInfo metadata", async () => {
    const expected = { notifications: [], pageInfo: { limit: 20, offset: 0, hasMore: false } };
    let body: unknown;
    await createListNotificationsHandler(async () => expected)(
        { authentication: { accessToken: "token" } } as never,
        { locals: { validatedQuery: { unreadOnly: false, limit: 20, offset: 0 } }, status() { return this; }, json(value: unknown) { body = value; return this; } } as never,
        (() => undefined) as never
    );
    assert.deepEqual(body, expected);
});
