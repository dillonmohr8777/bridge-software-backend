import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://contact-test.example.test";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://frontend.example.test/verified";
process.env.PASSWORD_RESET_REDIRECT_URL = "https://frontend.example.test/reset";

const services = await import("../src/services/contact-requests.js");
const handlers = await import("../src/routes/v1/contact-requests.js");
const organizationId = "22222222-2222-4222-8222-222222222222";
const requestId = "44444444-4444-4444-8444-444444444444";
const query = { limit: 20, offset: 0 };
const input = { firstName: "Jane", workEmail: "jane@example.test", phoneNumber: "+15555551212", yearsOfService: 4, contactPreference: "email" as const };
const calls = [
    { name: "discovery", rpc: "list_contact_inbox_organizations", call: () => services.listContactInboxOrganizations("test-user-token"), handler: () => handlers.createContactInboxOrganizationsHandler() },
    { name: "candidates", rpc: "list_contact_routing_candidates", call: () => services.listContactRoutingCandidates("test-user-token", organizationId), handler: () => handlers.createContactRoutingCandidatesHandler() },
    { name: "create", rpc: "create_contact_request", call: () => services.createContactRequest("test-user-token", "target", input), handler: () => handlers.createContactRequestHandler() },
    { name: "inbound", rpc: "list_inbound_contact_requests", call: () => services.listInboundContactRequests("test-user-token", organizationId, query), handler: () => handlers.createInboundContactRequestsHandler() },
    { name: "sent", rpc: "list_sent_contact_requests", call: () => services.listSentContactRequests("test-user-token", query), handler: () => handlers.createSentContactRequestsHandler() },
    { name: "transition", rpc: "transition_contact_request", call: () => services.transitionContactRequest("test-user-token", organizationId, requestId, { status: "viewed" }), handler: () => handlers.createTransitionContactRequestHandler() }
];

test("database permission denials remain 403 through all contact service and HTTP handlers", async (t) => {
    const originalFetch = globalThis.fetch;
    let expectedRpc = "";
    let responseCode = "42501";
    let count = 0;
    globalThis.fetch = async (request, init) => {
        const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
        assert.equal(url, "https://contact-test.example.test/rest/v1/rpc/" + expectedRpc);
        const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
        assert.equal(headers.get("authorization"), "Bearer test-user-token");
        count++;
        return new Response(JSON.stringify({ code: responseCode, message: "private database detail must not escape", details: null, hint: null }), { status: 403, headers: { "Content-Type": "application/json" } });
    };
    try {
        for (const scenario of calls) {
            await t.test(scenario.name, async () => {
                expectedRpc = scenario.rpc;
                responseCode = "42501";
                await assert.rejects(scenario.call, (error: unknown) =>
                    error instanceof services.ContactRequestServiceError && error.code === "CONTACT_REQUEST_FORBIDDEN");
                let statusCode = 0;
                let body: unknown;
                const response = { locals: { validatedQuery: query }, status(code: number) { statusCode = code; return this; }, json(value: unknown) { body = value; return this; } };
                await scenario.handler()({
                    authentication: { accessToken: "test-user-token" },
                    params: { slug: "target", organizationId, requestId },
                    body: scenario.name === "transition" ? { status: "viewed" } : input
                } as never, response as never, (() => undefined) as never);
                assert.equal(statusCode, 403);
                assert.deepEqual(body, { error: "CONTACT_REQUEST_FORBIDDEN", message: "You do not have permission to perform this action." });
            });
        }
        expectedRpc = "list_inbound_contact_requests";
        responseCode = "XX000";
        await assert.rejects(() => services.listInboundContactRequests("test-user-token", organizationId, query), (error: unknown) =>
            error instanceof services.ContactRequestServiceError && error.code === "CONTACT_REQUEST_FAILED");
        assert.equal(count, 13);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
