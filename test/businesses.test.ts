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
const { createBusinessSchema } = await import("../src/schemas/businesses.js");
const { projectBusinessRow } = await import("../src/services/businesses.js");
const {
    createCreateBusinessHandler,
    createListBusinessesHandler
} = await import("../src/routes/v1/businesses.js");

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const otherOrganizationId = "33333333-3333-4333-8333-333333333333";
const businessId = "44444444-4444-4444-8444-444444444444";

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

const business = {
    id: businessId,
    organizationId,
    legalName: "Example Business LLC",
    dbaName: "Example Business",
    status: "active" as const,
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z"
};

test("organization owner can create a business subject", () => {
    assert.equal(
        hasPermission(identityWithRole("owner"), "business:update", organizationId),
        true
    );
});

test("organization admin can create a business subject", () => {
    assert.equal(
        hasPermission(identityWithRole("admin"), "business:update", organizationId),
        true
    );
});

test("ordinary member cannot create a business subject", () => {
    assert.equal(
        hasPermission(identityWithRole("member"), "business:update", organizationId),
        false
    );
});

test("organization reviewer cannot create a business subject", () => {
    assert.equal(
        hasPermission(identityWithRole("reviewer"), "business:update", organizationId),
        false
    );
});

test("user from another organization cannot create a business subject", () => {
    assert.equal(
        hasPermission(identityWithRole("owner"), "business:update", otherOrganizationId),
        false
    );
});

test("unauthenticated business creation is denied", async () => {
    let status = 0;
    let body: unknown;
    await createCreateBusinessHandler(async () => business)(
        { params: { organizationId }, body: { legalName: business.legalName } } as never,
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

test("business creation uses the requested organization linkage", async () => {
    let receivedOrganizationId: string | undefined;
    let status = 0;
    let body: unknown;
    const input = { legalName: business.legalName, dbaName: business.dbaName };

    await createCreateBusinessHandler(async (
        accessToken,
        requestedOrganizationId,
        receivedInput
    ) => {
        assert.equal(accessToken, "access-token");
        receivedOrganizationId = requestedOrganizationId;
        assert.deepEqual(receivedInput, input);
        return business;
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

    assert.equal(receivedOrganizationId, organizationId);
    assert.equal(status, 201);
    assert.deepEqual(body, { business });
});

test("business creation rejects verification-owned and unknown fields", () => {
    const protectedFields = [
        "status",
        "ein",
        "einLastFour",
        "cannabisLicenseNumber",
        "cannabisLicenseState",
        "verificationStatus",
        "providerResult",
        "reviewedByUserId",
        "reviewedAt"
    ];

    for (const field of protectedFields) {
        const result = createBusinessSchema.safeParse({
            legalName: business.legalName,
            [field]: "forged"
        });
        assert.equal(result.success, false, `${field} must be rejected`);
    }
});

test("active organization member can retrieve businesses but unrelated user cannot", () => {
    assert.equal(
        hasPermission(identityWithRole("member"), "business:read", organizationId),
        true
    );
    assert.equal(
        hasPermission(identityWithRole("member"), "business:read", otherOrganizationId),
        false
    );
});

test("business list handler returns the safe service projection", async () => {
    let status = 0;
    let body: unknown;
    await createListBusinessesHandler(async (accessToken, requestedOrganizationId) => {
        assert.equal(accessToken, "access-token");
        assert.equal(requestedOrganizationId, organizationId);
        return [business];
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
    assert.deepEqual(body, { businesses: [business] });
});

test("business response projection excludes verification secrets and evidence", () => {
    const projected = projectBusinessRow({
        id: businessId,
        organization_id: organizationId,
        legal_name: business.legalName,
        dba_name: business.dbaName,
        status: "active",
        created_at: business.createdAt,
        updated_at: business.updatedAt,
        ein_last_four: "1234",
        ciphertext: "encrypted-ein",
        provider_response: { secret: true },
        review_notes: "internal"
    });

    assert.deepEqual(projected, business);
    const serialized = JSON.stringify(projected);
    for (const sensitiveValue of [
        "ein_last_four",
        "1234",
        "ciphertext",
        "encrypted-ein",
        "provider_response",
        "review_notes",
        "internal"
    ]) {
        assert.equal(serialized.includes(sensitiveValue), false);
    }
});

test("business insert RLS permits only admins and empty verification-owned fields", () => {
    const migration = readFileSync(
        new URL(
            "../supabase/migrations/20261005130000_milestone_4_1_business_subject_creation.sql",
            import.meta.url
        ),
        "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    assert.match(
        migration,
        /drop policy if exists businesses_insert_member on public\.businesses/
    );
    assert.match(
        migration,
        /create policy businesses_insert_admin on public\.businesses for insert to authenticated/
    );
    assert.match(migration, /public\.is_organization_admin\(organization_id\)/);
    assert.match(migration, /ein_last_four is null/);
    assert.match(migration, /cannabis_license_number is null/);
    assert.match(migration, /cannabis_license_state is null/);
});
