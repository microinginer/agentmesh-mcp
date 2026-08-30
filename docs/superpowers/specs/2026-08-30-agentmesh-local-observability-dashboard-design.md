# AgentMesh Local Observability Dashboard Design

**Status:** Approved for implementation

**Date:** 2026-08-30

## Goal

Give a local AgentMesh administrator a clear, read-only view of how AI agents
coordinate: which agents are present, what messages they exchange, which
messages are acknowledged, which operations fail, and what durable state is
stored in PostgreSQL.

The dashboard complements the MCP mailbox. It does not turn AgentMesh into a
task tracker and does not add controls that can change agent or message state.

## Scope

The first version adds:

1. A local web dashboard served by the existing AgentMesh process at `/admin`.
2. A read-only administrative HTTP API under `/api/admin`.
3. A durable, append-only `activity_events` journal for meaningful agent and
   message activity.
4. A server-wide project selector for an administrator who operates more than
   one project.
5. An optional, loopback-only PostgreSQL connection for pgAdmin using a
   dedicated observer role with read-only privileges.

The following remain out of scope: task assignment, file leases, agent
launching, manual messages, manual ACK, retries from the UI, message editing or
deletion, project creation, token management, public sign-up, organizations,
charts, alerts, SSE, WebSockets, external telemetry stacks, and a separate
frontend service.

## Runtime architecture

The dashboard remains inside the current modular TypeScript application:

```text
browser on this Mac
    |
    |  GET /admin and GET /api/admin/*
    v
AgentMesh / Fastify
    |-- existing POST /mcp
    |-- existing GET /health
    |-- admin authentication
    |-- read-only admin queries
    `-- static dashboard page and assets
             |
             v
          PostgreSQL
          |-- projects
          |-- agents
          |-- messages
          `-- activity_events
```

No second service, frontend framework, queue, cache, or analytics database is
introduced. Docker Compose continues to bind AgentMesh only to `127.0.0.1` by
default.

## Activity journal

### Purpose

The existing tables describe current durable state but cannot show a failed
send attempt because a failed operation creates no message row. The activity
journal records safe operational outcomes so the dashboard can distinguish
what an agent claimed from what the server actually accepted.

The journal covers requests that reach AgentMesh. A client-side approval
denial, MCP client crash, or transport failure before the HTTP request reaches
the server cannot create a server-side event; it remains visible only in the
client log. In that case the dashboard correctly shows no accepted message or
server outcome and must not invent a failed-send row.

The journal is append-only from the dashboard's perspective. No admin route
updates or deletes journal rows.

### Schema

`activity_events` contains:

- `sequence`: monotonic `bigserial` primary key used as the polling cursor;
- `id`: globally unique UUID;
- `project_id`: required project foreign key;
- `request_id`: UUID correlating events produced by one MCP request;
- `event_type`: bounded event name;
- `outcome`: `success` or `failure`;
- `actor_agent_id`: nullable same-project agent foreign key;
- `target_agent_id`: nullable same-project agent foreign key;
- `message_id`: nullable same-project message foreign key;
- `error_code`: nullable stable safe error code;
- `metadata`: JSONB produced only by typed, whitelisted event constructors;
- `created_at`: server timestamp.

The migration adds the composite uniqueness needed for same-project foreign
keys where the current schema exposes only a globally unique ID. Indexes cover
project plus descending sequence, project plus event type and sequence, and
project plus actor and sequence.

### Event taxonomy

The first version supports:

- `agent.registered`;
- `agent.registration_failed`;
- `agent.synced`;
- `message.sent`;
- `message.send_failed`;
- `message.acknowledged`;
- `mcp.request_failed`.

`mcp.request_failed` covers a server-visible tool operation only after valid
project authentication, so it can be attributed to a project without retaining
a credential. A request with a missing, malformed, or unknown project token has
no trustworthy project identity and is reported only as a redacted structured
server-log event. The token and its digest are never logged.

An empty successful inbox poll is not journaled. The agent's `last_seen_at`
already represents that heartbeat, and recording every empty poll would make
the timeline noisy and grow the database without adding useful history.
`agent.synced` is recorded when a poll delivers at least one message or
acknowledges at least one message. Every send outcome and every meaningful
domain failure is recorded.

One ACK event is written per acknowledged message. Events produced by the same
poll share a `request_id`.

### Allowed metadata

Metadata is deliberately small and event-specific. Allowed examples include:

- message byte length;
- inbox delivery count;
- ACK count;
- requested poll limit;
- whether an idempotent send was deduplicated;
- safe pagination counts.

The journal never stores:

- project, agent, or admin tokens;
- authorization or cookie headers;
- session registration identifiers or their raw digests;
- message text;
- arbitrary MCP input;
- raw database errors, stack traces, or environment values.

Successful journal rows are written in the same transaction as the state
change they describe. If that transaction fails, neither the state change nor
its success event commits. A safe failure event is attempted separately after
an expected domain error. Failure to persist a failure event never replaces or
masks the original MCP error and is reported through the structured server log.
When PostgreSQL itself is unavailable, the database cannot hold an event; the
server log is the remaining evidence source.

The first version has no automatic retention job. Cursor pagination prevents
large responses. Configurable retention is deferred until actual volume makes
it necessary.

## Administrative authentication

The dashboard is disabled unless `AGENTMESH_ADMIN_TOKEN` is configured. The
token must be high entropy and is stored only in the uncommitted local `.env`.
Project bearer tokens and agent tokens cannot authenticate the dashboard.

Opening `/admin` without a valid session displays a login form. A successful
login compares the supplied token in constant time and sets a signed,
`HttpOnly`, `SameSite=Strict` cookie. The cookie:

- uses `Path=/` because the page and API live under the disjoint `/admin` and
  `/api/admin` prefixes; only admin handlers inspect it;
- contains no admin token;
- expires after 12 hours;
- is signed using a domain-separated server key;
- uses `Secure` when the configured origin is HTTPS;
- is removed by logout.

No credential is placed in a URL or browser `localStorage`. Login and logout
may set or clear a cookie, but the observational API itself contains only GET
routes. Existing host and origin validation remains active. Admin responses
set `Cache-Control: no-store` and a restrictive Content Security Policy.

## Read-only admin API

The API exposes:

- `GET /api/admin/projects`;
- `GET /api/admin/projects/:projectId/summary`;
- `GET /api/admin/projects/:projectId/agents`;
- `GET /api/admin/projects/:projectId/messages`;
- `GET /api/admin/projects/:projectId/messages/:messageId`;
- `GET /api/admin/projects/:projectId/events`.

The administrator is server-wide and can select any project. Every project
query still includes the explicit project predicate; IDs from another project
return `404` rather than leaking their existence.

List endpoints use bounded cursor pagination. The default page size is 50 and
the maximum is 100. Message and event lists support server-side filters for
agent, event type, outcome, ACK state, and direction where applicable. Unknown
filters, malformed UUIDs, invalid cursors, and oversized limits return a safe
`400` response.

Message list rows contain a bounded preview. Full message text is returned only
from the authenticated message-detail endpoint. Admin API responses never
return idempotency keys, registration digests, token digests, or credentials.

## Dashboard experience

The first page is intentionally compact and useful without configuration:

- header with AgentMesh name, project selector, connection state, refresh
  state, theme, and logout;
- summary cards for online, idle, and offline agents, total messages,
  unacknowledged messages, and failures in the last 24 hours;
- an `Activity` tab with the newest meaningful events;
- a `Messages` tab with sender, recipient, time, ACK state, and preview;
- an `Agents` tab with name, client, capabilities, presence, registration time,
  and last activity;
- filters that update results without a full page reload;
- a side drawer for event and message details.

New rows appear without moving a user who has scrolled into history. Status
colors are never the only status indicator. The page follows the system light
or dark preference, maintains accessible contrast, works on a laptop and
tablet, and avoids decorative charts and heavy animation.

The UI is served by the current application without React or a separate build
service. Implementation modules remain separated into authentication, query
services, HTTP routes, event recording, page markup, browser behavior, and
styles so a future frontend replacement does not affect MCP logic.

## Refresh and recovery behavior

The browser polls once per second while visible and requests only rows newer
than its last cursor. Polling slows while the tab is hidden. A failed request
shows `Disconnected`, keeps already-rendered data, and retries with bounded
exponential backoff. After recovery it resumes from the last accepted cursor.

The first version deliberately uses polling instead of SSE or WebSockets. The
local workload is small, polling is easier to inspect and recover, and the
cursor contract remains reusable if a later version adds SSE.

If PostgreSQL is unavailable, admin data endpoints return a safe `503` without
stack traces. The dashboard does not replace existing rows with empty data.

## pgAdmin observer access

pgAdmin is a secondary diagnostic view, not the product dashboard. It is
optional and disabled by default.

An opt-in Compose override publishes PostgreSQL only on the Mac loopback
interface:

```text
127.0.0.1:${AGENTMESH_DB_OBSERVER_PORT:-55433} -> postgres:5432
```

Port `55433` avoids the repository's existing test-database port `55432`. The
mapping must never bind to `0.0.0.0` in the local setup.

A migration creates an `observer` schema with read-only views over safe
columns:

- `observer.projects`;
- `observer.agents`, without `registration_digest`;
- `observer.messages`, without `idempotency_key`;
- `observer.activity_events`.

`project_tokens` has no observer view. A fixed `agentmesh_observer` PostgreSQL
role is created or refreshed through an idempotent administrative CLI
operation. Its password comes from the local
`AGENTMESH_DB_OBSERVER_PASSWORD` environment variable. The role receives only:

- `CONNECT` on the `agentmesh` database;
- `USAGE` on the `observer` schema;
- `SELECT` on the four observer views.

The role has no create, insert, update, delete, truncate, trigger, execute,
ownership, replication, or role-management privileges. Its default transaction
mode is read-only. It receives no privileges on the underlying `public` tables.
The application owner password is not used in pgAdmin.

Desktop pgAdmin on the same Mac connects with:

```text
Name: AgentMesh Local (read-only)
Host: 127.0.0.1
Port: 55433
Maintenance database: agentmesh
Username: agentmesh_observer
Password: value from AGENTMESH_DB_OBSERVER_PASSWORD
SSL mode: Disable (loopback-only local connection)
```

The README will explain how to enable the override, create the observer role,
register the server in pgAdmin, and disable the port again. pgAdmin running in
another Docker container requires a different host/network configuration and
is not part of the first local guide.

## Compatibility and migration

The database migration is additive. Existing projects, tokens, agents,
messages, ACKs, and MCP contracts remain valid. The dashboard does not change
the three public MCP tool names or their input/output schemas.

Instrumentation is implemented behind typed event constructors rather than by
passing raw tool inputs to a generic logger. Existing service transactions are
extended only where an event must be atomic with the associated state change.

The admin HTTP modules depend on narrow read interfaces and do not call MCP
handlers. The MCP services do not depend on the dashboard.

## Verification

Fresh verification must cover:

1. Migration from the current four-table database without data loss.
2. Event constructors reject or omit token-like and unapproved fields.
3. A successful registration, meaningful sync, send, deduplicated retry,
   failure, and ACK create the expected safe events.
4. An empty successful poll does not create timeline noise.
5. Successful message and ACK events are transactionally consistent with their
   source rows.
6. Invalid admin credentials fail; valid login creates only the signed cookie.
7. Every admin endpoint requires authentication and sets no-store headers.
8. Cross-project IDs and filters cannot expose another project's rows.
9. Pagination is stable while new messages and events arrive.
10. Message list previews are bounded and detail access remains project-scoped.
11. Tokens, digests, authorization headers, and stack traces do not appear in
    event rows, API payloads, HTML, or application logs.
12. Polling recovers after a temporary server or database failure without
    clearing visible data.
13. The pgAdmin observer can select all four safe views, cannot read base
    tables or credential-derived fields, and cannot insert, update, delete,
    truncate, create, or assume the application role.
14. The pgAdmin port is loopback-only and absent when the override is disabled.
15. Existing MCP contract and integration tests continue to pass unchanged.
16. Type checking, linting, build, and Docker Compose smoke checks pass.
17. A two-agent live pilot displays registration, send, failure, ACK, and reply
    events correctly after an AgentMesh restart.

## Definition of done

The feature is complete when a local administrator can open `/admin`, log in,
select a project, watch two agents exchange and acknowledge messages, inspect a
safe failed-send event, and confirm the same durable state through read-only
pgAdmin access. The dashboard must remain observational, preserve all existing
MCP behavior, expose no credential, and survive an application restart with
its history intact.
