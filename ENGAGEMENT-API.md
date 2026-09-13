# Early Engagement API (local implementation)

Base: `/api/v1/engagement`. JSON, existing Bearer authentication. Every response is `Cache-Control: no-store`. Only `GET /posts` is anonymous. These files are not evidence of deployment or live migration.

| Method / path | Input | Success envelope |
| --- | --- | --- |
| GET /posts | page, pageSize, optional profileId UUID | `{posts: Post[], pagination}` |
| GET /posts/mine | same | `{posts: Post[], pagination}` |
| POST /posts | `{profileId,type,title,body,status?}` | 201 `{post: Post}` |
| PATCH /posts/:id | one or more type, title, body, status | `{post: Post}` |
| GET /saved-profiles | page, pageSize | `{savedProfiles:[{profileId,savedAt}],pagination}` |
| GET /saved-profiles/:id | profile UUID | `{saved:boolean}` (false for absent or no longer public) |
| PUT /saved-profiles/:id | profile UUID, no body | `{saved:true}` |
| DELETE /saved-profiles/:id | profile UUID, no body | `{saved:false}` |
| GET /notifications | page, pageSize | `{notifications:Notification[],pagination}` |
| PATCH /notifications/:id | `{read:true}` | `{notification:Notification}` |

Post: `{id,profileId,type,title,body,status,createdAt,updatedAt}`. Type is `announcement` or `news`; status is `draft` (default) or `published`. Title 1–200 trimmed characters, body 1–10000 trimmed characters. Text is plain text, never trusted HTML. Author and verification are derived from the directory profile; clients cannot submit them. No private author IDs appear in the projection.

Notification: `{id,type,title,body,createdAt,readAt}`; type is `system`; readAt is a timestamp or null. Read transitions are idempotent through the API and preserve the first read timestamp.

Pagination: `{page,pageSize,total,totalPages}`. Page defaults 1, max 10000; pageSize defaults 20, max 100. Exact counts; zero results means totalPages 0. Posts sort newest creation first then descending UUID. Saved profiles sort savedAt descending then profile UUID. Notifications sort createdAt descending then UUID. No relevance ranking or algorithmic feed. Offset pages can shift when records change.

Post management requires an active organization owner/admin and active organization, or the personal sales-rep owner. Drafts appear only in the managed list. Publishing and editing a published post require the profile to be currently public and verified, checked both by service and database trigger. The public view repeats current verification/visibility checks, so later revocation or hiding immediately removes public access. Personal verification is not yet modeled and personal profiles cannot publish. No platform-admin author impersonation or client badge overrides.

Saves are private per user, conflict-ignore on repeat PUT, and DELETE succeeds even if already absent. Only public profiles can be saved; saved list hides subsequently private profiles and inactive organizations. Saving does not subscribe to notifications.

Notifications are a private list/read foundation. Trusted database-owner functions may insert `{user_id,title,body}` (type defaults system); recipient must be server-derived. Authenticated users have SELECT and UPDATE(read_at) only under own-user RLS, no INSERT/DELETE or recipient/content updates. There is no public notification creation route. A later contact/claim migration can create generic request notifications atomically without copying private request bodies into this table. Service-role/table privileges must be explicitly provided by that trusted producer's deployment; no service key is used by these routes.

Failures use `{error,message}`: validation 400 adds `details:[{path,message}]`; existing auth middleware supplies 401; unauthorized ownership or verification 403; inaccessible profile/post/notification 404; database unavailable 503; unexpected server error 500. No database diagnostics exposed.

Checks: `npx tsx --test test/engagement.test.ts`; `npm run typecheck`; `npm run build`. `test/sql/engagement-rls.sql` is an isolated PostgreSQL assertion transaction after all migrations and rolls back its fixtures. It covers actual publish/revoke/hide, foreign draft access, duplicate saves, notification privacy and column privileges. Live Supabase/PostgREST end-to-end verification remains required before release.
