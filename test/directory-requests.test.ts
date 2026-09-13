import assert from "node:assert/strict";
import test from "node:test";
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://frontend.example.test/login";
process.env.PASSWORD_RESET_REDIRECT_URL = "http://localhost:5173/reset-password";
const { createDirectoryRequestSchema, reviewDirectoryRequestSchema, directoryRequestsQuerySchema } = await import("../src/schemas/directory-requests.js");
const { submitDirectoryRequest, reviewDirectoryRequest, getDirectoryRequest, directoryRequestResponse } = await import("../src/services/directory-requests.js");
const id = "11111111-1111-4111-8111-111111111111";
const input = { profileId: id, kind: "contact" as const, message: "A private message", idempotencyKey: id, shareEmail: false };
const row = { id, profile_id: id, kind: "contact", message: "A private message", reply_email: null, status: "pending", created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z", can_review: false };
test("request schema rejects spoofed identity/email, blank text and invalid review status", () => {
    for (const extra of [{ requesterId: id }, { recipientId: id }, { replyEmail: "forged@example.com" }, { status: "resolved" }, { message: "   " }, { idempotencyKey: "unbounded-text" }]) assert.equal(createDirectoryRequestSchema.safeParse({ ...input, ...extra }).success, false);
    assert.equal(createDirectoryRequestSchema.parse({ profileId: id, kind: "claim", message: "Evidence", idempotencyKey: id }).shareEmail, false);
    assert.equal(reviewDirectoryRequestSchema.safeParse({ status: "pending" }).success, false);
    assert.equal(directoryRequestsQuerySchema.safeParse({ pageSize: 101 }).success, false);
});
test("response contains request fields only and never claims email delivery", () => {
    const response = directoryRequestResponse({ ...row, requester_id: id, reviewed_by: id, idempotency_key: id, provider_token: "secret" });
    assert.deepEqual(Object.keys(response), ["id", "profileId", "kind", "message", "replyEmail", "status", "createdAt", "updatedAt", "canReview", "emailDelivery"]);
    assert.equal(response.emailDelivery, "not_configured");
});
test("submit uses one atomic scoped RPC, no client supplied sender or notification call", async () => {
    const calls: unknown[] = [];
    const client = {
        async rpc(name: string, args: unknown) { calls.push({ name, args }); return { data: id, error: null }; },
        from(name: string) { calls.push(name); const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() { return { data: row, error: null }; } }; return chain; }
    };
    await submitDirectoryRequest("access", input, client as never);
    assert.deepEqual(calls, [{ name: "submit_directory_request", args: { p_profile_id: id, p_kind: "contact", p_message: "A private message", p_share_email: false, p_idempotency_key: id } }, "directory_request_read"]);
});
test("idempotency mismatch is a conflict and does not read back or send a notification", async () => {
    const client = { async rpc() { return { data: null, error: { code: "23505", message: "private database detail" } }; } };
    await assert.rejects(submitDirectoryRequest("access", input, client as never), { status: 409, code: "DIRECTORY_REQUEST_CONFLICT" });
});
test("inaccessible request is404; review RPC denial cannot be reported as success", async () => {
    const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() { return { data: null, error: null }; } };
    await assert.rejects(getDirectoryRequest("access", id, { from() { return chain; } } as never), { status: 404 });
    await assert.rejects(reviewDirectoryRequest("access", id, "resolved", { async rpc() { return { data: null, error: { code: "P0002" } }; } } as never), { status: 404 });
});
