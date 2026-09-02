# Project Viewer Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner create a single-use seven-day link that grants read-only project access after the recipient signs in with GitHub, while keeping every project write owner-only.

**Architecture:** A digest-only `project_invitations` table and focused membership service own invitation lifecycle and viewer removal. A public capture route transfers the raw token into a short-lived HttpOnly cookie; the existing GitHub OAuth flow returns to an authenticated acceptance page that redeems atomically. Owner APIs and the project settings UI expose members and pending invitations without ever returning stored credentials.

**Tech Stack:** Node.js 24, TypeScript 7, Fastify 5, Drizzle ORM 0.45, PostgreSQL 18, Zod 4, React 19, React Router, Vitest, Playwright, Caddy, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-02-project-viewer-invitations-design.md`

## Global Constraints

- Invitation role is exactly `viewer`; no editor role or ownership transfer.
- Raw tokens are 32 random bytes in canonical base64url, expire after exactly seven days, and are returned only by creation and the copied invitation URL.
- PostgreSQL stores only `SHA-256(raw_token)` and must never store, audit, or log the raw token, cookie, digest, or URL.
- Invitation capture is non-mutating; redemption is authenticated, CSRF-protected, single-use, and atomic.
- Owner/list/revoke/remove APIs authorize exclusively through `projects.owner_user_id` and return indistinguishable not-found responses to viewers and unrelated users.
- Membership removal targets only `project_memberships.role = 'viewer'`; all existing project writes remain owner-only.
- `/api/v1` compatibility and current shared-read behavior must remain intact.
- Production deployment happens only after local checks and pull-request CI pass, with backup, restore check, exact image digest, migration/runtime checks, and fresh-log secret scan.

---

### Task 1: Invitation persistence and migration

**Files:**
- Modify: `src/db/schema.ts`
- Generate: `drizzle/0012_*.sql`
- Generate: `drizzle/meta/0012_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `test/support/database.ts`
- Modify: `test/db.integration.test.ts`
- Modify: `test/hosted-schema.integration.test.ts`

**Interfaces:**
- Produces: exported `projectInvitations` Drizzle table.
- Produces: columns `id`, `projectId`, `role`, `tokenDigest`, `createdBy`, `expiresAt`, `redeemedBy`, `redeemedAt`, `revokedAt`, `createdAt`, and `updatedAt`.
- Produces: unique digest constraint plus project/pending and expiry indexes used by Task 2.

- [ ] **Step 1: Write failing schema tests**

Add assertions that the table exists, accepts one pending viewer invitation, rejects a non-viewer role, rejects a non-32-byte digest, rejects mismatched redemption fields, rejects redeemed-and-revoked state, rejects duplicate digests, and cascades when the project is deleted. Extend reset order so `project_invitations` is truncated before `projects` and `users`.

```ts
await database.db.insert(projectInvitations).values({
  projectId: project.id,
  role: "viewer",
  tokenDigest: Buffer.alloc(32, 1),
  createdBy: owner.id,
  expiresAt: new Date("2026-09-09T00:00:00.000Z"),
});

await expect(database.db.insert(projectInvitations).values({
  projectId: project.id,
  role: "owner",
  tokenDigest: Buffer.alloc(32, 2),
  createdBy: owner.id,
  expiresAt: new Date("2026-09-09T00:00:00.000Z"),
})).rejects.toMatchObject({ cause: { constraint: "project_invitations_role_check" } });
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `pnpm test -- test/db.integration.test.ts test/hosted-schema.integration.test.ts`

Expected: FAIL because `projectInvitations` is not exported and the migration/table does not exist.

- [ ] **Step 3: Add the Drizzle table**

Implement the table with explicit checks and indexes.

```ts
export const projectInvitations = pgTable("project_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 32 }).notNull(),
  tokenDigest: bytea("token_digest").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedBy: uuid("redeemed_by").references(() => users.id),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_invitations_token_digest_unique").on(table.tokenDigest),
  index("project_invitations_project_created_idx").on(table.projectId, table.createdAt),
  index("project_invitations_expires_at_idx").on(table.expiresAt),
  check("project_invitations_role_check", sql`${table.role} = 'viewer'`),
  check("project_invitations_digest_length_check", sql`octet_length(${table.tokenDigest}) = 32`),
  check("project_invitations_redemption_pair_check", sql`(${table.redeemedBy} IS NULL) = (${table.redeemedAt} IS NULL)`),
  check("project_invitations_terminal_state_check", sql`NOT (${table.redeemedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)`),
]);
```

- [ ] **Step 4: Generate and inspect the append-only migration**

Run: `pnpm db:generate`

Expected: one new `0012` SQL migration and matching Drizzle metadata. Inspect the SQL for the named checks, unique digest index, foreign keys, and `ON DELETE CASCADE` on `project_id`; do not edit earlier migrations.

- [ ] **Step 5: Run schema tests and observe GREEN**

Run: `pnpm test -- test/db.integration.test.ts test/hosted-schema.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence**

```bash
git add src/db/schema.ts drizzle test/support/database.ts test/db.integration.test.ts test/hosted-schema.integration.test.ts
git commit -m "feat: add project invitation persistence"
```

### Task 2: Invitation and membership domain service

**Files:**
- Create: `src/control/membership-service.ts`
- Create: `test/project-membership-invitations.integration.test.ts`
- Modify: `src/audit/types.ts`
- Modify: `src/db/schema.ts`

**Interfaces:**
- Produces: `createProjectMembershipService({ db, audit, publicOrigin, clock? })`.
- Produces: `list({ ownerUserId, projectId })`, `createInvitation({ ownerUserId, projectId, requestId })`, `capture(rawToken)`, `redeem({ userId, rawToken, requestId })`, `revokeInvitation({ ownerUserId, projectId, invitationId, requestId })`, and `removeViewer({ ownerUserId, projectId, userId, requestId })`.
- Produces: `ProjectMembershipError` with `PROJECT_NOT_FOUND`, `INVITATION_NOT_FOUND`, `INVITATION_UNAVAILABLE`, `ALREADY_MEMBER`, and `CONTROL_UNAVAILABLE`.
- Produces: public member/invitation records containing identity metadata but no credential material.

- [ ] **Step 1: Write failing service tests for owner management**

Cover owner/viewer/pending listing, one-time raw URL return, 32-byte digest-only storage, fixed seven-day expiry, owner-only create/list/revoke/remove, removal restricted to viewers, and audit records.

```ts
const created = await service.createInvitation({ ownerUserId: owner.id, projectId: project.id, requestId });
expect(created.invitationUrl).toMatch(/^https:\/\/agentmesh\.example\/invite\/[A-Za-z0-9_-]{43}$/);
expect(created.expiresAt).toBe("2026-09-09T00:00:00.000Z");
const [stored] = await database.db.select().from(projectInvitations);
expect(stored?.tokenDigest).toHaveLength(32);
expect(JSON.stringify(stored)).not.toContain(created.invitationUrl.split("/").at(-1));
```

- [ ] **Step 2: Write failing redemption tests**

Cover successful redemption, second-user replay rejection, expired and revoked rejection, invalid canonical token rejection, already-member non-consumption, owner non-removal, and a two-request race where exactly one membership is created.

```ts
const results = await Promise.allSettled([
  service.redeem({ userId: viewerA.id, rawToken, requestId: crypto.randomUUID() }),
  service.redeem({ userId: viewerB.id, rawToken, requestId: crypto.randomUUID() }),
]);
expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
expect(await database.db.select().from(projectMemberships).where(eq(projectMemberships.role, "viewer"))).toHaveLength(1);
```

- [ ] **Step 3: Run the service tests and observe RED**

Run: `pnpm test -- test/project-membership-invitations.integration.test.ts`

Expected: FAIL because the service and new audit event types do not exist.

- [ ] **Step 4: Implement token lifecycle and owner-scoped queries**

Use `randomBytes(32).toString("base64url")`, canonical `/^[A-Za-z0-9_-]{43}$/` validation, `createHash("sha256")`, and injected clock. Build URLs only with `new URL(`/invite/${rawToken}`, publicOrigin)`.

```ts
const rawToken = randomBytes(32).toString("base64url");
const tokenDigest = createHash("sha256").update(rawToken, "utf8").digest();
const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
```

Owner operations must join or predicate against `projects.ownerUserId = ownerUserId`. Listing joins `users` and GitHub `oauthIdentities`, returns owner first and viewers by `createdAt`, and returns only active pending invitations.

- [ ] **Step 5: Implement atomic redemption**

Within one transaction, lock the invitation selected by digest and terminal-state predicates, check existing project access, conditionally set `redeemedBy/redeemedAt/updatedAt`, insert the viewer membership, and write the audit row. Throwing `ALREADY_MEMBER` rolls back every invitation mutation.

```ts
const [claimed] = await transaction.update(projectInvitations).set({
  redeemedBy: input.userId,
  redeemedAt: now,
  updatedAt: now,
}).where(and(
  eq(projectInvitations.id, invitation.id),
  isNull(projectInvitations.redeemedAt),
  isNull(projectInvitations.revokedAt),
  gt(projectInvitations.expiresAt, now),
)).returning({ projectId: projectInvitations.projectId, createdBy: projectInvitations.createdBy });
if (claimed === undefined) throw new ProjectMembershipError("INVITATION_UNAVAILABLE");
```

- [ ] **Step 6: Extend audit allowlists safely**

Add `project.invitation_created`, `project.invitation_revoked`, `project.invitation_redeemed`, and `project.viewer_removed` to TypeScript and database check allowlists. Metadata may use `subject_user_id` and a new `invitation_id`; it must never accept token fields.

- [ ] **Step 7: Generate the audit-constraint migration**

Run: `pnpm db:generate`

Expected: one append-only migration replaces `audit_events_type_check` with the four new values while retaining every existing event type. Inspect the generated SQL and matching metadata; do not modify the Task 1 migration.

- [ ] **Step 8: Run the focused service tests and observe GREEN**

Run: `pnpm test -- test/project-membership-invitations.integration.test.ts test/hosted-schema.integration.test.ts`

Expected: PASS with exactly one winning user in the replay race and no raw token in persisted/audited values.

- [ ] **Step 9: Commit the domain service**

```bash
git add src/control/membership-service.ts src/audit/types.ts src/db/schema.ts drizzle test/project-membership-invitations.integration.test.ts test/hosted-schema.integration.test.ts
git commit -m "feat: add viewer invitation lifecycle"
```

### Task 3: Owner member-management HTTP API

**Files:**
- Modify: `src/control/contracts.ts`
- Modify: `src/control/routes.ts`
- Modify: `shared/control-api.ts`
- Modify: `test/control-projects.integration.test.ts`
- Modify: `test/control-security.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 membership service and error codes.
- Produces: `projectMembersResponseSchema`, `projectInvitationResponseSchema`, and path schemas for invitation/member UUIDs.
- Produces: owner routes `GET members`, `POST invitations`, `DELETE invitation`, and `DELETE viewer`.

- [ ] **Step 1: Write failing HTTP contract tests**

Exercise all four owner routes with valid session/CSRF. Assert list response identity fields, create status `201`, revoke/remove status `204`, no-store headers, strict empty bodies/queries, and raw URL presence only in the create response.

```ts
const created = await ownerClient.post(`/api/v1/projects/${project.id}/invitations`, {});
expect(created.statusCode).toBe(201);
expect(projectInvitationResponseSchema.parse(created.json()).invitation.url).toMatch(/\/invite\//);
const listed = await ownerClient.get(`/api/v1/projects/${project.id}/members`);
expect(JSON.stringify(listed.json())).not.toMatch(/token|digest|\/invite\//i);
```

- [ ] **Step 2: Write failing authorization tests**

For every route, assert a viewer and unrelated user receive `404 PROJECT_NOT_FOUND`; missing/invalid CSRF receives the existing mutation rejection; deleting the owner or unrelated user does not change memberships.

- [ ] **Step 3: Run focused HTTP tests and observe RED**

Run: `pnpm test -- test/control-projects.integration.test.ts test/control-security.integration.test.ts`

Expected: FAIL with route-not-found or missing schema exports.

- [ ] **Step 4: Add strict Zod path and response contracts**

Define UUID paths with `.strict()`. Public member records expose `user_id`, `role`, `github_login`, `display_name`, `avatar_url`, and `joined_at`. Pending invitation records expose `id`, `role`, `created_at`, and `expires_at`; only the create response extends this with `url`.

- [ ] **Step 5: Register owner routes and error mapping**

Instantiate the membership service beside the project service. Use `readOptions` for list and `mutationOptions` for create/revoke/remove. Reject any unexpected body or query. Map missing ownership to `404 PROJECT_NOT_FOUND`, unavailable invitation IDs to `404 INVITATION_NOT_FOUND`, and unexpected storage failures to `503 CONTROL_UNAVAILABLE`.

- [ ] **Step 6: Run focused HTTP tests and observe GREEN**

Run: `pnpm test -- test/control-projects.integration.test.ts test/control-security.integration.test.ts`

Expected: PASS with owner-only behavior and unchanged project mutation tests.

- [ ] **Step 7: Commit the owner API**

```bash
git add src/control/contracts.ts src/control/routes.ts shared/control-api.ts test/control-projects.integration.test.ts test/control-security.integration.test.ts
git commit -m "feat: expose owner member management API"
```

### Task 4: Secure invitation capture, OAuth return, and redemption

**Files:**
- Modify: `src/config.ts`
- Modify: `src/rate-limits.ts`
- Modify: `src/web-auth/routes.ts`
- Modify: `src/http.ts`
- Modify: `deploy/Caddyfile.site`
- Modify: `deploy/env.production.example`
- Modify: `test/config.test.ts`
- Modify: `test/control-security.integration.test.ts`
- Modify: `test/web-auth-http.integration.test.ts`
- Modify: `test/production-deployment.test.ts`

**Interfaces:**
- Consumes: Task 2 `capture(rawToken)` and `redeem(...)` methods.
- Produces: public `GET /invite/:token` capture and authenticated `POST /api/v1/project-invitations/redeem`.
- Produces: `inviteCapture` IP rate-limit guard and `inviteRedeem` session rate-limit guard.
- Produces: `__Host-agentmesh_invite` in secure mode and `agentmesh_invite` locally, with 30-minute maximum age.

- [ ] **Step 1: Write failing capture/cookie tests**

Assert canonical valid token returns `303 /app/invitations/accept`, sets one HttpOnly SameSite=Lax invite cookie with correct secure prefix, and performs no membership mutation. Invalid, expired, revoked, and used tokens return the same safe unavailable redirect/result and do not set a usable cookie.

- [ ] **Step 2: Write failing first-login and authenticated redemption tests**

Simulate capture, GitHub start/callback, session creation, CSRF rotation, and redeem. Assert the new GitHub user receives one viewer membership and can read the project but receives 404 on archive and connection issuance. Repeat with a pre-existing authenticated recipient.

- [ ] **Step 3: Write failing cookie and logging security tests**

Cover duplicate invite cookies, malformed cookie bytes, replay after clearing, raw token absence from audit/log captures, and Caddy exclusion:

```ts
expect(caddyfile).toContain("@invite_capture path /invite/*");
expect(caddyfile).toContain("skip_log @invite_capture");
```

- [ ] **Step 4: Run focused tests and observe RED**

Run: `pnpm test -- test/config.test.ts test/control-security.integration.test.ts test/web-auth-http.integration.test.ts test/production-deployment.test.ts`

Expected: FAIL because invite guards, cookies, routes, and log policy do not exist.

- [ ] **Step 5: Add bounded rate-limit configuration**

Add `AGENTMESH_RATE_LIMIT_INVITE_CAPTURE` and `AGENTMESH_RATE_LIMIT_INVITE_REDEEM` with positive integer parsing and defaults `30` per ten minutes by IP and `10` per minute by session. Wire both through `RateLimitConfig`, `WebRouteRateLimits`, Compose environment, example environment, and tests. Rate-limit keys remain opaque hashes.

- [ ] **Step 6: Implement capture and redemption routes**

Use the existing strict raw-cookie parser to reject duplicate or malformed invitation cookies. Capture validates the path token, asks the service whether it is active, sets the short-lived cookie, and redirects without placing the raw token in a query string. Redemption requires `middleware.requireMutation`, reads exactly one canonical invite cookie, calls the service with `request.webSession.userId`, clears the cookie on every outcome, and returns `{ project_id }` on success.

- [ ] **Step 7: Protect application and proxy logs**

Ensure `/invite/*` is registered before SPA fallback, is not accepted as a static SPA path, and is skipped by Caddy access logs with a named matcher. Confirm application logging records neither raw request URLs for this route nor invitation token data.

- [ ] **Step 8: Run focused auth/security tests and observe GREEN**

Run: `pnpm test -- test/config.test.ts test/control-security.integration.test.ts test/web-auth-http.integration.test.ts test/production-deployment.test.ts`

Expected: PASS, including complete first-login GitHub OAuth redemption and viewer write denial.

- [ ] **Step 9: Commit secure invitation transport**

```bash
git add src/config.ts src/rate-limits.ts src/web-auth/routes.ts src/http.ts deploy/Caddyfile.site deploy/env.production.example test/config.test.ts test/control-security.integration.test.ts test/web-auth-http.integration.test.ts test/production-deployment.test.ts
git commit -m "feat: redeem viewer invitations after GitHub login"
```

### Task 5: Frontend API contracts and owner Members UI

**Files:**
- Modify: `shared/control-api.ts`
- Modify: `web/src/api/schemas.ts`
- Modify: `web/src/settings/project-settings.tsx`
- Create: `web/src/settings/project-members-section.tsx`
- Create: `web/src/settings/project-members-section.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: Task 3 owner HTTP response schemas.
- Produces: `ProjectMembersSection({ projectId })` rendered only after `project.can_edit === true`.
- Produces: one-time copy panel whose link exists only in React state.

- [ ] **Step 1: Write failing Members UI tests**

Render owner settings against a mocked API and assert owner/viewer identities, role badges, pending expiry, create-link button, copied feedback, revoke, remove confirmation, reload after mutations, and error states. Assert list responses never reconstruct or retain a raw URL.

```tsx
await user.click(screen.getByRole("button", { name: "Create viewer link" }));
expect(await screen.findByRole("textbox", { name: "Invitation link" })).toHaveValue(invitationUrl);
await user.click(screen.getByRole("button", { name: "Copy link" }));
expect(await screen.findByText("Copied")).toBeVisible();
```

- [ ] **Step 2: Run the UI test and observe RED**

Run: `pnpm --dir web test -- src/settings/project-members-section.test.tsx`

Expected: FAIL because the component and frontend exports do not exist.

- [ ] **Step 3: Export typed member and invitation schemas**

Re-export the shared schemas and types through `web/src/api/schemas.ts`. Keep `.strict()` parsing so accidental credential fields from the server cause an invalid-response failure.

- [ ] **Step 4: Implement the focused Members section**

Fetch `/api/v1/projects/${projectId}/members`, render semantic lists with avatars and role badges, and use `api.mutate` for creation/revocation/removal. Store `invitation.url` only in local state, clear it on route unmount, and never persist it to localStorage/sessionStorage. Use the Clipboard API with a failure message when unavailable.

- [ ] **Step 5: Integrate with owner settings**

Render `<ProjectMembersSection projectId={project.id} />` above lifecycle controls only after the existing `can_edit` gate. Do not expose Settings navigation or member management to viewers.

- [ ] **Step 6: Run Members and existing owner/shared-read tests and observe GREEN**

Run: `pnpm --dir web test -- src/settings/project-members-section.test.tsx src/owner/owner-flow.test.tsx src/owner/shared-read.test.tsx src/activity/activity-settings.test.tsx`

Expected: PASS with unchanged viewer read-only behavior.

- [ ] **Step 7: Commit the Members UI**

```bash
git add shared/control-api.ts web/src/api/schemas.ts web/src/settings/project-settings.tsx web/src/settings/project-members-section.tsx web/src/settings/project-members-section.test.tsx web/src/styles.css
git commit -m "feat: add project members settings"
```

### Task 6: Invitation acceptance UI and OAuth return preservation

**Files:**
- Create: `web/src/invitations/invitation-accept-page.tsx`
- Create: `web/src/invitations/invitation-accept-page.test.tsx`
- Modify: `web/src/auth/auth-gate.tsx`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/app/router.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/auth-onboarding.spec.ts`

**Interfaces:**
- Consumes: Task 4 `POST /api/v1/project-invitations/redeem` returning `{ project_id }`.
- Produces: authenticated route `/app/invitations/accept`.
- Produces: AuthGate GitHub link that returns to the current safe `/app` path, including the accept route but never an external origin.

- [ ] **Step 1: Write failing acceptance-page tests**

Cover loading, success redirect to `/app/projects/:projectId`, unavailable/expired-cookie result, already-member result, and retry guidance. Assert the page never reads a token from the URL or browser storage.

- [ ] **Step 2: Write failing AuthGate return-path tests**

At `/app/invitations/accept`, anonymous state must render:

```text
/auth/github/start?return_to=%2Fapp%2Finvitations%2Faccept
```

At ordinary `/app`, preserve the existing `%2Fapp` URL. Hostile or non-`/app` paths fall back to `/app`.

- [ ] **Step 3: Run focused frontend tests and observe RED**

Run: `pnpm --dir web test -- src/invitations/invitation-accept-page.test.tsx src/app/router.test.tsx`

Expected: FAIL because the accept route/page and current-path return behavior do not exist.

- [ ] **Step 4: Implement safe AuthGate return behavior**

Use React Router location, construct only `pathname + search + hash`, and accept it only when pathname is `/app` or begins `/app/`. Encode with `encodeURIComponent`; never accept a full URL or protocol-relative value.

- [ ] **Step 5: Implement the acceptance page and route**

On authenticated mount, submit one redemption request, guard React StrictMode against duplicate in-flight calls, and replace-navigate on success. Map `INVITATION_UNAVAILABLE` and `ALREADY_MEMBER` to clear messages with an **Open projects** action; clear sensitive state by relying only on the HttpOnly cookie.

- [ ] **Step 6: Add the browser journey**

Extend the E2E harness with an invitation fixture. Exercise public capture → anonymous accept page → GitHub OAuth callback → authenticated redeem → project overview, then verify Settings is absent and a write request returns 404.

- [ ] **Step 7: Run frontend unit and invitation E2E tests and observe GREEN**

Run: `pnpm --dir web test -- src/invitations/invitation-accept-page.test.tsx src/app/router.test.tsx`

Run: `pnpm --dir web exec playwright test e2e/auth-onboarding.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit invitation acceptance UI**

```bash
git add web/src/invitations web/src/auth/auth-gate.tsx web/src/app/router.tsx web/src/app/router.test.tsx web/src/styles.css web/e2e/auth-onboarding.spec.ts
git commit -m "feat: add viewer invitation acceptance flow"
```

### Task 7: Full verification and security review

**Files:**
- Modify only if a failing check exposes a defect in the files already listed.

**Interfaces:**
- Consumes: Tasks 1-6 as one release candidate.
- Produces: locally verified commit with no unrelated diff or raw invitation credential leakage.

- [ ] **Step 1: Run focused backend suites**

Run: `pnpm test -- test/db.integration.test.ts test/hosted-schema.integration.test.ts test/project-membership-invitations.integration.test.ts test/control-projects.integration.test.ts test/control-read.integration.test.ts test/control-connections.integration.test.ts test/control-security.integration.test.ts test/web-auth-http.integration.test.ts test/production-deployment.test.ts`

Expected: PASS.

- [ ] **Step 2: Run static checks**

Run: `pnpm typecheck && pnpm lint && pnpm --dir web test && pnpm build`

Expected: all commands exit 0.

- [ ] **Step 3: Run full backend and browser suites**

Run: `pnpm test && pnpm test:e2e && pnpm audit:repository && pnpm audit --prod`

Expected: all commands exit 0 and production dependency audit reports no blocking vulnerability.

- [ ] **Step 4: Perform credential and authorization diff review**

Run:

```bash
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- src/db/schema.ts src/control src/web-auth shared web/src deploy/Caddyfile.site test
rg -n "tokenDigest|token_digest|invitationUrl|rawToken|agentmesh_invite" src web shared test deploy
```

Expected: token material appears only in local variables, one-time creation response, secure cookie handling, and synthetic tests; no logger/audit payload or persistent plaintext field exists. Every project mutation still predicates on `ownerUserId`/`projects.ownerUserId`.

- [ ] **Step 5: Commit any verification fixes**

If checks required code changes, rerun the directly affected focused test first, then all Step 2 and Step 3 commands, and commit only those fixes:

```bash
git add -u
git commit -m "fix: harden project invitation flow"
```

If no files changed, record the successful commands in the pull-request description without creating an empty commit.

### Task 8: Pull request, merge, and production deployment

**Files:**
- No source edits expected.
- Production state: `/opt/agentmesh`, its protected environment, backup directory, and running Compose services.

**Interfaces:**
- Consumes: verified feature branch and GitHub Actions image digest.
- Produces: merged `main`, exact-digest production deployment, applied `project_invitations` migration, and runtime evidence.

- [ ] **Step 1: Coordinate and push the feature branch**

Poll AgentMesh, verify no active peer owns overlapping files, report final paths/tests, then run:

```bash
git status --short --branch
git push -u origin codex/project-invite-links
```

Expected: clean worktree and pushed branch.

- [ ] **Step 2: Open the pull request and wait for CI**

Run:

```bash
gh pr create --base main --head codex/project-invite-links --title "Add GitHub viewer invitation links" --body $'## Summary\n- add digest-only, single-use viewer invitations\n- redeem after GitHub OAuth through an HttpOnly cookie\n- add owner Members UI while preserving owner-only writes\n\n## Verification\n- pnpm typecheck\n- pnpm lint\n- pnpm test\n- pnpm --dir web test\n- pnpm build\n- pnpm test:e2e\n- pnpm audit:repository\n- pnpm audit --prod'
gh pr checks --watch
```

The body records the security model, migrations, exact test commands, UI flow, and owner-only write proof. Expected: pull-request CI passes; the immutable image is built only after merge.

- [ ] **Step 3: Merge only the green pull request**

Run: `gh pr merge --merge --delete-branch`

Then run: `git fetch origin --prune && git rev-parse origin/main`

Expected: the merge commit contains the reviewed feature commits.

- [ ] **Step 4: Resolve the immutable image digest**

Wait for the `Container image` workflow on the merge commit, then run:

```bash
merge_sha=$(git rev-parse origin/main)
image_tag="ghcr.io/microinginer/agentmesh-mcp:sha-${merge_sha:0:7}"
verified_digest=$(docker buildx imagetools inspect "$image_tag" --format '{{.Manifest.Digest}}')
[[ $verified_digest =~ ^sha256:[0-9a-f]{64}$ ]]
printf '%s %s\n' "$merge_sha" "$verified_digest"
```

Expected: one canonical manifest digest. Inspect image labels and verify the revision equals `merge_sha` before deployment.

- [ ] **Step 5: Back up and restore-check production**

On the production host, run `/opt/agentmesh/scripts/backup.sh` followed by `/opt/agentmesh/scripts/restore-check.sh` and retain their success output. Abort deployment if either command fails.

- [ ] **Step 6: Deploy the exact digest**

Pull the immutable image reference on the production host, then invoke the guarded deploy script with the validated digest:

```bash
ssh root@188.245.114.194 "docker pull '$image_tag@$verified_digest' >/dev/null && /opt/agentmesh/scripts/deploy.sh '$verified_digest'"
```

Expected: `deployment ready`; the script rolls back automatically if readiness fails. The value is the digest verified in Step 4, not a mutable tag.

- [ ] **Step 7: Verify migration and runtime**

Check container health/restart count; `/health`, `/ready`, `/app`, and `/guide`; and PostgreSQL table/check/index state. Confirm `project_invitations` exists, no invalid role/digest/terminal rows exist, and existing owner memberships remain unchanged.

- [ ] **Step 8: Perform authenticated owner/viewer smoke tests**

Using controlled GitHub test accounts, create a link as owner, capture it as the second account, complete GitHub OAuth, redeem, and verify project list/overview/agents/messages reads. Verify viewer archive, delete, connection issue/revoke, token, and member-management requests return the established 404/403 policy while owner mutations still work.

- [ ] **Step 9: Check fresh logs and report release evidence**

Record app and Caddy log byte offsets before the smoke journey, then scan only fresh output for the raw invitation token, invitation cookie name/value, OAuth credentials, unhandled errors, 5xx responses, and restart loops. Expected: no credential occurrence and no new unexpected error. Send AgentMesh the received/acknowledged/sent sequence numbers, merge commit, image digest, migration result, HTTP/auth proof, and test totals.
