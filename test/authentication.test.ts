import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import express from "express";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.CORS_ORIGINS = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_REDIRECT_URL =
    "https://frontend.example.test/login?verified=true";
process.env.PASSWORD_RESET_REDIRECT_URL = "http://localhost:5173/reset-password";

const { registrationSchema } = await import(
    "../src/schemas/authentication.js"
);
const {
    buildRegistrationCredentials,
    buildResendVerificationCredentials,
    classifySupabaseAuthFailure,
    logout
} = await import("../src/services/authentication.js");
const { authFailureStatus } = await import("../src/routes/v1/auth.js");
const { createLoginHandler, createLogoutHandler } = await import(
    "../src/routes/v1/auth.js"
);
const {
    ACCESS_TOKEN_COOKIE,
    REFRESH_TOKEN_COOKIE,
    getCookieSecurity
} = await import("../src/http/auth-cookies.js");

test("registration rate limits retain HTTP 429 semantics", () => {
    const error = classifySupabaseAuthFailure(
        "register",
        { code: "over_email_send_rate_limit", status: 429 },
        "AUTH_REGISTRATION_FAILED"
    );
    assert.equal(error.code, "AUTH_RATE_LIMITED");
    assert.equal(error.providerStatus, 429);
    assert.equal(authFailureStatus(error), 429);
});

test("unverified login is distinguished by provider code", () => {
    const error = classifySupabaseAuthFailure(
        "login",
        { code: "email_not_confirmed", status: 400 },
        "AUTH_LOGIN_FAILED"
    );
    assert.equal(error.code, "EMAIL_NOT_VERIFIED");
    assert.equal(authFailureStatus(error), 403);
});

test("other login rejections remain non-enumerating", () => {
    for (const code of ["invalid_credentials", "user_not_found"]) {
        const error = classifySupabaseAuthFailure(
            "login",
            { code, status: 400 },
            "AUTH_LOGIN_FAILED"
        );
        assert.equal(error.code, "INVALID_CREDENTIALS");
        assert.equal(authFailureStatus(error), 401);
    }
});

test("registration accepts and normalizes displayName", () => {
    const input = registrationSchema.parse({
        email: "USER@example.com",
        password: "ExamplePassword123!",
        displayName: "  Miraj Mor  "
    });
    assert.equal(input.email, "user@example.com");
    assert.equal(input.displayName, "Miraj Mor");
    assert.deepEqual(buildRegistrationCredentials(input).options, {
        emailRedirectTo: "https://frontend.example.test/login?verified=true",
        data: { display_name: "Miraj Mor" }
    });
});

test("registration remains valid without displayName", () => {
    const input = registrationSchema.parse({
        email: "user@example.com",
        password: "ExamplePassword123!"
    });
    assert.equal(input.displayName, undefined);
    assert.deepEqual(buildRegistrationCredentials(input).options, {
        emailRedirectTo: "https://frontend.example.test/login?verified=true"
    });
});

test("resend verification uses the configured email redirect", () => {
    assert.deepEqual(
        buildResendVerificationCredentials({ email: "user@example.com" }),
        {
            type: "signup",
            email: "user@example.com",
            options: {
                emailRedirectTo:
                    "https://frontend.example.test/login?verified=true"
            }
        }
    );
});

test("successful login keeps credentials in HttpOnly cookies and returns only the user", async () => {
    const result = {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: 1234,
        expiresIn: 3600,
        tokenType: "bearer",
        user: { id: "11111111-1111-4111-8111-111111111111", email: "user@example.com" }
    };
    const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    let body: unknown;
    await createLoginHandler(async () => result)(
        { body: { email: "user@example.com", password: "secret" } } as never,
        {
            cookie(name: string, value: string, options: Record<string, unknown>) {
                cookies.push({ name, value, options }); return this;
            },
            status() { return this; },
            json(value: unknown) { body = value; return this; }
        } as never,
        (() => undefined) as never
    );
    assert.deepEqual(body, { user: result.user });
    assert.deepEqual(cookies.map(({ value }) => value), [result.accessToken, result.refreshToken]);
    assert.deepEqual(cookies.map(({ name }) => name), [
        ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE
    ]);
    for (const cookie of cookies) {
        assert.equal(cookie.options.httpOnly, true);
        assert.equal(cookie.options.path, "/api/v1");
        assert.equal(cookie.options.sameSite, "lax");
        assert.equal(cookie.options.secure, false);
    }
    assert.equal(cookies[0]?.options.maxAge, 3_600_000);
    assert.equal("maxAge" in cookies[1]!.options, false);
});

test("Express emits both authentication Set-Cookie headers", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.post("/api/v1/auth/login", createLoginHandler(async () => ({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: 1234,
        expiresIn: 3600,
        tokenType: "bearer",
        user: { id: "11111111-1111-4111-8111-111111111111", email: "user@example.com" }
    })));
    const server = await new Promise<Server>((resolve) => {
        const listening = testApp.listen(0, "127.0.0.1", () => resolve(listening));
    });

    try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const response = await fetch(
            `http://127.0.0.1:${address.port}/api/v1/auth/login`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: "user@example.com", password: "secret" })
            }
        );
        const setCookies = response.headers.getSetCookie();
        assert.equal(setCookies.length, 2);
        assert.match(setCookies[0]!, /^bridge_access_token=/);
        assert.match(setCookies[1]!, /^bridge_refresh_token=/);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => error ? reject(error) : resolve())
        );
    }
});

test("production and staging cookie transport is Secure and SameSite=None", () => {
    assert.deepEqual(getCookieSecurity("production", undefined), {
        secure: true,
        sameSite: "none"
    });
    assert.deepEqual(getCookieSecurity("development", "staging"), {
        secure: true,
        sameSite: "none"
    });
    assert.deepEqual(getCookieSecurity("development", "production"), {
        secure: true,
        sameSite: "none"
    });
    assert.deepEqual(getCookieSecurity("development", "development"), {
        secure: false,
        sameSite: "lax"
    });
});

test("logout clears both cookies with matching attributes and revokes provider session", async () => {
    const cleared: Array<{ name: string; options: Record<string, unknown> }> = [];
    let revoked: unknown[] = [];
    let status = 0;
    await createLogoutHandler(async (...tokens) => { revoked = tokens; })(
        {
            get(name: string) {
                return name === "cookie"
                    ? `${ACCESS_TOKEN_COOKIE}=access; ${REFRESH_TOKEN_COOKIE}=refresh`
                    : undefined;
            }
        } as never,
        {
            clearCookie(name: string, options: Record<string, unknown>) {
                cleared.push({ name, options }); return this;
            },
            status(value: number) { status = value; return this; },
            send() { return this; }
        } as never,
        (() => undefined) as never
    );
    assert.equal(status, 204);
    assert.deepEqual(revoked, ["access", "refresh"]);
    assert.deepEqual(cleared.map(({ name }) => name), [
        ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE
    ]);
    for (const cookie of cleared) assert.equal(cookie.options.path, "/api/v1");
});

test("logout revokes only the current Supabase refresh session", async (context) => {
    const { createPublicSupabaseClient } = await import("../src/lib/supabase.js");
    const authPrototype = Object.getPrototypeOf(createPublicSupabaseClient().auth);
    const calls: Array<{ operation: string; value: unknown }> = [];
    context.mock.method(authPrototype, "setSession", async (tokens: unknown) => {
        calls.push({ operation: "setSession", value: tokens });
        return { data: { session: {} }, error: null } as never;
    });
    context.mock.method(authPrototype, "signOut", async (options: unknown) => {
        calls.push({ operation: "signOut", value: options });
        return { error: null } as never;
    });

    await logout("access", "refresh");

    assert.deepEqual(calls, [
        {
            operation: "setSession",
            value: { access_token: "access", refresh_token: "refresh" }
        },
        { operation: "signOut", value: { scope: "local" } }
    ]);
});
