# AgentMesh Blackboard Design

## Goal

Add a project-scoped Blackboard that lets authenticated AgentMesh agents store and retrieve shared facts, API contracts, environment notes, and architecture decisions. The module must preserve tenant isolation, support optional TTL expiry, and prevent stale writers from overwriting newer values when they provide an expected version.

## Scope

The change adds:

- a `blackboard_entries` PostgreSQL table and Drizzle migration;
- strict Zod input and output contracts;
- a Blackboard service for set, get, and delete operations;
- `agentmesh_set_fact` and `agentmesh_get_facts` MCP tools;
- activity journal events for mutations;
- integration tests covering creation, updates, conflicts, TTL, and project isolation.

The change does not add an HTTP control-plane API, web UI, background expiry cleanup, or an MCP delete tool. Expired rows remain stored but are invisible to reads until updated or deleted.

## Persistence Model

`blackboard_entries` contains the requested identity, value, tags, version, TTL, actor, and timestamp columns. Its unique key is `(project_id, namespace, key)`. Secondary indexes cover `(project_id, namespace)` and `(project_id, expires_at)`. The project foreign key cascades on deletion.

`tags` is a non-null PostgreSQL `text[]` with an empty-array default. `created_by_type` and `last_updated_by_type` are restricted to `agent` or `user`. Version begins at `1` and increases by exactly one for every successful update.

Drizzle Kit generates the migration and metadata from `src/db/schema.ts`; migrations remain append-only.

## Public Contracts

`blackboardSetFactInputSchema` accepts an agent token, namespace, key, value, up to ten tags, and optional `ttl_seconds` and `expected_version`. Namespace and key use the database length limits. Value size is measured as UTF-8 bytes and is limited to 64 KiB. TTL and expected version are positive integers when present.

`blackboardGetFactsInputSchema` accepts an agent token and optional namespace, keys, and tags. When tags are supplied, a fact must contain all requested tags. Optional arrays must contain at least one value when present so an empty array cannot silently change query meaning.

`blackboardFactSchema` exposes the stored identifiers and value, version and TTL state, creator/updater identity, and ISO timestamps. Set and get output schemas wrap successful data in the existing `{ ok: true, data }` tool-result convention and share the standard error shape.

Optimistic-lock failures use the new safe error code `VERSION_CONFLICT`. When a fact does not exist, any request carrying `expected_version` fails with `VERSION_CONFLICT`; creation is allowed only when it is omitted.

## Service Behavior

The service depends on the database, agent authentication, activity journal, and an injectable clock.

### Set

`setFact(projectId, input, context)` authenticates the agent inside a transaction.

- Without `expected_version`, it performs an atomic PostgreSQL upsert. Inserts create version `1`; conflict updates increment the current version in the database.
- With `expected_version`, it performs a conditional update whose predicate includes the project, namespace, key, and current version. No matching row produces `VERSION_CONFLICT`.
- `expires_at` is recalculated from the operation clock and `ttl_seconds`; omitting TTL clears both TTL fields and makes the fact non-expiring.
- A successful mutation records `blackboard.fact_set` in `activity_events` in the same transaction, without storing the fact value or agent token in event metadata.

### Get

`getFacts(projectId, input)` authenticates the agent and queries only the authenticated project. Filters are combined with AND semantics: namespace equality, key membership, and containment of all requested tags. Rows with `expires_at < now` are excluded; `expires_at = now` remains visible to match the stated boundary. Results use a deterministic namespace/key order.

### Delete

`deleteFact(projectId, namespace, key, context)` uses an explicit actor type and actor ID in its operation context, deletes only within the supplied project, and records `blackboard.fact_deleted` when a row is removed. It returns whether a row was deleted. No MCP delete tool is exposed in this change.

## MCP Integration

The MCP server creates one Blackboard service alongside the existing agent and message services.

- `agentmesh_set_fact`: "Save or update a shared project fact, API contract, or architecture decision."
- `agentmesh_get_facts`: "Retrieve shared project facts, API contracts, or environment notes."

Both tools use the authenticated project supplied by the HTTP authentication layer, validate their Zod contracts, and return text plus matching structured content. Expected domain failures use the existing safe MCP error path.

## Activity and Errors

The activity event allowlist and database check constraint gain `blackboard.fact_set` and `blackboard.fact_deleted`. Activity metadata may contain safe structural fields such as namespace, key, and resulting version, but never the fact value, tags, or credentials.

The application error-code union and tool error schema gain `VERSION_CONFLICT`. Authentication failures retain `AGENT_AUTH_INVALID`; unexpected database failures remain `INTERNAL_ERROR`.

## Testing and Verification

`test/blackboard.spec.ts` uses the real PostgreSQL integration harness and covers:

1. creating a fact with version `1` and correct creator/updater identity;
2. updating it and incrementing the version;
3. rejecting a stale expected version without changing the stored value;
4. excluding expired TTL entries while retaining non-expired entries;
5. preventing facts from another project from appearing in results.

Contract coverage also verifies the 64 KiB UTF-8 boundary and the MCP tool list/description changes. Tests are written and observed failing before production implementation. Completion requires focused Blackboard tests, `pnpm typecheck`, and the full `pnpm test` suite to exit successfully, followed by a diff review for unrelated changes.

## Coordination

The Blackboard implementation shares `src/db/schema.ts`, `src/contracts.ts`, and `src/mcp/server.ts` with an in-progress Pulse module. Those files must have one active owner at a time. Blackboard-only service and test files may proceed independently after ownership of the shared files is sequenced through AgentMesh.
