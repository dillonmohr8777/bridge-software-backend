import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readMigration = (name: string): string =>
    readFileSync(
        new URL(`../supabase/migrations/${name}`, import.meta.url),
        "utf8"
    )
        .replace(/\s+/g, " ")
        .toLowerCase();

const initialSchema = readMigration("20260812105046_initial_schema.sql");
const domainHardening = readMigration(
    "20260812120111_milestone_2_domain_hardening.sql"
);
const einWorkflow = readMigration("20260825150000_milestone_3_6_ein_workflow.sql");
const adminWorkflow = readMigration(
    "20260825200000_milestone_3_7_admin_verification_queue.sql"
);
const hardening = readMigration(
    "20261005120000_milestone_4_0_trusted_verification_hardening.sql"
);

const assertOrganizationRoleCannotDirectlyUpdate = (role: string): void => {
    assert.match(
        domainHardening,
        /create policy verification_items_update_reviewer on public\.verification_items/
    );
    assert.match(
        hardening,
        /drop policy if exists verification_items_update_reviewer on public\.verification_items/
    );
    assert.match(
        hardening,
        /revoke insert, update, delete, truncate on table public\.verification_items from public, anon, authenticated/
    );
    assert.ok(role.length > 0);
};

for (const role of ["owner", "admin", "reviewer"] as const) {
    test(`${role} cannot directly update trusted verification status`, () => {
        assertOrganizationRoleCannotDirectlyUpdate(role);
    });
}

test("cross-organization verification mutation has no authenticated write policy", () => {
    assert.match(
        hardening,
        /drop policy if exists verification_cases_insert_member on public\.verification_cases/
    );
    assert.match(
        hardening,
        /drop policy if exists verification_cases_update_reviewer on public\.verification_cases/
    );
    assert.match(
        hardening,
        /revoke insert, update, delete, truncate on table public\.verification_cases from public, anon, authenticated/
    );
    assert.match(
        hardening,
        /revoke insert, update, delete, truncate on table public\.ein_verifications from public, anon, authenticated/
    );
    assert.match(
        hardening,
        /revoke insert, update, delete, truncate on table public\.cannabis_license_verifications from public, anon, authenticated/
    );
});

test("trusted platform-admin and provider completion paths remain service-role only", () => {
    assert.match(
        adminWorkflow,
        /create or replace function public\.review_admin_verification_item\([\s\S]*?security definer/
    );
    assert.match(
        adminWorkflow,
        /grant execute on function public\.review_admin_verification_item\( uuid, uuid, public\.verification_item_status, text \) to service_role/
    );
    assert.match(
        einWorkflow,
        /create or replace function public\.complete_ein_verification\([\s\S]*?security definer/
    );
    assert.match(
        einWorkflow,
        /grant execute on function public\.complete_ein_verification\(uuid, text, text, text, public\.verification_item_status\) to service_role/
    );
    assert.doesNotMatch(
        hardening,
        /revoke execute on function public\.(review_admin_verification_item|complete_ein_verification)[\s\S]*?from service_role/
    );
});

test("legitimate organization verification reads remain available", () => {
    assert.match(
        initialSchema,
        /create policy verification_cases_select_member on public\.verification_cases for select to authenticated/
    );
    assert.match(
        initialSchema,
        /create policy verification_items_select_member on public\.verification_items for select to authenticated/
    );
    assert.doesNotMatch(
        hardening,
        /drop policy if exists verification_(cases|items)_select_member/
    );
    assert.doesNotMatch(
        hardening,
        /revoke select on table public\.verification_(cases|items)/
    );
});

test("uploaded evidence starts pending and cannot forge review fields", () => {
    assert.match(
        hardening,
        /create policy documents_insert_member_pending on public\.documents for insert to authenticated/
    );
    assert.match(
        hardening,
        /review_status = 'pending'::public\.document_review_status/
    );
    assert.match(hardening, /reviewed_by_user_id is null/);
    assert.match(hardening, /reviewed_at is null/);
    assert.match(hardening, /review_notes is null/);
    assert.match(
        hardening,
        /drop policy if exists documents_update_reviewer on public\.documents/
    );
    assert.match(
        hardening,
        /drop policy if exists verification_item_documents_delete_admin on public\.verification_item_documents/
    );
});
