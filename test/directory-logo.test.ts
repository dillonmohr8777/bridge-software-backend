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
const { directoryProfileLogoUploadSchema } = await import(
    "../src/schemas/directory-profiles.js"
);
const { createDirectoryProfileLogoUploadHandler } = await import(
    "../src/routes/v1/directory-profiles.js"
);
const { projectPublicDirectoryProfile } = await import(
    "../src/services/directory-profiles.js"
);

const migration = readFileSync(
    new URL(
        "../supabase/migrations/20261005153000_milestone_4_5_directory_profile_logos.sql",
        import.meta.url
    ),
    "utf8"
).replace(/\s+/g, " ").toLowerCase();

const organizationId = "22222222-2222-4222-8222-222222222222";
const otherOrganizationId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";

const identity = (role: "owner" | "admin" | "member" | "reviewer") => ({
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

test("owner and admin may mutate logos while member, reviewer, and other tenants may not", () => {
    assert.equal(hasPermission(identity("owner"), "business:update", organizationId), true);
    assert.equal(hasPermission(identity("admin"), "business:update", organizationId), true);
    assert.equal(hasPermission(identity("member"), "business:update", organizationId), false);
    assert.equal(hasPermission(identity("reviewer"), "business:update", organizationId), false);
    assert.equal(hasPermission(identity("owner"), "business:update", otherOrganizationId), false);
});

test("logo upload accepts only PNG, JPEG, and WebP up to two MiB", () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp"]) {
        assert.equal(directoryProfileLogoUploadSchema.safeParse({
            contentType,
            fileSize: 2 * 1024 * 1024
        }).success, true);
    }
    assert.equal(directoryProfileLogoUploadSchema.safeParse({
        contentType: "image/svg+xml",
        fileSize: 100
    }).success, false);
    assert.equal(directoryProfileLogoUploadSchema.safeParse({
        contentType: "application/javascript",
        fileSize: 100
    }).success, false);
    assert.equal(directoryProfileLogoUploadSchema.safeParse({
        contentType: "image/png",
        fileSize: 2 * 1024 * 1024 + 1
    }).success, false);
});

test("upload body rejects user-selected filenames, paths, and buckets", () => {
    assert.equal(directoryProfileLogoUploadSchema.safeParse({
        contentType: "image/png",
        fileSize: 100,
        path: "../../verification/private.pdf",
        bucket: "verification-documents",
        filename: "logo.png"
    }).success, false);
});

test("authenticated upload handler returns only the signed upload contract", async () => {
    let receivedOrganization = "";
    let statusCode = 0;
    let body: unknown;
    const handler = createDirectoryProfileLogoUploadHandler(
        async (_token, selectedOrganization) => {
            receivedOrganization = selectedOrganization;
            return {
                signedUrl: "https://storage.example.test/signed-upload",
                expiresInSeconds: 7200
            };
        }
    );
    const response = {
        status(code: number) { statusCode = code; return this; },
        json(value: unknown) { body = value; return this; }
    };
    await handler({
        authentication: { accessToken: "token" },
        params: { organizationId },
        body: { contentType: "image/png", fileSize: 100 }
    } as never, response as never, (() => undefined) as never);
    assert.equal(receivedOrganization, organizationId);
    assert.equal(statusCode, 201);
    assert.deepEqual(body, {
        upload: {
            signedUrl: "https://storage.example.test/signed-upload",
            expiresInSeconds: 7200
        }
    });
});

test("unauthenticated upload handler is denied", async () => {
    let called = false;
    let statusCode = 0;
    const handler = createDirectoryProfileLogoUploadHandler(async () => {
        called = true;
        throw new Error("unreachable");
    });
    const response = {
        status(code: number) { statusCode = code; return this; },
        json() { return this; }
    };
    await handler({ params: { organizationId } } as never, response as never, (() => undefined) as never);
    assert.equal(statusCode, 401);
    assert.equal(called, false);
});

test("private bucket enforces MIME and size without verification-document mixing", () => {
    assert.match(migration, /'directory-media', 'directory-media', false, 2097152/);
    assert.match(migration, /array\['image\/png', 'image\/jpeg', 'image\/webp'\]/);
    assert.doesNotMatch(migration, /insert into storage\.buckets[^;]*verification/);
});

test("database logo mutation is tenant-admin scoped and validates generated paths", () => {
    assert.match(migration, /public\.is_organization_admin\(p_organization_id\)/);
    assert.match(migration, /p_organization_id::text \|\| '\/' \|\| target_profile\.id::text \|\| '\/logo\/'/);
    assert.match(migration, /\(png\|jpg\|webp\)/);
    assert.match(migration, /grant execute on function public\.set_directory_profile_logo\(uuid, text\) to authenticated/);
});

test("logo changes move approved content to draft without clearing publication", () => {
    assert.match(migration, /new\.logo_storage_path is distinct from old\.logo_storage_path/);
    assert.match(migration, /new\.status := 'draft'/);
    assert.doesNotMatch(migration, /new\.published_version_id := null/);
});

test("approval copies the working logo into the immutable snapshot", () => {
    assert.match(migration, /before insert on public\.directory_profile_versions/);
    assert.match(migration, /select dp\.logo_storage_path into new\.logo_storage_path/);
});

test("replacement and deletion never physically remove a published object", () => {
    assert.doesNotMatch(migration, /delete from storage\.objects/);
    assert.doesNotMatch(migration, /storage\.objects[^;]*for delete/);
});

test("public response exposes stable logo URL but never the storage path", () => {
    const projected = projectPublicDirectoryProfile({
        slug: "published",
        display_name: "Published",
        summary: null,
        story: null,business_type:"brand",categories:[],city:null,state:null,region:null,
        public_email:null,public_phone:null,license_type:null,license_number:null,links:[],
        legal_name:"Published LLC",dba_name:null,
        business_name: "Published LLC",
        verified: true,
        has_logo: true,
        logo_storage_path: "private/path/that-must-not-leak.png"
    });
    assert.equal(projected.logoUrl, "/api/v1/directory/profiles/published/logo");
    assert.equal(JSON.stringify(projected).includes("private/path"), false);
});

test("public logo path lookup uses only eligible published snapshot media", () => {
    assert.match(migration, /get_public_directory_profile_logo_path/);
    assert.match(migration, /dpv\.id = dp\.published_version_id/);
    assert.match(migration, /dpv\.logo_storage_path is not null/);
    assert.match(migration, /dp\.status <> 'suspended'/);
    assert.match(migration, /public\.is_business_ein_verified\(b\.id\)/);
});

test("raw public RPCs reveal only has_logo, not private object paths", () => {
    assert.match(migration, /dpv\.logo_storage_path is not null/);
    assert.match(migration, /get_public_directory_profile_logo_path\(text\) to service_role/);
    assert.doesNotMatch(migration, /get_public_directory_profile_logo_path\(text\) to anon/);
});
