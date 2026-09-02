# AgentMesh Blackboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-scoped Blackboard for shared facts, contracts, decisions, and environment notes with TTL filtering and optimistic concurrency.

**Architecture:** Store facts in one PostgreSQL table keyed by project, namespace, and key. A focused service authenticates agents, performs atomic writes and reads, and journals mutations; the MCP layer exposes set/get tools through strict Zod contracts and the existing safe result envelope.

**Tech Stack:** Node.js 24+, TypeScript 7, PostgreSQL, Drizzle ORM 0.45, Zod 4, MCP TypeScript SDK 2, Fastify 5, Vitest 4, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-09-02-agentmesh-blackboard-design.md`

## Global Constraints

- Preserve project isolation on every query using `project_id`.
- Limit values to 65,536 UTF-8 bytes and tags to 10 unique non-empty strings.
- `expected_version` on a missing row returns `VERSION_CONFLICT`; creation requires it to be omitted.
- Tag filtering requires all requested tags.
- Exclude rows only when `expires_at < now`; equality remains visible.
- Never journal fact values, tags, or credentials.
- Do not add an HTTP API, web UI, cleanup job, or MCP delete tool.
- Do not commit, push, deploy, or mutate external systems without separate user authorization.
- Resolve AgentMesh ownership before editing `src/db/schema.ts`, `src/contracts.ts`, or `src/mcp/server.ts`, which overlap the Pulse change.

## File Map

- Create `src/blackboard/service.ts`: authentication, persistence, formatting, and mutation journaling.
- Create `test/blackboard.spec.ts`: real-PostgreSQL schema and service coverage.
- Modify `src/db/schema.ts`: table, constraints, indexes, and inferred type.
- Create the next Drizzle migration and snapshot with `pnpm db:generate`.
- Modify `src/contracts.ts`: Blackboard inputs, fact shape, and set/get outputs.
- Modify `src/errors.ts`: add `VERSION_CONFLICT`.
- Modify `src/activity/types.ts` and `src/activity/service.ts`: new event types and safe metadata.
- Modify `src/mcp/server.ts`: register set/get tools.
- Modify `test/contracts.test.ts`, `test/mcp.contract.test.ts`, and `test/support/database.ts`.

---

### Task 1: Public Contracts

**Files:**
- Modify: `test/contracts.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/errors.ts`

**Interfaces:**
- Produces: `BlackboardSetFactInput`, `BlackboardGetFactsInput`, `blackboardFactSchema`, `blackboardSetFactOutputSchema`, `blackboardGetFactsOutputSchema`, and `VERSION_CONFLICT`.
- Consumes: existing `agentTokenSchema`, `uuidV4Schema`, and tool result convention.

- [ ] **Step 1: Write failing validation tests**

Add contract cases using these literal boundaries:

```ts
const blackboardBase = {
  agent_token: agentToken,
  namespace: "contracts",
  key: "users.v2",
};

expect(blackboardSetFactInputSchema.safeParse({
  ...blackboardBase,
  value: "é".repeat(MAX_BLACKBOARD_VALUE_BYTES / 2),
  tags: ["api", "v2"],
  ttl_seconds: 60,
  expected_version: 1,
}).success).toBe(true);

expect(blackboardSetFactInputSchema.safeParse({
  ...blackboardBase,
  value: `${"é".repeat(MAX_BLACKBOARD_VALUE_BYTES / 2)}é`,
  tags: [],
}).success).toBe(false);
```

Also accept a valid get filter and reject unknown keys, duplicate tags, eleven tags, empty optional arrays, non-positive TTL, and non-positive/non-integer expected versions.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/contracts.test.ts`

Expected: FAIL because the Blackboard exports do not exist.

- [ ] **Step 3: Implement the schemas**

Add `MAX_BLACKBOARD_VALUE_BYTES = 64 * 1024`. Use `Buffer.byteLength(value, "utf8")`, namespace length 64, key length 128, at most 10 unique tags, positive integer TTL/version, and strict objects. Define `blackboardFactSchema` with snake_case public fields and ISO timestamp strings. Define set/get output unions with the standard safe error shape. Add `VERSION_CONFLICT` to the Zod error enum and `AgentMeshErrorCode`.

- [ ] **Step 4: Verify GREEN and inspect**

Run: `pnpm vitest run test/contracts.test.ts && pnpm typecheck && git diff --check`

Expected: both checks exit `0`; existing sync/send/list schemas remain behaviorally unchanged.

---

### Task 2: Table and Migration

**Files:**
- Create: `test/blackboard.spec.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/activity/types.ts`
- Modify: `test/support/database.ts`
- Create: next `drizzle/NNNN_*.sql` and `drizzle/meta/NNNN_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `blackboardEntries`, `BlackboardEntry`, `blackboard.fact_set`, and `blackboard.fact_deleted`.
- Consumes: `projects.id`, migration runner, and PostgreSQL test database.

- [ ] **Step 1: Write a failing schema test**

Create the standard integration-test database lifecycle and assert:

```ts
const table = await database.pool.query<{ name: string | null }>(
  "SELECT to_regclass('public.blackboard_entries')::text AS name",
);
expect(table.rows).toEqual([{ name: "blackboard_entries" }]);
```

Query `pg_constraint` and assert the unique definition is exactly `UNIQUE (project_id, namespace, key)`.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/blackboard.spec.ts`

Expected: FAIL because the table is absent.

- [ ] **Step 3: Define the table and activity event types**

Add all requested columns. Use:

```ts
tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
version: integer("version").notNull().default(1),
```

Add the project cascade foreign key, actor-type and positive-version checks, named unique constraint, and requested indexes. Export `BlackboardEntry`. Add both Blackboard event types to the TypeScript allowlist and database check. Add optional safe metadata fields `blackboard_namespace`, `blackboard_key`, and `blackboard_version`.

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm db:generate`

Expected: exactly one new SQL migration, snapshot, and journal entry. The SQL creates the table/indexes/checks and replaces the activity event check; no older migration changes.

- [ ] **Step 5: Update cleanup and verify GREEN**

Add `blackboard_entries` to `resetDatabase()` before project tables.

Run: `pnpm vitest run test/blackboard.spec.ts test/hosted-schema.integration.test.ts`

Expected: both test files pass.

---

### Task 3: Atomic Set and Version Conflicts

**Files:**
- Modify: `test/blackboard.spec.ts`
- Create: `src/blackboard/service.ts`
- Modify: `src/activity/service.ts`

**Interfaces:**
- Produces: `createBlackboardService({ db, agentService, activity, clock? })` and `setFact(projectId, input, context)`.
- Consumes: `AgentService.authenticateAgent`, `ActivityService.record`, `BlackboardSetFactInput`, and `OperationContext`.

- [ ] **Step 1: Write failing creation/update/conflict tests**

Register a real agent, create `contracts/users.v2`, and assert version `1`, creator/updater identity, tags, and TTL. Update with `expected_version: 1` and assert version `2`. Retry with stale version `1` and assert `{ code: "VERSION_CONFLICT" }` plus unchanged stored value/version. Attempt a missing key with `expected_version: 1` and assert the same conflict.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/blackboard.spec.ts -t "creates|updates|conflict"`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement dependencies and public formatting**

Define:

```ts
interface BlackboardServiceDependencies {
  db: AgentMeshDatabase;
  agentService: Pick<AgentService, "authenticateAgent">;
  activity: Pick<ActivityService, "record">;
  clock?: () => Date;
}
```

Map rows to the snake_case shape defined by `blackboardFactSchema`.

- [ ] **Step 4: Implement atomic writes**

Inside one transaction, authenticate the agent and compute expiry from the injected clock. Without `expected_version`, use `insert(...).onConflictDoUpdate(...)` and `version: sql\`${blackboardEntries.version} + 1\``. With it, use an `UPDATE` predicate containing project, namespace, key, and version; no returned row throws `VERSION_CONFLICT`. Omitted TTL clears TTL and expiry. Record `blackboard.fact_set` in the same transaction.

Update `safeMetadata()` to retain only type-valid Blackboard namespace, key, and version fields.

- [ ] **Step 5: Verify GREEN and activity safety**

Run: `pnpm vitest run test/blackboard.spec.ts -t "creates|updates|conflict"`

Expected: selected tests pass. Assert serialized activity rows contain neither the fact value nor agent token.

---

### Task 4: Filtered Reads and TTL

**Files:**
- Modify: `test/blackboard.spec.ts`
- Modify: `src/blackboard/service.ts`

**Interfaces:**
- Produces: `getFacts(projectId, input)` returning `{ facts: BlackboardFact[] }`.
- Consumes: `BlackboardGetFactsInput`, `arrayContains`, `inArray`, and service clock.

- [ ] **Step 1: Write failing TTL, tag, and isolation tests**

Create two projects. Seed active, expired, equal-to-now, and future-expiring rows. Assert project A sees only its active/equal/future rows, never project B. Filter with `tags: ["api", "v2"]` and prove a fact containing only `api` is excluded. Verify namespace and keys filters combine with AND semantics.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/blackboard.spec.ts -t "TTL|project|tags"`

Expected: FAIL because `getFacts` is absent.

- [ ] **Step 3: Implement composed filters**

Authenticate first. Start with project equality and:

```ts
or(
  isNull(blackboardEntries.expiresAt),
  gte(blackboardEntries.expiresAt, clock()),
)
```

Add namespace equality, `inArray` for keys, and `arrayContains` for all tags. Order by namespace then key and return formatted facts.

- [ ] **Step 4: Verify GREEN and inspect**

Run: `pnpm vitest run test/blackboard.spec.ts && git diff --check`

Expected: all Blackboard tests pass; every query contains the project predicate.

---

### Task 5: Delete and Mutation Journal

**Files:**
- Modify: `test/blackboard.spec.ts`
- Modify: `src/blackboard/service.ts`

**Interfaces:**
- Produces: `deleteFact(projectId, namespace, key, context)` returning `{ deleted: boolean }`.
- Consumes: context `{ requestId, actorType: "agent" | "user", actorId }`.

- [ ] **Step 1: Write a failing project-scoped delete test**

Create the same namespace/key in two projects. Delete project A using an explicit agent actor. Assert `{ deleted: true }`, project B remains, a second delete returns `{ deleted: false }`, and only the successful delete records `blackboard.fact_deleted`.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/blackboard.spec.ts -t "deletes"`

Expected: FAIL because `deleteFact` is absent.

- [ ] **Step 3: Implement transactional delete**

Delete with project/namespace/key predicates and return the deleted row. If none, return false. Otherwise journal the safe structural event in the same transaction and return true.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run test/blackboard.spec.ts`

Expected: all Blackboard tests pass.

---

### Task 6: MCP Tools

**Files:**
- Modify: `test/mcp.contract.test.ts`
- Modify: `src/mcp/server.ts`

**Interfaces:**
- Produces: `agentmesh_set_fact` and `agentmesh_get_facts`.
- Consumes: contracts and Blackboard service from earlier tasks.

- [ ] **Step 1: Write failing discovery and round-trip coverage**

Update the sorted tool list to five names. Assert exact descriptions:

```ts
agentmesh_set_fact: "Save or update a shared project fact, API contract, or architecture decision.",
agentmesh_get_facts: "Retrieve shared project facts, API contracts, or environment notes.",
```

After agent registration, call set, assert version `1`, call get with namespace/key/tags, and assert the same fact. A stale set must return structured error code `VERSION_CONFLICT`.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/mcp.contract.test.ts -t "official SDK clients"`

Expected: FAIL because the tools are not registered.

- [ ] **Step 3: Register both tools**

Instantiate the Blackboard service alongside message service. Register both tools with strict input/output schemas and exact descriptions. Require the authenticated project, create a request ID, call the service, and wrap success in `{ ok: true, data }`. Route expected errors through `runTool` without leaking internal details.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run test/mcp.contract.test.ts test/contracts.test.ts`

Expected: both files pass, including SDK output-schema validation.

---

### Task 7: Integrated Verification and Handoff

**Files:**
- Review all paths in the File Map.

**Interfaces:**
- Produces: fresh evidence for every acceptance criterion.

- [ ] **Step 1: Run focused integration checks**

Run: `pnpm vitest run test/blackboard.spec.ts test/contracts.test.ts test/mcp.contract.test.ts test/hosted-schema.integration.test.ts`

Expected: exit `0` with no failed tests.

- [ ] **Step 2: Run requested verification**

Run: `pnpm typecheck && pnpm test`

Expected: both exit `0`. If the Docker topology test hits its prior five-second variance, diagnose the exact failure before any rerun or timeout change.

- [ ] **Step 3: Run proportional repository checks**

Run: `pnpm lint && pnpm build:server`

Expected: both exit `0`.

- [ ] **Step 4: Review the complete diff**

Run: `git status --short`, `git diff --check`, `git diff --stat`, and `git diff -- src test drizzle`.

Confirm no secrets, unrelated formatting, changes to older migrations, generated noise outside Drizzle metadata, or compatibility changes to existing MCP tools.

- [ ] **Step 5: Complete AgentMesh coordination**

Poll, acknowledge handled overlap messages, and send affected active peers the final paths and verification results. Report received, acknowledged, and sent sequence numbers.

- [ ] **Step 6: Map requirements to evidence**

Report table/indexes/migration against schema tests; create/update/conflict against Blackboard tests; TTL/isolation against Blackboard tests; MCP discovery/round trip against MCP contract tests; and regression safety against `pnpm typecheck` plus `pnpm test`.

Do not commit, push, create a PR, or deploy unless the user separately authorizes it.
