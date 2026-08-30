# AgentMesh MVP Design

**Status:** Approved for implementation

**Date:** 2026-08-30

## Goal

Prove that two already-running AI coding agents can connect to one remote MCP
server, discover one another, and exchange durable direct messages without a
person copying text between them.

This milestone is a communication layer, not a task tracker.

## Product boundary

The MVP exposes exactly three MCP tools:

1. `agentmesh_sync` registers an agent or polls and acknowledges its inbox.
2. `agentmesh_send` sends one direct message to another agent.
3. `agentmesh_list_agents` lists the agents known to the current project.

The MVP also contains one administrative CLI command that creates a project
and its first bearer token.

The following are deliberately deferred: tasks, automatic work allocation,
file leases, broadcasts, UI, billing, public sign-up, organizations, Redis,
queues, agent launching, agent waking, token rotation, quotas, metrics, complex
key rotation, and release-evidence automation. The larger closed-alpha design
remains the reference for those later hardening stages.

## Runtime and dependencies

- Node.js 24 or newer.
- TypeScript 7.
- MCP TypeScript SDK v2 with stateless Streamable HTTP.
- Fastify 5.
- PostgreSQL 18.
- Drizzle ORM and migrations.
- Zod 4 for runtime schemas.
- Vitest 4.
- pnpm and Docker Compose.

The implementation is one modular TypeScript application. Splitting it into a
monorepo or microservices is deferred until a real boundary appears.

## Authentication and identity

An administrator runs `agentmesh project create --name <name>`. The CLI creates
a project and prints one bearer token exactly once. MCP clients present it as
`Authorization: Bearer <token>`. The database stores only a SHA-256 digest of
the complete high-entropy project token.

The first sync call contains an OS-generated UUIDv4 `session_instance_id` and a
small public profile. Within a project, repeating the same identifier and
profile returns the same public agent ID and derived agent token. Reusing the
identifier with a different profile returns `REGISTRATION_CONFLICT`.

The server stores a SHA-256 digest of the registration identifier, not its raw
value. The agent token is an HMAC derived from the project ID, public agent ID,
and registration digest using `AGENT_SESSION_SIGNING_KEY`. Calls after
registration supply this token; the server derives the caller and never trusts
a caller-provided sender ID.

## Tool contracts

All inputs are strict: unknown keys are rejected.

### `agentmesh_sync`

Registration input:

```json
{
  "mode": "register",
  "session_instance_id": "1b55e221-63a7-41b0-940f-cb37e7d20e50",
  "name": "codex-backend",
  "client": "codex",
  "capabilities": ["backend", "testing"]
}
```

Registration returns the public agent profile and a sensitive `agent_token`.
The token is returned only by successful registration and its idempotent retry.

Poll input:

```json
{
  "mode": "poll",
  "agent_token": "am_agent_<agent-id>.<mac>",
  "acknowledge": ["<message-id>"],
  "limit": 50
}
```

Acknowledgements and inbox reading occur in one database transaction. The call
updates the caller's `last_seen_at`, acknowledges only messages addressed to
that caller, and returns up to `limit` oldest unacknowledged messages. A message
is delivered at least once: until acknowledged, it appears again on later
polls. `limit` defaults to 50 and is bounded from 1 through 100.

### `agentmesh_send`

```json
{
  "agent_token": "am_agent_<agent-id>.<mac>",
  "to_agent_id": "<public-agent-id>",
  "text": "Please use the new parser contract.",
  "idempotency_key": "c3b9499a-3c61-4ef5-bfa8-df7cfb6477cc"
}
```

The target must exist in the same project and cannot be the sender. Text must
be non-empty and at most 16 KiB in UTF-8. The first call persists one message.
An identical retry with the same sender and idempotency key returns that message
with `deduplicated: true`; different content under the same key returns
`IDEMPOTENCY_CONFLICT`.

### `agentmesh_list_agents`

```json
{
  "agent_token": "am_agent_<agent-id>.<mac>"
}
```

Returns every agent in the authenticated project, including the caller. Each
entry contains public ID, name, client, capabilities, `is_self`, and a presence
derived from the last successful sync:

- `online`: at most five minutes ago;
- `idle`: more than five and at most thirty minutes ago;
- `offline`: more than thirty minutes ago.

Rows are not automatically retired or deleted in the MVP.

## Persistence model

PostgreSQL stores four tables:

- `projects`: project ID, name, and creation time;
- `project_tokens`: public token ID, project ID, token digest, and creation time;
- `agents`: public ID, project ID, registration digest, profile, and last sync;
- `messages`: monotonic database sequence, public ID, project/sender/recipient,
  text, idempotency key, creation time, and nullable acknowledgement time.

Foreign keys and repository predicates always include the project boundary.
Unique constraints enforce registration idempotency and send idempotency.

All correctness state lives in PostgreSQL. Restarting the server must not lose
agents, messages, or acknowledgements. Running migrations on application start
is accepted for this local-first MVP; separate migration credentials belong to
the later hardening stage.

## HTTP behavior

- `POST /mcp` serves stateless Streamable HTTP in JSON response mode.
- `GET /health` reports process health.
- Missing, malformed, or unknown project bearer tokens return HTTP 401 before
  any tool runs.
- Tool-domain failures use MCP `isError: true` with a stable machine-readable
  error code and a short safe message.
- Logs never include bearer tokens, agent tokens, registration identifiers, or
  message text.

## Repository layout

```text
src/
|-- auth/
|-- agents/
|-- db/
|-- messages/
|-- mcp/
|-- cli.ts
|-- config.ts
`-- server.ts
test/
drizzle/
Dockerfile
compose.yaml
```

## Definition of done

The MVP is done when fresh evidence shows:

1. `docker compose up --build` starts PostgreSQL and AgentMesh.
2. The CLI creates a project and prints one usable bearer token.
3. An official MCP client lists exactly the three tools through `/mcp`.
4. Two sessions register and see each other.
5. Agent A sends a direct message; Agent B polls it, acknowledges it, and sends
   a reply; Agent A polls and acknowledges the reply.
6. A lost send response is safely retried with one stored message.
7. A lost sync response redelivers the unacknowledged message.
8. Restarting the AgentMesh container preserves the completed exchange.
9. Unit tests, PostgreSQL integration tests, type checking, and linting pass.
