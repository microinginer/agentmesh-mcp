# Project Membership Read Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated project members read project data while preserving `projects.owner_user_id` as the only mutation authority.

**Architecture:** Add a normalized membership table and backfill existing owned projects. Centralize the user read predicate as owner-or-membership SQL and reuse it in project, child-data, and connection reads; keep all existing mutation predicates untouched.

**Tech Stack:** TypeScript 7, PostgreSQL, Drizzle ORM/Kit, Fastify 5, Vitest 4, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-09-02-project-membership-read-access-design.md`

## Global Constraints

- Do not change `web/*` or `shared/control-api.ts` in this slot.
- Preserve the `/api/v1/projects` response shape.
- Return the existing indistinguishable `404 PROJECT_NOT_FOUND` for unauthorized reads.
- Keep archive, restore, delete, connection issue/revoke, tokens, and every other mutation owner-only through `projects.owner_user_id`.
- Skip ownerless legacy projects during membership backfill.
- Do not commit, push, deploy, or change production state without separate user authorization.

---

### Task 1: Membership schema, migration, and backfill

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0009_*.sql` using the exact tag produced by `pnpm db:generate`
- Create: `drizzle/meta/0009_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `test/db.integration.test.ts`
- Modify: `test/hosted-schema.integration.test.ts`
- Modify: `test/support/database.ts`
- Modify: `test/support/legacy-migrations.ts`

**Interfaces:**
- Produces: exported `projectMemberships` Drizzle table.
- Produces: role values constrained to `"viewer" | "owner"` in PostgreSQL.
- Produces: migration backfill for rows with non-null `projects.owner_user_id`.

- [ ] **Step 1: Write failing schema and migration tests**

Add a database invariant test that inserts one project, two users, and memberships,
then proves duplicate `(project_id, user_id)` and an invalid role fail. Extend the
legacy migration fixture to migrate through `0009`, and assert:

```ts
expect(await fixture.database.db.select().from(projectMemberships)).toEqual([
  expect.objectContaining({
    projectId: ownedProjectId,
    userId: ownerId,
    role: "owner",
    createdBy: ownerId,
  }),
]);
```

Also assert no membership exists for an ownerless legacy project.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run test/db.integration.test.ts test/hosted-schema.integration.test.ts
```

Expected: FAIL because `projectMemberships` and migration `0009` do not exist.

- [ ] **Step 3: Add the Drizzle schema**

Add after `projects`:

```ts
export const projectMemberships = pgTable("project_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 32 }).notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_memberships_project_user_unique").on(table.projectId, table.userId),
  check("project_memberships_role_check", sql`${table.role} IN ('viewer', 'owner')`),
  index("project_memberships_user_id_idx").on(table.userId),
  index("project_memberships_project_id_idx").on(table.projectId),
]);
```

- [ ] **Step 4: Generate and complete migration `0009`**

Run `pnpm db:generate`, then add this statement after table/constraint creation:

```sql
INSERT INTO "project_memberships" (
  "project_id", "user_id", "role", "created_by"
)
SELECT "id", "owner_user_id", 'owner', "owner_user_id"
FROM "projects"
WHERE "owner_user_id" IS NOT NULL
ON CONFLICT ("project_id", "user_id") DO NOTHING;
```

Keep the generated snapshot and journal entry. Add `project_memberships` before
`projects` in `resetDatabase()` so test cleanup remains explicit.

- [ ] **Step 5: Run focused tests and inspect migration**

Run the Task 1 test command again. Expected: PASS. Inspect the generated SQL for
both cascading foreign keys, the `created_by` foreign key, the role check, the
unique index, both supporting indexes, and the conditional backfill.

- [ ] **Step 6: Review the slice**

Run `git diff --check` and inspect only the Task 1 paths. Do not commit without
explicit user authorization.

---

### Task 2: Maintain owner membership on project ownership creation

**Files:**
- Modify: `src/control/project-service.ts`
- Modify: `src/control/operator-service.ts`
- Modify: `test/control-projects.integration.test.ts`
- Modify: `test/cli.integration.test.ts`

**Interfaces:**
- Consumes: `projectMemberships` from Task 1.
- Produces: owner membership created atomically with a new project.
- Produces: owner membership created atomically when an operator assigns an ownerless project.

- [ ] **Step 1: Write failing lifecycle tests**

After creating a project through `createControlProjectService`, assert exactly one
membership:

```ts
expect(await database.db.select().from(projectMemberships)).toEqual([
  expect.objectContaining({
    projectId: created.id,
    userId: owner.id,
    role: "owner",
    createdBy: owner.id,
  }),
]);
```

Add the same assertion after the existing operator owner-assignment HTTP test.
Retain existing audit and idempotency assertions.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run test/control-projects.integration.test.ts test/cli.integration.test.ts
```

Expected: FAIL with empty membership rows.

- [ ] **Step 3: Insert memberships in existing transactions**

In project creation, immediately after the project insert:

```ts
await transaction.insert(projectMemberships).values({
  projectId: created.id,
  userId: input.ownerUserId,
  role: "owner",
  createdBy: input.ownerUserId,
  createdAt: now,
  updatedAt: now,
});
```

In `assignOwner`, insert the analogous row with the assigned project ID and
destination user ID before recording the audit event. Do not change archive,
restore, delete, limits, or any ownership predicates.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 2 command again. Expected: PASS with all existing ownership tests
still green.

- [ ] **Step 5: Review the slice**

Inspect transaction boundaries and `git diff --check`. Do not commit without
explicit user authorization.

---

### Task 3: Central owner-or-membership read predicate

**Files:**
- Create: `src/control/project-access.ts`
- Modify: `src/control/project-service.ts`
- Modify: `src/control/read-service.ts`
- Modify: `src/control/routes.ts`
- Modify: `test/control-projects.integration.test.ts`
- Modify: `test/control-read.integration.test.ts`

**Interfaces:**
- Produces: `projectReadPredicate(userId: string, projectId?: string): SQL`.
- Changes user read scope to `{ kind: "user"; userId: string } | { kind: "operator" }`.
- Changes project list/get read inputs from `ownerUserId` to `userId`; mutation inputs remain unchanged.

- [ ] **Step 1: Write failing member-read HTTP tests**

Seed user B with:

```ts
await database.db.insert(projectMemberships).values({
  projectId: fixture.projectA,
  userId: fixture.ownerB,
  role: "viewer",
  createdBy: fixture.ownerA,
});
```

Assert user B receives 200 from v1/v2 lists, project detail, overview, agents,
messages, message detail, and events; assert an unrelated user receives the
existing 404. For v2, assert the shared active project can be `default_project`.
Assert `active_count` still counts only projects owned by user B.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run test/control-projects.integration.test.ts test/control-read.integration.test.ts
```

Expected: FAIL because list/detail and child reads still require ownership.

- [ ] **Step 3: Add the reusable predicate**

Create `src/control/project-access.ts`:

```ts
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { projectMemberships, projects } from "../db/schema.js";

export function projectReadPredicate(userId: string, projectId?: string): SQL {
  const membership = sql<boolean>`exists (
    select 1 from ${projectMemberships}
    where ${projectMemberships.projectId} = ${projects.id}
      and ${projectMemberships.userId} = ${userId}
  )`;
  return and(
    projectId === undefined ? undefined : eq(projects.id, projectId),
    or(eq(projects.ownerUserId, userId), membership),
  )!;
}
```

Keep this file responsible only for access predicates.

- [ ] **Step 4: Apply the predicate to list/get and child reads**

Update project list rows and v2 default selection to use
`projectReadPredicate(input.userId)`. Keep owner-only active count unchanged:

```ts
eq(projects.ownerUserId, input.userId)
```

Update `get` and every user `ProjectReadScope` child query to use the correlated
predicate in the same SQL statement. Operator scope remains `eq(projects.id,
projectId)`. Routes pass `{ kind: "user", userId: request.webSession.userId }`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 3 command again. Expected: PASS, including SQL-scoping assertions
adapted to accept owner-or-membership predicates.

- [ ] **Step 6: Review the slice**

Confirm no mutation call site was changed from `ownerUserId`, run
`git diff --check`, and inspect Task 3 paths. Do not commit without explicit user
authorization.

---

### Task 4: Membership-aware connection metadata reads and owner-only mutations

**Files:**
- Modify: `src/control/connection-service.ts`
- Modify: `src/control/routes.ts`
- Modify: `test/control-connections.integration.test.ts`
- Modify: `test/control-security.integration.test.ts`

**Interfaces:**
- Consumes: `projectReadPredicate` from Task 3.
- Changes only `list` input to `{ userId; projectId; limit }`.
- Leaves `issue` and `revoke` inputs and owner checks unchanged.

- [ ] **Step 1: Write failing viewer connection and mutation tests**

Give user B a viewer membership and assert connection list returns only safe
metadata with no token digest/secret. With user B's valid CSRF session, assert:

```ts
expect(archive.statusCode).toBe(404);
expect(deleteResponse.statusCode).toBe(404);
expect(issue.statusCode).toBe(404);
expect(revoke.statusCode).toBe(404);
```

Repeat representative mutations as owner A and retain their existing successful
status assertions.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run test/control-connections.integration.test.ts test/control-security.integration.test.ts
```

Expected: viewer connection list fails with 404 while mutation-denial tests
already remain green.

- [ ] **Step 3: Scope only connection list through membership**

Replace the connection list ownership predicate with
`projectReadPredicate(input.userId, input.projectId)` and change only the GET
route call site. Keep `lockOwnedProject`, `issue`, and `revoke` unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 4 command again. Expected: PASS; viewer reads safe connection
metadata and every viewer mutation remains denied.

- [ ] **Step 5: Review the slice**

Search for mutation predicates and verify they still contain
`eq(projects.ownerUserId, input.ownerUserId)`. Run `git diff --check`. Do not
commit without explicit user authorization.

---

### Task 5: Integrated backend verification

**Files:**
- Verify all modified backend, migration, documentation, and test files.

**Interfaces:**
- Consumes: Tasks 1-4 integrated in one worktree.
- Produces: fresh evidence for schema, authorization, compatibility, and build health.

- [ ] **Step 1: Run focused authorization suites together**

```bash
pnpm exec vitest run test/db.integration.test.ts test/hosted-schema.integration.test.ts test/control-projects.integration.test.ts test/control-read.integration.test.ts test/control-connections.integration.test.ts test/control-security.integration.test.ts test/cli.integration.test.ts test/operator-http.integration.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run static verification**

```bash
pnpm typecheck
pnpm lint
pnpm build:server
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the full backend suite**

```bash
pnpm test
```

Expected: all backend tests PASS with zero failures.

- [ ] **Step 4: Inspect final diff and migration safety**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Verify no `web/*` or `shared/control-api.ts` changes, no secrets, no generated
noise beyond the Drizzle migration snapshot/journal, and no owner mutation scope
was widened.

- [ ] **Step 5: AgentMesh checkpoint and handoff**

Poll and acknowledge relevant peer messages, report sent/received sequence
numbers, and send affected paths plus exact test results. Do not commit, push,
deploy, or mutate production state without explicit user authorization.
