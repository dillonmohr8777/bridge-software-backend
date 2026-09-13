import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL = "https://frontend.example.test/login";
process.env.PASSWORD_RESET_REDIRECT_URL = "https://frontend.example.test/reset-password";

const {
    createTinComplyProvider,
    EinProviderRequestError
} = await import("../src/services/ein-verification-provider.js");

const providerResponse = (result: number, message = "Provider result") =>
    new Response(JSON.stringify({
        id: "provider-request-1",
        irsTinNameMatchingResult: { completed: true, message, result }
    }), { status: 200, headers: { "Content-Type": "application/json" } });

test("TIN Comply sends only the required EIN and legal name", async () => {
    let request: Request | undefined;
    const provider = createTinComplyProvider("secret-key", async (input, init) => {
        request = new Request(input, init);
        return providerResponse(7, "TIN and name match EIN records");
    });

    const result = await provider.verifyEin({
        ein: "123456789",
        legalName: "Example LLC"
    });

    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("x-api-key"), "secret-key");
    assert.deepEqual(await request.json(), {
        tin: "123456789",
        name: "Example LLC"
    });
    assert.deepEqual(result, {
        providerReference: "provider-request-1",
        status: "verified",
        reason: "TIN and name match EIN records"
    });
});

test("TIN Comply result codes become review suggestions", async () => {
    const cases = [
        [7, "verified"], [8, "verified"],
        [3, "correction_required"],
        [2, "rejected"], [6, "rejected"]
    ] as const;

    for (const [code, expected] of cases) {
        const provider = createTinComplyProvider("key", async () => providerResponse(code));
        assert.equal(
            (await provider.verifyEin({ ein: "123456789", legalName: "Example LLC" })).status,
            expected
        );
    }
});

test("TIN Comply transport and operational results fail closed", async () => {
    for (const response of [
        new Response("upstream error", { status: 503 }),
        new Response("not-json", { status: 200 }),
        providerResponse(0),
        providerResponse(1),
        providerResponse(17)
    ]) {
        const provider = createTinComplyProvider("key", async () => response);
        await assert.rejects(
            provider.verifyEin({ ein: "123456789", legalName: "Example LLC" }),
            EinProviderRequestError
        );
    }
});
