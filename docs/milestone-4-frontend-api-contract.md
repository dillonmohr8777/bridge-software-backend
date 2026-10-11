# Milestone 4 frontend API contract

Base path: `/api/v1`. JSON requests require `Content-Type: application/json`. Protected routes accept the HttpOnly access-token cookie; browser callers must use `credentials: "include"`.

## Frontend decisions resolved

1. All exact request/response examples are below.
2. Admin queue: `GET /admin/directory-profiles`, platform `admin` only, with `status`, `limit`, and `offset`.
3. Logo upload is a three-step flow: request a signed URL, `PUT` the bytes to it with the exact returned `Content-Type` and no BRIDGE cookie/Authorization header, then call `/logo/complete`. The signed URL expires after 7,200 seconds. The private working logo is not public until approval.
4. Directory workflow status values are exactly `draft`, `pending_review`, `correction_requested`, `approved`, `rejected`, `suspended`. EIN verification status is a separate workflow and is never inferred from Directory status.
5. `contactPreference` is exactly `email | phone | either`.
6. Public Directory pagination is `{ "profiles": [], "pageInfo": { "nextCursor": null, "hasMore": false } }`. `nextCursor` is opaque, filter-specific client state; do not decode or modify it.
7. Both contact lists return `{ requests, pageInfo: { limit, offset, hasMore } }`.
8. Notifications return `{ notifications, pageInfo: { limit, offset, hasMore } }`.
9. Notification preferences always use `{ "preferences": { ... } }` for both GET and PUT.
10. A Sales Representative is a `user_profiles.account_type = "sales_rep"` user attached by an active organization membership and selected in profile contact routing. It is not an `organizationType` and has no separate public business profile in this milestone.
11. Errors use `{ "error": "MACHINE_CODE", "message": "Human-readable message." }`; validation errors additionally include `details`.
12. Credentialed CORS uses the environment-driven `CORS_ORIGINS` allowlist. The checked-in example includes `http://localhost:3000`, `http://localhost:5173`, `https://bridge-connected-signal-dev.netlify.app`, and `https://bridge-connected-signal.netlify.app`. Responses set `Access-Control-Allow-Credentials: true`; wildcard origins are rejected. Auth cookies are HttpOnly. Development uses `Secure=false; SameSite=Lax`; staging/production uses `Secure; SameSite=None`. A Netlify frontend and separately hosted API are cross-site, so HTTPS, `SameSite=None`, and `credentials: "include"` are required.

## Shared errors

Validation (400):

```json
{
  "error": "VALIDATION_ERROR",
  "message": "The request body is invalid.",
  "details": [{ "path": "links.0.url", "message": "Website URL must use HTTP or HTTPS." }]
}
```

Authentication (401):

```json
{ "error": "UNAUTHORIZED", "message": "A valid authentication credential is required." }
```

Authorization (403):

```json
{ "error": "FORBIDDEN", "message": "You do not have permission to perform this action." }
```

Not found (404), transition/conflict (409), and unexpected failure (500):

```json
{ "error": "DIRECTORY_PROFILE_NOT_FOUND", "message": "Directory profile not found." }
```

```json
{ "error": "DIRECTORY_PROFILE_INVALID_STATE", "message": "The Directory profile cannot transition from its current status." }
```

```json
{ "error": "INTERNAL_SERVER_ERROR", "message": "An unexpected error occurred." }
```

The exact message may be endpoint-specific. Frontend branching must use `error`, not `message`. A service dependency can also return 503 (`DIRECTORY_PROFILE_MEDIA_UNAVAILABLE` or `DIRECTORY_PROFILE_REVIEW_UNAVAILABLE`). No token is returned in JSON.

## Account settings

### PATCH `/auth/me`

Auth: any authenticated user. This route updates only the authenticated user's `display_name` and `phone`; it cannot change email, password, account type, platform roles, organization memberships, or verification state.

At least one field is required. Unknown fields are rejected. `displayName` is a trimmed string of 1â€“100 characters or `null`; `phone` is a trimmed string of at most 30 characters or `null`. Use `null` to clear either value.

```json
{
  "displayName": "Bridge Admin",
  "phone": "+1 555 0100"
}
```

Success 200:

```json
{
  "profile": {
    "displayName": "Bridge Admin",
    "phone": "+1 555 0100"
  }
}
```

Errors: 400 `VALIDATION_ERROR`, 401 `UNAUTHORIZED`, 500 `ACCOUNT_SETTINGS_UPDATE_FAILED`. The update uses the caller's authenticated Supabase session and remains subject to self-only profile RLS.

## Administrator user accounts

Brand, Retailer, and Dispensary are organization types (`brand | retailer | dispensary`), not user roles. User account type is separately `standard | sales_rep`; the only platform role is `admin`. Organization roles and memberships are assigned through separate organization-membership workflows and are never created by these endpoints.

### GET `/admin/users`

Auth: platform role `admin` / permission `admin:users_read`. Query parameters are `page` (integer, minimum 1, default 1) and `pageSize` (integer, 1â€“100, default 50). Unknown query parameters are rejected.

Success 200:

```json
{
  "users": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "user@example.com",
    "displayName": "New User",
    "emailVerified": false,
    "createdAt": "2026-10-07T10:00:00.000Z",
    "lastSignInAt": null,
    "accountType": "standard",
    "platformRole": null,
    "organizationMemberships": [{
      "organizationId": "22222222-2222-4222-8222-222222222222",
      "organizationName": "Example Brand",
      "role": "member"
    }]
  }],
  "pagination": { "page": 1, "pageSize": 50, "total": 1 }
}
```

Errors: 400 `VALIDATION_ERROR`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 503 `ADMIN_USERS_UNAVAILABLE`, and 500 `INTERNAL_SERVER_ERROR`.

### POST `/admin/users`

Auth: platform role `admin` / permission `admin:users_write`. Account creation is invitation-based: Supabase sends the user an email so the user, not the administrator, establishes authentication credentials. Administrators never choose or receive another user's password.

```json
{
  "email": "new.user@example.com",
  "displayName": "New User",
  "accountType": "standard",
  "platformRole": null
}
```

`email` is required, lowercased after trimming, must be a valid address, and is limited to 254 characters. `displayName` is required, trimmed, and 1â€“100 characters. `accountType` is `standard | sales_rep` and defaults to `standard`. `platformRole` is optional and is `admin | null`. Unknown fieldsâ€”including every password fieldâ€”are rejected. This endpoint does not assign an organization membership.

Success 201:

```json
{
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "new.user@example.com",
    "displayName": "New User",
    "accountType": "standard",
    "platformRole": null,
    "invitationSent": true
  }
}
```

The backend records an audit event containing only the invited account type and platform role. If profile configuration, platform-role assignment, or audit creation fails, the newly invited Supabase user is deleted so no partial account remains.

Errors: 400 `VALIDATION_ERROR`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 409 `ADMIN_USER_ALREADY_EXISTS`, 500 `ADMIN_USER_INVITATION_FAILED`, and 503 `ADMIN_USERS_UNAVAILABLE`. A 503 means Supabase administration is unavailable or not configured.

## Canonical Directory profile object

Protected responses use this shape:

```json
{
  "id": "55555555-5555-4555-8555-555555555555",
  "organizationId": "22222222-2222-4222-8222-222222222222",
  "businessId": "44444444-4444-4444-8444-444444444444",
  "slug": "green-company",
  "displayName": "Green Company",
  "summary": "Oregon wholesale cannabis partner.",
  "story": "Founded by operators for operators.",
  "businessType": "brand",
  "categories": ["Cultivation", "Wholesale"],
  "city": "Portland",
  "state": "Oregon",
  "region": "Willamette Valley",
  "publicContact": { "email": "hello@green.example", "phone": "+1 503 555 0100" },
  "license": { "type": "METRC", "number": "LIC-100" },
  "links": [
    { "type": "website", "label": "Website", "url": "https://green.example", "sortOrder": 0 },
    { "type": "menu", "label": "Menu", "url": "https://green.example/menu", "sortOrder": 1 }
  ],
  "logoUrl": "/api/v1/organizations/22222222-2222-4222-8222-222222222222/directory-profile/logo",
  "status": "pending_review",
  "hasPublishedVersion": true,
  "submittedAt": "2026-10-06T10:00:00.000Z",
  "reviewedAt": null,
  "workflowReason": null,
  "approvedAt": null,
  "createdAt": "2026-10-05T10:00:00.000Z",
  "updatedAt": "2026-10-06T10:00:00.000Z",
  "business": {
    "id": "44444444-4444-4444-8444-444444444444",
    "legalName": "Green Company LLC",
    "dbaName": "Green Company",
    "status": "active"
  }
}
```

`license` is `null` when neither license field is set. Nullable scalar values are JSON `null`; `categories` and `links` are arrays.

## Business endpoints

### GET `/organizations/:organizationId/businesses`

Auth: active organization member with `business:read`. No query/body.

```json
{
  "businesses": [{
    "id": "44444444-4444-4444-8444-444444444444",
    "organizationId": "22222222-2222-4222-8222-222222222222",
    "legalName": "Green Company LLC",
    "dbaName": "Green Company",
    "status": "active",
    "createdAt": "2026-10-05T10:00:00.000Z",
    "updatedAt": "2026-10-05T10:00:00.000Z"
  }]
}
```

Likely errors: 400 invalid UUID, 401, 403, 500 `BUSINESS_LIST_FAILED`.

### POST `/organizations/:organizationId/businesses`

Auth: owner/admin (`business:update`).

```json
{ "legalName": "Green Company LLC", "dbaName": "Green Company" }
```

Success 201:

```json
{
  "business": {
    "id": "44444444-4444-4444-8444-444444444444",
    "organizationId": "22222222-2222-4222-8222-222222222222",
    "legalName": "Green Company LLC",
    "dbaName": "Green Company",
    "status": "active",
    "createdAt": "2026-10-06T10:00:00.000Z",
    "updatedAt": "2026-10-06T10:00:00.000Z"
  }
}
```

Likely errors: 400, 401, 403, 500 `BUSINESS_CREATE_FAILED`.

## Directory owner/staff endpoints

### GET `/organizations/:organizationId/directory-profile`

Auth: active member with `business:read`. Success 200: `{ "profile": <canonical protected profile> }`. Errors: 400, 401, 403, 404 `DIRECTORY_PROFILE_NOT_FOUND`, 500.

### PUT `/organizations/:organizationId/directory-profile`

Auth: owner/admin/page manager with `directory_profile:content_update`. Page managers can update an existing profile's ordinary fields but cannot create it or change `businessId`. Owner/admin can create; a published profile's business association can never change.

```json
{
  "businessId": "44444444-4444-4444-8444-444444444444",
  "slug": "green-company",
  "displayName": "Green Company",
  "summary": "Oregon wholesale cannabis partner.",
  "story": "Founded by operators for operators.",
  "businessType": "brand",
  "categories": ["Cultivation", "Wholesale"],
  "city": "Portland",
  "state": "Oregon",
  "region": "Willamette Valley",
  "publicEmail": "hello@green.example",
  "publicPhone": "+1 503 555 0100",
  "licenseType": "METRC",
  "licenseNumber": "LIC-100",
  "links": [
    { "type": "website", "label": "Website", "url": "https://green.example", "sortOrder": 0 },
    { "type": "menu", "label": "Menu", "url": "https://green.example/menu", "sortOrder": 1 }
  ]
}
```

Link `type` is exactly `website | menu | product | other`; maximum 20 links and 20 categories. New and updated profiles always have one of the three `businessType` values. A pre-Milestone-3 legacy organization can read as `null` until its organization type is classified; the migration deliberately does not guess a type. Success 200: `{ "profile": <canonical protected profile> }`. Errors: 400 validation/business mismatch, 401, 403, 409 `DIRECTORY_PROFILE_BUSINESS_CHANGE_REQUIRES_REAPPROVAL` or `DIRECTORY_PROFILE_SLUG_CONFLICT`, 500.

### POST `/organizations/:organizationId/directory-profile/submit`

Auth: owner/admin only (`business:update`); page managers cannot submit/publish. Body: none. Success 200: `{ "profile": <canonical protected profile with status "pending_review"> }`. Errors: 400, 401, 403, 404, 409 `DIRECTORY_PROFILE_INVALID_STATE`, 500.

### GET `/organizations/:organizationId/directory-profile/contact-routing`

Auth: owner/admin only. Success 200:

```json
{
  "routing": {
    "salesRepresentative": {
      "membershipId": "77777777-7777-4777-8777-777777777777",
      "userId": "88888888-8888-4888-8888-888888888888",
      "displayName": "Sam Sales"
    },
    "bridgeAdmin": {
      "userId": "99999999-9999-4999-8999-999999999999",
      "displayName": "Alex Admin"
    }
  }
}
```

Either target is `null` when not configured. Errors: 400, 401, 403, 404/500.

### PUT `/organizations/:organizationId/directory-profile/contact-routing`

Auth: owner/admin only.

```json
{
  "salesRepresentativeMembershipId": "77777777-7777-4777-8777-777777777777",
  "bridgeAdminUserId": "99999999-9999-4999-8999-999999999999"
}
```

Use `null` to clear either target. Success 200 uses the GET wrapper above. The sales rep must be an active membership whose user has `account_type=sales_rep`; the Bridge target must be a real platform admin. Errors: 400, 401, 403, 500.

## Logo endpoints

### POST `/organizations/:organizationId/directory-profile/logo/upload`

Auth: owner/admin/page manager.

```json
{ "contentType": "image/png", "fileSize": 245760 }
```

Allowed content types: `image/png`, `image/jpeg`, `image/webp`; maximum 2 MiB. Success 201:

```json
{
  "upload": {
    "uploadId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "signedUrl": "https://project.supabase.co/storage/v1/object/upload/sign/directory-media/...",
    "method": "PUT",
    "requiredHeaders": {
      "Content-Type": "image/png",
      "cache-control": "max-age=3600",
      "x-upsert": "false"
    },
    "expiresInSeconds": 7200
  }
}
```

Upload the raw bytes to `signedUrl` with `PUT` and all three returned headers. `Content-Type` must exactly equal the requested/returned value. Do not send BRIDGE cookies or the BRIDGE Authorization header to Storage; the signed URL query token is the upload credential. A successful Storage upload does not itself change the working profile.

### POST `/organizations/:organizationId/directory-profile/logo/complete`

Auth: owner/admin/page manager.

```json
{ "uploadId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
```

The server verifies that the expected private object exists, then atomically changes the working logo reference. Success 200: `{ "profile": <canonical protected profile> }`. Missing, expired, reused, or unuploaded IDs return 503 `DIRECTORY_PROFILE_MEDIA_UNAVAILABLE`.

### GET `/organizations/:organizationId/directory-profile/logo`

Auth: organization member. No JSON success body: 302 redirect to a five-minute private signed download URL. Errors: 400, 401, 403, 404, 503.

### DELETE `/organizations/:organizationId/directory-profile/logo`

Auth: owner/admin/page manager. No body. Success 200: `{ "profile": <canonical protected profile with logoUrl null> }`. Published snapshots/objects are not physically deleted.

## Public Directory endpoints

### GET `/directory/profiles`

No auth. Query parameters: `q` (max 100), `organizationType=brand|retailer|dispensary`, `category`, `state`, `city`, `region`, `verified=true|false`, `sort=name_asc|name_desc` (default `name_asc`), `limit=1..50` (default 20), and opaque `cursor`.

```json
{
  "profiles": [{
    "slug": "green-company",
    "displayName": "Green Company",
    "summary": "Oregon wholesale cannabis partner.",
    "story": "Founded by operators for operators.",
    "businessType": "brand",
    "categories": ["Cultivation", "Wholesale"],
    "city": "Portland",
    "state": "Oregon",
    "region": "Willamette Valley",
    "publicContact": { "email": "hello@green.example", "phone": "+1 503 555 0100" },
    "license": { "type": "METRC", "number": "LIC-100" },
    "links": [{ "type": "website", "label": "Website", "url": "https://green.example", "sortOrder": 0 }],
    "legalName": "Green Company LLC",
    "dbaName": "Green Company",
    "businessName": "Green Company",
    "verified": true,
    "logoUrl": "/api/v1/directory/profiles/green-company/logo"
  }],
  "pageInfo": { "nextCursor": "eyJzb3J0IjoibmFtZV9hc2MiLCJuYW1lIjoiZ3JlZW4gY29tcGFueSIsInNsdWciOiJncmVlbi1jb21wYW55In0", "hasMore": true }
}
```

All public results are currently trusted-EIN-verified. Therefore `verified=false` intentionally returns an empty page; it does not expose unverified profiles. Search covers display/legal/DBA name, category, city, and state. Public values always come from the immutable approved snapshot. Errors: 400 validation/`DIRECTORY_PROFILE_INVALID_CURSOR`, 500.

### GET `/directory/profiles/:slug`

No auth. Success 200: `{ "profile": <one public profile object shown above> }`. Errors: 400, 404, 500.

### GET `/directory/profiles/:slug/logo`

No auth. No JSON success body: 302 redirect to a five-minute signed URL for the approved snapshot's private object. Errors: 400, 404, 503.

## Admin Directory endpoints

All require platform role `admin` / permission `admin:directory_review`.

### GET `/admin/directory-profiles`

Query: optional `status` using the six-value Directory enum, `limit=1..50` (default 20), `offset=0..10000` (default 0).

```json
{
  "profiles": [{
    "id": "55555555-5555-4555-8555-555555555555",
    "organization": { "id": "22222222-2222-4222-8222-222222222222", "name": "Green Organization" },
    "business": { "id": "44444444-4444-4444-8444-444444444444", "legalName": "Green Company LLC", "dbaName": "Green Company" },
    "workingProfile": {
      "slug": "green-company",
      "displayName": "Green Company",
      "summary": "Oregon wholesale cannabis partner.",
      "story": "Founded by operators for operators.",
      "businessType": "brand",
      "categories": ["Cultivation", "Wholesale"],
      "city": "Portland",
      "state": "Oregon",
      "region": "Willamette Valley",
      "publicContact": { "email": "hello@green.example", "phone": "+1 503 555 0100" },
      "license": { "type": "METRC", "number": "LIC-100" },
      "links": [{ "type": "website", "label": "Website", "url": "https://green.example", "sortOrder": 0 }],
      "hasLogo": true
    },
    "status": "pending_review",
    "submittedAt": "2026-10-06T10:00:00.000Z",
    "hasPublishedVersion": true,
    "verificationEligibility": {
      "eligible": true,
      "einVerified": true,
      "organizationActive": true,
      "businessActive": true
    }
  }],
  "pageInfo": { "limit": 20, "offset": 0, "hasMore": false }
}
```

The queue contains no EIN digits, provider response, evidence, or internal verification notes. Errors: 400, 401, 403, 503.

### POST `/admin/directory-profiles/:profileId/approve`

Body: none. Success 200:

```json
{ "review": { "profileId": "55555555-5555-4555-8555-555555555555", "status": "approved", "hasPublishedVersion": true, "reviewedAt": "2026-10-06T11:00:00.000Z" } }
```

Errors: 400, 401, 403 (including `DIRECTORY_PROFILE_SELF_REVIEW_FORBIDDEN`), 404, 409 verification/state/slug conflict, 503.

### POST `/admin/directory-profiles/:profileId/request-correction`

```json
{ "reason": "Please add the public license number." }
```

Success uses the review wrapper with `status: "correction_requested"`. Errors: 400, 401, 403, 404, 409, 503.

### POST `/admin/directory-profiles/:profileId/reject`

Request `{ "reason": "The profile is not eligible." }`; success uses the review wrapper with `status: "rejected"`. Same errors as correction.

### POST `/admin/directory-profiles/:profileId/suspend`

Request `{ "reason": "Compliance hold." }`; success uses the review wrapper with `status: "suspended"`. Suspension immediately hides the published snapshot. Same errors as correction.

## Contact request endpoints

### POST `/directory/profiles/:slug/contact-requests`

Auth: any authenticated user who belongs to exactly one currently eligible published organization.

```json
{
  "firstName": "Taylor",
  "workEmail": "taylor@buyer.example",
  "phoneNumber": "+1 503 555 0199",
  "yearsOfService": 4,
  "contactPreference": "either",
  "message": "Please send wholesale terms."
}
```

Success 201:

```json
{ "request": { "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "status": "new", "routingStatus": "routed", "createdAt": "2026-10-06T12:00:00.000Z" } }
```

Routing order is: configured active Sales Rep; configured valid Bridge Admin; active owner; otherwise `needs_assignment`. No arbitrary global admin is selected and recipient identity is not exposed to the sender. Errors: 400, 401, 403 `CONTACT_REQUEST_INELIGIBLE`, 404 `CONTACT_REQUEST_NOT_FOUND`, 500.

### GET `/organizations/:organizationId/contact-requests`

Auth: owner/admin with `contact_request:read`. Query: optional `status=new|viewed|responded|closed`, `limit=1..50`, `offset=0..10000`.

```json
{
  "requests": [{
    "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "status": "new",
    "routingStatus": "routed",
    "firstName": "Taylor",
    "workEmail": "taylor@buyer.example",
    "phoneNumber": "+1 503 555 0199",
    "yearsOfService": 4,
    "contactPreference": "either",
    "message": "Please send wholesale terms.",
    "createdAt": "2026-10-06T12:00:00.000Z",
    "updatedAt": "2026-10-06T12:00:00.000Z"
  }],
  "pageInfo": { "limit": 20, "offset": 0, "hasMore": false }
}
```

### GET `/contact-requests/sent`

Auth required. Query: `limit`, `offset` as above.

```json
{
  "requests": [{
    "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "target": { "slug": "green-company", "displayName": "Green Company" },
    "status": "new",
    "createdAt": "2026-10-06T12:00:00.000Z",
    "updatedAt": "2026-10-06T12:00:00.000Z"
  }],
  "pageInfo": { "limit": 20, "offset": 0, "hasMore": false }
}
```

### POST `/organizations/:organizationId/contact-requests/:requestId/status`

Auth: owner/admin with `contact_request:update`.

```json
{ "status": "responded" }
```

Allowed target values: `viewed | responded | closed`. Success 200:

```json
{ "request": { "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "status": "responded", "updatedAt": "2026-10-06T12:30:00.000Z" } }
```

Errors for contact list/status routes: 400, 401, 403, 404 `CONTACT_REQUEST_NOT_FOUND`, 409 `CONTACT_REQUEST_INVALID_TRANSITION`, 500.

## Notification endpoints

### GET `/notifications`

Auth required. Query: `unreadOnly=true|false` (default false), `limit=1..50` (default 20), `offset=0..10000`.

```json
{
  "notifications": [{
    "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "type": "contact_request_received",
    "category": "contact",
    "title": "New contact request",
    "body": "Your organization received a new contact request.",
    "resourceType": "contact_request",
    "resourceId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "createdAt": "2026-10-06T12:00:00.000Z",
    "readAt": null
  }],
  "pageInfo": { "limit": 20, "offset": 0, "hasMore": false }
}
```

### POST `/notifications/:notificationId/read`

Auth required; no body. Success 200: `{ "success": true }`. Errors: 400, 401, 404 `NOTIFICATION_NOT_FOUND`, 500.

### POST `/notifications/read-all`

Auth required; no body. Success 200: `{ "updatedCount": 3 }`. Errors: 401, 500.

### GET `/notification-preferences`

Auth required. Success 200:

```json
{
  "preferences": {
    "profile": { "inApp": true, "email": true },
    "contact": { "inApp": true, "email": true },
    "verification": { "inApp": true, "email": true }
  }
}
```

### PUT `/notification-preferences`

Auth required. Request:

```json
{
  "profile": { "inApp": true, "email": false },
  "contact": { "inApp": true, "email": true },
  "verification": { "inApp": true, "email": true }
}
```

Success 200 wraps the submitted values in `{ "preferences": ... }`. Errors: 400, 401, 500.

## Publication and integration notes

All public profile fields—including legal/DBA names, type, categories, location, story, links, public contact, license display, and logo reference—come from immutable version snapshots. Editing working version B does not change public version A; only admin approval atomically switches the published version. LeafLink, Weedmaps, wholesale synchronization, product synchronization, SMS, chat, and delivery-worker implementation are intentionally out of scope.
