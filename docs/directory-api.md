# Directory API (M4)

Status: local implementation and migration draft. Existing Miraj authentication is reused unchanged. Deploying the API without applying the migration produces an explicit unavailable response; it never substitutes fixtures.

All endpoints are below `/api/v1/directory`. Public endpoints use an anonymous Supabase client; managed endpoints use the authenticated user's scoped client and existing bearer/cookie middleware.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/` | Public listings, `{profiles, pagination:{page,pageSize,total,totalPages}}` |
| GET | `/:identifier` | Public slug or UUID, `{profile}`; hidden/missing returns 404 |
| GET | `/mine` | Authenticated manageable listings including drafts, `{profiles}` |
| POST | `/` | Create listing, `{profile}`, 201 |
| PATCH | `/:id` | Edit/publish/unpublish owned listing, `{profile}`, 200 |

List filters: `query` searches name/company/description/location/state/products/categories/service territories (100 chars max), `role` one of `brand`, `retailer`, `dispensary`, `sales_rep`, `state` two letters, `territory` two-letter service territory, `category` and `product` exact array entries (100 chars max), `verified` exactly `true` or `false`, `page` 1..10000 (default1), `pageSize` 1..100 (default24). State is normalized uppercase. Ordering is name then UUID for deterministic paging. Total counts use the same filters. Unknown query keys and repeated scalar parameters are rejected.

Create example:

```json
{
  "organizationId": "22222222-2222-4222-8222-222222222222",
  "slug": "example-brand",
  "name": "Example Brand",
  "companyName": "Example Brand LLC",
  "description": "A Pennsylvania business.",
  "location": "Pittsburgh",
  "state": "PA",
  "serviceTerritories": ["PA", "OH"],
  "products": ["Flower"],
  "categories": ["Cultivation"],
  "logoUrl": "https://cdn.example.com/logo.png",
  "visibility": "private"
}
```

Only `slug` and `name` are required. Omit `organizationId` for a personal profile; the authenticated account must already be classified `sales_rep`. Organization listings derive role from their existing organization type. There is one listing per organization and one personal listing per sales rep. Slugs must be lowercase hyphen-separated words, 3..80 chars; `mine` and UUID-shaped slugs are reserved. Duplicate slug/owner returns409. All other fields default empty/null and visibility defaults **private**. Publication is explicit `PATCH {"visibility":"public"}`; withdrawal uses `private`.

PATCH accepts only editable fields shown above, excluding `organizationId`. Ownership, role, verification, timestamps and IDs cannot be set by request. Strings/arrays have bounds; URLs must be HTTPS without credentials. Logo files are externally hosted URLs, not uploads or proxied requests. API400 = validation,401 = authentication,403 = forbidden,404 = absent/inaccessible,409 = duplicate,503 = storage unavailable/write failure. Error messages exclude database internals.

The response profile contains exactly: `id, slug, role, name, companyName, description, location, state, serviceTerritories, products, categories, logoUrl, visibility, verified, verificationStatus, createdAt, updatedAt`. No email, phone, EIN, owner user ID, case IDs, raw organization rows, or documents are returned. Profile free text is owner-authored public copy; the UI must render it as text and explain publication.

Both API authorization and RLS restrict edits to active organization owner/admin in an active organization or the personal sales rep owner. RLS also protects direct Supabase access. There is no client ownership-transfer or delete endpoint. `/mine` reads manageable IDs from the RLS table, then the safe projection. Suspended/unclassified organizations are not public.

`verified` is server-derived conservatively from the latest organization case: approved, active business, EIN and cannabis-license items currently verified by actual platform admins, latest append-only item history says verified by that reviewer, and matching organization/case audit evidence exists. The current workflow may leave the case unapproved even after item review; those listings remain pending. Personal verification does not exist in the underlying model and remains false/pending. No private verification evidence is exposed. Directory does not change or broaden existing verification permissions.

Migration: `supabase/migrations/20260912210000_directory_mvp.sql`. The intentional security-barrier definer view exposes only explicit safe fields and public/managed rows, with no direct anonymous grants to the base table. Do not convert this view to `select *` or grant anonymous base-table reads.

Validation: `npm run typecheck`, `npm test`. `test/directory.test.ts` exercises validation, membership gates, query composition, projection, and persistence/error boundaries using fake clients. These tests do not prove live Supabase RLS. The directory migration and `test/sql/directory-rls.sql` passed in isolated PGlite PostgreSQL with the prior migrations and Supabase auth stubs. This is local PostgreSQL evidence, not hosted Supabase verification. The SQL file is a transactional runtime assertion script for an isolated PostgreSQL database with all migrations applied. It tests anonymous visibility, private defaults, member/owner/suspended permissions, personal ownership and direct-column protections, then rolls back. Never run the fixture script against production. Real hosted Supabase JWT/role/grant behavior still requires an approved staging verification after migration.

