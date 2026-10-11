import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { Server } from "node:http";

process.env.NODE_ENV = "test";
process.env.DEPLOYMENT_ENVIRONMENT = "staging";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://bridge-connected-signal-dev.netlify.app",
    "https://bridge-connected-signal.netlify.app"
].join(",");
process.env.EMAIL_VERIFICATION_REDIRECT_URL =
    "https://frontend.example.test/login?verified=true";
process.env.PASSWORD_RESET_REDIRECT_URL = "http://localhost:5173/reset-password";

const { app } = await import("../src/app.js");
const { corsOriginsSchema } = await import("../src/config/env.js");
let server: Server;
let baseUrl: string;

before(async () => {
    await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                throw new Error("Test server did not bind to a TCP port.");
            }
            baseUrl = `http://127.0.0.1:${address.port}`;
            resolve();
        });
    });
});

after(async () => {
    await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
    );
});

test("v1 health is public and stable", async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        status: "ok",
        service: "bridge-api"
    });
});

test("CORS origin configuration trims whitespace and ignores empty entries", () => {
    assert.deepEqual(
        corsOriginsSchema.parse(
            " http://localhost:3000, ,https://bridge-connected-signal-dev.netlify.app "
        ),
        [
            "http://localhost:3000",
            "https://bridge-connected-signal-dev.netlify.app"
        ]
    );
});

test("CORS origin configuration rejects empty, malformed, and wildcard values", () => {
    for (const value of ["", " , ", "not-a-url", "*", "https://*.example.com"]) {
        assert.equal(corsOriginsSchema.safeParse(value).success, false);
    }
});

test("v1 version is public and does not expose sensitive configuration", async () => {
    const response = await fetch(`${baseUrl}/api/v1/version`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, {
        service: "bridge-api",
        version: "0.1.0",
        environment: "staging"
    });
    const serialized = JSON.stringify(body).toLowerCase();
    for (const value of ["key", "token", "password", "database", "supabase_url"]) {
        assert.equal(serialized.includes(value), false);
    }
});

for (const origin of [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://bridge-connected-signal-dev.netlify.app",
    "https://bridge-connected-signal.netlify.app"
]) {
    test(`CORS allows ${origin}`, async () => {
        const response = await fetch(`${baseUrl}/api/v1/health`, {
            headers: { Origin: origin }
        });
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        assert.equal(response.headers.get("access-control-allow-credentials"), "true");
        assert.match(response.headers.get("vary") ?? "", /(?:^|,\s*)Origin(?:,|$)/i);
    });
}

test("CORS does not grant access to an unknown origin", async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { Origin: "https://malicious.example" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.has("access-control-allow-origin"), false);
});

test("allowed CORS preflight supports Authorization and required methods", async () => {
    const response = await fetch(`${baseUrl}/api/v1/session`, {
        method: "OPTIONS",
        headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type"
        }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("vary") ?? "", /(?:^|,\s*)Origin(?:,|$)/i);
    assert.equal(
        response.headers.get("access-control-allow-origin"),
        "http://localhost:3000"
    );
    const headers = response.headers.get("access-control-allow-headers") ?? "";
    assert.match(headers.toLowerCase(), /authorization/);
    assert.match(headers.toLowerCase(), /content-type/);
    const methods = response.headers.get("access-control-allow-methods") ?? "";
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        assert.match(methods, new RegExp(`(?:^|,)${method}(?:,|$)`));
    }
});
