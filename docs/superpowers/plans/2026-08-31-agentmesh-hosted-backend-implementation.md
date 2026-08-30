# AgentMesh Hosted Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub sign-in, durable web sessions, single-owner projects, named connection tokens, owner and operator APIs, and safe control-plane auditing without changing the public MCP tool contract.

**Architecture:** Extend the existing Fastify and PostgreSQL modular monolith. GitHub OAuth is isolated behind a typed client, browser sessions are opaque database-backed credentials, and owner services apply user-plus-project predicates at the repository boundary. The MCP HTTP wrapper authenticates a named project token and passes its non-secret ID into existing agent registration as provenance.

**Tech Stack:** Node.js 24, TypeScript 7, Fastify 5, `@fastify/cookie`, `@fastify/rate-limit`, PostgreSQL 18, Drizzle ORM, Zod 4, Vitest 4, Node `crypto` and `fetch`

**Spec:** `docs/superpowers/specs/2026-08-31-agentmesh-hosted-control-plane-design.md`

## Global Constraints

- Preserve the existing MCP tools `agentmesh_sync`, `agentmesh_send`, and `agentmesh_list_agents` and their request and response contracts.
- Anyone with a GitHub account may sign in; request no OAuth scopes and persist no GitHub access or refresh token.
- Identify GitHub users only by the immutable numeric provider user ID; login, display name, and avatar are snapshots.
- One web-created project has exactly one owner; the hosted default is five active projects per owner and self-hosted `0` means unlimited.
- A named connection token is shown once, stored only as a digest, has a 90-day hosted default, and may be revoked independently.
- Web sessions have a seven-day idle expiry and a 30-day absolute expiry.
- Every state-changing owner request requires a valid session, exact allowed `Origin`, and CSRF header.
- Never log or return OAuth codes, state, PKCE values, GitHub tokens, cookies, session tokens, CSRF tokens, project tokens, token digests, message text, or metadata outside their approved owner response.
- Keep legacy CLI-created projects and the emergency `/admin` dashboard working while the new control plane is introduced.
- Use TDD for every behavior and commit only after the focused and relevant regression tests pass.

---

## File Structure

New backend units:

- `src/audit/types.ts`: closed vocabulary and safe metadata for human and operator audit events.
- `src/audit/service.ts`: secret-free best-effort and transactional control-plane audit persistence.
- `src/web-auth/oauth-cookie.ts`: five-minute authenticated encryption for OAuth state and PKCE verifier.
- `src/web-auth/github-client.ts`: GitHub authorization URL, code exchange, and validated profile fetch.
- `src/web-auth/identity-service.ts`: durable GitHub identity upsert keyed by numeric provider ID.
- `src/web-auth/session-service.ts`: opaque sessions, CSRF proof, sliding idle expiry, logout, and blocking.
- `src/web-auth/oauth-service.ts`: orchestration of OAuth start and callback without token persistence.
- `src/web-auth/middleware.ts`: Fastify session, operator, origin, and CSRF pre-handlers.
- `src/web-auth/routes.ts`: `/auth/github/*` and `/api/v1/session` HTTP routes.
- `src/control/contracts.ts`: strict project, connection, paging, and operator schemas.
- `src/control/project-service.ts`: owner project create/list/archive/restore/delete with serialized limits.
- `src/control/connection-service.ts`: named token issue/list/revoke and idempotency behavior.
- `src/control/read-service.ts`: owner-scoped project summary, agents, messages, and activity queries.
- `src/control/routes.ts`: owner project, connection, and read APIs.
- `src/control/operator-service.ts`: metadata-only user/project blocking and operator queries.
- `src/control/operator-routes.ts`: `/api/v1/ops/*` routes protected by numeric GitHub ID allowlist.
- `src/http-errors.ts`: one safe control-plane error envelope and status mapping.
- `test/support/database.ts`: one reset helper for all PostgreSQL integration suites.
- `test/support/hosted.ts`: deterministic clock, cookie extraction, and authenticated owner HTTP fixture helpers.

### Test Harness Conventions

Create these exact helpers once in `test/support/hosted.ts` and import them wherever a snippet below uses the corresponding name:

```ts
export interface TestClock {
  now(): Date;
  set(iso: string): void;
}

export function createTestClock(initialIso: string): TestClock;
export function firstCookie(response: { headers: Record<string, unknown> }): string;
export function createOwnerClient(input: {
  app: FastifyInstance;
  cookie: string;
  csrf: string;
  origin: string;
}): { get(path: string): Promise<LightMyRequestResponse> };
```

Every browser-auth integration test constructs its own `clock`, `ownerA`, and `ownerB` from these helpers; no test relies on undeclared globals.

Existing files remain responsible for MCP transport, agent behavior, message behavior, CLI provisioning, and the legacy admin surface.

### Task 1: Extend the database schema without breaking existing projects

**Files:**
- Create: `src/audit/types.ts`
- Create: `src/audit/service.ts`
- Create: `test/support/database.ts`
- Create: `test/support/hosted.ts`
- Create: `test/hosted-schema.integration.test.ts`
- Create: `drizzle/0003_hosted_control_plane.sql`
- Create: `drizzle/meta/0003_snapshot.json`
- Modify: `src/db/schema.ts`
- Modify: `src/activity/types.ts`
- Modify: `src/observer/service.ts`
- Modify: `drizzle/meta/_journal.json`
- Modify: `test/db.integration.test.ts`
- Modify: `test/projects.integration.test.ts`
- Modify: `test/agents.integration.test.ts`
- Modify: `test/messages.integration.test.ts`
- Modify: `test/activity.integration.test.ts`
- Modify: `test/mcp.contract.test.ts`
- Modify: `test/admin-http.integration.test.ts`
- Modify: `test/admin-query.integration.test.ts`
- Modify: `test/observer.integration.test.ts`
- Modify: `test/cli.integration.test.ts`

**Interfaces:**
- Consumes: current `projects`, `project_tokens`, `agents`, `messages`, and observer views from `src/db/schema.ts`.
- Produces: Drizzle tables `users`, `oauthIdentities`, `webSessions`, `auditEvents`; nullable legacy-compatible `projects.ownerUserId`; connection metadata on `projectTokens`; nullable `agents.registeredViaTokenId`; `resetDatabase(pool)`; `createAuditService({ db, clock?, onPersistFailure? })`.

- [ ] **Step 1: Add a shared reset helper and a failing hosted-schema integration test**

```ts
// test/support/database.ts
import type { Pool } from "pg";

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      audit_events, web_sessions, oauth_identities,
      activity_events, messages, agents, project_tokens, projects, users
    RESTART IDENTITY CASCADE
  `);
}
```

```ts
// test/hosted-schema.integration.test.ts
it("preserves legacy projects while enforcing durable hosted identities", async () => {
  const legacyId = randomUUID();
  await database.db.insert(projects).values({ id: legacyId, name: "legacy" });
  const [legacy] = await database.db.select().from(projects);
  expect(legacy?.ownerUserId).toBeNull();

  const [user] = await database.db.insert(users).values({
    displayName: "Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  }).returning();
  expect(user).toBeDefined();

  await database.db.insert(oauthIdentities).values({
    userId: user!.id,
    provider: "github",
    providerUserId: "1",
    login: "octocat",
  });
  await expect(database.db.insert(oauthIdentities).values({
    userId: randomUUID(),
    provider: "github",
    providerUserId: "1",
    login: "duplicate",
  })).rejects.toThrow();
});
```

- [ ] **Step 2: Run the new schema test and verify that it fails before the tables exist**

Run: `pnpm vitest run test/hosted-schema.integration.test.ts`

Expected: FAIL because `users`, `oauthIdentities`, `webSessions`, and new hosted columns are not exported.

- [ ] **Step 3: Define the hosted tables, constraints, observer views, and migration**

Add these exact domain shapes in `src/db/schema.ts`:

```ts
export const projectStatuses = ["active", "archived"] as const;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  avatarUrl: text("avatar_url"),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthIdentities = pgTable("oauth_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  providerUserId: varchar("provider_user_id", { length: 64 }).notNull(),
  login: varchar("login", { length: 100 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("oauth_identities_provider_user_unique").on(table.provider, table.providerUserId)]);

export const webSessions = pgTable("web_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenDigest: bytea("token_digest").notNull().unique(),
  csrfDigest: bytea("csrf_digest").notNull(),
  authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Extend existing tables with the approved nullable legacy fields and enforce same-project provenance with a composite foreign key. Define `audit_events` without a project foreign key so deletion evidence survives. Add safe observer views for users, connections, and audit events; never include digests or session rows.

Generate the migration with:

```bash
pnpm db:generate -- --name hosted_control_plane
```

Review `drizzle/0003_hosted_control_plane.sql` to ensure existing project tokens receive label `Legacy CLI token`, existing projects remain ownerless, and existing agents keep null provenance.

- [ ] **Step 4: Implement secret-free audit persistence; defer runtime provenance wiring to Task 7**

```ts
// src/audit/types.ts
export const auditEventTypes = [
  "auth.login_succeeded", "auth.login_failed", "auth.logout",
  "project.created", "project.archived", "project.restored", "project.deleted",
  "connection.created", "connection.revoked",
  "operator.user_blocked", "operator.user_unblocked", "operator.project_archived",
] as const;

export interface AuditMetadata {
  provider?: "github";
  connection_label?: string;
  project_name?: string;
}
```

`createAuditService` must expose `record(input, executor?)` and `recordBestEffort(input)`, copy only keys declared in `AuditMetadata`, and accept nullable `userId` and `projectId`. Task 1 adds the nullable provenance column only; Task 7 changes the agent-service signature after authenticated connection IDs are available, so intermediate commits remain buildable.

- [ ] **Step 5: Replace repeated integration-test truncation with `resetDatabase` and run migrations twice**

Run: `pnpm vitest run test/hosted-schema.integration.test.ts test/db.integration.test.ts test/observer.integration.test.ts test/agents.integration.test.ts`

Expected: PASS, including a second call to `migrateDatabase()` against the already migrated test database.

- [ ] **Step 6: Run the full existing suite before committing the schema boundary**

Run: `pnpm typecheck && pnpm lint && pnpm test`

Expected: PASS with all pre-hosted MCP and admin regressions still green.

- [ ] **Step 7: Commit the schema boundary**

```bash
git add src/db src/audit src/activity/types.ts src/observer/service.ts drizzle test
git commit -m "feat: add hosted identity and ownership schema"
```

### Task 2: Add validated hosted configuration and credential primitives

**Files:**
- Create: `src/web-auth/oauth-cookie.ts`
- Create: `src/web-auth/session-token.ts`
- Create: `test/web-auth-crypto.test.ts`
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: root `AGENT_SESSION_SIGNING_KEY` and existing optional-admin configuration behavior.
- Produces: `WebAuthConfig`; `sealOAuthAttempt(attempt, key)`; `openOAuthAttempt(value, key, now)`; `createSessionCredential(keys)`; `digestSessionToken(raw, key)`; `verifyCsrfToken(raw, digest, key)`.

- [ ] **Step 1: Write failing configuration and crypto tests**

```ts
it("enables web auth only when the complete OAuth group is present", () => {
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    AGENT_SESSION_SIGNING_KEY: signingKey,
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_OAUTH_CALLBACK_URL: "https://agentmesh.example/auth/github/callback",
    AGENTMESH_PUBLIC_ORIGIN: "https://agentmesh.example",
    AGENTMESH_WEB_AUTH_KEY: Buffer.alloc(32, 4).toString("base64url"),
    AGENTMESH_OPERATOR_GITHUB_IDS: "1,42",
    AGENTMESH_PROJECT_LIMIT: "5",
  });
  expect(config.web?.operatorGitHubIds).toEqual(new Set(["1", "42"]));
  expect(config.web?.projectLimit).toBe(5);
});

it("rejects a tampered or expired OAuth attempt", () => {
  const key = Buffer.alloc(32, 8);
  const sealed = sealOAuthAttempt({ state: "s", verifier: "v", expiresAt: 1_000 }, key);
  expect(openOAuthAttempt(sealed, key, new Date(999))).toEqual({ state: "s", verifier: "v", expiresAt: 1_000 });
  expect(() => openOAuthAttempt(`${sealed}x`, key, new Date(999))).toThrow("Invalid OAuth attempt");
  expect(() => openOAuthAttempt(sealed, key, new Date(1_001))).toThrow("Invalid OAuth attempt");
});
```

- [ ] **Step 2: Run focused tests and verify missing exports and environment rules fail**

Run: `pnpm vitest run test/config.test.ts test/web-auth-crypto.test.ts`

Expected: FAIL because hosted configuration and crypto modules do not exist.

- [ ] **Step 3: Install cookie and route rate-limit support**

Run: `pnpm add @fastify/cookie @fastify/rate-limit`

Expected: `package.json` and `pnpm-lock.yaml` contain compatible Fastify 5 plugins and no unrelated dependency changes.

- [ ] **Step 4: Implement all-or-nothing `WebAuthConfig` validation**

```ts
export interface WebAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: URL;
  publicOrigin: URL;
  authKey: Buffer;
  operatorGitHubIds: ReadonlySet<string>;
  projectLimit: number;
  tokenTtlDays: number;
  secureCookies: boolean;
}
```

`loadConfig` must return `web: null` when all hosted keys are absent, fail closed when only part of the group is set, require callback origin equality with `AGENTMESH_PUBLIC_ORIGIN`, require HTTPS except loopback development origins, validate numeric operator IDs, allow project limit `0..100`, and default token TTL to 90 days.

- [ ] **Step 5: Implement authenticated OAuth cookies and opaque session credentials**

Use AES-256-GCM with a fresh 96-bit IV for OAuth-attempt cookies and a versioned `v1.<iv>.<ciphertext>.<tag>` value. Derive independent OAuth, session-digest, and CSRF-digest keys with HMAC-SHA-256 labels. Generate session and CSRF secrets with 32 random bytes and compare digests with `timingSafeEqual`.

- [ ] **Step 6: Run focused and regression tests**

Run: `pnpm vitest run test/config.test.ts test/web-auth-crypto.test.ts test/admin-auth.test.ts`

Expected: PASS; tests prove raw secrets are absent from returned configuration snapshots and error messages.

- [ ] **Step 7: Commit configuration and primitives**

```bash
git add package.json pnpm-lock.yaml .env.example src/config.ts src/web-auth test/config.test.ts test/web-auth-crypto.test.ts
git commit -m "feat: add hosted auth configuration primitives"
```

### Task 3: Implement the GitHub OAuth client and durable identity upsert

**Files:**
- Create: `src/web-auth/github-client.ts`
- Create: `src/web-auth/identity-service.ts`
- Create: `test/github-client.test.ts`
- Create: `test/identity.integration.test.ts`

**Interfaces:**
- Consumes: `users`, `oauthIdentities`, `auditEvents`, `WebAuthConfig`.
- Produces: `GitHubOAuthClient`; `GitHubProfile`; `createGitHubClient({ clientId, clientSecret, callbackUrl, fetchImpl?, endpoints? })`; `createIdentityService({ db, clock? }).upsertGitHub(profile)`.

- [ ] **Step 1: Write failing GitHub validation and identity concurrency tests**

```ts
it("uses no scope and rejects non-numeric GitHub IDs", async () => {
  const requests: Request[] = [];
  const client = createGitHubClient({
    clientId: "id",
    clientSecret: "secret",
    callbackUrl: new URL("https://agentmesh.example/auth/github/callback"),
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ id: "not-numeric", login: "bad" });
    },
  });
  expect(client.authorizationUrl("state", "challenge").searchParams.get("scope")).toBeNull();
  await expect(client.fetchProfile("ephemeral-token")).rejects.toThrow("Invalid GitHub profile");
});

it("converges concurrent callbacks on one local user", async () => {
  const profile = { id: "42", login: "octocat", name: "Octo Cat", avatarUrl: null };
  const [a, b] = await Promise.all([service.upsertGitHub(profile), service.upsertGitHub(profile)]);
  expect(a.userId).toBe(b.userId);
  const [{ value }] = await database.db.select({ value: count() }).from(oauthIdentities);
  expect(value).toBe(1);
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm vitest run test/github-client.test.ts test/identity.integration.test.ts`

Expected: FAIL because the GitHub and identity services are absent.

- [ ] **Step 3: Implement the typed GitHub client with injected transport**

```ts
export interface GitHubProfile {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubOAuthClient {
  authorizationUrl(state: string, challenge: string): URL;
  exchangeCode(code: string, verifier: string): Promise<string>;
  fetchProfile(accessToken: string): Promise<GitHubProfile>;
}
```

The exchange sends `Accept: application/json`; the profile request sends `Authorization: Bearer` and GitHub's JSON media type. Zod accepts only a positive base-10 integer ID, a bounded login, nullable bounded name, and nullable HTTPS avatar URL. Any non-2xx or invalid body becomes a safe typed error without response-body or token text.

- [ ] **Step 4: Implement transactional identity upsert keyed by `(github, numeric ID)`**

On first login insert a local user and identity. On repeated login update login, display name fallback, avatar, and last-login timestamps. Use insert-on-conflict plus a reselect so concurrent callbacks return one local user. Record only safe success/failure audit metadata.

- [ ] **Step 5: Run focused tests and verify token secrecy**

Run: `pnpm vitest run test/github-client.test.ts test/identity.integration.test.ts`

Expected: PASS, and serialized thrown errors and recorded audit events do not contain the fake access token or GitHub response body.

- [ ] **Step 6: Commit GitHub identity support**

```bash
git add src/web-auth/github-client.ts src/web-auth/identity-service.ts test/github-client.test.ts test/identity.integration.test.ts
git commit -m "feat: add GitHub identity service"
```

### Task 4: Implement database-backed web sessions and CSRF validation

**Files:**
- Create: `src/http-errors.ts`
- Create: `src/web-auth/session-service.ts`
- Create: `src/web-auth/middleware.ts`
- Create: `test/web-session.integration.test.ts`

**Interfaces:**
- Consumes: session/CSRF digests from Task 2 and `webSessions`, `users`, `oauthIdentities` from Task 1.
- Produces: `AuthenticatedWebSession`; `createWebSessionService({ db, keys, clock? })`; Fastify pre-handlers `requireSession`, `requireMutation`, and `requireOperator`.

- [ ] **Step 1: Write failing session lifetime, logout, block, origin, and CSRF tests**

```ts
it("extends idle expiry without crossing the absolute expiry", async () => {
  const clock = createTestClock("2026-08-01T00:00:00Z");
  const service = createWebSessionService({ db: database.db, keys, clock: clock.now });
  const issued = await service.issue(userId, new Date("2026-08-01T00:00:00Z"));
  clock.set("2026-08-07T23:00:00Z");
  const session = await service.authenticate(issued.sessionToken);
  expect(session?.idleExpiresAt.toISOString()).toBe("2026-08-14T23:00:00.000Z");
  expect(session?.absoluteExpiresAt.toISOString()).toBe("2026-08-31T00:00:00.000Z");
});

it("rejects a valid session when origin or CSRF proof is wrong", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/test-mutation",
    headers: { cookie, origin: "https://attacker.example", "x-csrf-token": csrf },
  });
  expect(response.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run the session test and verify it fails**

Run: `pnpm vitest run test/web-session.integration.test.ts`

Expected: FAIL because session service and pre-handlers do not exist.

- [ ] **Step 3: Implement opaque session issue, touch, revoke, and bulk revoke**

```ts
export interface AuthenticatedWebSession {
  sessionId: string;
  userId: string;
  githubUserId: string;
  githubLogin: string;
  displayName: string;
  avatarUrl: string | null;
  authenticatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  csrfDigest: Buffer;
}
```

`issue` returns raw `sessionToken` and `csrfToken` only to the caller and stores their keyed digests. `authenticate` joins user and GitHub identity, rejects revoked/expired/blocked rows, updates `lastSeenAt` and idle expiry at most once per five minutes, and never extends past `absoluteExpiresAt`. `revoke` and `revokeAllForUser` update rows transactionally.

- [ ] **Step 4: Implement exact-origin and CSRF pre-handlers**

`requireSession` parses only the AgentMesh session cookie and attaches `request.webSession`. `requireMutation` additionally requires exact `Origin` equality and `X-CSRF-Token` digest verification. `requireOperator` checks `githubUserId` against `WebAuthConfig.operatorGitHubIds`. Map missing auth to `401`, origin/CSRF/operator failures to `403`, and database failures to safe `503` envelopes.

- [ ] **Step 5: Run session and legacy admin tests**

Run: `pnpm vitest run test/web-session.integration.test.ts test/admin-http.integration.test.ts`

Expected: PASS; new cookie names do not collide with `agentmesh_admin_session`.

- [ ] **Step 6: Commit web sessions**

```bash
git add src/web-auth/session-service.ts src/web-auth/middleware.ts src/http-errors.ts test/web-session.integration.test.ts
git commit -m "feat: add secure web sessions"
```

### Task 5: Expose OAuth, session, and logout HTTP routes

**Files:**
- Create: `src/web-auth/oauth-service.ts`
- Create: `src/web-auth/routes.ts`
- Create: `test/web-auth-http.integration.test.ts`
- Modify: `src/http.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `GitHubOAuthClient`, identity service, session service, OAuth-cookie crypto, audit service, and `@fastify/cookie`.
- Produces: `createOAuthService(dependencies)`; `registerWebAuthRoutes(app, dependencies)`; `GET /auth/github/start`; `GET /auth/github/callback`; `GET /api/v1/session`; `DELETE /api/v1/session`.

- [ ] **Step 1: Write failing HTTP tests for start, callback, replay, safe return paths, reauthentication, session, and logout**

```ts
it("creates a local session and never persists the GitHub token", async () => {
  const start = await app.inject({ method: "GET", url: "/auth/github/start" });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location!).searchParams.get("state");
  const attemptCookie = firstCookie(start);

  const callback = await app.inject({
    method: "GET",
    url: `/auth/github/callback?code=one-use&state=${encodeURIComponent(state!)}`,
    headers: { cookie: attemptCookie },
  });
  expect(callback.statusCode).toBe(303);
  expect(callback.headers.location).toBe("/app");
  expect(callback.headers["set-cookie"]).toContain("HttpOnly");
  expect(await database.pool.query("select access_token from oauth_identities"))
    .rejects.toThrow();
});
```

- [ ] **Step 2: Run the HTTP test and verify it fails**

Run: `pnpm vitest run test/web-auth-http.integration.test.ts`

Expected: FAIL because OAuth routes are not registered.

- [ ] **Step 3: Implement single-use OAuth orchestration**

`start` generates 32-byte state and a 43..128 character PKCE verifier, seals them for five minutes, and returns GitHub's URL plus the cookie value. An optional `return_to` is accepted only when it is a relative `/app` path with no authority, backslash, encoded slash, or control character; otherwise use `/app`. `callback` consumes the cookie before exchange, verifies state with constant-time comparison, exchanges and fetches profile, discards the access token in a `finally`-bounded local scope, upserts identity, and issues the local session. Reauthentication for an already signed-in identity rotates the local session, updates `authenticatedAt`, and redirects only to the sealed safe path.

- [ ] **Step 4: Register routes and safe cookie policies**

Production cookies are `__Host-agentmesh_oauth` and `__Host-agentmesh_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`, and have no `Domain`. Loopback development uses unprefixed names with `Secure=false`. OAuth failures redirect to `/?auth_error=github` and never include provider error text. `/api/v1/session` returns the user snapshot, CSRF token, and operator boolean under `Cache-Control: no-store`.

- [ ] **Step 5: Run OAuth, config, logging, and admin regressions**

Run: `pnpm vitest run test/web-auth-http.integration.test.ts test/config.test.ts test/admin-http.integration.test.ts test/mcp.contract.test.ts`

Expected: PASS, including callback replay rejection, external/protocol-relative/encoded-path rejection, recent-auth rotation, and serialized-output scans for fake secrets.

- [ ] **Step 6: Commit HTTP authentication**

```bash
git add src/web-auth src/http.ts src/server.ts test/web-auth-http.integration.test.ts
git commit -m "feat: expose GitHub web authentication"
```

### Task 6: Implement owner project lifecycle with serialized limits

**Files:**
- Create: `src/control/contracts.ts`
- Create: `src/control/project-service.ts`
- Create: `src/control/routes.ts`
- Create: `test/control-projects.integration.test.ts`
- Modify: `src/http.ts`

**Interfaces:**
- Consumes: authenticated web session, CSRF middleware, `projects`, `users`, audit service, and configured project limit.
- Produces: `createControlProjectService({ db, audit, projectLimit, clock? })`; owner endpoints for list, create, detail, archive, restore, and delete.

- [ ] **Step 1: Write failing concurrency, ownership, archive, and deletion tests**

```ts
it("never exceeds five active projects under concurrent creation", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) => service.create({
      ownerUserId,
      name: `project-${index}`,
      description: null,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    })),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
  expect(await activeProjectCount(ownerUserId)).toBe(5);
});

it("returns not found for another owner's project", async () => {
  const response = await ownerB.get(`/api/v1/projects/${ownerAProjectId}`);
  expect(response.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run the project tests and verify they fail**

Run: `pnpm vitest run test/control-projects.integration.test.ts`

Expected: FAIL because owner project service and routes are absent.

- [ ] **Step 3: Implement strict contracts and transactional lifecycle service**

Use Zod limits: trimmed project name `1..100`, description `0..500` or null, UUID v4 path IDs, UUID v4 `Idempotency-Key`, and page limit `1..100` default 50. `create` and `restore` lock the owner row, count active rows, and enforce the configured limit in the same transaction. Creation uses unique `(owner_user_id, create_idempotency_key)` to return the original project on replay.

- [ ] **Step 4: Implement owner routes and destructive confirmation**

Expose:

```text
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:projectId
POST   /api/v1/projects/:projectId/archive
POST   /api/v1/projects/:projectId/restore
DELETE /api/v1/projects/:projectId
```

Deletion requires `authenticatedAt` within 15 minutes and body `{ "confirm_name": "exact project name" }`. Every mutation writes an audit event in the same transaction as the domain change. Every response uses the safe envelope and `Cache-Control: no-store`.

- [ ] **Step 5: Run project and cross-owner isolation tests**

Run: `pnpm vitest run test/control-projects.integration.test.ts test/projects.integration.test.ts`

Expected: PASS for limit races, idempotent retry, archive/restore, exact-name deletion, and legacy ownerless project invisibility.

- [ ] **Step 6: Commit project lifecycle**

```bash
git add src/control/contracts.ts src/control/project-service.ts src/control/routes.ts src/http.ts test/control-projects.integration.test.ts
git commit -m "feat: add owner project lifecycle"
```

### Task 7: Add named connection tokens and MCP provenance

**Files:**
- Create: `src/control/connection-service.ts`
- Create: `test/control-connections.integration.test.ts`
- Modify: `src/control/routes.ts`
- Modify: `src/projects/service.ts`
- Modify: `src/http.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/agents/service.ts`
- Modify: `src/cli.ts`
- Modify: `test/projects.integration.test.ts`
- Modify: `test/mcp.contract.test.ts`
- Modify: `test/cli.integration.test.ts`

**Interfaces:**
- Consumes: current project-token parser/digest, owner project lifecycle, agent registration, and Fastify-to-MCP `AuthInfo.extra`.
- Produces: `AuthenticatedProject { projectId: string; connectionTokenId: string }`; `createConnectionService`; connection list/issue/revoke routes; agent provenance.

- [ ] **Step 1: Write failing one-time secret, replay, expiry, revocation, and provenance tests**

```ts
it("returns a named token once and revokes only that connection", async () => {
  const first = await service.issue({ ownerUserId, projectId, label: "Main Mac", idempotencyKey, requestId });
  expect(first.secret).toMatch(/^am_proj_/);
  const replay = await service.issue({ ownerUserId, projectId, label: "Main Mac", idempotencyKey, requestId });
  expect(replay).toMatchObject({ connectionId: first.connectionId, secret: null, secretRecoverable: false });

  const second = await service.issue({ ownerUserId, projectId, label: "Second PC", idempotencyKey: randomUUID(), requestId });
  await service.revoke({ ownerUserId, projectId, connectionId: first.connectionId, requestId });
  await expect(projectService.authenticateProject(first.secret!)).rejects.toMatchObject({ code: "PROJECT_AUTH_INVALID" });
  await expect(projectService.authenticateProject(second.secret!)).resolves.toMatchObject({ projectId });
});
```

- [ ] **Step 2: Run connection tests and verify they fail**

Run: `pnpm vitest run test/control-connections.integration.test.ts test/projects.integration.test.ts`

Expected: FAIL because token metadata, revoke behavior, and `AuthenticatedProject` are absent.

- [ ] **Step 3: Implement named issue/list/revoke with one-time replay semantics**

Labels are trimmed `1..80`. Issue locks the owned active project, inserts the digest with 90-day default expiry and UUID idempotency key, and returns the secret only from the insert path. A uniqueness conflict reselects metadata and returns `secret: null`. List never selects `tokenDigest`. Revoke sets `revokedAt` once and audits in the same transaction.

- [ ] **Step 4: Harden project authentication and pass token provenance into MCP**

Change the service contract to:

```ts
export interface AuthenticatedProject {
  projectId: string;
  connectionTokenId: string;
}

authenticateProject(token: string): Promise<AuthenticatedProject>;
```

Authentication parses and verifies without mutating, then in a transaction locks project followed by token, rechecks digest, active status, owner block state, expiry, and revocation, updates `lastUsedAt`, and returns both IDs. Set `request.raw.auth.extra = { connectionTokenId }`; `buildMcpHandler` reads that exact string and passes it only to registration. Update the CLI project-create path to label its initial token `Legacy CLI token` and keep its JSON output compatible.

- [ ] **Step 5: Expose connection routes**

```text
GET  /api/v1/projects/:projectId/connections
POST /api/v1/projects/:projectId/connections
POST /api/v1/projects/:projectId/connections/:connectionId/revoke
```

The first POST response includes `{ connection, secret, secret_recoverable: true }`; a replay includes `{ connection, secret: null, secret_recoverable: false }`. All responses are `no-store`.

- [ ] **Step 6: Run focused and MCP contract tests**

Run: `pnpm vitest run test/control-connections.integration.test.ts test/projects.integration.test.ts test/mcp.contract.test.ts test/cli.integration.test.ts`

Expected: PASS, including two SDK clients on two tokens, provenance stored on each agent, first-token revoke failure, and second-token continued success.

- [ ] **Step 7: Commit named connections**

```bash
git add src/control src/projects/service.ts src/http.ts src/mcp/server.ts src/agents/service.ts src/cli.ts test/control-connections.integration.test.ts test/projects.integration.test.ts test/mcp.contract.test.ts test/cli.integration.test.ts
git commit -m "feat: add named MCP connections"
```

### Task 8: Add owner read models and metadata-only operator APIs

**Files:**
- Create: `src/control/read-service.ts`
- Create: `src/control/operator-service.ts`
- Create: `src/control/operator-routes.ts`
- Create: `test/control-read.integration.test.ts`
- Create: `test/operator-http.integration.test.ts`
- Modify: `src/control/routes.ts`
- Modify: `src/admin/query-service.ts`
- Modify: `src/admin/routes.ts`
- Modify: `src/cli.ts`
- Modify: `src/http.ts`
- Modify: `src/server.ts`
- Modify: `test/cli.integration.test.ts`

**Interfaces:**
- Consumes: current admin cursors and project read queries, owner session, operator allowlist, audit service.
- Produces: `ProjectReadScope`; `createProjectReadService`; owner overview/agents/messages/events routes; metadata-only operator list/block/archive routes; explicit legacy-project owner assignment.

- [ ] **Step 1: Write failing owner isolation and operator privacy tests**

```ts
it("never returns another owner's message through list or detail", async () => {
  const list = await service.listMessages({ kind: "owner", userId: ownerB }, projectA, query);
  const detail = await service.getMessage({ kind: "owner", userId: ownerB }, projectA, messageA);
  expect(list).toEqual({ found: false });
  expect(detail).toEqual({ found: false });
});

it("blocks a user without exposing message bodies to the operator", async () => {
  const response = await operatorRequest(`/api/v1/ops/projects/${projectId}`);
  expect(JSON.stringify(response.json())).not.toContain("private message body");
  await operatorRequest(`/api/v1/ops/users/${userId}/block`, { method: "POST", csrf });
  expect((await sessionService.authenticate(userSessionToken))).toBeNull();
  await expect(projectService.authenticateProject(projectToken)).rejects.toMatchObject({ code: "PROJECT_AUTH_INVALID" });
});
```

- [ ] **Step 2: Run read/operator tests and verify they fail**

Run: `pnpm vitest run test/control-read.integration.test.ts test/operator-http.integration.test.ts`

Expected: FAIL because scoped read and operator services are absent.

- [ ] **Step 3: Extract one scope-aware project read service**

```ts
export type ProjectReadScope =
  | { kind: "owner"; userId: string }
  | { kind: "operator" };
```

Move shared summary, agent, message, and event query logic behind this scope. Every owner query joins `projects` and applies both `projects.id = projectId` and `projects.ownerUserId = userId` in the same SQL statement. The legacy admin service becomes a compatibility adapter using `{ kind: "operator" }`. Owner message detail may return text; operator list/detail adapters omit text and use metadata only.

- [ ] **Step 4: Expose owner read routes**

```text
GET /api/v1/projects/:projectId/overview
GET /api/v1/projects/:projectId/agents
GET /api/v1/projects/:projectId/messages
GET /api/v1/projects/:projectId/messages/:messageId
GET /api/v1/projects/:projectId/events
```

Retain bounded opaque cursors and current online/idle/offline windows. Return `404` for both absent and foreign projects.

- [ ] **Step 5: Implement operator metadata and blocking**

Expose metadata-only paginated `GET /api/v1/ops/users`, `GET /api/v1/ops/projects`, `POST /api/v1/ops/users/:userId/block`, `POST /api/v1/ops/users/:userId/unblock`, and `POST /api/v1/ops/projects/:projectId/archive`. Block locks the user, sets `blockedAt`, revokes all web sessions, and makes project auth fail through the owner-block check. Mutations audit in the same transaction.

Also add an audited headless command `agentmesh project assign-owner --project-id <uuid> --github-user-id <numeric-id>`. It locks the destination user, rejects a missing/already-owned project, enforces the active-project limit in the same transaction, and never accepts a mutable GitHub login as identity. No public owner API can claim a legacy project.

- [ ] **Step 6: Run owner, operator, and legacy admin tests**

Run: `pnpm vitest run test/control-read.integration.test.ts test/operator-http.integration.test.ts test/admin-query.integration.test.ts test/admin-http.integration.test.ts test/cli.integration.test.ts`

Expected: PASS with owner isolation, no message-body field in operator JSON, and atomic legacy assignment by immutable GitHub ID.

- [ ] **Step 7: Commit read and operator APIs**

```bash
git add src/control src/admin src/cli.ts src/http.ts src/server.ts test/control-read.integration.test.ts test/operator-http.integration.test.ts test/admin-query.integration.test.ts test/admin-http.integration.test.ts test/cli.integration.test.ts
git commit -m "feat: add owner and operator APIs"
```

### Task 9: Enforce abuse controls, security headers, documentation, and full verification

**Files:**
- Create: `test/control-security.integration.test.ts`
- Modify: `src/http.ts`
- Modify: `src/logging.ts`
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`
- Modify: `test/mcp.contract.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `compose.yaml`
- Modify: `scripts/compose-smoke.ts`

**Interfaces:**
- Consumes: all hosted backend routes and safe logger.
- Produces: per-surface configured rate limits, common no-store/security headers, distinct liveness `/health` and database readiness `/ready`, documented environment, and a green backend release gate.

- [ ] **Step 1: Write failing rate-limit, header, and secrecy tests**

```ts
it("rate limits token creation independently from owner reads", async () => {
  for (let index = 0; index < 10; index += 1) {
    expect((await createConnection()).statusCode).toBe(201);
  }
  expect((await createConnection()).statusCode).toBe(429);
  expect((await listProjects()).statusCode).toBe(200);
});

it("never logs hosted secrets or message text", async () => {
  await exerciseHostedFailures(app, secrets);
  const serialized = JSON.stringify(logged);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
});
```

- [ ] **Step 2: Run the security test and verify it fails**

Run: `pnpm vitest run test/control-security.integration.test.ts`

Expected: FAIL because final per-route limits and hosted security headers are absent.

- [ ] **Step 3: Register bounded in-memory rate limits with exact defaults**

Configure 20 OAuth starts per ten minutes per IP, 300 owner reads per minute per session, 60 owner mutations per minute per session, 10 connection creations per hour per user, and 600 MCP requests per minute per project token. Use route-specific `keyGenerator` functions that return only hashed or non-secret identifiers. Return the standard `429` envelope without echoing keys.

- [ ] **Step 4: Apply common response protections and safe logging**

Authenticated and secret-bearing responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a restrictive API-compatible CSP where HTML is served. Expand `SafeLogEvent` only with request ID, safe event name, safe error code, user ID, project ID, and non-secret connection ID. Ignore all other runtime fields.

Keep `/health` as process liveness with no database dependency. Add `/ready` with a bounded `SELECT 1` and migration-version check; return 200 only when the database is reachable and current, otherwise return a safe 503 without driver error text.

- [ ] **Step 5: Document and smoke-test optional hosted mode**

Update `.env.example`, Compose environment passthrough, and README with the exact OAuth callback, key-generation commands, operator numeric ID format, project limit behavior, named-token warning, and the fact that omitting the complete OAuth group leaves MCP and legacy admin mode working. Extend `scripts/compose-smoke.ts` to prove `/auth/github/start` is unavailable in headless mode and no hosted secrets enter image history or output.

- [ ] **Step 6: Run the complete backend verification gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm smoke:compose`

Expected: PASS with no skipped hosted suites, no changed MCP tool snapshots, and no secret-bearing output.

- [ ] **Step 7: Commit the backend release gate**

```bash
git add src test .env.example README.md compose.yaml scripts package.json pnpm-lock.yaml
git commit -m "feat: complete hosted backend controls"
```

## Backend Completion Evidence

Before starting the web-product plan, record:

```text
typecheck: pass
lint: pass
tests: pass, including hosted auth/ownership/connection isolation
build: pass
compose smoke: pass
MCP two-token contract: pass
GitHub access tokens persisted: 0
foreign-owner reads: 0 successful
```
