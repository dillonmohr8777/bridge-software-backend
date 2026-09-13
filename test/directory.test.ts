import assert from "node:assert/strict";
import test from "node:test";
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://frontend.example.test/login";
process.env.PASSWORD_RESET_REDIRECT_URL = "http://localhost:5173/reset-password";
const { createDirectorySchema, updateDirectorySchema, directoryQuerySchema } = await import("../src/schemas/directory.js");
const { canManageDirectory, createDirectoryProfile, updateDirectoryProfile, directoryProfileResponse, listDirectory, getDirectoryProfile } = await import("../src/services/directory.js");
const userId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const profileId = "33333333-3333-4333-8333-333333333333";
const identity = { userId, email: "private@test.invalid", accountType: "standard" as const, platformRoles: [], profile: null, memberships: [{ organizationId: orgId, organizationName: "Company", organizationType: "brand" as const, status: "active" as const, role: "owner" as const }] };
const row = { id: profileId, slug: "company", role: "brand", name: "Company", company_name: "Company", description: "", location: "Pittsburgh", state: "PA", service_territories: ["PA"], products: ["Flower"], categories: [], logo_url: null, visibility: "public", verified: false, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" };
function fakeClient(results: unknown[]) {
    const calls: Array<[string, ...unknown[]]> = [];
    const client = { from(table: string) {
        calls.push(["from", table]);
        const result = results.shift();
        const chain: Record<string, unknown> = { then(resolve: (value: unknown) => unknown) { return Promise.resolve(result).then(resolve); } };
        for (const method of ["select", "eq", "in", "or", "contains", "ilike", "order", "range", "insert", "update", "single", "maybeSingle"]) {
            chain[method] = (...args: unknown[]) => { calls.push([method, ...args]); return chain; };
        }
        return chain;
    } };
    return { client: client as never, calls };
}
test("strict directory inputs default private and reject privilege or unsafe URL writes", () => {
    assert.equal(createDirectorySchema.parse({ name: "Company", slug: "company" }).visibility, "private");
    for (const payload of [{ verified: true }, { role: "brand" }, { owner_user_id: userId }, { organizationId: orgId }, { logoUrl: "javascript:alert(1)" }, { logoUrl: "https://user:secret@example.com/logo.png" }, {}]) {
        assert.equal(updateDirectorySchema.safeParse(payload).success, false, JSON.stringify(payload));
    }
    assert.equal(updateDirectorySchema.safeParse({ logoUrl: "https://cdn.example.com/logo.png", state: "pa", visibility: "public" }).success, true);
    assert.equal(createDirectorySchema.safeParse({ name: "Company", slug: "mine" }).success, false);
});
test("filters parse false correctly and bound pagination", () => {
    assert.equal(directoryQuerySchema.parse({ verified: "false" }).verified, false);
    for (const query of [{ verified: "1" }, { page: 0 }, { pageSize: 101 }, { state: "Pennsylvania" }, { role: "admin" }, { query: ["a", "b"] }]) assert.equal(directoryQuerySchema.safeParse(query).success, false);
});
test("membership authorization denies removed, suspended, member and reviewer roles", () => {
    const owner = { organization_id: orgId, owner_user_id: null };
    assert.equal(canManageDirectory(identity, owner), true);
    for (const status of ["removed", "suspended", "invited"] as const) assert.equal(canManageDirectory({ ...identity, memberships: [{ ...identity.memberships[0]!, status }] }, owner), false);
    for (const role of ["member", "reviewer"] as const) assert.equal(canManageDirectory({ ...identity, memberships: [{ ...identity.memberships[0]!, role }] }, owner), false);
    assert.equal(canManageDirectory({ ...identity, memberships: [] }, owner), false);
    assert.equal(canManageDirectory(identity, { organization_id: null, owner_user_id: userId }), false);
    assert.equal(canManageDirectory({ ...identity, accountType: "sales_rep" }, { organization_id: null, owner_user_id: userId }), true);
    assert.equal(canManageDirectory({ ...identity, accountType: "sales_rep" }, { organization_id: null, owner_user_id: orgId }), false);
});
test("public projection drops every private or unexpected field", () => {
    const result = directoryProfileResponse({ ...row, email: "private@test.invalid", ein: "123", phone: "555", owner_user_id: userId, organization_id: orgId, documents: ["secret"] });
    assert.deepEqual(Object.keys(result), ["id", "slug", "role", "name", "companyName", "description", "location", "state", "serviceTerritories", "products", "categories", "logoUrl", "visibility", "verified", "verificationStatus", "createdAt", "updatedAt"]);
    assert.equal(result.verificationStatus, "pending");
});
test("list executes public, role, state, false verification filters and stable page range", async () => {
    const fake = fakeClient([{ data: [row], error: null, count: 51 }]);
    const result = await listDirectory(directoryQuerySchema.parse({ role: "brand", state: "pa", verified: "false", page: "2", pageSize: "24", query: "name),verified.eq.true", territory: "oh", category: "Flower", product: "Extract" }), fake.client);
    assert.equal(result.pagination.totalPages, 3);
    assert.deepEqual(fake.calls.filter(c => c[0] === "eq"), [["eq", "visibility", "public"], ["eq", "role", "brand"], ["eq", "state", "PA"], ["eq", "verified", false]]);
    assert.deepEqual(fake.calls.find(c => c[0] === "range"), ["range", 24, 47]);
    assert.deepEqual(fake.calls.filter(c => c[0] === "order"), [["order", "name"], ["order", "id"]]);
    assert.deepEqual(fake.calls.filter(c => c[0] === "contains"), [["contains", "service_territories", ["OH"]], ["contains", "categories", ["Flower"]], ["contains", "products", ["Extract"]]]);
    assert.deepEqual(fake.calls.find(c => c[0] === "ilike"), ["ilike", "search_text", "%name),verified.eq.true%"]);
    assert.equal(fake.calls.some(c => c[0] === "or"), false);
});
test("public detail filters private rows and returns not found", async () => {
    const fake = fakeClient([{ data: null, error: null }]);
    await assert.rejects(getDirectoryProfile("company", fake.client), { status: 404 });
    assert.ok(fake.calls.some(c => c[0] === "eq" && c[1] === "visibility" && c[2] === "public"));
});
test("unauthorized create never attempts a write; inactive org is denied", async () => {
    const fake = fakeClient([]);
    await assert.rejects(createDirectoryProfile("token", { ...identity, memberships: [] }, createDirectorySchema.parse({ organizationId: orgId, name: "Name", slug: "name" }), fake.client), { status: 403 });
    assert.equal(fake.calls.length, 0);
    const inactive = fakeClient([{ data: { id: orgId, status: "suspended", organization_type: "brand" }, error: null }]);
    await assert.rejects(createDirectoryProfile("token", identity, createDirectorySchema.parse({ organizationId: orgId, name: "Name", slug: "name" }), inactive.client), { status: 403 });
    assert.equal(inactive.calls.some(c => c[0] === "insert"), false);
});
test("create persists private default and server identity then returns safe stored profile", async () => {
    const fake = fakeClient([{ data: { id: orgId, status: "active", organization_type: "brand" }, error: null }, { data: { id: profileId }, error: null }, { data: { ...row, visibility: "private" }, error: null }]);
    const result = await createDirectoryProfile("token", identity, createDirectorySchema.parse({ organizationId: orgId, name: "Company", slug: "company" }), fake.client);
    assert.equal(result.visibility, "private");
    const payload = fake.calls.find(c => c[0] === "insert")![1] as Record<string, unknown>;
    assert.equal(payload.organization_id, orgId);
    assert.equal(payload.owner_user_id, null);
    assert.equal(payload.visibility, "private");
    assert.equal("verified" in payload, false);
});
test("cross-owner edit is rejected before update and duplicate slug reports conflict", async () => {
    const fake = fakeClient([{ data: { organization_id: orgId, owner_user_id: null }, error: null }]);
    await assert.rejects(updateDirectoryProfile("token", { ...identity, memberships: [] }, profileId, { name: "Hijacked" }, fake.client), { status: 403 });
    assert.equal(fake.calls.some(c => c[0] === "update"), false);
    const conflict = fakeClient([{ data: { organization_id: orgId, owner_user_id: null }, error: null }, { data: { status: "active", organization_type: "brand" }, error: null }, { data: null, error: { code: "23505" } }]);
    await assert.rejects(updateDirectoryProfile("token", identity, profileId, { slug: "taken" }, conflict.client), { status: 409 });
});

