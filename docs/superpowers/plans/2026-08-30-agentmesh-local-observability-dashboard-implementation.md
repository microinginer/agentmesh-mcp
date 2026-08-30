# AgentMesh Local Observability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure local dashboard, durable activity journal, and optional read-only pgAdmin view so an administrator can observe real AgentMesh coordination without changing agent state.

**Architecture:** The existing Fastify process gains an append-only PostgreSQL activity journal, authenticated read-only admin queries, and a lightweight server-delivered dashboard. MCP services write success events atomically with their state transitions and safe failure events separately; optional pgAdmin access uses loopback-only networking and sanitized SQL views owned by a dedicated observer role.

**Tech Stack:** Node.js 24+, TypeScript 7, Fastify 5, PostgreSQL 18, Drizzle ORM 0.45, Zod 4, Vitest 4, pnpm 11, Docker Compose, browser-native HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-30-agentmesh-local-observability-dashboard-design.md`

## Global Constraints

- Preserve the existing `agentmesh_sync`, `agentmesh_send`, and `agentmesh_list_agents` names and their public input/output schemas.
- Keep the dashboard inside the existing AgentMesh process; do not add React, another frontend service, a queue, Redis, SSE, or WebSockets.
- Bind AgentMesh and optional PostgreSQL observer access only to `127.0.0.1` in the local Compose configuration.
- Disable every admin route when `AGENTMESH_ADMIN_TOKEN` is absent.
- Keep the observational API read-only; only login and logout may set or clear a cookie.
- Never persist or return project tokens, agent tokens, admin tokens, authorization headers, cookies, registration digests, token digests, idempotency keys, arbitrary MCP input, raw database errors, stack traces, or environment values.
- Do not duplicate successful message text into `activity_events`; full text remains only in the project-scoped message detail response and the underlying message row.
- Suppress empty successful inbox polls from the activity journal; continue updating `agents.last_seen_at`.
- Journal only requests that reach AgentMesh; client-side approval, process, or transport failures remain client-log evidence and must not be synthesized as server events.
- Use opaque, validated cursor pagination with default limit 50 and maximum 100.
- Use a signed `HttpOnly`, `SameSite=Strict`, `Path=/` admin cookie; only admin handlers inspect it.
- Give pgAdmin access only to the `observer` schema views through `agentmesh_observer`; never give that role privileges on `public` tables.
- Write each behavioral change test-first, observe the expected failure, make the smallest implementation pass, and commit each task independently.
- Work on `main` as previously authorized; do not push or publish anything.

## File structure

New focused modules:

```text
src/
|-- activity/
|   |-- service.ts        # typed event persistence and best-effort failure recording
|   `-- types.ts          # event names, outcomes, metadata, operation context
|-- admin/
|   |-- auth.ts           # constant-time token verification and signed cookie sessions
|   |-- contracts.ts      # query/cursor schemas and API DTOs
|   |-- query-service.ts  # project-scoped read models
|   |-- routes.ts         # login, logout, page, and read-only HTTP routes
|   `-- ui/
|       |-- browser.ts    # dependency-free browser script source
|       |-- page.ts       # nonce-bound login and dashboard HTML
|       `-- styles.ts     # responsive light/dark styles
|-- observer/
|   `-- service.ts        # idempotent PostgreSQL observer-role provisioning
`-- logging.ts            # redacted structured operational logging
test/
|-- activity.integration.test.ts
|-- admin-auth.test.ts
|-- admin-query.integration.test.ts
|-- admin-http.integration.test.ts
|-- admin-ui.test.ts
`-- observer.integration.test.ts
compose.pgadmin.yaml       # opt-in loopback PostgreSQL mapping
```

Existing files changed in bounded ways:

- `src/db/schema.ts` and generated `drizzle/*` add events, safe views, indexes, and composite message identity.
- `src/agents/service.ts`, `src/messages/service.ts`, and `src/mcp/server.ts` emit typed events.
- `src/config.ts`, `src/http.ts`, and `src/server.ts` wire optional admin authentication and routes.
- `src/cli.ts` provisions the observer role.
- `compose.yaml`, `.env.example`, `README.md`, and `scripts/compose-smoke.ts` expose and verify the local workflow.

---

### Task 1: Add the typed activity journal and migration

**Files:**
- Create: `src/activity/types.ts`
- Create: `src/activity/service.ts`
- Modify: `src/db/schema.ts:1-94`
- Generate: `drizzle/0001_*.sql`
- Modify: `test/db.integration.test.ts:1-140`
- Create: `test/activity.integration.test.ts`

**Interfaces:**
- Produces: `ActivityEventType`, `ActivityOutcome`, `ActivityMetadata`, `OperationContext`, `createActivityService()`.
- Produces: Drizzle table `activityEvents` and composite unique key `messages_id_project_unique`.
- Consumes: `AgentMeshDatabase`, safe `AgentMeshErrorCode`, and a redacted logging callback.

- [ ] **Step 1: Write failing schema and persistence tests**

Add a five-table migration assertion and a test that proves an event stores only explicitly selected fields:

```ts
const requestId = randomUUID();
await activity.record({
  projectId,
  requestId,
  eventType: "message.sent",
  outcome: "success",
  actorAgentId: senderId,
  targetAgentId: recipientId,
  messageId,
  metadata: { message_bytes: 17, deduplicated: false },
  ...({ agent_token: "must-not-persist", text: "must-not-duplicate" } as object),
});

const [stored] = await database.db.select().from(activityEvents);
expect(stored?.metadata).toEqual({ message_bytes: 17, deduplicated: false });
expect(JSON.stringify(stored)).not.toContain("must-not");
```

Assert foreign keys reject an actor, target, or message from another project and that `(message_id, project_id)` can be referenced safely.

- [ ] **Step 2: Run focused tests and observe the missing journal failure**

Run:

```bash
pnpm vitest run test/db.integration.test.ts test/activity.integration.test.ts
```

Expected: FAIL because `activityEvents` and `createActivityService` do not exist and the database still has four application tables.

- [ ] **Step 3: Define closed event types and metadata**

Create `src/activity/types.ts` with closed unions rather than a free-form logger:

```ts
export const activityEventTypes = [
  "agent.registered",
  "agent.registration_failed",
  "agent.synced",
  "message.sent",
  "message.send_failed",
  "message.acknowledged",
  "mcp.request_failed",
] as const;

export type ActivityEventType = (typeof activityEventTypes)[number];
export type ActivityOutcome = "success" | "failure";

export interface ActivityMetadata {
  message_bytes?: number;
  delivered_count?: number;
  acknowledged_count?: number;
  poll_limit?: number;
  deduplicated?: boolean;
}

export interface OperationContext {
  requestId: string;
}
```

Do not add an index signature to `ActivityMetadata`.

- [ ] **Step 4: Add the Drizzle table and generated migration**

Add `jsonb` and `index` imports, the composite message uniqueness, and an `activityEvents` table whose checks constrain `event_type` and `outcome`. Use same-project composite foreign keys for actor, target, and message. The table definition must expose the following TypeScript shape:

```ts
export const activityEvents = pgTable(
  "activity_events",
  {
    sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
    id: uuid("id").notNull().defaultRandom().unique(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    actorAgentId: uuid("actor_agent_id"),
    targetAgentId: uuid("target_agent_id"),
    messageId: uuid("message_id"),
    errorCode: varchar("error_code", { length: 64 }),
    metadata: jsonb("metadata")
      .$type<ActivityMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "activity_events_type_check",
      sql`${table.eventType} IN ('agent.registered', 'agent.registration_failed', 'agent.synced', 'message.sent', 'message.send_failed', 'message.acknowledged', 'mcp.request_failed')`,
    ),
    check(
      "activity_events_outcome_check",
      sql`${table.outcome} IN ('success', 'failure')`,
    ),
    foreignKey({
      name: "activity_events_actor_project_fk",
      columns: [table.actorAgentId, table.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_events_target_project_fk",
      columns: [table.targetAgentId, table.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_events_message_project_fk",
      columns: [table.messageId, table.projectId],
      foreignColumns: [messages.id, messages.projectId],
    }).onDelete("cascade"),
    index("activity_events_project_sequence_idx").on(table.projectId, table.sequence),
    index("activity_events_project_type_sequence_idx").on(
      table.projectId,
      table.eventType,
      table.sequence,
    ),
    index("activity_events_project_actor_sequence_idx").on(
      table.projectId,
      table.actorAgentId,
      table.sequence,
    ),
  ],
);
```

Generate the migration with `pnpm db:generate`; inspect the SQL and keep it additive.

- [ ] **Step 5: Implement typed persistence without spreading caller input**

`createActivityService()` must construct the insert object field-by-field:

```ts
type ActivityExecutor = Pick<AgentMeshDatabase, "insert">;

export interface RecordActivityInput {
  projectId: string;
  requestId: string;
  eventType: ActivityEventType;
  outcome: ActivityOutcome;
  actorAgentId?: string | null;
  targetAgentId?: string | null;
  messageId?: string | null;
  errorCode?: AgentMeshErrorCode | null;
  metadata?: ActivityMetadata;
}

async function record(input: RecordActivityInput, executor: ActivityExecutor = db) {
  await executor.insert(activityEvents).values({
    projectId: input.projectId,
    requestId: input.requestId,
    eventType: input.eventType,
    outcome: input.outcome,
    actorAgentId: input.actorAgentId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    messageId: input.messageId ?? null,
    errorCode: input.errorCode ?? null,
    metadata: input.metadata ?? {},
    createdAt: clock(),
  });
}
```

Expose `record` for atomic transaction use and `recordBestEffort` for an already-failed operation. `recordBestEffort` catches persistence failure and invokes only a safe callback with `{ event: "activity.persist_failed", request_id }`; it never receives or logs the caught error object.

- [ ] **Step 6: Run migration and activity tests**

Run:

```bash
pnpm vitest run test/db.integration.test.ts test/activity.integration.test.ts
pnpm typecheck
```

Expected: both files pass and TypeScript reports no errors.

- [ ] **Step 7: Commit the journal foundation**

```bash
git add src/activity src/db/schema.ts drizzle test/db.integration.test.ts test/activity.integration.test.ts
git commit -m "feat: add AgentMesh activity journal"
```

---

### Task 2: Audit agent registration, sync, delivery, and ACK

**Files:**
- Modify: `src/agents/service.ts:1-267`
- Modify: `src/mcp/server.ts:1-128`
- Modify: `test/agents.integration.test.ts:1-235`
- Modify: `test/mcp.contract.test.ts:1-285`
- Modify: `test/activity.integration.test.ts`

**Interfaces:**
- Consumes: `ActivityService.record`, `ActivityService.recordBestEffort`, and `OperationContext` from Task 1.
- Produces: `registerAgent(projectId, input, context)` and `syncAgent(projectId, input, context)` with audited outcomes.
- Produces: one `message.acknowledged` event per committed ACK and one meaningful `agent.synced` event per non-empty delivery/ACK poll.

- [ ] **Step 1: Write failing agent-event tests**

Extend the agent integration test to pass explicit request IDs and assert:

```ts
const context = { requestId: randomUUID() };
const registered = await service.registerAgent(projectId, registerInput, context);
expect(await eventsFor(context.requestId)).toEqual([
  expect.objectContaining({
    eventType: "agent.registered",
    outcome: "success",
    actorAgentId: registered.agent.id,
    metadata: {},
  }),
]);
```

Add cases proving:

- a profile conflict creates `agent.registration_failed` with `REGISTRATION_CONFLICT` and no token-like metadata;
- an empty poll creates no event;
- a poll that delivers a message creates one `agent.synced` with `delivered_count: 1`;
- a successful ACK creates `agent.synced` plus one `message.acknowledged`, sharing one request ID;
- a bystander ACK attempt does not create a false ACK event.

- [ ] **Step 2: Run tests and observe signature/event failures**

```bash
pnpm vitest run test/agents.integration.test.ts test/activity.integration.test.ts
```

Expected: FAIL because agent service methods do not accept `OperationContext` and emit no events.

- [ ] **Step 3: Inject the activity service into agent operations**

Change dependencies to:

```ts
interface AgentServiceDependencies {
  db: AgentMeshDatabase;
  signingKey: Buffer;
  activity: Pick<ActivityService, "record" | "recordBestEffort">;
  clock?: () => Date;
}
```

Pass `context: OperationContext` into registration and sync. Record `agent.registered` inside the existing registration transaction after the final agent row is known. Catch expected registration errors outside the transaction, call `recordBestEffort` with `agent.registration_failed`, then rethrow the original `AgentMeshError`.

Wrap sync authentication and its transaction in the same pattern. On an
expected sync failure, record `agent.synced` with `outcome: "failure"`, the
safe error code, and `actorAgentId: null` when authentication never established
an identity; then rethrow the original error. This makes the sync tool's
expected domain failures specific and prevents a duplicate generic MCP event.

- [ ] **Step 4: Journal only meaningful sync activity**

Keep authentication and state changes project-scoped. Inside the sync transaction:

```ts
const acknowledged =
  input.acknowledge.length === 0
    ? []
    : await transaction
        .update(messages)
        .set({ acknowledgedAt: now })
        .where(
          and(
            eq(messages.projectId, projectId),
            eq(messages.recipientAgentId, caller.id),
            inArray(messages.id, input.acknowledge),
            isNull(messages.acknowledgedAt),
          ),
        )
        .returning({ id: messages.id });

const rows = await transaction
  .select({
    id: messages.id,
    sequence: messages.sequence,
    senderAgentId: messages.senderAgentId,
    text: messages.text,
    createdAt: messages.createdAt,
  })
  .from(messages)
  .where(
    and(
      eq(messages.projectId, projectId),
      eq(messages.recipientAgentId, caller.id),
      isNull(messages.acknowledgedAt),
    ),
  )
  .orderBy(asc(messages.sequence))
  .limit(input.limit + 1);
const delivered = rows.slice(0, input.limit);

if (delivered.length > 0 || acknowledged.length > 0) {
  await activity.record({
    projectId,
    requestId: context.requestId,
    eventType: "agent.synced",
    outcome: "success",
    actorAgentId: caller.id,
    metadata: {
      delivered_count: delivered.length,
      acknowledged_count: acknowledged.length,
      poll_limit: input.limit,
    },
  }, transaction);
}

for (const message of acknowledged) {
  await activity.record({
    projectId,
    requestId: context.requestId,
    eventType: "message.acknowledged",
    outcome: "success",
    actorAgentId: caller.id,
    messageId: message.id,
  }, transaction);
}
```

Return the original public sync contract unchanged.

- [ ] **Step 5: Generate one request ID per MCP sync call**

In the sync tool callback, generate `const context = { requestId: randomUUID() }` and pass it to the service. Do not add request IDs to MCP output.

- [ ] **Step 6: Update direct service and MCP tests**

Update every direct registration/sync call in tests to pass `{ requestId: randomUUID() }`. Extend the MCP contract test to query the database after the exchange and prove the existing tool list/output contract is unchanged while registration, delivery, and ACK events exist.

- [ ] **Step 7: Run affected and full tests**

```bash
pnpm vitest run test/agents.integration.test.ts test/mcp.contract.test.ts test/activity.integration.test.ts
pnpm test
pnpm typecheck
```

Expected: focused tests and all existing tests pass.

- [ ] **Step 8: Commit agent auditing**

```bash
git add src/agents/service.ts src/mcp/server.ts test/agents.integration.test.ts test/mcp.contract.test.ts test/activity.integration.test.ts
git commit -m "feat: audit AgentMesh agent activity"
```

---

### Task 3: Audit message success, idempotent retry, safe failure, and unexpected MCP failure

**Files:**
- Create: `src/logging.ts`
- Modify: `src/messages/service.ts:1-113`
- Modify: `src/mcp/server.ts:1-128`
- Modify: `src/http.ts:1-85`
- Modify: `test/messages.integration.test.ts:1-150`
- Modify: `test/mcp.contract.test.ts`
- Modify: `test/activity.integration.test.ts`

**Interfaces:**
- Consumes: `OperationContext` and activity writer from Task 1.
- Produces: `sendMessage(projectId, input, context)` with atomic `message.sent` and best-effort `message.send_failed`.
- Produces: `SafeLogger.write(event)` that accepts only a bounded structured DTO.

- [ ] **Step 1: Write failing send-event and redaction tests**

Add cases for:

```ts
expect(await eventByRequest(firstRequestId)).toMatchObject({
  eventType: "message.sent",
  outcome: "success",
  messageId: first.message.id,
  actorAgentId: sender.agent.id,
  targetAgentId: recipient.agent.id,
  metadata: { message_bytes: 24, deduplicated: false },
});

expect(await eventByRequest(retryRequestId)).toMatchObject({
  eventType: "message.sent",
  metadata: { message_bytes: 24, deduplicated: true },
});
```

Assert self-send, cross-project target, conflicting idempotency, and invalid agent token produce `message.send_failed` with only the safe code and message byte length. Assert serialized events do not contain the attempted message or token.

- [ ] **Step 2: Run focused tests and observe missing events**

```bash
pnpm vitest run test/messages.integration.test.ts test/activity.integration.test.ts
```

Expected: FAIL because `sendMessage` lacks context and event persistence.

- [ ] **Step 3: Record send success inside the message transaction**

Track authenticated actor and validated target IDs in local variables. After insert or deduplication resolution, record:

```ts
await activity.record({
  projectId,
  requestId: context.requestId,
  eventType: "message.sent",
  outcome: "success",
  actorAgentId: sender.id,
  targetAgentId: target.id,
  messageId: persisted.id,
  metadata: {
    message_bytes: Buffer.byteLength(input.text, "utf8"),
    deduplicated,
  },
}, transaction);
```

Return exactly the existing `{ message, deduplicated }` payload.

- [ ] **Step 4: Record expected send failure without masking it**

Wrap the transaction, catch only `AgentMeshError`, and call `recordBestEffort` with `message.send_failed`. Use an actor or target ID only after it has been authenticated or validated in the current project. Rethrow the same error object after recording.

- [ ] **Step 5: Add the redacted structured logger**

Create a closed log DTO:

```ts
export interface SafeLogEvent {
  event: "activity.persist_failed" | "mcp.request_failed" | "http.request_failed";
  request_id?: string;
  project_id?: string;
  error_code?: "INTERNAL_ERROR";
}

export interface SafeLogger {
  write(event: SafeLogEvent): void;
}
```

The production implementation writes one JSON line to stderr. Never accept an `Error`, headers, input, or arbitrary metadata.

- [ ] **Step 6: Record unexpected MCP failures safely**

Give `runTool` these explicit options:

```ts
interface RunToolOptions {
  projectId: string;
  requestId: string;
  activity: Pick<ActivityService, "recordBestEffort">;
  logger: SafeLogger;
  domainFailureRecordedByService: boolean;
}
```

Registration, sync, and send pass `domainFailureRecordedByService: true` because
their services record expected outcomes. Agent listing passes `false`; an
`AgentMeshError` from listing therefore creates one `mcp.request_failed` event
with its safe code. Every unexpected exception creates one
`mcp.request_failed` event with `INTERNAL_ERROR`. Preserve the existing public
MCP error payload in every case and never pass the exception object to the
logger or event metadata.

- [ ] **Step 7: Run focused, contract, and secrecy tests**

```bash
pnpm vitest run test/messages.integration.test.ts test/mcp.contract.test.ts test/activity.integration.test.ts
pnpm test
pnpm typecheck
```

Expected: all tests pass; searching test database event JSON for `am_proj_`, `am_agent_`, attempted message text, and authorization headers returns no matches.

- [ ] **Step 8: Commit message and failure auditing**

```bash
git add src/logging.ts src/messages/service.ts src/mcp/server.ts src/http.ts test/messages.integration.test.ts test/mcp.contract.test.ts test/activity.integration.test.ts
git commit -m "feat: audit AgentMesh message outcomes"
```

---

### Task 4: Add optional local admin authentication and signed sessions

**Files:**
- Create: `src/admin/auth.ts`
- Modify: `src/config.ts:1-66`
- Modify: `src/server.ts:1-72`
- Modify: `compose.yaml:18-44`
- Modify: `.env.example`
- Create: `test/admin-auth.test.ts`
- Modify: `test/config.test.ts:1-70`

**Interfaces:**
- Produces: `AdminAuth`, `createAdminAuth()`, `parseAdminCookie()`, `createSessionCookie()`, and `clearSessionCookie()`.
- Produces: optional `AgentMeshConfig.admin` with token digest, domain-separated session key, and secure-cookie flag.
- Consumes: `AGENTMESH_ADMIN_TOKEN`, `AGENT_SESSION_SIGNING_KEY`, and `AGENTMESH_ADMIN_COOKIE_SECURE`.

- [ ] **Step 1: Write failing configuration and cryptographic session tests**

Cover dashboard disabled when the token is absent or empty, rejection of a token with less than 32 bytes of entropy, constant-time digest verification, expiry boundaries, signature mutation, and cookie attributes:

```ts
const rawAdminToken = Buffer.alloc(32, 9).toString("base64url");
const serverSigningKey = Buffer.alloc(32, 7);
const auth = createAdminAuth({
  tokenDigest: createHash("sha256").update(rawAdminToken).digest(),
  sessionSigningKey: createHmac("sha256", serverSigningKey)
    .update("agentmesh-admin-session-v1")
    .digest(),
  secureCookies: false,
  clock: () => new Date("2026-08-30T12:00:00.000Z"),
});

expect(auth.verifyLogin(rawAdminToken)).toBe(true);
const session = auth.issueSession();
expect(session.cookie).toContain("HttpOnly");
expect(session.cookie).toContain("SameSite=Strict");
expect(session.cookie).toContain("Path=/");
expect(session.cookie).not.toContain(rawAdminToken);
expect(auth.verifySession(session.value)).toBe(true);
```

- [ ] **Step 2: Run tests and observe missing admin auth**

```bash
pnpm vitest run test/config.test.ts test/admin-auth.test.ts
```

Expected: FAIL because admin configuration and session helpers do not exist.

- [ ] **Step 3: Extend validated environment configuration**

Treat an empty admin token as disabled. For a configured token, require base64url text decoding to at least 32 bytes. Derive:

```ts
admin: {
  tokenDigest: createHash("sha256").update(adminToken).digest(),
  sessionSigningKey: createHmac("sha256", signingKey)
    .update("agentmesh-admin-session-v1")
    .digest(),
  secureCookies: parsed.data.AGENTMESH_ADMIN_COOKIE_SECURE === "1",
} | null
```

Do not retain the raw token in `AgentMeshConfig`.

- [ ] **Step 4: Implement stateless 12-hour sessions**

Use a cookie value containing version, expiry timestamp, random nonce, and HMAC. Compare login and HMAC digests with `timingSafeEqual`. Reject malformed, expired, future-skewed, or mutated values without throwing raw parse errors. Export the cookie name `agentmesh_admin_session` and TTL `12 * 60 * 60 * 1_000`.

- [ ] **Step 5: Wire optional admin config into Compose and runtime**

Pass these variables to AgentMesh:

```yaml
AGENTMESH_ADMIN_TOKEN: ${AGENTMESH_ADMIN_TOKEN:-}
AGENTMESH_ADMIN_COOKIE_SECURE: ${AGENTMESH_ADMIN_COOKIE_SECURE:-0}
```

Add commented local generation guidance to `.env.example` without committing a real secret.

- [ ] **Step 6: Run authentication tests**

```bash
pnpm vitest run test/config.test.ts test/admin-auth.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit local admin authentication**

```bash
git add src/admin/auth.ts src/config.ts src/server.ts compose.yaml .env.example test/admin-auth.test.ts test/config.test.ts
git commit -m "feat: add local AgentMesh admin authentication"
```

---

### Task 5: Build project-scoped admin read models and stable cursors

**Files:**
- Create: `src/admin/contracts.ts`
- Create: `src/admin/query-service.ts`
- Create: `test/admin-query.integration.test.ts`

**Interfaces:**
- Produces: strict `adminListQuerySchema`, `messageListQuerySchema`, `eventListQuerySchema`, `encodeAdminCursor()`, and `decodeAdminCursor()`.
- Produces: `createAdminQueryService()` methods `listProjects`, `getSummary`, `listAgents`, `listMessages`, `getMessage`, and `listEvents`.
- Consumes: project, agent, message, and activity tables from Tasks 1 through 3.

- [ ] **Step 1: Write failing cross-project, filter, and cursor tests**

Seed two projects with distinct agents, messages, events, and one message containing `<img src=x onerror=alert(1)>`. Assert:

- project A endpoints never return project B IDs or text;
- unknown project/message IDs return a typed not-found result;
- message list returns a 160-code-point preview but not idempotency keys;
- message detail returns full text for the correct project only;
- event results contain safe metadata and joined public agent names;
- filters for agent, event type, outcome, and ACK state are applied server-side;
- message/event `after` cursors return only newly inserted higher sequences;
- a query containing both history `cursor` and live `after` is rejected;
- limit 0, limit 101, unknown keys, malformed UUIDs, and malformed cursors fail validation;
- fetching page 2 with the page-1 cursor remains stable after a newer row is inserted.

- [ ] **Step 2: Run tests and observe missing contracts/service**

```bash
pnpm vitest run test/admin-query.integration.test.ts
```

Expected: FAIL because admin contracts and query service modules do not exist.

- [ ] **Step 3: Define opaque cursor contracts**

Use strict Zod schemas for two cursor payloads:

```ts
type SequenceCursor = { kind: "sequence"; sequence: number };
type CreatedCursor = { kind: "created"; created_at: string; id: string };
```

Encode UTF-8 JSON as base64url and reject decoded payloads over 512 bytes. Never interpolate cursor content into SQL; pass validated values through Drizzle predicates.

Message and event query schemas accept either `cursor` for older history or
`after` for live higher-sequence rows, never both. History pages order newest
first; live pages order ascending so the browser applies events in sequence.

- [ ] **Step 4: Implement bounded public DTOs**

Define exact API-facing records. Message list output must omit `idempotencyKey`; agent output must omit `registrationDigest`; project output must omit all token rows. Use a code-point preview helper:

```ts
export function previewMessage(text: string): string {
  const points = [...text];
  return points.length <= 160 ? text : `${points.slice(0, 160).join("")}…`;
}
```

- [ ] **Step 5: Implement project-scoped queries**

Every method receives an explicit `projectId` except `listProjects`. Query predicates must include `projectId` before any supplied agent or message ID. Presence uses the existing five-minute and thirty-minute boundaries. Summary returns:

```ts
{
  project: { id, name, created_at },
  agents: { online, idle, offline, total },
  messages: { total, unacknowledged },
  failures_last_24h,
}
```

Order message/event pages by descending sequence and project/agent pages by descending `(created_at, id)`. Fetch `limit + 1`, emit `next_cursor` only when another row exists, and return at most 100 rows.

For live message/event requests with `after`, use
`sequence > decoded.sequence`, order ascending, return at most 100 rows, and
emit `has_more: true` when another incremental page is required. The client
must drain incremental pages before advancing its saved cursor.

- [ ] **Step 6: Run query and neighboring integration tests**

```bash
pnpm vitest run test/admin-query.integration.test.ts test/activity.integration.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit read models**

```bash
git add src/admin/contracts.ts src/admin/query-service.ts test/admin-query.integration.test.ts
git commit -m "feat: add AgentMesh observability queries"
```

---

### Task 6: Expose the authenticated read-only admin HTTP API

**Files:**
- Create: `src/admin/routes.ts`
- Create: `src/admin/ui/page.ts`
- Modify: `src/http.ts:1-85`
- Modify: `src/server.ts:1-72`
- Create: `test/admin-http.integration.test.ts`
- Modify: `test/mcp.contract.test.ts`

**Interfaces:**
- Consumes: `AdminAuth` from Task 4 and `AdminQueryService` from Task 5.
- Produces: optional `/admin`, `/admin/session`, `/api/admin/*` routes with no-store headers and safe errors.
- Produces: `registerAdminRoutes(app, dependencies)`.

- [ ] **Step 1: Write failing HTTP authentication and isolation tests**

Use `app.inject()` with a configured admin token and assert:

```ts
expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(200);
expect((await app.inject({ method: "GET", url: "/api/admin/projects" })).statusCode).toBe(401);

const login = await app.inject({
  method: "POST",
  url: "/admin/session",
  payload: { token: adminToken },
});
expect(login.statusCode).toBe(204);
expect(login.headers["set-cookie"]).toContain("HttpOnly");
```

Reuse the returned cookie to test every API endpoint, project isolation, malformed queries, `404`, `400`, and safe `503`. Assert all admin responses include `Cache-Control: no-store`. Build another app with admin disabled and assert `/admin` plus `/api/admin/projects` both return `404`.

- [ ] **Step 2: Run HTTP tests and observe missing routes**

```bash
pnpm vitest run test/admin-http.integration.test.ts
```

Expected: FAIL because no admin routes are registered.

- [ ] **Step 3: Implement cookie-only admin guards**

`registerAdminRoutes` parses only `agentmesh_admin_session` from the Cookie header and never logs the header. Use a shared pre-handler for `/api/admin/*`. Return:

- `401 { "error": "unauthorized" }` for missing/invalid/expired sessions;
- `400 { "error": "invalid_request" }` for strict query failures;
- `404 { "error": "not_found" }` for project-scoped misses;
- `503 { "error": "temporarily_unavailable" }` for database failures.

Do not return caught error messages or stack traces.

- [ ] **Step 4: Implement login, logout, and a minimal authenticated shell**

`POST /admin/session` accepts strict JSON `{ token: string }`, issues the signed cookie, and returns 204. `DELETE /admin/session` clears the cookie and returns 204. `GET /admin` renders either the login form or an authenticated HTML shell using a per-response CSP nonce. At this task the shell only needs the header and empty application mount; Task 7 supplies the complete UI.

- [ ] **Step 5: Register exact read-only endpoints**

Wire the approved routes:

```text
GET /api/admin/projects
GET /api/admin/projects/:projectId/summary
GET /api/admin/projects/:projectId/agents
GET /api/admin/projects/:projectId/messages
GET /api/admin/projects/:projectId/messages/:messageId
GET /api/admin/projects/:projectId/events
```

No POST, PUT, PATCH, or DELETE route may exist under `/api/admin`.

- [ ] **Step 6: Preserve MCP behavior**

Construct one `AdminQueryService` and optional `AdminAuth` in `startServer`, pass them to `buildHttpApp`, and leave project bearer authentication for `/mcp` unchanged. Update existing test factories with `admin: null` where appropriate.

- [ ] **Step 7: Run HTTP, MCP contract, and full tests**

```bash
pnpm vitest run test/admin-http.integration.test.ts test/mcp.contract.test.ts
pnpm test
pnpm typecheck
```

Expected: admin tests pass and the MCP tool contract remains unchanged.

- [ ] **Step 8: Commit the admin API**

```bash
git add src/admin/routes.ts src/admin/ui/page.ts src/http.ts src/server.ts test/admin-http.integration.test.ts test/mcp.contract.test.ts
git commit -m "feat: expose read-only AgentMesh admin API"
```

---

### Task 7: Build the lightweight live dashboard

**Files:**
- Create: `src/admin/ui/styles.ts`
- Create: `src/admin/ui/browser.ts`
- Modify: `src/admin/ui/page.ts`
- Create: `test/admin-ui.test.ts`
- Modify: `test/admin-http.integration.test.ts`

**Interfaces:**
- Consumes: authenticated endpoints from Task 6.
- Produces: login view, summary cards, Activity/Messages/Agents tabs, filters, detail drawer, theme support, and cursor polling.
- Produces: `renderAdminPage({ authenticated, nonce })`, `ADMIN_STYLES`, and `ADMIN_BROWSER_SOURCE`.

- [ ] **Step 1: Write failing markup, CSP, and browser-safety tests**

Assert the authenticated page includes project selector, status region, three tabs, summary region, filter region, table/list mount, drawer, and logout. Assert the login page contains no application data. Verify:

```ts
expect(html).toContain(`nonce="${nonce}"`);
expect(html).not.toContain(adminToken);
expect(ADMIN_BROWSER_SOURCE).toContain("textContent");
expect(ADMIN_BROWSER_SOURCE).not.toMatch(/innerHTML\s*=/);
expect(ADMIN_BROWSER_SOURCE).not.toContain("localStorage");
```

Test pure exported delay/cursor helpers for one-second visible polling, slower hidden polling, bounded exponential backoff, and reset after success.

- [ ] **Step 2: Run UI tests and observe missing UI modules**

```bash
pnpm vitest run test/admin-ui.test.ts test/admin-http.integration.test.ts
```

Expected: FAIL because styles, browser source, and complete markup do not exist.

- [ ] **Step 3: Implement accessible static markup and styles**

Use semantic buttons, labels, tables/lists, `aria-live` connection status, visible focus rings, and text labels in addition to status colors. Apply `prefers-color-scheme` for light/dark themes and responsive breakpoints for laptop/tablet. Keep all CSS local to the dashboard; do not add a CSS framework.

- [ ] **Step 4: Implement safe browser rendering**

Build nodes with `document.createElement`, assign server data through `textContent`, and set fixed attributes only. Never concatenate message text, agent names, metadata, or error text into HTML. A detail drawer fetches full message text only after an authenticated click.

- [ ] **Step 5: Implement project selection, tabs, and filters**

On authenticated load:

1. fetch projects;
2. choose the first project unless a project ID is already held in in-memory page state;
3. fetch summary plus the active tab;
4. render filters for agent, event type, outcome, and ACK state as applicable;
5. reset tab cursors when project or filters change.

Do not persist project or filter state in browser storage.

- [ ] **Step 6: Implement polling and recovery**

Poll once per second while visible and use the newest accepted sequence as the
`after` cursor for incremental Activity and Messages updates. Drain
`has_more` incremental pages in sequence before saving the newest cursor. A
`message.acknowledged` activity event updates the ACK state of a matching
message already rendered in the Messages tab; switching projects or opening
the Messages tab performs a full first-page refresh so an ACK received while
the tab was inactive is visible. Slow polling while hidden. On failure, keep
rendered rows, set status to `Disconnected`, and retry with bounded delays
`1s, 2s, 4s, 8s, 15s`. Reset to one second after success. If the user has
scrolled away from the top, show a `New activity` button rather than moving
their viewport.

- [ ] **Step 7: Apply nonce-bound CSP**

Serve styles and browser script inline only with the generated nonce. Set:

```text
default-src 'none'; script-src 'nonce-<nonce>'; style-src 'nonce-<nonce>';
connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none';
form-action 'self'
```

Also set `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

- [ ] **Step 8: Run UI, HTTP, and full checks**

```bash
pnpm vitest run test/admin-ui.test.ts test/admin-http.integration.test.ts
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands pass.

- [ ] **Step 9: Commit the dashboard**

```bash
git add src/admin/ui test/admin-ui.test.ts test/admin-http.integration.test.ts
git commit -m "feat: add local AgentMesh activity dashboard"
```

---

### Task 8: Add safe pgAdmin observer views, role provisioning, and loopback override

**Files:**
- Modify: `src/db/schema.ts`
- Generate: `drizzle/0002_*.sql`
- Create: `src/observer/service.ts`
- Modify: `src/cli.ts:1-73`
- Modify: `compose.yaml`
- Create: `compose.pgadmin.yaml`
- Modify: `.env.example`
- Create: `test/observer.integration.test.ts`
- Modify: `test/cli.integration.test.ts:1-90`

**Interfaces:**
- Produces: SQL views `observer.projects`, `observer.agents`, `observer.messages`, and `observer.activity_events`.
- Produces: `ensureObserverRole(pool, password, roleName?)` and CLI command `agentmesh db observer ensure`.
- Consumes: `AGENTMESH_DB_OBSERVER_PASSWORD` and the existing owner `DATABASE_URL`.

- [ ] **Step 1: Write failing migration, privilege, and CLI tests**

Use a unique test role name matching `^agentmesh_observer_test_[a-z0-9_]+$`. Assert:

- all four views exist in schema `observer`;
- agents view omits `registration_digest`;
- messages view omits `idempotency_key`;
- no project-token view exists;
- observer can `SELECT` every view;
- observer cannot select `public.project_tokens`, `public.agents`, or `public.messages`;
- observer cannot insert through a view or base table, create a table, truncate, or `SET ROLE agentmesh`;
- `SHOW default_transaction_read_only` returns `on` for a new observer connection;
- CLI stdout/stderr never contains the observer password.

Clean up only the unique test role after closing its connection by running `DROP OWNED BY <validated test role>; DROP ROLE <validated test role>` on the dedicated integration-test PostgreSQL.

- [ ] **Step 2: Run observer tests and observe missing views/service**

```bash
pnpm vitest run test/observer.integration.test.ts test/cli.integration.test.ts
```

Expected: FAIL because the observer schema, role service, and CLI command do not exist.

- [ ] **Step 3: Add safe SQL views in an additive migration**

The generated/custom migration must create schema `observer` and owner-executed views selecting explicit safe columns:

```sql
CREATE VIEW observer.projects AS
SELECT id, name, created_at FROM public.projects;

CREATE VIEW observer.agents AS
SELECT id, project_id, name, client, capabilities, last_seen_at, created_at
FROM public.agents;

CREATE VIEW observer.messages AS
SELECT sequence, id, project_id, sender_agent_id, recipient_agent_id,
       text, created_at, acknowledged_at
FROM public.messages;

CREATE VIEW observer.activity_events AS
SELECT sequence, id, project_id, request_id, event_type, outcome,
       actor_agent_id, target_agent_id, message_id, error_code,
       metadata, created_at
FROM public.activity_events;
```

Do not grant `PUBLIC` access to the observer schema or views.

- [ ] **Step 4: Implement idempotent fixed-role provisioning**

Validate `roleName` against `^[a-z][a-z0-9_]{0,62}$` before placing it in SQL. Production calls omit it and use `agentmesh_observer`; tests pass a unique validated name. In one transaction:

1. create the login role if absent;
2. enforce `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`;
3. set a password supplied through a bound server-side setting and dynamic `%L` quoting;
4. set `default_transaction_read_only = on`;
5. revoke schema/table access not required;
6. grant database connect, observer schema usage, and select on the four views.

Never interpolate or log the password.

- [ ] **Step 5: Extend CLI parsing without weakening project creation**

Support exactly:

```text
agentmesh project create --name <name>
agentmesh db observer ensure
```

The observer command requires `AGENTMESH_DB_OBSERVER_PASSWORD` with at least 24 characters, calls `ensureObserverRole`, and prints only:

```json
{"ok":true,"role":"agentmesh_observer"}
```

Invalid commands print the two valid usage forms and no environment values.

Pass the optional password into the AgentMesh container without a fallback
credential:

```yaml
AGENTMESH_DB_OBSERVER_PASSWORD: ${AGENTMESH_DB_OBSERVER_PASSWORD:-}
```

- [ ] **Step 6: Add an opt-in Compose override**

Create:

```yaml
services:
  postgres:
    ports:
      - 127.0.0.1:${AGENTMESH_DB_OBSERVER_PORT:-55433}:5432
```

Do not add a PostgreSQL host port to base `compose.yaml`.

- [ ] **Step 7: Run observer, CLI, and migration tests**

```bash
pnpm vitest run test/observer.integration.test.ts test/cli.integration.test.ts test/db.integration.test.ts
pnpm test
pnpm typecheck
```

Expected: all pass; the test role cannot mutate or read base tables.

- [ ] **Step 8: Commit pgAdmin observer support**

```bash
git add src/db/schema.ts src/observer/service.ts src/cli.ts drizzle compose.yaml compose.pgadmin.yaml .env.example test/observer.integration.test.ts test/cli.integration.test.ts test/db.integration.test.ts
git commit -m "feat: add read-only pgAdmin observer access"
```

---

### Task 9: Extend Compose smoke coverage through admin APIs and restart

**Files:**
- Modify: `scripts/compose-smoke.ts:1-260`
- Modify: `package.json:11-20`
- Modify: `compose.yaml`

**Interfaces:**
- Consumes: MCP, admin login/API, activity events, and persistence from Tasks 1 through 8.
- Produces: one automated Compose proof for meaningful two-agent activity, safe failure, ACK, dashboard state, and restart durability.

- [ ] **Step 1: Write the failing smoke assertions**

Set deterministic non-production smoke credentials only in the smoke child environment:

```ts
AGENTMESH_ADMIN_TOKEN: Buffer.alloc(32, 11).toString("base64url"),
AGENTMESH_ADMIN_COOKIE_SECURE: "0",
```

After the existing two-agent exchange, send one invalid self-target message and assert MCP returns the safe target error. Login through `/admin/session`, retain only the returned cookie, and assert the selected project exposes:

```ts
assert.equal(summary.messages.total, 2);
assert.equal(summary.messages.unacknowledged, 0);
assert(events.some((event) => event.event_type === "message.sent"));
assert(events.some((event) => event.event_type === "message.send_failed"));
assert(events.some((event) => event.event_type === "message.acknowledged"));
```

Assert the activity API payload contains neither project/agent tokens nor the authorization header.

- [ ] **Step 2: Run smoke test and observe missing admin state**

Use the existing isolated Compose project:

```bash
pnpm smoke:compose
```

Expected: FAIL at admin login or activity query before the new environment and assertions are wired.

- [ ] **Step 3: Implement authenticated smoke helpers**

Add `adminLogin()`, `adminGet(path)`, and bounded JSON decoders. Never print the cookie or any token. Keep command-failure messages redacted as the existing script does.

- [ ] **Step 4: Verify persistence after restart**

After restarting AgentMesh, login again, query the same project, and assert the two messages, both ACK timestamps, and journal events remain. Also verify `/health` and `/admin` return 200.

- [ ] **Step 5: Run the complete smoke and local checks**

```bash
pnpm smoke:compose
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands pass and the smoke JSON reports event/message/ACK counts without credentials.

- [ ] **Step 6: Commit end-to-end coverage**

```bash
git add scripts/compose-smoke.ts package.json compose.yaml
git commit -m "test: verify AgentMesh observability in Compose"
```

---

### Task 10: Document local dashboard and pgAdmin operation, then run the live pilot

**Files:**
- Modify: `README.md:1-90`
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-08-30-agentmesh-local-observability-dashboard-design.md`

**Interfaces:**
- Consumes: all finished runtime and CLI behavior.
- Produces: exact local startup, login, pgAdmin enable/disable, observer provisioning, and verification instructions.

- [ ] **Step 1: Add exact local dashboard setup**

Document secret generation without showing generated values:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

The operator places separate generated values in `.env` as
`AGENTMESH_ADMIN_TOKEN` and `AGENTMESH_DB_OBSERVER_PASSWORD`, runs
`docker compose up --build -d --wait`, and opens
`http://127.0.0.1:3000/admin`.

- [ ] **Step 2: Add exact pgAdmin enable/provision/disable instructions**

Document:

```bash
set -a
source .env
set +a
docker compose -f compose.yaml -f compose.pgadmin.yaml up -d --wait
docker compose exec -T agentmesh node dist/cli.js db observer ensure
```

Connection fields:

```text
Name: AgentMesh Local (read-only)
Host: 127.0.0.1
Port: 55433
Maintenance database: agentmesh
Username: agentmesh_observer
Password: AGENTMESH_DB_OBSERVER_PASSWORD from .env
SSL mode: Disable
```

Explain that data appears under `Databases > agentmesh > Schemas > observer > Views`. To remove the host port while preserving data, run base Compose again without the override and recreate the PostgreSQL and AgentMesh services after explicitly confirming no active pgAdmin session.

Use this exact disable command after closing pgAdmin:

```bash
docker compose up -d --force-recreate --wait postgres agentmesh
```

Verify `docker compose port postgres 5432` prints no published host address and
the named PostgreSQL volume remains attached.

- [ ] **Step 3: Document boundaries and troubleshooting**

State that dashboard and pgAdmin are read-only, pgAdmin views intentionally hide credential-derived columns, port 55433 is loopback-only, test database port 55432 is separate, and the dashboard is absent when the admin token is unset. Include safe checks for healthy containers, `/health`, and observer role creation without printing secrets.

- [ ] **Step 4: Mark the written spec implemented only after evidence exists**

Change the spec status from `Approved for implementation` to `Implemented and verified` only after every command in Step 5 and the live pilot pass. Do not change the status earlier.

- [ ] **Step 5: Run a fresh two-Codex live pilot and independent verification**

Launch two ephemeral Codex CLI sessions with distinct registration UUIDs and read-only prompts. Require agent A to send a source-backed finding to B, B to run a focused test and reply, and both to ACK only after handling. Gate success on MCP `ok: true`, not natural-language claims. Independently verify:

```bash
curl --fail --silent http://127.0.0.1:3000/health
pnpm test
pnpm typecheck
pnpm lint
pnpm build
docker compose ps
git diff --check
```

Query the admin API and observer views to confirm two agents, two meaningful messages, two ACKs, registration/send/ACK events, and at least one safe failed-send event. Restart AgentMesh and repeat the counts. Search responses and logs for token prefixes without printing matches; the expected result is zero matches.

- [ ] **Step 6: Review final repository state**

Confirm `git status --short` contains only the intended documentation/status change before committing. Do not push.

- [ ] **Step 7: Commit documentation and verified spec status**

```bash
git add README.md .env.example docs/superpowers/specs/2026-08-30-agentmesh-local-observability-dashboard-design.md
git commit -m "docs: document AgentMesh observability workflow"
```

## Self-review

- Spec coverage: Tasks 1-3 implement safe durable events; Tasks 4-7 implement authentication, server-wide project selection, read-only APIs, UI, polling, recovery, and security headers; Task 8 implements safe pgAdmin views and loopback access; Tasks 9-10 cover restart persistence, documentation, and the live two-agent proof.
- Scope: the dashboard, event journal, and observer access are one release slice because the dashboard consumes the journal and final acceptance requires comparison with PostgreSQL; none creates a separate runtime subsystem.
- Completeness scan: every task names concrete files, interfaces, failing evidence, implementation behavior, commands, and commit boundaries.
- Type consistency: every instrumented operation accepts `OperationContext`; activity writes use `ActivityService`; admin routes consume `AdminAuth` and `AdminQueryService`; observer setup is isolated behind `ensureObserverRole`.
- Security consistency: successful events are atomic, failure events are best-effort and redacted, cookies contain no token, admin data remains project-scoped, UI uses text nodes, and pgAdmin cannot reach base tables.
