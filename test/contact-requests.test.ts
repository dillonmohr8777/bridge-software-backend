import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://frontend.example.test/verified";
process.env.PASSWORD_RESET_REDIRECT_URL = "https://frontend.example.test/reset";

const { hasPermission } = await import("../src/middleware/authorization.js");
const {
    contactRequestListQuerySchema,
    contactRequestTransitionSchema,
    createContactRequestSchema
} = await import("../src/schemas/contact-requests.js");
const { createContactRequestHandler } = await import(
    "../src/routes/v1/contact-requests.js"
);

const migration = readFileSync(
    new URL(
        "../supabase/migrations/20261005154000_milestone_4_6_contact_requests.sql",
        import.meta.url
    ),
    "utf8"
).replace(/\s+/g, " ").toLowerCase();

const organizationId = "22222222-2222-4222-8222-222222222222";
const otherOrganizationId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";
const requestId = "44444444-4444-4444-8444-444444444444";

const identity = (role: "owner" | "admin" | "reviewer" | "member") => ({
    userId,
    email: "user@example.com",
    accountType: "standard" as const,
    platformRoles: [],
    profile: { displayName: "User", phone: null },
    memberships: [{
        organizationId,
        organizationName: "Organization",
        organizationType: "brand" as const,
        role,
        status: "active" as const
    }]
});

const validBody = {
    firstName: "Jane",
    workEmail: "jane@example.com",
    phoneNumber: "+1 (555) 555-1212",
    yearsOfService: 4,
    contactPreference: "email" as const,
    message: "Please contact me."
};

test("contact request body accepts confirmed fields and optional bounded message", () => {
    assert.equal(createContactRequestSchema.safeParse(validBody).success, true);
    assert.equal(createContactRequestSchema.safeParse({
        ...validBody,
        message: undefined
    }).success, true);
});

test("contact request body rejects invalid identity/contact values", () => {
    assert.equal(createContactRequestSchema.safeParse({ ...validBody, firstName: "" }).success, false);
    assert.equal(createContactRequestSchema.safeParse({ ...validBody, workEmail: "not-email" }).success, false);
    assert.equal(createContactRequestSchema.safeParse({ ...validBody, phoneNumber: "<script>" }).success, false);
    assert.equal(createContactRequestSchema.safeParse({ ...validBody, yearsOfService: 81 }).success, false);
    assert.equal(createContactRequestSchema.safeParse({ ...validBody, contactPreference: "sms" }).success, false);
    assert.equal(createContactRequestSchema.safeParse({ ...validBody, message: "x".repeat(2001) }).success, false);
});

test("client cannot choose recipient, organization, routing, status, or attachments", () => {
    for (const extra of [
        { recipientUserId: userId },
        { targetOrganizationId: organizationId },
        { routingStatus: "routed" },
        { status: "responded" },
        { attachments: ["private"] }
    ]) {
        assert.equal(createContactRequestSchema.safeParse({ ...validBody, ...extra }).success, false);
    }
});

test("create handler returns new request contract without recipient details", async () => {
    let selectedSlug = "";
    let statusCode = 0;
    let body: unknown;
    const handler = createContactRequestHandler(async (_token, slug) => {
        selectedSlug = slug;
        return { request: {
            id: requestId,
            status: "new" as const,
            routingStatus: "routed" as const,
            createdAt: "2026-10-05T12:00:00.000Z"
        } };
    });
    const response = {
        status(code: number) { statusCode = code; return this; },
        json(value: unknown) { body = value; return this; }
    };
    await handler({
        authentication: { accessToken: "token" },
        params: { slug: "target-business" },
        body: validBody
    } as never, response as never, (() => undefined) as never);
    assert.equal(selectedSlug, "target-business");
    assert.equal(statusCode, 201);
    assert.equal(JSON.stringify(body).includes("recipient"), false);
    assert.equal(JSON.stringify(body).includes("email"), false);
});

test("unauthenticated contact request creation is denied before service use", async () => {
    let called = false;
    let statusCode = 0;
    const handler = createContactRequestHandler(async () => {
        called = true;
        throw new Error("unreachable");
    });
    const response = {
        status(code: number) { statusCode = code; return this; },
        json() { return this; }
    };
    await handler({ params: { slug: "target-business" }, body: validBody } as never,
        response as never, (() => undefined) as never);
    assert.equal(statusCode, 401);
    assert.equal(called, false);
});

test("only owner/admin receive inbox and lifecycle permissions", () => {
    for (const permission of ["contact_request:read", "contact_request:update"] as const) {
        assert.equal(hasPermission(identity("owner"), permission, organizationId), true);
        assert.equal(hasPermission(identity("admin"), permission, organizationId), true);
        assert.equal(hasPermission(identity("member"), permission, organizationId), false);
        assert.equal(hasPermission(identity("reviewer"), permission, organizationId), false);
        assert.equal(hasPermission(identity("owner"), permission, otherOrganizationId), false);
    }
});

test("list and transition query contracts are bounded and whitelisted", () => {
    assert.deepEqual(contactRequestListQuerySchema.parse({}), { limit: 20, offset: 0 });
    assert.equal(contactRequestListQuerySchema.safeParse({ limit: 51 }).success, false);
    assert.equal(contactRequestListQuerySchema.safeParse({ offset: -1 }).success, false);
    assert.equal(contactRequestListQuerySchema.safeParse({ status: "cancelled" }).success, false);
    assert.equal(contactRequestTransitionSchema.safeParse({ status: "viewed" }).success, true);
    assert.equal(contactRequestTransitionSchema.safeParse({ status: "new" }).success, false);
});

test("sender eligibility reuses current publication and trusted verification", () => {
    assert.match(migration, /om\.user_id = actor_id/);
    assert.match(migration, /om\.status = 'active'/);
    assert.match(migration, /dpv\.id = dp\.published_version_id/);
    assert.match(migration, /dp\.status <> 'suspended'/);
    assert.match(migration, /public\.is_business_ein_verified\(b\.id\)/);
    assert.match(migration, /if sender_count <> 1/);
});

test("target is resolved only from an eligible public slug", () => {
    assert.match(migration, /where dpv\.slug = lower\(btrim\(p_target_slug\)\)/);
    assert.match(migration, /o\.status = 'active'/);
    assert.match(migration, /b\.status = 'active'/);
    assert.match(migration, /contactable directory profile not found/);
    assert.doesNotMatch(migration, /p_target_organization_id/);
});

test("routing deterministically selects active admin then active owner", () => {
    assert.match(migration, /om\.role in \('admin'.*'owner'/);
    assert.match(migration, /case om\.role when 'admin'.*then 0 else 1 end/);
    assert.match(migration, /om\.created_at asc, om\.user_id asc/);
});

test("missing recipient is retained safely for manual assignment", () => {
    assert.match(migration, /'needs_assignment'::public\.contact_request_routing_status/);
    assert.match(migration, /'manual_assignment_needed'/);
    assert.doesNotMatch(migration, /support@|admin@|hard.?coded/i);
});

test("initial request status is new and routing is server-owned", () => {
    assert.match(migration, /status public\.contact_request_status not null default 'new'/);
    assert.match(migration, /routed_recipient_membership_id/);
    assert.match(migration, /return query select new_request_id, 'new'/);
});

test("RLS isolates sender and target organization while denying public access", () => {
    assert.match(migration, /sender_user_id = \(select auth\.uid\(\)\)/);
    assert.match(migration, /public\.is_organization_admin\(target_organization_id\)/);
    assert.match(migration, /revoke all on table public\.contact_requests from public, anon, authenticated/);
    assert.doesNotMatch(migration, /grant (insert|update|delete) on table public\.contact_requests to authenticated/);
});

test("inbox and sent RPCs remain actor and tenant scoped", () => {
    assert.match(migration, /list_inbound_contact_requests/);
    assert.match(migration, /not public\.is_organization_admin\(p_organization_id\)/);
    assert.match(migration, /cr\.target_organization_id = p_organization_id/);
    assert.match(migration, /list_sent_contact_requests/);
    assert.match(migration, /cr\.sender_user_id = auth\.uid\(\)/);
});

test("sent projection omits form and internal routing data", () => {
    const start = migration.indexOf("create or replace function public.list_sent_contact_requests");
    const end = migration.indexOf("revoke all on function public.list_sent_contact_requests", start);
    const sentFunction = migration.slice(start, end);
    assert.match(sentFunction, /target_slug text, target_display_name text/);
    assert.doesNotMatch(sentFunction, /work_email|phone_number|recipient|routing_status|sender_organization_id/);
});

test("lifecycle allows documented forward transitions only", () => {
    assert.match(migration, /target\.status = 'new' and p_status in \('viewed', 'responded', 'closed'\)/);
    assert.match(migration, /target\.status = 'viewed' and p_status in \('responded', 'closed'\)/);
    assert.match(migration, /target\.status = 'responded' and p_status = 'closed'/);
    assert.match(migration, /invalid contact request transition/);
});

test("sender cannot mark requests responded through a sender RPC", () => {
    assert.match(migration, /transition_contact_request/);
    assert.match(migration, /not public\.is_organization_admin\(p_organization_id\)/);
    assert.doesNotMatch(migration, /sender_user_id = auth\.uid\(\).*update public\.contact_requests/);
});

test("history and existing audit log record creation, routing, and transitions", () => {
    for (const action of ["created", "routed", "manual_assignment_needed", "viewed", "responded", "closed"]) {
        assert.match(migration, new RegExp(`'${action}'`));
    }
    assert.match(migration, /insert into public\.audit_logs/);
    assert.match(migration, /entity_type, entity_id/);
});

test("contact request tables never enter public Directory projections", () => {
    assert.doesNotMatch(migration, /create or replace function public\.get_public_directory_profile/);
    assert.doesNotMatch(migration, /create or replace function public\.list_public_directory_profiles/);
    assert.doesNotMatch(migration, /ein_last_four|provider_response|verification_evidence/);
});
