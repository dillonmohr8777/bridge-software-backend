# Private directory requests

Local M4 implementation. Mount `directoryRequestsRouter` at `/api/v1/directory-requests`. All routes require the existing authenticated bearer/cookie transport and return `Cache-Control: no-store`.

| Method | Path | Payload / response |
| --- | --- | --- |
| POST | `/` | `{profileId, kind, message, shareEmail?, idempotencyKey}` → `{request}`,201 |
| GET | `/` | `page` default1, `pageSize` default20 (max100), optional `kind` / `status` → `{requests,pagination:{page,pageSize,total,totalPages}}` |
| GET | `/:id` | `{request}`; inaccessible or absent returns404 |
| PATCH | `/:id` | `{status:"resolved"|"rejected"}` → `{request}` |

`kind` is `contact`, `claim`, or `correction`. `profileId` and `idempotencyKey` are UUIDs. `message` is trimmed, 1..5000 characters. `shareEmail` defaults false. No sender/recipient/contact email/ownership/status fields are accepted during submission. The database derives sender from `auth.uid()` and optional reply email from that sender's current `auth.users.email`. The user must explicitly choose to share that email.

Response fields: `id, profileId, kind, message, replyEmail, status, createdAt, updatedAt, canReview, emailDelivery`. `status` starts `pending`. `emailDelivery` is `not_configured` until the Resend key, verified sender and service role are configured; configured deployments report `queued`, `sent`, `partial`, `failed`, or `not_applicable`. The request, in-app notification and derived-recipient email outbox rows are persisted atomically. Email contains generic status copy and a Bridge inbox link, never the private request message.

Contact requests are readable only by their requester and currently active listing owners/admins (or the personal sales rep owner). Claims and corrections are readable only by their requester and platform admins; listing ownership alone never grants access to those messages. Submission requires an actually public, active directory profile. Only the receiving side can resolve/reject a request. Repeating the same terminal decision is idempotent; switching terminal decisions returns409. Claim resolution records a review status only: it never creates membership, transfers ownership, or changes listing data. Any eventual claim transfer requires a separate trusted process.

`submit_directory_request` atomically inserts the request and generic notifications for the actual recipient IDs. Contact recipients are the personal owner or active owner/admin members of the active organization. Claim/correction recipients are current platform admins. If there are no platform admins, the request remains persisted for the admin queue and no recipient notification is fabricated. Notification text never contains private message text or reply email; authorization is rechecked when opening the inbox. Removing a role removes access to the private request even if a generic notification remains in that user's inbox.

The same sender + kind + idempotency key + normalized payload returns the original request. Reusing that key for a changed profile/message/email-sharing choice returns409. A transaction-scoped advisory lock serializes matching retries, and a unique constraint protects durable identity. Generic recipient notifications are inserted only on first submission. Review status and its requester notification are also one transaction and repeated review does not duplicate notifications. New retries may retrieve the sender's existing request after a profile is withdrawn; they cannot create a new request to that private profile.

All request writes use scoped authenticated RPCs. Table RLS protects reads; authenticated callers have no direct insert/update/delete grant. Definer RPCs independently validate authentication, inputs, target visibility and recipient review permission. The private outbox and its claim/completion RPCs are service-role only. Delivery uses Resend's HTTPS endpoint with a stable provider idempotency key and bounded retry recovery; provider credentials remain server-only.

Errors:400 validation,401 auth,403 forbidden,404 missing/inaccessible/private target,409 idempotency or terminal-review conflict,503 storage failure. The API excludes underlying database messages.

Checks: `npm run typecheck`; `npm test`; transactional isolated PostgreSQL assertions in `test/sql/directory-requests-rls.sql`, after all migrations including `20260912230000_directory_requests.sql`. The SQL assertions cover tenant isolation, private target denial, optional email derivation, claim review permissions, direct update denial, role revocation, retry dedupe, notification counts, and absence of ownership grants. Hosted Supabase migration and production transport are separate deployment validation steps; no live migration or live messaging was performed.
