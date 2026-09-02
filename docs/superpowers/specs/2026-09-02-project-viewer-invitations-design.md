# Project Viewer Invitations Design

## Goal

Let a project owner share read-only access with a person who may not yet have an
AgentMesh account. The recipient joins through the existing GitHub OAuth flow,
becomes a `viewer` member, and can use the project read surfaces already guarded
by `project_memberships`. Project writes remain authorized exclusively by
`projects.owner_user_id`.

The owner must be able to see the project owner, current viewers, and pending
invitations in the product UI; create and copy an invitation link; revoke a
pending invitation; and remove a viewer.

## User Flow

1. In project settings, the owner opens the Members section and selects
   **Create viewer link**.
2. AgentMesh creates a cryptographically random, single-use invitation valid
   for seven days. The raw token is returned once and shown as a copyable URL.
3. The recipient opens `/invite/:token`. The server validates the token without
   consuming it, stores it in a short-lived HttpOnly invitation cookie, and
   redirects to `/app/invitations/accept`. The raw token is not placed in the
   OAuth `return_to` value.
4. If the recipient has no session, the accept page starts the existing GitHub
   OAuth flow with `/app/invitations/accept` as the safe return path. GitHub
   login creates or updates the AgentMesh user exactly as it does today.
5. The authenticated accept page sends a CSRF-protected redemption request.
   The server atomically consumes the invitation and creates the recipient's
   `viewer` membership, then the UI navigates to the project overview.
6. Invalid, expired, revoked, already-used, or already-member cases show a safe
   result without exposing project details. Reopening the original link is the
   recovery path when the short-lived cookie expires.

The invitation cookie is Secure in production, HttpOnly, SameSite=Lax,
host-scoped, and short-lived. It is cleared after every redemption result.

## Persistence Model

Add `project_invitations` with:

- UUID `id` primary key with `defaultRandom()`;
- required `project_id` foreign key to `projects.id` with cascading delete;
- required `role`, restricted to `viewer` for this release;
- required unique 32-byte `token_digest`; the raw token is never stored;
- required `created_by` foreign key to `users.id`;
- required `expires_at`, `created_at`, and `updated_at` timezone-aware
  timestamps;
- nullable `redeemed_by` foreign key to `users.id`, `redeemed_at`, and
  `revoked_at`;
- indexes supporting project member-page listing and expiry lookup;
- checks keeping redemption fields paired and preventing a row from being both
  redeemed and revoked.

The raw credential contains 32 random bytes encoded as canonical base64url.
The server stores `SHA-256(raw_token)` and compares by indexed digest lookup.
Seven days is fixed server behavior in this release, not client input.

An invitation is pending only when `redeemed_at IS NULL`, `revoked_at IS NULL`,
and `expires_at > now`. Expired rows may remain for auditability but are not
shown as active links and cannot be redeemed. No backfill is required.

## Authorization and Atomicity

Member administration is owner-only. Every list, create, revoke, and remove
operation scopes the project by both `project_id` and the authenticated
`owner_user_id`; a viewer or unrelated user receives the existing
indistinguishable project-not-found response.

Redemption is the only membership-creating operation available to a non-owner.
It accepts no project or role from the client. In one database transaction it:

1. validates and locks the unexpired, unrevoked, unredeemed invitation by
   digest;
2. confirms that the authenticated user is not already an owner or member;
3. conditionally marks that exact invitation redeemed by the user;
4. inserts one `project_memberships` row with `role = 'viewer'` and
   `created_by = invitation.created_by`;
5. records the audit event.

The conditional update guarantees that two users racing the same link cannot
both join. A user who already owns or views the project receives an
already-member result and does not consume the invitation. A membership
unique-key race is handled as the same result with the invitation transaction
rolled back, so it cannot widen access or partially consume state. The owner
membership can never be removed: removal targets only `role = 'viewer'`, while
`projects.owner_user_id` remains the sole write-authority source of truth.

Archived projects may still be shared for historical read access. Invitation
management does not reactivate MCP connections or bypass archived-state checks.

## HTTP Contracts

Add owner-authenticated, no-store routes under the existing control API:

- `GET /api/v1/projects/:projectId/members` returns the owner, current viewers,
  and pending invitations without token digests or raw tokens;
- `POST /api/v1/projects/:projectId/invitations` creates a viewer invitation and
  returns its metadata plus the full invitation URL exactly once;
- `DELETE /api/v1/projects/:projectId/invitations/:invitationId` revokes a
  pending invitation;
- `DELETE /api/v1/projects/:projectId/members/:userId` removes a viewer;
- `POST /api/v1/project-invitations/redeem` consumes the invitation from the
  HttpOnly cookie and returns the accessible project ID.

`GET /invite/:token` is a public capture route. It performs no membership
mutation, accepts only a canonical token shape, uses a dedicated rate limit,
sets the invitation cookie, and redirects to the fixed accept page. The capture
path is excluded or redacted from proxy and application request logs so the raw
bearer credential cannot be retained in logs.

All mutation routes require the existing session and CSRF protections. Owner
invitation creation and revocation additionally use the existing mutation rate
limit; capture and redemption receive bounded abuse protection. API errors use
coarse codes such as `INVITATION_UNAVAILABLE` and do not reveal project names or
membership state to unauthorised callers.

## UI Contract

Project settings gains a Members section for owners. It shows:

- the owner, labelled `Owner`;
- viewer avatar, GitHub login/display name, join time, and a remove action;
- pending invitation creation and expiry times with a revoke action;
- a create-link action followed by a one-time copy panel explaining the
  seven-day and single-use rules.

The raw link is held only in component memory and disappears on navigation or
refresh. It is never reconstructed from list responses.

Add `/app/invitations/accept` as a focused state page. It preserves the pending
invitation across GitHub OAuth through the HttpOnly cookie, redeems only after
the user is authenticated, and handles success, unavailable, expired-cookie,
and already-member outcomes. Existing viewer project pages stay read-only and
continue hiding project settings.

## Auditing and Secret Handling

Add audit event types for invitation creation, revocation, redemption, and
viewer removal. Events may contain invitation IDs and subject user IDs, but
never raw tokens, token digests, cookies, or invitation URLs.

The token must not appear in database plaintext, structured application logs,
audit metadata, error responses, frontend telemetry, or proxy access logs.
Production log checks search from a fresh byte offset after exercising capture
and redemption.

## Tests and Verification

Implementation follows red-green TDD and covers:

- schema constraints, indexes, cascade behavior, and digest-only storage;
- owner-only list/create/revoke/remove authorization and unchanged owner-only
  project mutation rules;
- one successful first-login GitHub OAuth journey from invitation capture to
  viewer membership and project read access;
- an already-authenticated recipient journey;
- race safety, single use, expiry, revocation, invalid token, expired cookie,
  already-member, and owner-removal protection;
- member list privacy and absence of raw credentials from subsequent reads,
  errors, audit events, and captured logs;
- UI rendering, copy feedback, remove/revoke behavior, viewer read-only state,
  and invitation acceptance routing;
- production proxy policy preventing invite-token path logging.

Run focused schema/control/auth/UI tests first, then server and web typechecks,
lint, full backend tests, frontend unit tests, build, and relevant Playwright
flows. Release only after CI is green. Production rollout requires a database
backup and restore check, exact-revision image deployment, migration
verification, authenticated owner and invited-viewer smoke tests, health and
readiness checks, container restart inspection, and fresh-log secret/error
scans.

## Out of Scope

- inviting by GitHub username or email;
- GitHub organisation/team synchronisation;
- editor roles or any viewer write permission;
- invitation email delivery;
- ownership transfer;
- exposing invitation management through MCP.
