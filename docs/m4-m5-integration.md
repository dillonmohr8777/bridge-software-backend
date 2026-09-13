# Bridge M4 / M5 backend integration

This branch extends Miraj's main `5da54867ed5f4f5c01f2b451f9f4cf1d0b4cac34`. It is a contribution for review, not a hosted deployment or milestone acceptance.

## Implemented

- Directory profiles: private defaults, controlled editing, public projections, search and role/state/territory/category/product/verification filters.
- Contact, claim and correction requests: atomic persistence, idempotent retries, private requester/reviewer access, terminal review outcomes, in-app notifications, and a private transactional email outbox. Claims never change ownership automatically.
- Early engagement: draft and published announcements/news, current verified-public-profile publication checks, saved profiles, private notifications/read state.
- Verification completion: the second trusted admin approval atomically completes the case, grants the directory badge, and unlocks publishing.
- Existing cookie authentication and Supabase user-scoped access reused.

## Verification permission correction

The previous organization-reviewer policy allowed direct updates to requirement type, review evidence and case association. These fields determine the new directory badge and publication permission. The final migration removes authenticated direct updates to verification cases/items and business legal-identity fields. Existing service-role EIN and platform-admin review RPCs retain their authority; directory display fields remain editable. A runnable regression proves normal users cannot relabel a requirement, replace its business association, write approval state or replace the reviewed legal identity, while the existing admin review RPC still works and records history.

This is an intentional permission change and must be reviewed together with all migrations. The new directory alone must not deploy without the final permission migration.

## Local verification

`npm ci`, `npm test`, `npm run build`, `npm run test:sql`.

The SQL command runs all untouched baseline migrations and all new migrations in an isolated in-memory PostgreSQL engine with pgcrypto. It supplies minimal Supabase auth roles and `auth.uid()` semantics, then executes transaction/rollback assertions. It never reads DATABASE_URL or connects to a hosted database. This covers actual SQL/RLS behavior, but not hosted Supabase JWT configuration or PostgREST deployment.

API details: [directory](directory-api.md), [requests](directory-requests-api.md), [engagement](../ENGAGEMENT-API.md).

## Still required for live acceptance

1. Apply all six new migrations to the authorized staging project, deploy this backend, and validate a real signed-in owner/admin/member flow against it.
2. Then connect the matching frontend feature branch to that staging API. Existing Connected Signal production remains on the already released redesign with its original preview environment.
3. Configure `RESEND_API_KEY`, a verified `DIRECTORY_EMAIL_FROM`, and optional reply-to in staging, then prove a real provider receipt. Until configured, API responses explicitly report `emailDelivery: not_configured` and no external send occurs.
4. Personal sales-rep verification has no supporting model yet, so those profiles stay unverified and can save post drafts but cannot publish. The existing EIN provider selector also deliberately throws not-configured until a real provider adapter is implemented.

No production data, credentials, sender domain or paid verification service was changed by this work.
