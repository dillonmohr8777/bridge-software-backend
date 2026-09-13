import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://frontend.example.test/login";
process.env.PASSWORD_RESET_REDIRECT_URL = "https://frontend.example.test/reset-password";

const { env } = await import("../src/config/index.js");
const { sendDirectoryEmail } = await import("../src/services/directory-email.js");

test("Resend request uses a stable idempotency key and generic private-safe content", async () => {
    const priorKey = env.RESEND_API_KEY;
    const priorFrom = env.DIRECTORY_EMAIL_FROM;
    env.RESEND_API_KEY = "re_test";
    env.DIRECTORY_EMAIL_FROM = "Bridge <updates@example.com>";
    let captured: { url?: string; init?: RequestInit } = {};
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init };
        return new Response(JSON.stringify({ id: "provider-message" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    }) as typeof fetch;
    try {
        const result = await sendDirectoryEmail({
            outbox_id: "c1111111-1111-4111-8111-111111111111",
            request_id: "c2222222-2222-4222-8222-222222222222",
            event_type: "submitted",
            recipient_email: "owner@example.com",
            request_kind: "contact",
            request_status: "pending"
        }, fetcher);
        assert.equal(result, "provider-message");
        assert.equal(captured.url, "https://api.resend.com/emails");
        assert.equal(new Headers(captured.init?.headers).get("Idempotency-Key"), "bridge-directory/submitted/c1111111-1111-4111-8111-111111111111");
        const body = JSON.parse(String(captured.init?.body));
        assert.deepEqual(body.to, ["owner@example.com"]);
        assert.equal(body.text.includes("Private message"), false);
    } finally {
        env.RESEND_API_KEY = priorKey;
        env.DIRECTORY_EMAIL_FROM = priorFrom;
    }
});
