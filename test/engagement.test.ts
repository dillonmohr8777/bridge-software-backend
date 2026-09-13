import assert from "node:assert/strict";
import test from "node:test";
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://frontend.example.test/login?verified=true";
process.env.PASSWORD_RESET_REDIRECT_URL = "http://localhost:5173/reset-password";
const schemas = await import("../src/schemas/engagement.js");
const service = await import("../src/services/engagement.js");
const userId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const identity = { userId, email: null, accountType: "sales_rep" as const, profile: null, platformRoles: [], memberships: [] };
const post = { id: userId, profile_id: profileId, type: "news", title: "Update", body: "Details", status: "draft", created_at: "2026-09-12", updated_at: "2026-09-12" };
type Result = { data: unknown; error: null | { code: string }; count?: number };
const mock = (results: Result[]) => {
    const calls: Array<[string, ...unknown[]]> = [];
    const client = { from(table: string) {
        calls.push(["from", table]);
        const result = results.shift();
        assert.ok(result, "unexpected database request");
        const builder = new Proxy({}, { get(_target, key) {
            if (key === "then") return Promise.resolve(result).then.bind(Promise.resolve(result));
            return (...args: unknown[]) => { calls.push([String(key), ...args]); return builder; };
        } });
        return builder;
    } };
    return { client: client as never, calls, results };
};
test("engagement validates bounds and rejects author, verification and recipient overrides", () => {
    const input = { profileId, type: "news", title: " T ", body: " B " };
    assert.equal(schemas.createPostSchema.parse(input).status, "draft");
    for (const key of ["authorId", "verified", "userId", "created_at"]) assert.equal(schemas.createPostSchema.safeParse({ ...input, [key]: userId }).success, false);
    assert.equal(schemas.updatePostSchema.safeParse({ profileId }).success, false);
    assert.equal(schemas.updatePostSchema.safeParse({}).success, false);
    assert.equal(schemas.engagementPageSchema.safeParse({ pageSize: 101 }).success, false);
    assert.equal(schemas.markReadSchema.safeParse({ read: true, userId }).success, false);
    assert.equal(schemas.markReadSchema.safeParse({ read: false }).success, false);
});
test("post and notification projections discard internal identifiers and secrets", () => {
    assert.equal(JSON.stringify(service.postResponse({ ...post, user_id: "secret", audit: "secret" })).includes("secret"), false);
    assert.equal(JSON.stringify(service.notificationResponse({ ...post, user_id: "secret" })).includes("secret"), false);
});
test("public posts use gated view with stable bounded pagination", async () => {
    const db = mock([{ data: [{ ...post, status: "published" }], error: null, count: 21 }]);
    const result = await service.listPosts({ page: 2, pageSize: 20, profileId }, db.client);
    assert.deepEqual(result.pagination, { page: 2, pageSize: 20, total: 21, totalPages: 2 });
    assert.deepEqual(db.calls[0], ["from", "engagement_public_posts"]);
    assert.ok(db.calls.some(call => call[0] === "range" && call[1] === 20 && call[2] === 39));
});
test("foreign owner and unverified profile cannot publish", async () => {
    const input = schemas.createPostSchema.parse({ profileId, type: "news", title: "T", body: "B", status: "published" });
    const foreign = mock([{ data: { organization_id: null, owner_user_id: organizationId }, error: null }]);
    await assert.rejects(service.createPost("token", identity, input, foreign.client), { code: "ENGAGEMENT_FORBIDDEN" });
    const unverified = mock([{ data: { organization_id: null, owner_user_id: userId }, error: null }, { data: null, error: null }]);
    await assert.rejects(service.createPost("token", identity, input, unverified.client), { code: "VERIFIED_PUBLIC_PROFILE_REQUIRED" });
    assert.equal(unverified.calls.some(call => call[0] === "insert"), false);
});
test("active membership does not bypass inactive organization", async () => {
    const db = mock([{ data: { organization_id: organizationId, owner_user_id: null }, error: null }, { data: { status: "suspended" }, error: null }]);
    const owner = { ...identity, memberships: [{ organizationId, organizationName: "Org", organizationType: "brand" as const, role: "owner" as const, status: "active" as const }] };
    await assert.rejects(service.createPost("token", owner, schemas.createPostSchema.parse({ profileId, type: "news", title: "T", body: "B" }), db.client), { code: "ENGAGEMENT_FORBIDDEN" });
});
test("draft creation derives attribution solely from authorized profile", async () => {
    const db = mock([{ data: { organization_id: null, owner_user_id: userId }, error: null }, { data: post, error: null }]);
    await service.createPost("token", identity, schemas.createPostSchema.parse({ profileId, type: "news", title: "T", body: "B" }), db.client);
    assert.deepEqual(db.calls.find(call => call[0] === "insert"), ["insert", { profile_id: profileId, type: "news", title: "T", body: "B", status: "draft" }]);
});
test("editing an existing published post repeats the current verification check", async () => {
    const db = mock([{ data: { profile_id: profileId, status: "published" }, error: null }, { data: { organization_id: null, owner_user_id: userId }, error: null }, { data: null, error: null }]);
    await assert.rejects(service.updatePost("token", identity, userId, { title: "Changed" }, db.client), { code: "VERIFIED_PUBLIC_PROFILE_REQUIRED" });
});
test("save is conflict-ignore idempotent and private profiles fail before insertion", async () => {
    const hidden = mock([{ data: null, error: null }]);
    await assert.rejects(service.setSavedProfile("token", userId, profileId, true, hidden.client), { code: "PROFILE_NOT_FOUND" });
    const db = mock([{ data: { id: profileId }, error: null }, { data: null, error: null }]);
    assert.deepEqual(await service.setSavedProfile("token", userId, profileId, true, db.client), { saved: true });
    assert.deepEqual(db.calls.find(call => call[0] === "upsert"), ["upsert", { user_id: userId, profile_id: profileId }, { onConflict: "user_id,profile_id", ignoreDuplicates: true }]);
    const deleted = mock([{ data: null, error: null }]);
    assert.deepEqual(await service.setSavedProfile("token", userId, profileId, false, deleted.client), { saved: false });
    assert.ok(deleted.calls.some(call => call[0] === "eq" && call[1] === "user_id" && call[2] === userId));
});
test("saved list reads the visibility-filtered projection", async () => {
    const db = mock([{ data: [], error: null, count: 0 }]);
    await service.listSavedProfiles("token", { page: 1, pageSize: 20 }, db.client);
    assert.deepEqual(db.calls[0], ["from", "engagement_saved_profile_read"]);
});
test("saved status scopes the private safe view to one profile and fails closed on errors", async () => {
    for (const data of [null, { profile_id: profileId }]) {
        const db = mock([{ data, error: null }]);
        assert.deepEqual(await service.isSavedProfile("token", profileId, db.client), { saved: data !== null });
        assert.deepEqual(db.calls[0], ["from", "engagement_saved_profile_read"]);
        assert.ok(db.calls.some(call => call[0] === "eq" && call[1] === "profile_id" && call[2] === profileId));
    }
    const failed = mock([{ data: null, error: { code: "unavailable" } }]);
    await assert.rejects(service.isSavedProfile("token", profileId, failed.client), { code: "ENGAGEMENT_UNAVAILABLE" });
});
test("mark read scopes both write and read to caller and preserves existing read time", async () => {
    const db = mock([{ data: null, error: null }, { data: { id: profileId, read_at: "earlier" }, error: null }]);
    const result = await service.markNotificationRead("token", userId, profileId, db.client);
    assert.equal(result.readAt, "earlier");
    assert.equal(db.calls.filter(call => call[0] === "eq" && call[1] === "user_id" && call[2] === userId).length, 2);
    assert.ok(db.calls.some(call => call[0] === "is" && call[1] === "read_at" && call[2] === null));
});
