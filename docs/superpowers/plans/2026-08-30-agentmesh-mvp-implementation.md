# AgentMesh MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hostable MCP server through which two running coding agents discover one another and exchange durable direct messages.

**Architecture:** One TypeScript application exposes exactly three stateless MCP tools over Fastify and stores every correctness-relevant state transition in PostgreSQL. Project bearer authentication scopes the HTTP request; a derived agent token proves the caller inside each tool.

**Tech Stack:** Node.js 24+, TypeScript 7, MCP TypeScript SDK v2, Fastify 5, PostgreSQL 18, Drizzle ORM, Zod 4, Vitest 4, pnpm, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-30-agentmesh-mvp-design.md`

## Global Constraints

- Expose exactly `agentmesh_sync`, `agentmesh_send`, and `agentmesh_list_agents`.
- Keep tasks, broadcasts, file locks, UI, billing, queues, and agent execution out of this milestone.
- Store all durable state in PostgreSQL and scope every repository operation by project ID.
- Never log project tokens, agent tokens, registration identifiers, or message text.
- Write each behavior test first and observe the expected failure before implementation.
- Work inline on `main` as explicitly authorized by the user; do not commit without separate authorization.

---

### Task 1: Bootstrap and validate public contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/contracts.ts`
- Test: `test/contracts.test.ts`

**Interfaces:**
- Produces: strict `syncInputSchema`, `sendInputSchema`, and `listAgentsInputSchema` Zod schemas plus their inferred TypeScript types.
- Consumes: no application code.

- [x] Write a failing table-driven test proving valid register/poll/send/list inputs pass and unknown fields, non-v4 UUIDs, empty text, oversized UTF-8 text, duplicate capabilities, and out-of-range limits fail.
- [x] Run `pnpm vitest run test/contracts.test.ts` and verify failure is caused by the missing `src/contracts.ts` module.
- [x] Implement only the schema rules needed by the test. Export `MAX_MESSAGE_BYTES = 16 * 1024` and check UTF-8 size with `Buffer.byteLength`.
- [x] Run `pnpm vitest run test/contracts.test.ts`, `pnpm typecheck`, and verify both pass.
- [x] Record the checkpoint; do not commit without user authorization.

### Task 2: Add PostgreSQL schema and credential primitives

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`
- Create: `src/db/migrate.ts`
- Create: `src/auth/project-token.ts`
- Create: `src/auth/agent-token.ts`
- Create: `test/auth.test.ts`
- Create: `test/db.integration.test.ts`
- Generate: `drizzle/*.sql`

**Interfaces:**
- Produces: `createProjectToken()`, `verifyProjectToken()`, `deriveAgentToken()`, and tables `projects`, `projectTokens`, `agents`, `messages`.
- Consumes: `DATABASE_URL` and `AGENT_SESSION_SIGNING_KEY` from validated configuration.

- [x] Write failing credential tests with literal expected token shapes and mutation/cross-project rejection cases.
- [x] Observe the expected missing-module failure.
- [x] Implement high-entropy project tokens, SHA-256 digests, constant-time comparisons, and HMAC-derived agent tokens.
- [x] Write a failing real-PostgreSQL migration test that inserts two projects and proves duplicate registrations/idempotency keys are rejected per project while identical values remain legal across projects.
- [x] Generate and apply the Drizzle migration, then run the focused auth and database tests to green.
- [x] Record the checkpoint; do not commit without user authorization.

### Task 3: Implement agent registration, polling, and discovery

**Files:**
- Create: `src/agents/service.ts`
- Create: `src/errors.ts`
- Test: `test/agents.integration.test.ts`

**Interfaces:**
- Produces: `registerAgent(projectId, input)`, `syncAgent(projectId, input)`, and `listAgents(projectId, agentToken, now)`.
- Consumes: contract types, credential primitives, and Drizzle database client.

- [x] Write a failing PostgreSQL integration test for idempotent registration, profile conflict, agent-token impersonation rejection, ACK scoping, redelivery before ACK, disappearance after ACK, and online/idle/offline boundaries.
- [x] Observe failures against missing service functions.
- [x] Implement registration and sync transactions; hash the registration UUID before storage and never return it.
- [x] Implement project-scoped discovery with presence derived from the supplied/database timestamp.
- [x] Run `pnpm vitest run test/agents.integration.test.ts` and the earlier suites to green.
- [x] Record the checkpoint; do not commit without user authorization.

### Task 4: Implement durable direct send

**Files:**
- Create: `src/messages/service.ts`
- Test: `test/messages.integration.test.ts`

**Interfaces:**
- Produces: `sendMessage(projectId, input)` returning `{ message, deduplicated }`.
- Consumes: validated send input, authenticated agent identity, and the `messages` table.

- [x] Write failing PostgreSQL tests for direct delivery, sender/target separation, cross-project target rejection, identical idempotent retry, conflicting retry, and monotonic inbox order.
- [x] Observe the expected missing-function failures.
- [x] Implement one transaction that authenticates the sender, validates the target, inserts the message, and resolves unique-key retries by comparing stored payload fields.
- [x] Run focused and neighboring suites to green.
- [x] Record the checkpoint; do not commit without user authorization.

### Task 5: Expose MCP/HTTP, CLI, and self-hosted runtime

**Files:**
- Create: `src/config.ts`
- Create: `src/mcp/server.ts`
- Create: `src/http.ts`
- Create: `src/server.ts`
- Create: `src/cli.ts`
- Create: `test/mcp.contract.test.ts`
- Create: `test/cli.integration.test.ts`
- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Produces: authenticated `POST /mcp`, `GET /health`, and `agentmesh project create --name <name>`.
- Consumes: all application services from Tasks 1 through 4.

- [x] Write a failing contract test using the official MCP v2 client against a real local Fastify listener; assert exact tool names, registration, discovery, send, redelivery, ACK, and reply.
- [x] Observe the missing HTTP/MCP factory failure.
- [x] Register exactly three tools with strict input/output schemas and MCP `isError` domain-error results; mount the stateless JSON handler behind bearer authentication.
- [x] Write and observe a failing CLI test, then implement transactional project/token creation that prints the secret once.
- [x] Add startup migrations, health handling, multi-stage image, and Compose services for PostgreSQL plus AgentMesh.
- [x] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and the Docker Compose exchange/restart smoke test.
- [x] Record the checkpoint; do not commit without user authorization.

## Self-review

- Spec coverage: every MVP definition-of-done item maps to Tasks 1 through 5; deferred closed-alpha features are absent.
- Placeholder scan: the plan contains no deferred implementation placeholder; intentionally excluded work is named only as scope.
- Type consistency: the three contract schemas feed the three services and the three MCP registrations; project ID comes only from bearer authentication and sender identity only from the agent token.
