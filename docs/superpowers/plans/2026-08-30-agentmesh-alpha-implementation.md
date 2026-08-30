# AgentMesh Closed Alpha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the open-source AgentMesh server that lets already-running Codex and Claude Code agents discover one another and exchange durable project-scoped messages through remote MCP.

**Architecture:** Implement a TypeScript modular monolith with a stateless MCP v2/Fastify edge and PostgreSQL as the only correctness store. Domain operations enter PostgreSQL through project-scoped repositories; lifecycle-sensitive operations use one shared lock coordinator, while protocol schemas, cryptographic codecs, canonical serialization, and wire-size checks remain pure and independently testable.

**Tech Stack:** Node.js 24 LTS, TypeScript 7, pnpm 11 workspaces, MCP TypeScript SDK v2, Fastify 5, PostgreSQL, Drizzle ORM/Kit, Zod 4, Vitest 4, Testcontainers, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-30-agentmesh-alpha-design.md`

## Global Constraints

- Read the complete spec before starting each task and preserve its exact three-tool product scope: `agentmesh_sync`, `agentmesh_send`, and `agentmesh_list_agents`.
- Before using an external package API, resolve and query its current documentation through Context7. If Context7 is unavailable, use only the package's official documentation or source and record the fallback in the task notes.
- Use Node.js 24 LTS and ESM only. The root `packageManager` is exactly `pnpm@11.24.0`; commit `pnpm-lock.yaml`.
- Every later workspace package keeps the Task 1 script contract: production exports resolve only from `dist`, `build` emits that package, `typecheck:local` is no-emit, public `typecheck` first invokes the root topological build, and focused Vitest uses the root's exact source-only test aliases. A clean checkout must never depend on stale untracked `dist` output.
- Pin initial versions exactly: all direct MCP packages `2.0.0`, Fastify `5.12.1`, Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, PostgreSQL driver `8.23.0`, Zod `4.5.4`, Vitest `4.1.11`, TypeScript `7.0.2`, Commander `15.0.0`, `canonicalize` `4.0.0`, Pino `10.3.1`, prom-client `15.1.3`, Testcontainers PostgreSQL `12.1.0`, tsx `4.23.13`, @types/node `24.13.3`, and @types/pg `8.23.1`.
- Import Zod through `zod/v4`. Import MCP v2 packages by their split names; never import the removed v1 monolith or `@modelcontextprotocol/core-internal`.
- Keep raw `pg`, Drizzle clients, and SQL inside `packages/database`. Tool handlers and business services consume repository interfaces, never a pool or transaction object.
- All application transactions use PostgreSQL `READ COMMITTED`. Lifecycle lock order is project -> presented project token -> agents by public ID -> delivery states by agent ID -> idempotency/message/delivery children.
- Capture `lifecycle_now` with `SELECT clock_timestamp()` only after project and project-token locks are acquired.
- Preserve the immutable alpha wire constants: 64 KiB request body, 128-byte ASCII JSON-RPC ID, 16 KiB message text, 8 KiB metadata, 25/32 KiB sync page, 96 KiB tool result, and 100 KiB final uncompressed JSON-RPC response.
- Every user-controlled string/array is bounded and every Zod object is strict. Message strings reject control characters except TAB, LF, and CR.
- Never log, trace, metric-label, audit, return in ordinary errors, or retain in evidence: project tokens, registration UUIDs/digests, agent tokens, cursors, message text, metadata, raw tool arguments, or arbitrary exception messages.
- Follow test-driven development: add one focused failing test, run it and observe the expected failure, implement the minimum behavior, rerun the focused test, then run the affected package checks before committing.
- PostgreSQL concurrency claims require real PostgreSQL tests with bounded deterministic probes. Mock databases cannot satisfy a concurrency or tenant-isolation gate.
- Do not add Redis, queues, background workers, OAuth, a web panel, task tracking, agent execution, push adapters, or repository storage.
- Commit after every task using the exact commit message named by that task. Never combine two review gates into one commit.

## Authoritative API References

- MCP HTTP/per-request factory: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md>
- MCP Fastify adapter: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/fastify.md>
- MCP tools and structured results: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md>
- Fastify server/request/TypeScript/testing/hooks: <https://fastify.dev/docs/latest/Reference/Server/>, <https://fastify.dev/docs/latest/Reference/Request/>, <https://fastify.dev/docs/latest/Reference/TypeScript/>, <https://fastify.dev/docs/latest/Guides/Testing/>, <https://fastify.dev/docs/latest/Reference/Hooks/>
- Drizzle PostgreSQL/migrations: <https://orm.drizzle.team/docs/get-started-postgresql>, <https://orm.drizzle.team/docs/drizzle-kit-migrate>
- PostgreSQL isolation: <https://www.postgresql.org/docs/current/transaction-iso.html>
- Codex non-interactive execution/configuration/permissions: <https://developers.openai.com/codex/noninteractive/>, <https://developers.openai.com/codex/config-reference/>, <https://developers.openai.com/codex/permissions/>
- Claude Code MCP configuration: <https://code.claude.com/docs/en/mcp>
- Claude Code CLI/headless/authentication/permission modes: <https://code.claude.com/docs/en/cli-reference>, <https://code.claude.com/docs/en/headless>, <https://code.claude.com/docs/en/authentication>, <https://code.claude.com/docs/en/permission-modes>

## File and Responsibility Map

```text
apps/server/
  src/app.ts                         Fastify application composition
  src/index.ts                       process lifecycle and signal handling
  src/cli/                           command parser and admin commands
  src/http/                          HTTP guards, authentication, rate limits
  src/mcp/                           per-request MCP server and three tools
  src/agents/                        agent application services
  src/messages/                      send/sync application services
  src/observability/                 bounded logs, audit, metrics
  src/health/                        liveness/readiness/operator routes
  tests/                             unit, HTTP, MCP, deployment contracts

packages/config/
  src/                               command-specific validated configuration

packages/protocol/
  src/                               public IDs, Zod contracts, crypto codecs,
                                     canonical JSON, cursors, result encoding,
                                     wire sizing, stable domain errors

packages/database/
  src/schema/                        complete initial Drizzle schema
  src/internal/                      lock coordinator and unexported SQL
  src/repositories/                  tenant-scoped application repositories
  src/operator/                      migrations and exact-target operations
  drizzle/                           committed SQL migration and metadata
  tests/                             Testcontainers integration/concurrency

examples/                            AGENTS/CLAUDE and client configurations
tests/interop/                       two-client physical acceptance harness
deploy/                              PostgreSQL role bootstrap, proxy examples
docs/                                self-hosting, security, data, runbooks
```

Package dependency direction is fixed:

```text
config ------> protocol
database ----> protocol
server ------> config + protocol + database public repositories
interop -----> public server/CLI surface only
```

`packages/database` never imports `apps/server`; `packages/protocol` imports neither database nor server.

---

### Task 1: Bootstrap the workspace and validated configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `pnpm-lock.yaml` (generated by pnpm)
- Create: `.npmrc`
- Create: `.gitignore`
- Create: `.node-version`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/primitives.ts`
- Create: `packages/protocol/src/limits.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/tests/limits.test.ts`
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/duration.ts`
- Create: `packages/config/src/secrets.ts`
- Create: `packages/config/src/server-config.ts`
- Create: `packages/config/src/admin-config.ts`
- Create: `packages/config/src/migration-config.ts`
- Create: `packages/config/src/index.ts`
- Test: `packages/config/tests/config.test.ts`

**Interfaces:**
- Consumes: `NodeJS.ProcessEnv` plus `Secret32` and immutable limits from the new `@agentmesh/protocol` package.
- Produces:

```ts
// packages/protocol/src/primitives.ts
export type Secret32 = Uint8Array & { readonly __brand: "Secret32" };
export type CursorKeyId = string & { readonly __brand: "CursorKeyId" };
export function parseCursorKeyId(value: string): CursorKeyId;

// packages/protocol/src/limits.ts
export const PROTOCOL_LIMITS = Object.freeze({
  requestBodyBytes: 65_536,
  jsonRpcIdAsciiBytes: 128,
  cursorKeyIdAsciiBytes: 32,
  messageTextUtf8Bytes: 16_384,
  metadataJsonBytes: 8_192,
  syncPageMessages: 25,
  syncMessagesJsonBytes: 32_768,
  toolResultJsonBytes: 98_304,
  jsonRpcResponseBytes: 102_400,
} as const);

export type AgentLifecyclePolicy = Readonly<{
  onlineTtlMs: number;
  idleTtlMs: number;
  retireAfterMs: number;
  projectAgentLimit: number;
  broadcastFanoutLimit: number;
}>;

export type ServerConfig = Readonly<{
  databaseUrl: string;
  databaseRuntime: Readonly<{
    connectionTimeoutMs: number;
    maxConnections: number;
    maxPendingCheckouts: number;
    cancellationDeadlineMs: number;
  }>;
  tokenPepper: Secret32;
  agentSessionSigningKey: Secret32;
  cursorKeys: Readonly<{
    current: Readonly<{ kid: CursorKeyId; secret: Secret32 }>;
    grace: Readonly<{ kid: CursorKeyId; secret: Secret32 }> | null;
    gracePeriodMs: number;
  }>;
  lifecycle: AgentLifecyclePolicy;
  projectTokenDefaultTtlMs: number;
  releaseEvidenceMode: boolean;
  deploymentIdentity: Readonly<{
    commitSha: string;
    imageDigest: string;
  }> | null;
}>;

export type AdminConfig = Readonly<{
  databaseUrl: string;
  tokenPepper: Secret32;
  projectTokenDefaultTtlMs: number;
}>;

export type MigrationConfig = Readonly<{
  migrationDatabaseUrl: string;
}>;

export type ConfigReadinessIssue =
  | "lifecycle_order"
  | "agent_limit"
  | "broadcast_limit"
  | "quota_limit"
  | "rate_limit"
  | "timeout"
  | "deployment_identity";

export type ServerConfigLoadResult = Readonly<{
  config: ServerConfig;
  readinessIssues: readonly ConfigReadinessIssue[];
}>;

export function parseDuration(value: string): number;
export function loadServerConfig(env: NodeJS.ProcessEnv): ServerConfigLoadResult;
export function loadAdminConfig(env: NodeJS.ProcessEnv): AdminConfig;
export function loadMigrationConfig(env: NodeJS.ProcessEnv): MigrationConfig;
```

- [ ] **Step 1: Add the failing configuration contract test**

```ts
import { describe, expect, it } from "vitest";
import {
  loadMigrationConfig,
  loadServerConfig,
  parseDuration,
} from "../src/index.js";

const secret = Buffer.alloc(32, 7).toString("base64url");

describe("configuration", () => {
  it("loads exact hosted lifecycle defaults", () => {
    const loaded = loadServerConfig({
      DATABASE_URL: "postgresql://app:pw@db/agentmesh",
      TOKEN_PEPPER: secret,
      AGENT_SESSION_SIGNING_KEY: Buffer.alloc(32, 8).toString("base64url"),
      CURSOR_CURRENT_KID: "cursor-k1",
      CURSOR_CURRENT_KEY: Buffer.alloc(32, 9).toString("base64url"),
    });
    const config = loaded.config;

    expect(loaded.readinessIssues).toEqual([]);
    expect(config.lifecycle).toEqual({
      onlineTtlMs: 5 * 60_000,
      idleTtlMs: 30 * 60_000,
      retireAfterMs: 7 * 24 * 60 * 60_000,
      projectAgentLimit: 100,
      broadcastFanoutLimit: 100,
    });
    expect(config.cursorKeys.gracePeriodMs).toBe(24 * 60 * 60_000);
  });

  it.each(["0m", "1", "1w", "1.5h", "-1s"])(
    "rejects duration %s",
    value => expect(() => parseDuration(value)).toThrow(),
  );

  it("keeps migration credentials command-specific", () => {
    expect(loadMigrationConfig({ MIGRATION_DATABASE_URL: "postgresql://migrate:pw@db/agentmesh" }))
      .toEqual({ migrationDatabaseUrl: "postgresql://migrate:pw@db/agentmesh" });
    expect(() => loadMigrationConfig({ DATABASE_URL: "postgresql://app:pw@db/agentmesh" }))
      .toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm the package is absent**

Run: `corepack pnpm exec vitest run packages/config/tests/config.test.ts`

Expected: FAIL because the root workspace/package configuration and package source files do not exist.

- [ ] **Step 3: Create the pinned workspace manifests**

Each workspace manifest sets its exact package name, ESM type, exports, build, typecheck, and test scripts. The root Vitest configuration uses test.projects rather than the deprecated workspace option.

Use this root manifest and install once so pnpm generates the lockfile:

```json
{
  "name": "agentmesh",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.24.0",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "build": "pnpm -r --sort build",
    "typecheck": "pnpm build && pnpm -r --sort typecheck:local",
    "test": "pnpm build && vitest run",
    "check": "pnpm build && pnpm -r --sort typecheck:local && vitest run"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "tsx": "4.23.13",
    "typescript": "7.0.2",
    "vitest": "4.1.11"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
  - tests/*
```

Use these package-manifest contracts:

~~~json
{
  "name": "@agentmesh/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "pnpm --workspace-root build && pnpm run typecheck:local",
    "typecheck:local": "tsc -p tsconfig.json --noEmit",
    "test": "pnpm --workspace-root build && vitest run --config ../../vitest.config.ts tests"
  }
}
~~~

~~~json
{
  "name": "@agentmesh/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "pnpm --workspace-root build && pnpm run typecheck:local",
    "typecheck:local": "tsc -p tsconfig.json --noEmit",
    "test": "pnpm --workspace-root build && vitest run --config ../../vitest.config.ts tests"
  },
  "dependencies": {
    "@agentmesh/protocol": "workspace:*"
  }
}
~~~

tsconfig.base.json uses target ES2024, module and moduleResolution NodeNext, strict true, noUncheckedIndexedAccess true, exactOptionalPropertyTypes true, declaration true, sourceMap true, and noEmitOnError true. Each package tsconfig extends it, sets rootDir to src and outDir to dist, and includes src. Production exports remain `dist` only. The root build is topologically sorted, so a clean checkout builds protocol before config/database/server. `vitest.config.ts` uses test.projects rather than the deprecated workspace option and four explicit aliases—`@agentmesh/protocol`, `@agentmesh/config`, `@agentmesh/database`, and `@agentmesh/server`—to their exact workspace `src/index.ts` paths. Future-path aliases may exist before the corresponding task creates the file; they are resolved only when imported. This lets focused source tests observe a new failing test without relying on stale dist; production/CLI/container resolution never uses those test-only aliases. `.npmrc` sets engine-strict=true and save-exact=true.

Run: `corepack enable && pnpm install`

Expected: `pnpm-lock.yaml` records exact versions and `pnpm --version` prints `11.24.0`.

- [ ] **Step 4: Implement strict command-specific loaders**

Cursor key IDs use the exact ASCII grammar `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`; `parseCursorKeyId` returns the brand or one bounded validation error. The optional grace cursor kid/key pair must be complete, distinct from current, and absent by default. CURSOR_KEY_GRACE_PERIOD defaults to 24h and accepts a positive duration no greater than 30d. All configured token, agent-session, current-cursor, and grace-cursor secrets must be independent.

Database runtime defaults are a 5s connect timeout, 20 ordinary connections, 1,000 pending checkouts, and a 1s cancellation deadline. Validate connect timeout 100ms..30s, connections 2..100, pending checkouts 1..10,000, and cancellation 100ms..5s; invalid values use the safe defaults and add the bounded `timeout` readiness issue. Task 14 also requires connect timeout not exceed the HTTP handler timeout.

Use a positive integer plus `ms|s|m|h|d` duration grammar, decode secrets from canonical base64url to exactly 32 bytes, reject equal signing secrets, enforce `0 < online < idle < retire`, and enforce agent/fan-out ranges `1..1000`. `loadServerConfig` must not read or expose `MIGRATION_DATABASE_URL`; `loadMigrationConfig` must not require runtime secrets. Add a limits test that attempts mutation and confirms the frozen object and exact numbers above remain unchanged.

At this task, missing or malformed DSNs and secrets are fatal bootstrap errors. Bind addresses and security allowlists are introduced by Task 14 and become fatal bootstrap inputs there. For a semantically invalid lifecycle, quota, rate, or timeout value, record only its bounded readiness issue and place the corresponding documented safe default in the immutable runtime config; never retain the invalid raw value. The process may therefore construct the liveness/readiness routes safely, but exposes /ready=503 and keeps /mcp closed until the environment is corrected and the process restarts with an empty issue list.

`AGENTMESH_BUILD_COMMIT` and `AGENTMESH_IMAGE_DIGEST` are an optional complete pair with exact lowercase `40-or-64 hex` and `sha256:` plus 64 lowercase hex syntax. Both undefined or both empty mean absent for ordinary Compose interpolation; a half-pair, mixed empty/non-empty pair, or malformed value is fatal. `RELEASE_EVIDENCE_MODE` is a strict boolean defaulting to false; when true, an absent pair adds only `deployment_identity` to readinessIssues and keeps `/mcp` closed. These non-secret values must be observed from the built/running image by the release scripts, never trusted from user-supplied evidence arguments.

```ts
const durationPattern = /^(\d+)(ms|s|m|h|d)$/;
const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(value: string): number {
  const match = durationPattern.exec(value);
  if (!match) throw new Error("Invalid duration");
  const amount = Number(match[1]);
  const result = amount * multipliers[match[2] as keyof typeof multipliers];
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Invalid duration");
  return result;
}
```

- [ ] **Step 5: Run focused and workspace checks**

Run: `pnpm exec vitest run packages/protocol/tests/limits.test.ts packages/config/tests/config.test.ts && pnpm typecheck`

Expected: PASS from a clean tree with no pre-existing `dist`; the explicit dependency-ordered build emits `dist`, then the no-emit typecheck phase emits nothing further.

- [ ] **Step 6: Commit the bootstrap**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc .gitignore .node-version tsconfig.base.json tsconfig.json vitest.config.ts packages/protocol packages/config
git commit -m "feat: bootstrap workspace and validated configuration"
```

---

### Task 2: Add public IDs, canonical JSON, and credential codecs

**Files:**
- Modify: `packages/protocol/package.json`
- Create: `packages/protocol/src/ids.ts`
- Create: `packages/protocol/src/canonical-json.ts`
- Create: `packages/protocol/src/digests.ts`
- Create: `packages/protocol/src/credentials/project-token.ts`
- Create: `packages/protocol/src/credentials/agent-session-token.ts`
- Create: `packages/protocol/src/credentials/registration-key.ts`
- Create: `packages/protocol/src/agents/profile.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/tests/ids.test.ts`
- Test: `packages/protocol/tests/canonical-json.test.ts`
- Test: `packages/protocol/tests/credentials.test.ts`

**Interfaces:**
- Consumes: `Secret32` from Task 1 and Node 24 `crypto` primitives.
- Produces:

```ts
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type ProjectTokenId = string & { readonly __brand: "ProjectTokenId" };
export type Digest32 = Uint8Array & { readonly __brand: "Digest32" };

export interface RandomSource {
  bytes(size: number): Uint8Array;
}

export const PUBLIC_ID_RANDOM_BYTES = 16;
export const PROJECT_TOKEN_ID_RANDOM_BYTES = 16;
export const PROJECT_TOKEN_SECRET_BYTES = 32;

export type PublicIdByPrefix = {
  prj: ProjectId;
  agt: AgentId;
  msg: MessageId;
};

export function generatePublicId<P extends keyof PublicIdByPrefix>(
  prefix: P,
  random: RandomSource,
): PublicIdByPrefix[P];

export function canonicalJson(value: unknown): string;
export function sha256(value: Uint8Array | string): Digest32;
export function constantTimeDigestEqual(left: Digest32, right: Digest32): boolean;

export type ProjectTokenMaterial = Readonly<{
  tokenId: ProjectTokenId;
  token: string;
  digest: Digest32;
}>;

export function issueProjectToken(pepper: Secret32, random: RandomSource): ProjectTokenMaterial;
export function parseProjectToken(token: string): { tokenId: ProjectTokenId } | null;
export function digestProjectToken(token: string, pepper: Secret32): Digest32;

export function registrationKeyDigest(projectId: ProjectId, uuid: string): Digest32;
export function profileFingerprint(profile: AgentProfile): Digest32;

export function issueAgentSessionToken(input: {
  signingKey: Secret32;
  projectId: ProjectId;
  agentId: AgentId;
  sessionInstanceId: string;
}): { token: string; digest: Digest32 };

export function parseAgentSessionToken(token: string):
  | { agentId: AgentId; digest: Digest32 }
  | null;
```

Every generated `prj_`, `agt_`, and `msg_` identifier and project-token lookup ID encodes exactly 16 CSPRNG bytes as canonical unpadded base64url (22 characters after its fixed type prefix). Project-token secret material encodes a separate 32-byte draw. Input schemas retain the spec's broader 8..128-character compatibility range, but generators have this one exact entropy/length contract so pagination-envelope sizing is provable.

- [ ] **Step 1: Add failing canonicalization and credential vectors**

```ts
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  digestProjectToken,
  issueAgentSessionToken,
  parseAgentSessionToken,
  registrationKeyDigest,
} from "../src/index.js";

const bytes = (value: number) => new Uint8Array(32).fill(value) as never;

describe("canonical JSON", () => {
  it("uses RFC 8785 key ordering", () => {
    expect(canonicalJson({ z: 1, a: "x", nested: { b: true, a: null } }))
      .toBe('{"a":"x","nested":{"a":null,"b":true},"z":1}');
  });
});

describe("credentials", () => {
  it("reproduces one agent token for an idempotent registration retry", () => {
    const input = {
      signingKey: bytes(9),
      projectId: "prj_example" as never,
      agentId: "agt_example" as never,
      sessionInstanceId: "1b55e221-63a7-41b0-940f-cb37e7d20e50",
    };
    const first = issueAgentSessionToken(input);
    const second = issueAgentSessionToken(input);
    expect(second).toEqual(first);
    expect(parseAgentSessionToken(first.token)).toEqual({
      agentId: input.agentId,
      digest: first.digest,
    });
  });

  it("domain-separates registration keys by project", () => {
    const uuid = "1b55e221-63a7-41b0-940f-cb37e7d20e50";
    expect(registrationKeyDigest("prj_a000" as never, uuid))
      .not.toEqual(registrationKeyDigest("prj_b000" as never, uuid));
  });

  it("keys project-token digests with the deployment pepper", () => {
    const token = "am_proj_lookup.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(digestProjectToken(token, bytes(1)))
      .not.toEqual(digestProjectToken(token, bytes(2)));
  });
});
```

Also inject a recording RandomSource and assert every public/lookup ID requests exactly 16 bytes, every project-token secret requests a separate 32 bytes, generated strings have the fixed canonical lengths above, and short/long/noncanonical RandomSource output is rejected rather than truncated or padded.

- [ ] **Step 2: Run the vectors and observe missing exports**

Run: `pnpm --filter @agentmesh/protocol exec vitest run tests/canonical-json.test.ts tests/credentials.test.ts`

Expected: FAIL because the canonicalization and credential modules are not implemented.

- [ ] **Step 3: Install the audited canonicalizer and implement exact codecs**

Run: `pnpm --filter @agentmesh/protocol add --save-exact canonicalize@4.0.0`

Use these domain-separated byte representations:

```ts
const encoder = new TextEncoder();

export function registrationKeyDigest(projectId: ProjectId, uuid: string): Digest32 {
  const canonicalUuid = parseUuidV4To16Bytes(uuid);
  return sha256(concatBytes(
    encoder.encode("agentmesh-registration-v1\0"),
    encoder.encode(projectId),
    canonicalUuid,
  ));
}

function agentSessionMacInput(projectId: ProjectId, agentId: AgentId, uuid: string): Uint8Array {
  return concatBytes(
    encoder.encode("agentmesh-agent-session-v1\0"),
    encoder.encode(projectId),
    Uint8Array.of(0),
    encoder.encode(agentId),
    Uint8Array.of(0),
    parseUuidV4To16Bytes(uuid),
  );
}
```

Project tokens contain a CSPRNG lookup ID plus a 32-byte base64url secret. Agent tokens contain the public agent ID plus the HMAC-SHA-256 MAC. Store `SHA-256(complete_agent_token)` as the agent-session digest. Reject padding, non-canonical base64url, malformed prefixes, wrong digest length, and non-v4 UUIDs. Compare fixed-length digests only through `timingSafeEqual`.

- [ ] **Step 4: Add mutation and non-reflection tests**

Extend the table tests with one-byte token mutations, invalid prefixes, cross-project issuance, non-v4 UUIDs, and sentinels asserting thrown validation errors never contain the raw token or UUID.

Run: `pnpm --filter @agentmesh/protocol exec vitest run tests/ids.test.ts tests/canonical-json.test.ts tests/credentials.test.ts`

Expected: PASS for every valid/mutated credential case.

- [ ] **Step 5: Run package checks**

Run: `pnpm --filter @agentmesh/protocol typecheck && pnpm --filter @agentmesh/protocol test`

Expected: PASS.

- [ ] **Step 6: Commit credential primitives**

```bash
git add packages/protocol pnpm-lock.yaml
git commit -m "feat: add identifiers and credential codecs"
```

---

### Task 3: Create the complete tenant-safe PostgreSQL schema

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/schema/projects.ts`
- Create: `packages/database/src/schema/project-tokens.ts`
- Create: `packages/database/src/schema/agents.ts`
- Create: `packages/database/src/schema/agent-delivery-state.ts`
- Create: `packages/database/src/schema/messages.ts`
- Create: `packages/database/src/schema/message-deliveries.ts`
- Create: `packages/database/src/schema/message-idempotency.ts`
- Create: `packages/database/src/schema/cursor-key-registry.ts`
- Create: `packages/database/src/schema/schema-version.ts`
- Create: `packages/database/src/schema/index.ts`
- Create: `packages/database/src/index.ts`
- Create: `packages/database/drizzle/0000_initial.sql` (generated, then reviewed)
- Create: `packages/database/drizzle/meta/*` (generated)
- Create: `packages/database/tests/support/postgres-container.ts`
- Create: `packages/database/tests/support/migrate-test-database.ts`
- Test: `packages/database/tests/migration.integration.test.ts`
- Test: `packages/database/tests/tenant-constraints.integration.test.ts`

**Interfaces:**
- Consumes: public ID/digest types from Task 2.
- Produces: complete schema tables, `DatabaseSchema`, and a Testcontainers helper used by every later PostgreSQL task.

```ts
export type StartedTestDatabase = Readonly<{
  applicationUrl: string;
  migrationUrl: string;
  stop(): Promise<void>;
}>;

export type DatabaseTestClient = Readonly<{
  execute(query: SQL): Promise<{
    rows: readonly Record<string, unknown>[];
  }>;
  close(): Promise<void>;
}>;

export async function startTestDatabase(): Promise<StartedTestDatabase>;
export async function migrateTestDatabase(migrationUrl: string): Promise<DatabaseTestClient>;
export const EXPECTED_SCHEMA_VERSION = "0000_initial";
```

The initial migration must contain every table required by the approved spec so lifecycle work never depends on a later message migration:

| Table | Required invariants |
|---|---|
| `projects` | `last_message_seq`, `message_count`, `delivery_count`, `logical_payload_bytes` are non-negative `bigint` values defaulting to zero |
| `project_tokens` | global `token_id NOT NULL UNIQUE`, 32-byte digest, expiry/use/revocation timestamps, composite project FK |
| `agents` | composite `(project_id,id)` key, registration/profile/session digests, bounded profile columns, `last_seen_at`, `retired_at`, `retirement_delivery_count` |
| `agent_delivery_state` | one row per agent and `0 <= acked_through_seq <= issued_through_seq` |
| `messages` | unique project sequence, immutable normalized payload, logical byte count, direct/broadcast check, project-scoped sender/target/reply FKs |
| `message_deliveries` | unique recipient/message, denormalized sequence, `pending|acknowledged|expired`, composite message/recipient FKs |
| `message_idempotency` | unique project/sender/key, 32-byte fingerprint, complete stored success result |
| `cursor_key_registry` | globally unique ASCII `kid` matching the 1..32-byte CursorKeyId grammar, a 32-byte domain-separated one-way key commitment (never the secret), `current|grace|retired`, activation/grace-expiry/retirement timestamps with state checks |
| `agentmesh_schema_version` | one row naming the exact expected application migration |

All persisted times use PostgreSQL timestamptz through Drizzle timestamp columns with withTimezone true and millisecond precision. Migration tests inspect information_schema.columns and fail any timestamp without time zone.

message_deliveries.status is the normative state. Enforce exact combinations: pending has both acknowledged_at and expired_at null; acknowledged has acknowledged_at non-null and expired_at null; expired has acknowledged_at null and expired_at non-null. ACK, retirement, pending indexes, and metrics filter by status and maintain these checks atomically. Migration tests inspect `pg_get_expr(indpred, indrelid)` and require `message_deliveries_pending_idx` to predicate on `status = 'pending'`, not merely infer state from nullable timestamps.

Add UNIQUE(project_id, id, project_seq) on messages. The delivery foreign key is exactly (project_id, message_id, project_seq) to that key, and the stored idempotency result carries message_id plus project_seq under the same composite consistency constraint. Include same-project wrong-sequence negative tests.

cursor_key_registry uses `varchar(32)` plus the exact CursorKeyId CHECK and a `bytea` commitment with `octet_length(key_commitment) = 32`; it has partial uniqueness enforcing at most one current and at most one grace row. State checks require grace_expires_at only for grace, retired_at only for retired, and neither on current. The commitment is `SHA-256(UTF8("agentmesh-cursor-key-commitment-v1\0") || UTF8(kid) || 0x00 || secret32)` and exists only to fail readiness/rotation on the wrong protected key without putting key material in PostgreSQL.

- [ ] **Step 1: Write a failing empty-database migration test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDatabase } from "./support/postgres-container.js";
import { migrateTestDatabase } from "./support/migrate-test-database.js";

describe("initial migration", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>>;

  beforeAll(async () => { testDb = await startTestDatabase(); }, 60_000);
  afterAll(async () => testDb.stop());

  it("creates the full alpha schema from an empty PostgreSQL database", async () => {
    const db = await migrateTestDatabase(testDb.migrationUrl);
    try {
      const tables = await db.execute(sql`
        select table_name from information_schema.tables
        where table_schema = 'public' order by table_name
      `);
      expect(tables.rows.map(row => row.table_name)).toEqual([
        "agent_delivery_state",
        "agentmesh_schema_version",
        "agents",
        "cursor_key_registry",
        "message_deliveries",
        "message_idempotency",
        "messages",
        "project_tokens",
        "projects",
      ]);
    } finally {
      await db.close();
    }
  });
});
```

- [ ] **Step 2: Run the migration test and confirm the database package is missing**

Run: `pnpm exec vitest run packages/database/tests/migration.integration.test.ts --hookTimeout=60000 --testTimeout=60000`

Expected: FAIL because the package, migration, and container helper do not exist.

- [ ] **Step 3: Install database dependencies and define all tables**

Create `@agentmesh/database` with the Task 1 `build`/`typecheck`/`typecheck:local`/root-config `test` scripts, production `dist` exports, and an exact `"@agentmesh/protocol": "workspace:*"` dependency before running filtered installs. This workspace edge is mandatory for the root topological clean build.

Run:

```bash
pnpm --filter @agentmesh/database add --save-exact drizzle-orm@0.45.2 pg@8.23.0
pnpm --filter @agentmesh/database add -D --save-exact drizzle-kit@0.31.10 @types/pg@8.23.1 @testcontainers/postgresql@12.1.0
```

Use named constraints so collision/error handling can key on exact names:

```text
projects_id_pk
project_tokens_token_id_uq
agents_project_id_pk
agents_project_registration_digest_uq
agent_delivery_state_project_agent_pk
messages_project_id_uq
messages_project_seq_uq
messages_project_id_seq_uq
message_idempotency_sender_key_uq
message_deliveries_recipient_message_uq
cursor_key_registry_kid_pk
```

Drizzle definitions set these names explicitly rather than accepting dialect-generated names. Task 6 catches only `projects_id_pk` and `project_tokens_token_id_uq`, Task 7 only `agents_project_id_pk`, and Task 9 only `messages_project_id_uq`; tests inject each collision and assert the driver `constraint` field before mapping it to the bounded outcome. Every other uniqueness/foreign-key/check failure remains an unexpected database error.

Use `bytea CHECK (octet_length(column) = 32)` for every digest. Use project-scoped composite foreign keys for sender, direct recipient, reply target, delivery recipient, delivery state, and idempotency owner. Add these lock/query indexes:

```sql
CREATE INDEX agents_project_due_idx
  ON agents(project_id, last_seen_at, id) WHERE retired_at IS NULL;
CREATE INDEX message_deliveries_pending_idx
  ON message_deliveries(project_id, recipient_agent_id, project_seq)
  WHERE status = 'pending';
CREATE INDEX agents_project_active_idx
  ON agents(project_id, id) WHERE retired_at IS NULL;
```

- [ ] **Step 4: Generate and inspect the initial migration**

Run: `pnpm --filter @agentmesh/database exec drizzle-kit generate --name=initial`

Expected: one migration with all nine tables, named constraints, composite foreign keys, checks, and indexes. Rename the generated SQL to `0000_initial.sql` only if Drizzle did not already use that stable name, and keep its metadata consistent.

The final statement of 0000_initial.sql inserts the one EXPECTED_SCHEMA_VERSION row. The version marker therefore commits in the same migration transaction as the complete schema and cannot be advanced independently by application code.

- [ ] **Step 5: Add table-driven cross-project constraint tests**

```ts
it.each([
  "message sender",
  "direct target",
  "reply target",
  "delivery recipient",
  "delivery state",
  "idempotency owner",
])("rejects a cross-project %s", async relation => {
  await expect(insertForgedCrossProjectRelation(db, fixtures, relation))
    .rejects.toMatchObject({ code: "23503" });
});

it("rejects a duplicate global token_id across projects", async () => {
  await insertProjectToken(db, fixtures.projectA, "shared_lookup");
  await expect(insertProjectToken(db, fixtures.projectB, "shared_lookup"))
    .rejects.toMatchObject({ constraint: "project_tokens_token_id_uq" });
});
```

- [ ] **Step 6: Run database schema gates**

Run:

```bash
pnpm --filter @agentmesh/database typecheck
pnpm exec vitest run packages/database/tests/migration.integration.test.ts packages/database/tests/tenant-constraints.integration.test.ts --hookTimeout=60000 --testTimeout=60000
```

Expected: PASS from a newly created PostgreSQL container; no test may depend on a developer database.

- [ ] **Step 7: Commit the complete initial schema**

```bash
git add packages/database pnpm-lock.yaml
git commit -m "feat: add initial tenant-safe database schema"
```

---

### Task 4: Add the database runtime, explicit migration runner, and schema gate

**Files:**
- Modify: packages/database/package.json
- Create: packages/database/src/internal/pool.ts
- Create: packages/database/src/internal/cancel-backend.ts
- Create: packages/database/src/internal/read-committed.ts
- Create: packages/database/src/internal/postgres-errors.ts
- Create: packages/database/src/readiness/schema-readiness.ts
- Create: packages/database/src/operator/migrate.ts
- Create: packages/database/src/runtime.ts
- Modify: packages/database/src/index.ts
- Modify: packages/database/tests/migration.integration.test.ts
- Test: packages/database/tests/schema-readiness.integration.test.ts
- Test: packages/database/tests/runtime-role.integration.test.ts

**Interfaces:**
- Consumes: the committed migration folder, EXPECTED_SCHEMA_VERSION, application DSN, or migration DSN.
- Produces only bounded runtime/operator entry points; Pool, Drizzle database objects, transactions, and raw SQL stay unexported.

~~~ts
export type SchemaReadiness =
  | { ready: true; version: string }
  | { ready: false; reason: "database_unavailable" | "migration_required" | "migration_mismatch" };

export interface SchemaReadinessRepository {
  check(signal: AbortSignal): Promise<SchemaReadiness>;
}

export interface DatabaseRuntime {
  readonly readiness: SchemaReadinessRepository;
  close(): Promise<void>;
}

export type DatabaseRuntimeOptions = Readonly<{
  connectionTimeoutMs: number;
  maxConnections: number;
  maxPendingCheckouts: number;
  cancellationDeadlineMs: number;
}>;

export function createDatabaseRuntime(
  databaseUrl: string,
  options: DatabaseRuntimeOptions,
): DatabaseRuntime;

export function runMigrations(input: {
  migrationDatabaseUrl: string;
  migrationsFolder: string;
}): Promise<void>;
~~~

- [ ] **Step 1: Make the migration test call the public operator entry point**

Replace the Task 3 test-only migrateTestDatabase helper with runMigrations, then assert that agentmesh_schema_version contains exactly EXPECTED_SCHEMA_VERSION.

- [ ] **Step 2: Add the failing readiness tests**

Cover an empty database, the exact migration, a deliberately wrong version row, and a stopped container. Require bounded reason enums rather than PostgreSQL exception text.

Run: pnpm exec vitest run packages/database/tests/migration.integration.test.ts packages/database/tests/schema-readiness.integration.test.ts --hookTimeout=60000 --testTimeout=60000

Expected: FAIL because the runtime and operator modules do not exist.

- [ ] **Step 3: Implement the private pool and READ COMMITTED wrapper**

The transaction helper must issue application transactions at READ COMMITTED, accept an AbortSignal, roll back on cancellation, and expose no transaction type through packages/database/src/index.ts.

~~~ts
async function inReadCommittedTransaction<T>(
  pool: Pool,
  cancellationPool: Pool,
  signal: AbortSignal,
  operation: (tx: InternalTransaction) => Promise<T>,
): Promise<T> {
  // Internal implementation owns one checked-out client so cancellation,
  // rollback, and destroy-on-uncertainty are explicit.
  return runCheckedOutReadCommitted(
    pool,
    cancellationPool,
    signal,
    operation,
  );
}
~~~

`createDatabaseRuntime` creates the ordinary bounded application pool plus a one-connection cancellation pool using the same application role. Both pools use an explicit finite `connectionTimeoutMillis`; an internal bounded checkout queue rejects overload rather than allowing unbounded `pool.connect()` waiters. `acquireCheckedOutClient` races checkout against the caller signal: if abort wins, the caller returns promptly, any later checkout is consumed and immediately destroyed without issuing `BEGIN` or a business query, and every rejection is observed. It checks the signal immediately after checkout and again before `BEGIN`. This covers pool exhaustion and a blackholed database even though node-postgres has no QueryConfig AbortSignal support.

`inReadCommittedTransaction` calls `signal.throwIfAborted()` before checkout, immediately after checkout, before BEGIN, after BEGIN, before every repository mutation, and at one explicit pre-commit gate. While a query or row-lock wait is active before that gate, abort uses the reserved connection to call `pg_cancel_backend` for the checked-out backend PID. An abort observed before the gate rolls back; if cancellation or rollback cannot be confirmed within the bounded cancellation deadline, destroy that checked-out client and never return it to the pool. At the gate, check the signal once, transition the wrapper to `committing`, remove the pre-commit cancellation listener, send COMMIT, and race its result against the same finite `cancellationDeadlineMs` as an outcome deadline. An exact response releases the client normally. If that deadline or a post-gate request abort arrives first, destroy the client, release the request slot, and return only the documented uncertain/lost-response category—never claim rollback or re-use the connection. Registration UUID, send idempotency key, monotonic sync cursor, idempotent retirement, and read-only list semantics make the identical retry safe whether PostgreSQL ultimately committed or disconnected first. Do not depend on an unsupported node-postgres QueryConfig signal field.

The same module provides a private `runCancelableRead(signal, operation)` path for readiness and the first project-token lookup. It uses the bounded checkout helper, records the backend PID, checks the signal before the read, and applies the same reserved-connection cancel/destroy discipline to an active read or lock wait; it never exposes a Pool/client/query object.

Normalize AbortError, PostgreSQL query-canceled 57014 caused by a pre-commit signal, and destroy-on-cancel into one internal `RequestTransactionAborted` category with no driver text. It is neither DATABASE_UNAVAILABLE nor an unknown SQL failure; the HTTP boundary owns whether the client observes its bounded 503 or a closed connection. A completed COMMIT is never mislabeled as aborted merely because the transport closed afterward.

- [ ] **Step 4: Implement the explicit migration command**

Use drizzle-orm/node-postgres/migrator against only migrationDatabaseUrl. Never insert, update, or repair agentmesh_schema_version in the runner: the committed migration owns that marker. Never fall back from MIGRATION_DATABASE_URL to DATABASE_URL.

Readiness verifies the exact version row, the Drizzle journal entry plus committed migration checksum, and a bounded critical-invariant probe covering all nine tables, named tenant foreign keys, delivery status checks, current/grace partial uniqueness, and quota columns. A forged version row over an incomplete schema remains migration_mismatch.

- [ ] **Step 5: Prove least-privilege runtime and cancellation behavior**

Create separate migration/operator and application roles in the Testcontainers database. The application role receives SELECT on the Drizzle journal and `agentmesh_schema_version`; SELECT/INSERT/UPDATE on projects, project_tokens, agents, agent_delivery_state, message_deliveries, and cursor_key_registry; and only SELECT/INSERT on immutable messages and message_idempotency. It receives no DELETE on any table, no UPDATE of schema/journal/immutable rows, and no CREATE/ALTER/DROP. The migration/operator role owns schema changes and exact-target cascading project deletion. Assert readiness succeeds, while application-role UPDATE of the schema marker or immutable message, DELETE of a project, and CREATE TABLE each fail with SQLSTATE 42501.

Hold one application transaction in `pg_sleep` and another on a row lock before the commit gate, abort each through the reserved same-role cancellation connection, and require prompt query cancellation, full rollback, no surviving mutation, and a healthy replacement checkout. Exhaust the ordinary pool, abort a queued checkout, then release capacity and prove no late `BEGIN`/operation and no leaked client; repeat against a blackholed host and require return at the signal deadline while the finite connection timeout cleans up the pending connect. Exercise the same cases through `runCancelableRead`. Force cancellation-pool failure and require the target client to be destroyed with PostgreSQL proving rollback after disconnect. Separately pause immediately before and immediately after the commit gate: the former aborts and rolls back, while the latter may commit and must be reported/tested as an uncertain response whose identical retry is safe. Blackhole the COMMIT response itself and require the finite outcome deadline to destroy/replace that client, free the request/in-flight slot, and let an identical retry derive the one valid committed-or-rolled-back state.

- [ ] **Step 6: Run the database boundary checks**

Run:

~~~bash
pnpm --filter @agentmesh/database typecheck
pnpm exec vitest run packages/database/tests/migration.integration.test.ts packages/database/tests/schema-readiness.integration.test.ts packages/database/tests/runtime-role.integration.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: PASS, and an import test confirms packages/database exports no Pool, SQL tag, Drizzle handle, or internal transaction type.

- [ ] **Step 7: Commit the runtime boundary**

~~~bash
git add packages/database pnpm-lock.yaml
git commit -m "feat: add database runtime and migration gate"
~~~

---

### Task 5: Define message, tool, error, and wire contracts

**Files:**
- Modify: packages/protocol/package.json
- Create: packages/protocol/src/errors.ts
- Create: packages/protocol/src/text.ts
- Create: packages/protocol/src/agents/contracts.ts
- Create: packages/protocol/src/messages/types.ts
- Create: packages/protocol/src/messages/schemas.ts
- Create: packages/protocol/src/messages/canonical-send.ts
- Create: packages/protocol/src/serialization/json.ts
- Create: packages/protocol/src/mcp/result.ts
- Create: packages/protocol/src/mcp/wire-size.ts
- Create: packages/protocol/src/mcp/pack-sync-page.ts
- Create: packages/protocol/src/tools/sync.ts
- Create: packages/protocol/src/tools/send.ts
- Create: packages/protocol/src/tools/list-agents.ts
- Modify: packages/protocol/src/index.ts
- Test: packages/protocol/tests/message-schemas.test.ts
- Test: packages/protocol/tests/canonical-send.test.ts
- Test: packages/protocol/tests/tool-schemas.test.ts
- Test: packages/protocol/tests/result-envelope.test.ts
- Test: packages/protocol/tests/wire-size.test.ts

**Interfaces:**

~~~ts
export type AgentMeshErrorCode =
  | "REGISTRATION_CONFLICT"
  | "AGENT_AUTH_INVALID"
  | "AGENT_NOT_FOUND"
  | "REPLY_TARGET_INVALID"
  | "AGENT_RETIRED"
  | "AGENT_LIMIT_REACHED"
  | "INVALID_CURSOR"
  | "CURSOR_KEY_ROTATED"
  | "IDEMPOTENCY_CONFLICT"
  | "MESSAGE_TOO_LARGE"
  | "PROJECT_QUOTA_EXCEEDED"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type ToolErrorPayload = Readonly<{
  code: AgentMeshErrorCode;
  message: string;
  retryable: boolean;
}>;

export type ToolResultCode = "OK" | AgentMeshErrorCode;
export const ERROR_CATALOG: Readonly<Record<
  AgentMeshErrorCode,
  Readonly<{ message: string; retryable: boolean }>
>>;

export type MessageTarget =
  | { type: "agent"; agent_id: AgentId }
  | { type: "broadcast" };

export type NormalizedSendPayload = Readonly<{
  sender_agent_id: AgentId;
  to: MessageTarget;
  text: string;
  metadata: MessageMetadata | null;
  reply_to: MessageId | null;
}>;

export type PreparedSendPayload = Readonly<{
  payload: NormalizedSendPayload;
  canonicalJson: string;
  fingerprint: Digest32;
  logicalPayloadBytes: bigint;
}>;

export function prepareSendPayload(
  senderAgentId: AgentId,
  input: Omit<AgentMeshSendInput, "agent_session_token">,
): PreparedSendPayload;

export function buildSuccessToolResult<T extends object>(
  output: T,
): {
  structuredContent: T;
  content: [{ type: "text"; text: string }];
};

export function buildErrorToolResult(error: ToolErrorPayload): {
  isError: true;
  content: [{ type: "text"; text: string }];
};

export function assertSingleMessageWireFit(prepared: PreparedSendPayload): void;
export function packSyncPage(input: PackSyncPageInput): PackedSyncPage;
~~~

Export the three strict schemas and their inferred types:

~~~text
AgentMeshSyncInputSchema / AgentMeshSyncOutputSchema
AgentMeshSendInputSchema / AgentMeshSendOutputSchema
AgentMeshListAgentsInputSchema / AgentMeshListAgentsOutputSchema
ToolErrorPayloadSchema
~~~

Also export the discriminated successful sync branches `AgentMeshRegistrationOutput`, `AgentMeshContinuationOutput`, and `AgentMeshRetirementOutput`; the root schema remains the single strict object above. This lets Task 11 type the token-free database registration result without weakening the public output union.

- [ ] **Step 1: Add failing strict-schema tests**

Use one strict root object for agentmesh_sync with mode plus optional fields and superRefine. Do not generate a root-level anyOf. Assert the exact legal field sets for register, sync, and retire; unknown or cross-mode fields fail.

AgentMeshSyncOutputSchema is also one strict root z.object with bounded optional registration, continuation, and retirement fields plus superRefine. It never uses root anyOf/oneOf. Assert its advertised JSON Schema root type is object so the MCP legacy codec cannot wrap structuredContent differently from TextContent.

- [ ] **Step 2: Add failing message-bound tests**

Cover UTF-8 byte boundaries, invalid surrogate input, disallowed control characters, allowed TAB/LF/CR, 32 files, 8 HTTPS links, metadata at 8 KiB, duplicate capabilities, invalid slugs, and unknown metadata fields.

Run: pnpm --filter @agentmesh/protocol exec vitest run tests/message-schemas.test.ts tests/tool-schemas.test.ts

Expected: FAIL on missing schemas.

- [ ] **Step 3: Install Zod and implement the strict contracts**

Run: pnpm --filter @agentmesh/protocol add --save-exact zod@4.5.4

Import only from zod/v4. Bound every string, array, cursor, token, public ID, project name, and error message exactly as the spec requires. Normalize omitted metadata and reply_to to null.

- [ ] **Step 4: Implement canonical send preparation**

Fingerprint the RFC 8785 representation of sender_agent_id, to, text, normalized metadata, and normalized reply_to. Exclude agent_session_token and idempotency_key. Count the UTF-8 bytes of that same canonical string once per message.

Add vectors proving reordered object keys do not change the fingerprint, array order does, and omitted versus null optional fields are identical.

- [ ] **Step 5: Implement the only success and error serializers**

Successful results must place the same validated object in structuredContent and in whitespace-free JSON TextContent. Business errors contain one JSON TextContent block and no structuredContent. ERROR_CATALOG is the only source of stable messages/default retryability and fixes REPLY_TARGET_INVALID to The reply target is not available. Unknown exceptions map to a bounded INTERNAL_ERROR without using exception.message, SQL detail, or stack.

- [ ] **Step 6: Add worst-case wire tests before the checker**

Build cases with quotes, backslashes, TAB/LF/CR, maximum metadata, 25 small messages, and a 128-character U+0000 request ID whose JSON encoding expands every character to six ASCII bytes. Test limit minus one, exact limit, and limit plus one for the messages array, complete tool result, modern JSON response, and finite legacy SSE response.

Run: pnpm --filter @agentmesh/protocol exec vitest run tests/result-envelope.test.ts tests/wire-size.test.ts

Expected: FAIL because the production page packer and checker are absent.

- [ ] **Step 7: Implement the shared wire checker and page packer**

The packer queries or accepts at most 26 candidate deliveries, appends at most 25 messages one by one, and stops before either 32 KiB messages JSON or 96 KiB complete tool-result JSON. It then adds active-agent entries one by one while budget remains and sets both has_more flags exactly.

The pre-send checker accepts only PreparedSendPayload. It substitutes maximum legal project/message/agent IDs, cursor, timestamp, project/name fields, and the six-byte-per-character request-ID vector itself; callers cannot accidentally pass shorter real envelope values. It must prove all three immutable caps against both modern JSON and finite legacy SSE outer fixtures. The same buildSuccessToolResult and UTF-8 byte function are used by send validation, pagination, the bounded HTTP wrapper, and later contract tests.

- [ ] **Step 8: Run all protocol gates**

Run:

~~~bash
pnpm --filter @agentmesh/protocol typecheck
pnpm --filter @agentmesh/protocol test
~~~

Expected: PASS; mutation attempts cannot alter PROTOCOL_LIMITS, and a schema-valid wire-oversized message returns MESSAGE_TOO_LARGE.

- [ ] **Step 9: Commit protocol contracts**

~~~bash
git add packages/protocol pnpm-lock.yaml
git commit -m "feat: define AgentMesh protocol contracts"
~~~

---

### Task 6: Add project administration, project-token authentication, and CLI routing

**Files:**
- Create: packages/database/src/repositories/projects/admin.ts
- Create: packages/database/src/repositories/projects/auth.ts
- Create: packages/database/src/repositories/projects/types.ts
- Create: packages/database/src/operator/delete-project.ts
- Modify: packages/database/src/runtime.ts
- Modify: packages/database/src/index.ts
- Create: apps/server/package.json
- Create: apps/server/tsconfig.json
- Create: apps/server/src/main.ts
- Create: apps/server/src/cli/program.ts
- Create: apps/server/src/cli/output.ts
- Create: apps/server/src/cli/project-commands.ts
- Create: apps/server/src/cli/token-commands.ts
- Create: apps/server/src/cli/db-commands.ts
- Create: apps/server/src/auth/project-token-authenticator.ts
- Create: apps/server/src/auth/principal.ts
- Create: apps/server/src/auth/index.ts
- Test: packages/database/tests/project-admin.integration.test.ts
- Test: packages/database/tests/project-auth.integration.test.ts
- Test: apps/server/tests/cli/project-token.test.ts
- Test: apps/server/tests/cli/config-routing.test.ts

**Interfaces:**

~~~ts
export type PresentedProjectToken = Readonly<{
  projectId: ProjectId;
  tokenId: ProjectTokenId;
  digest: Digest32;
}>;

export type ProjectPrincipal = Readonly<{
  projectId: ProjectId;
  tokenId: ProjectTokenId;
  presentedToken: PresentedProjectToken;
}>;

export type PersistedProjectTokenMaterial = Readonly<{
  tokenId: ProjectTokenId;
  digest: Digest32;
}>;

export type CreateProjectTokenCommand = Readonly<{
  projectId: ProjectId;
  token: PersistedProjectTokenMaterial;
  tokenTtlMs: number | null;
}>;

export interface ProjectTokenAuthenticator {
  authenticateReadOnly(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; principal: ProjectPrincipal }
    | { ok: false; reason: "invalid" | "database_unavailable" }
  >;
}

export interface ProjectAdminRepository {
  createProject(input: {
    projectId: ProjectId;
    name: string;
    initialToken: PersistedProjectTokenMaterial;
    tokenTtlMs: number | null;
  }): Promise<{ committed: true } | { committed: false; reason: "public_id_collision" | "token_id_collision" }>;
  createToken(input: CreateProjectTokenCommand): Promise<"created" | "token_id_collision">;
  listTokens(projectId: ProjectId): Promise<readonly SafeProjectTokenSummary[]>;
  revokeToken(projectId: ProjectId, tokenId: ProjectTokenId): Promise<boolean>;
}
~~~

The operator deletion function accepts one exact public project ID and a separately supplied confirmation name. It is not part of tenant repositories.

- [ ] **Step 1: Write failing project/token repository tests**

Cover project creation, 90-day hosted expiry, multiple active tokens, safe summaries without digests, rotate creating a replacement without revoking the old token, explicit revocation, and exact-target deletion. Skew the application clock far before/after PostgreSQL and prove create/rotate store `issued_at` from one database `clock_timestamp()` and `expires_at = issued_at + validated ttlMs`; `null` is the only non-expiring value.

- [ ] **Step 2: Add the authentication equivalence test**

Missing, malformed, unknown, expired, revoked, and one-byte-mutated tokens must all return the same repository-level invalid result. A stopped database returns database_unavailable. No result or captured error may contain the raw bearer token.

Run: pnpm exec vitest run packages/database/tests/project-admin.integration.test.ts packages/database/tests/project-auth.integration.test.ts --hookTimeout=60000 --testTimeout=60000

Expected: FAIL because the repositories do not exist.

- [ ] **Step 3: Implement project/token repositories with the normative lock order**

Read-only authentication parses token_id and performs the global candidate lookup through Task 4 `runCancelableRead` using the exact HTTP/request signal. It checks project scope, expiry/revocation against database time including expires_at <= now, and compares the HMAC digest in constant time. An abort during pool wait, network connect, `pg_sleep`, or row lookup returns the bounded aborted/unavailable path before MCP dispatch and cannot issue a late operation. Mutations lock project first and the sorted affected token rows second, then capture one database `token_now`; token creation/rotation stores both `issued_at = token_now` and `expires_at = token_now + ttlMs`. Plaintext token material remains in the admin application service only until its one-time stdout write; repositories receive only tokenId, digest, and validated TTL, never an application-computed Date.

Every later tenant command receives PresentedProjectToken and revalidates it after locking the project and token rows. The revalidation helper updates last_used_at only after the locked token remains valid.

- [ ] **Step 4: Add deterministic collision-safe CLI tests**

Inject a RandomSource that produces a global project/token public-ID collision first and a unique ID second. Each admin service retries at most three independent candidate allocations; three named-constraint collisions return one bounded failure without printing any candidate. Assert stdout contains only a committed token, never a discarded candidate, and stderr contains neither.

- [ ] **Step 5: Implement the Commander CLI and command-specific config loaders**

Create `@agentmesh/server` with the Task 1 script/export contract and exact workspace dependencies on `@agentmesh/config`, `@agentmesh/protocol`, and `@agentmesh/database` before running filtered installs. These declared edges—not directory naming—must order the clean root build.

Install Commander:

Run: pnpm --filter @agentmesh/server add --save-exact commander@15.0.0

Provide these commands:

~~~text
agentmesh project create --name NAME
agentmesh project delete --project-id ID --confirm-name NAME
agentmesh token create --project-id ID
agentmesh token list --project-id ID
agentmesh token rotate --project-id ID
agentmesh token revoke --project-id ID --token-id TOKEN_ID
agentmesh db migrate
~~~

Project/token commands use loadAdminConfig and DATABASE_URL. Migration and exact-target deletion use the explicit operator path and MIGRATION_DATABASE_URL. No loader falls back to another DSN. token rotate creates a replacement and leaves the old token active until token revoke.

Set the package bin entry agentmesh to dist/main.js. main.ts invokes the Commander program exactly once, and the package build emits an executable Node ESM entry with a shebang. Task 14 adds the server subcommand to this same binary.

- [ ] **Step 6: Implement print-once output discipline**

Write public IDs and safe summaries as compact JSON. Print a newly committed bearer token exactly once on stdout and never through logger, audit, exception, or test snapshot. Handle SIGPIPE without retrying token issuance.

- [ ] **Step 7: Run repository and CLI checks**

Run:

~~~bash
pnpm --filter @agentmesh/database typecheck
pnpm --filter @agentmesh/server typecheck
pnpm exec vitest run packages/database/tests/project-admin.integration.test.ts packages/database/tests/project-auth.integration.test.ts apps/server/tests/cli --hookTimeout=60000 --testTimeout=60000
~~~

Expected: PASS, including a table-driven import test showing every exported tenant method requires projectId.

- [ ] **Step 8: Commit project administration**

~~~bash
git add packages/database apps/server pnpm-lock.yaml
git commit -m "feat: add project administration and token auth"
~~~

---

### Task 7: Implement the shared lifecycle lock coordinator and idempotent registration

**Files:**
- Create: packages/database/src/internal/lifecycle/types.ts
- Create: packages/database/src/internal/lifecycle/lock-project-token.ts
- Create: packages/database/src/internal/lifecycle/lock-agent-union.ts
- Create: packages/database/src/internal/lifecycle/retire-due.ts
- Create: packages/database/src/internal/lifecycle/coordinator.ts
- Create: packages/database/src/internal/lifecycle/capture-now.ts
- Create: packages/database/src/internal/child-savepoint.ts
- Create: packages/database/src/testing/transaction-probe.ts
- Create: packages/database/src/repositories/agents/types.ts
- Create: packages/database/src/repositories/agents/register.ts
- Modify: packages/database/src/runtime.ts
- Create: apps/server/src/agents/register-agent.ts
- Create: apps/server/src/agents/authenticate-agent.ts
- Test: packages/database/tests/lifecycle-locking.integration.test.ts
- Test: packages/database/tests/agent-registration.integration.test.ts
- Create: packages/database/tests/support/controlled-transaction-probe.ts
- Test: apps/server/tests/agents/register-agent.test.ts

**Interfaces:**

~~~ts
export type RepositoryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: ToolErrorPayload };

export type PresentedAgentSession = Readonly<{
  agentId: AgentId;
  digest: Digest32;
}>;

export type TransactionStage =
  | "before_project_lock"
  | "after_project_lock"
  | "after_token_lock"
  | "after_lifecycle_now"
  | "after_agent_locks"
  | "after_delivery_state_locks"
  | "after_lifecycle_maintenance"
  | "after_idempotency_lookup"
  | "after_counter_update"
  | "after_message_insert"
  | "after_delivery_insert"
  | "after_ack_update"
  | "after_issued_update"
  | "before_commit";

export interface TransactionProbe {
  reach(stage: TransactionStage, context: {
    operationId: string;
    projectId: ProjectId;
    backendPid: number;
  }): Promise<void>;
}

export type RegisterAgentCommand = Readonly<{
  project: PresentedProjectToken;
  registrationDigest: Digest32;
  profileFingerprint: Digest32;
  profile: AgentProfile;
  proposedAgentId: AgentId;
  proposedSessionDigest: Digest32;
  lifecycle: AgentLifecyclePolicy;
  signal: AbortSignal;
}>;

export type RegisterAttemptOutcome =
  | RepositoryOutcome<{
      agentId: AgentId;
      profile: AgentProfile;
      lifecycleNow: Date;
      created: boolean;
    }>
  | { ok: false; reason: "public_id_collision" };

export interface AgentRepository {
  registerAtomic(command: RegisterAgentCommand): Promise<RegisterAttemptOutcome>;
}
~~~

The lifecycle coordinator is internal to packages/database. It returns a locked context to repository code but never exports a transaction or query builder. Every request-originated repository command in Tasks 7-12 carries the required `ProjectRequestPrincipal.signal`; application services may not replace it with a fresh signal or make it optional.

- [ ] **Step 1: Add a failing exact-boundary lifecycle test**

Unit-test a pure derivePresence(lastSeenAt, lifecycleNow, policy) at exactly five minutes, immediately after five, exactly thirty minutes, immediately after thirty, immediately before seven days, and exactly seven days. Repeat with one valid custom policy. Integration tests inject a fixed test captureLifecycleNow implementation; production captureLifecycleNow executes SELECT clock_timestamp() only after the waited project/token locks.

- [ ] **Step 2: Add a failing lock-order probe**

Create the no-op production TransactionProbe and bounded controlled test probe now, inject it through DatabaseRuntime, and assert registration reaches the shared stages in order:

~~~text
after_project_lock
after_token_lock
after_lifecycle_now
after_agent_locks
after_delivery_state_locks
after_lifecycle_maintenance
~~~

Run: pnpm exec vitest run packages/database/tests/lifecycle-locking.integration.test.ts

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement project/token locks and database time capture**

Pass `command.signal` into the Task 4 transaction wrapper. Execute three ordered statements: lock the project row; fetch the presented token row with `SELECT ... FOR UPDATE` and wait until that statement returns; only then execute a separate `SELECT clock_timestamp()` as `lifecycle_now`. PostgreSQL may evaluate target expressions below `LockRows`, so the timestamp must not share the waited `FOR UPDATE` statement. Revalidate digest and revocation, compare expiry as `expires_at <= lifecycle_now`, and only then set `last_used_at = lifecycle_now`. Reuse that exact value for every lifecycle boundary in the transaction. Call `signal.throwIfAborted()` before the token update and every later mutation. Hold the token lock past an expiry/retirement boundary in an integration test and prove the captured time is post-wait. Do not use now(), transaction_timestamp(), application time, or capture time before a waited lock.

- [ ] **Step 4: Implement union locking and committed maintenance outcomes**

Select the union of overdue agents plus explicitly required caller, target, or registration match. Lock all agent IDs ascending, then their delivery-state rows ascending, recheck deadlines, expire outstanding deliveries, and persist retired_at plus retirement_delivery_count.

Expected business failures after maintenance return RepositoryOutcome and allow the retirement changes to commit. The child-savepoint helper rolls back only idempotency/message/delivery child writes when a later operation must fail, without undoing already-required lifecycle maintenance.

- [ ] **Step 5: Add failing registration algorithm tests**

Cover:

- a new row plus delivery-state row;
- lost response plus same UUID returning the same agent and token;
- same registration digest with a different profile returning REGISTRATION_CONFLICT;
- retired registration returning AGENT_RETIRED before the agent limit check;
- existing active retry succeeding at or above the project limit;
- genuinely new registration at the limit returning AGENT_LIMIT_REACHED;
- raw UUID absent from every database column and captured surface.

- [ ] **Step 6: Implement the registration repository**

Resolve the locked registration digest including retired rows before counting active sessions. Insert only after the limit check. On a public agent-ID collision, the application service generates another proposed ID and retries without changing the registration digest.

Catch only the named agent public-ID uniqueness constraint and return `public_id_collision`. The application service tries at most three independently generated public IDs, then returns the fixed INTERNAL_ERROR without reflecting a candidate; tests force three collisions and prove no partial agent/delivery-state row. It derives the deterministic session token from project ID, the committed agent ID, and the raw UUID, passes only the digest into persistence, and returns plaintext only in the dedicated registration success field.

For an active same-profile registration replay, atomically set last_seen_at to lifecycle_now and return the reproducible token. Add an older-but-not-retired fixture proving this refresh. Conflict, retired, and failed new-registration paths do not refresh presence.

- [ ] **Step 7: Prove agent-token isolation**

Test A acting as B, mixed A/B token parts, a mutated token, and a Project A bearer with a Project B agent token; those invalid combinations return AGENT_AUTH_INVALID without indicating which component matched. An exact authentic token whose persisted agent is retired returns AGENT_RETIRED for register/sync/send/list and the stored `already_retired: true` result only for an idempotent retire retry.

- [ ] **Step 8: Run registration gates**

Run:

~~~bash
pnpm --filter @agentmesh/database typecheck
pnpm --filter @agentmesh/server typecheck
pnpm exec vitest run packages/database/tests/lifecycle-locking.integration.test.ts packages/database/tests/agent-registration.integration.test.ts apps/server/tests/agents/register-agent.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: PASS with no raw registration UUID or session token stored.

- [ ] **Step 9: Commit registration and lifecycle locking**

~~~bash
git add packages/database apps/server
git commit -m "feat: add lifecycle-safe agent registration"
~~~

---

### Task 8: Add explicit retirement, discovery, cursor keys, and key rotation operations

**Files:**
- Modify: packages/config/src/server-config.ts
- Create: packages/config/src/key-maintenance-config.ts
- Modify: packages/config/src/index.ts
- Modify: packages/config/tests/config.test.ts
- Create: packages/protocol/src/cursors/types.ts
- Create: packages/protocol/src/cursors/codec.ts
- Modify: packages/protocol/src/index.ts
- Test: packages/protocol/tests/cursor-codec.test.ts
- Create: packages/database/src/repositories/cursor-keys.ts
- Create: packages/database/src/repositories/cursor-registry-verifier.ts
- Modify: packages/database/src/index.ts
- Create: packages/database/src/repositories/agents/retire.ts
- Create: packages/database/src/repositories/agents/list.ts
- Create: packages/database/src/operator/rotate-cursor-key.ts
- Create: packages/database/src/operator/retire-all-sessions.ts
- Modify: packages/database/src/runtime.ts
- Create: apps/server/src/agents/retire-agent.ts
- Create: apps/server/src/agents/list-agents.ts
- Create: apps/server/src/cli/key-commands.ts
- Modify: apps/server/src/cli/program.ts
- Test: packages/database/tests/cursor-keys.integration.test.ts
- Test: packages/database/tests/agent-retirement.integration.test.ts
- Test: packages/database/tests/agent-list.integration.test.ts
- Test: apps/server/tests/cli/key-commands.test.ts

**Interfaces:**

~~~ts
export type CursorKeyMaintenanceConfig = Readonly<{
  migrationDatabaseUrl: string;
  maintenanceMode: true;
  cursorKeys: CursorKeyConfig;
}>;

export type AgentKeyMaintenanceConfig = Readonly<{
  migrationDatabaseUrl: string;
  maintenanceMode: true;
  currentAgentSessionSigningKey: Secret32;
  nextAgentSessionSigningKey: Secret32;
}>;

export function loadCursorKeyMaintenanceConfig(env: NodeJS.ProcessEnv): CursorKeyMaintenanceConfig;
export function loadAgentKeyMaintenanceConfig(env: NodeJS.ProcessEnv): AgentKeyMaintenanceConfig;

export type CursorKeyConfig = Readonly<{
  current: Readonly<{ kid: CursorKeyId; secret: Secret32 }>;
  grace: Readonly<{ kid: CursorKeyId; secret: Secret32 }> | null;
  gracePeriodMs: number;
}>;

export type CursorClaims =
  | {
      version: 1;
      kind: "delivery";
      projectId: ProjectId;
      agentId: AgentId;
      throughSeq: bigint;
    }
  | {
      version: 1;
      kind: "agent_list";
      projectId: ProjectId;
      agentId: AgentId;
      filtersFingerprint: Digest32;
      afterAgentId: AgentId;
    };

export type CursorPayloadV1 =
  | {
      v: "1";
      kind: "delivery";
      project_id: string;
      agent_id: string;
      through_seq: string;
    }
  | {
      v: "1";
      kind: "agent_list";
      project_id: string;
      agent_id: string;
      filters_sha256: string;
      after_agent_id: string;
    };

export type ParsedCursorEnvelope = Readonly<{
  kid: CursorKeyId;
  payload: CursorPayloadV1;
  mac: Uint8Array;
}>;

export interface CursorCodec {
  parseEnvelope(cursor: string): ParsedCursorEnvelope;
  verify(parsed: ParsedCursorEnvelope, secret: Secret32): CursorClaims;
  issue(claims: CursorClaims, key: { kid: CursorKeyId; secret: Secret32 }): string;
}

export interface CursorKeyRepository {
  ensureInitializedAndCompatible(command: Readonly<{
    configuredCurrent: Readonly<{ kid: CursorKeyId; commitment: Digest32 }>;
    configuredGrace: Readonly<{ kid: CursorKeyId; commitment: Digest32 }> | null;
    signal: AbortSignal;
  }>): Promise<
    "initialized" | "compatible" | "registry_mismatch" | "temporarily_unavailable"
  >;
}

export class CursorRegistryIntegrityFailure extends Error {
  readonly category = "cursor_registry_integrity" as const;
}

export type RotateCursorKeyCommand = Readonly<{
  migrationDatabaseUrl: string;
  newCurrentKid: CursorKeyId;
  newCurrentCommitment: Digest32;
  expectedPreviousKid: CursorKeyId;
  expectedPreviousCommitment: Digest32;
  gracePeriodMs: number;
  signal: AbortSignal;
}>;

export function rotateCursorKey(
  command: RotateCursorKeyCommand,
): Promise<"rotated" | "already_rotated" | "registry_mismatch">;

export type RetireAllSessionsCommand = Readonly<{
  migrationDatabaseUrl: string;
  signal: AbortSignal;
}>;

export function retireAllSessionsForAgentKeyRotation(
  command: RetireAllSessionsCommand,
): Promise<Readonly<{
  retiredAgents: bigint;
  expiredDeliveries: bigint;
}>>;

export type RetireAgentCommand = Readonly<{
  project: PresentedProjectToken;
  caller: PresentedAgentSession;
  lifecycle: AgentLifecyclePolicy;
  signal: AbortSignal;
}>;

export type ListAgentsCommand = Readonly<{
  project: PresentedProjectToken;
  caller: PresentedAgentSession;
  statuses: readonly ("online" | "idle" | "offline")[];
  cursor: string | null;
  limit: number;
  lifecycle: AgentLifecyclePolicy;
  cursorCodec: CursorCodec;
  cursorKeys: CursorKeyConfig;
  signal: AbortSignal;
}>;

export interface AgentLifecycleRepository {
  retireAtomic(command: RetireAgentCommand): Promise<RepositoryOutcome<RetireAgentResult>>;
  listAtomic(command: ListAgentsCommand): Promise<RepositoryOutcome<ListAgentsResult>>;
}
~~~

- [ ] **Step 1: Add failing cursor vectors**

Test strict base64url, domain separation, current and grace key material, invalid signatures, cross-project/agent claims, filter changes, and 512-character pagination-cursor bounds. Test empty, 33-byte, Unicode, whitespace, slash, and control-character key IDs at config, codec, registry, and `--new-kid` boundaries; only branded CursorKeyId reaches persistence or signing. through_seq is a canonical unsigned decimal string and filters_sha256 is canonical base64url for exactly 32 bytes; parse both back to branded bigint/Digest32. Reject JSON bigint, Uint8Array object serialization, leading zeroes, padding, duplicate fields, and unknown fields. MAC comparison is constant-time.

- [ ] **Step 2: Implement the signed cursor envelope**

MAC the canonical wire payload plus version, kind, and kid. Keep the codec pure: it parses envelopes and verifies only against key material explicitly supplied by the locked database operation. It never queries or caches registry state. A retired delivery cursor later maps to CURSOR_KEY_ROTATED; a retired agent-list cursor maps to INVALID_CURSOR because the redelivery recovery contract applies only to deliveries.
Load exactly one current key and at most one complete grace key from protected configuration; never accept a kid without its matching 32-byte secret or duplicate kid/secret material. Export a pure domain-separated `cursorKeyCommitment(kid, secret)` helper matching Task 3 so only commitments cross into database operator/readiness entry points.

- [ ] **Step 3: Add failing retirement tests**

Assert explicit retirement expires outstanding deliveries exactly once, stores retired_at and retirement_delivery_count, does not acknowledge a page, and returns the stored result with already_retired true on an uncertain same-token retry. Every other operation with that token returns AGENT_RETIRED.
After the global agent-key retirement operation, an old registration identifier returns AGENT_RETIRED without adding a row, while a fresh UUIDv4 creates a new session under the new signing key.

- [ ] **Step 4: Implement explicit retirement through the shared coordinator**

Use project -> token -> sorted agents -> delivery states, then persist expiration and the terminal result in one transaction. Pass the required caller signal to the transaction wrapper and check it before expiration/terminal-result mutations. retire does not refresh last_seen_at.

- [ ] **Step 5: Add failing discovery pagination tests**

Use ID-ascending keyset pages. Validate/default `limit` at the tool boundary to an integer 1..25, carry it unchanged in `ListAgentsCommand`, normalize statuses to sorted unique online, idle, offline values, and fingerprint both normalized statuses and limit. Exclude retired agents, derive presence from the one lifecycle_now, fetch `limit + 1`, return exactly at most limit, set has_more only from the extra matching row, and issue the cursor after the last row actually returned. Changing limit or statuses while reusing a cursor returns INVALID_CURSOR. list_agents must not acknowledge messages or refresh presence.

- [ ] **Step 6: Implement listAtomic and cursor-key persistence**

The registry stores only kid, one-way key commitment, current/grace/retired state, activation, grace-expiry, and retirement timestamps. Process composition and every later readiness probe invoke the sole typed `ensureInitializedAndCompatible` entry point with configured current/grace commitments plus a bounded signal combined from readiness timeout and shutdown; there is no permanent process latch. Under one registry transaction it selects and locks every persisted `current` and `grace` row with one `SELECT ... WHERE state IN ('current', 'grace') ORDER BY kid ASC FOR UPDATE`, waits for the complete ordered lock set, then captures a fresh database `cursor_key_now`. It atomically changes an expired grace row to retired before compatibility evaluation, even when no cursor traffic has occurred. It inserts the configured current kid/commitment only when the migrated table is completely empty and returns `initialized`; on any other non-empty state it performs no repair except that deterministic grace-expiry transition. Persisted current kid/commitment must exactly match configured current, and any still-active grace kid/commitment must have the exact configured grace secret-derived commitment. Exact state returns `compatible`; a missing/wrong active grace or any other conflict returns `registry_mismatch`; transient database/migration/lock failure returns `temporarily_unavailable`. A missing/wrong grace configuration keeps `/ready` at 503 for the persisted grace window; removing it is allowed after the row is retired by readiness without requiring an old cursor. Add empty database -> initialize -> restart -> readiness-ready, restart mid-grace with absent/wrong/exact grace config, zero-traffic expiry -> readiness retirement -> restart with grace removed, unavailable -> migrate -> retry, and blocked registry lock -> abort/rollback -> later retry coverage. Task 8 deterministically interleaves readiness with listAtomic during active grace in both acquisition orders and requires bounded completion without a deadlock.

For listAtomic, pass the required caller signal to the transaction wrapper, validate project token and caller lifecycle before parsing a raw list cursor, and check the signal before lifecycle/key-state mutations. Parse only the bounded envelope, then lock the referenced and persisted current key rows in kid order (or only current when no cursor). After those potentially waited locks return, execute a separate `SELECT clock_timestamp()` as `cursor_key_now`; do not reuse the earlier lifecycle timestamp. Lazily transition grace where `grace_expires_at <= cursor_key_now` to retired. Before any MAC verification or signing, compare every locked usable registry row's kid and commitment against the matching configured secret-derived commitment. Then choose the matching protected key material, verify MAC/scope/filter, and recheck that the locked current kid and commitment still equal configuration before issuing the next page cursor. Hold all key-state locks through issuance and commit so rotation cannot race verification/signing. A test waits on the key lock across grace expiry and requires retirement/rejection at the post-wait time. Unknown/future/signature-invalid and retired list cursors return INVALID_CURSOR.

`cursor-registry-verifier.ts` owns one private typed `CursorRegistryMismatch` error used inside list, sync, and registration transactions whenever a locked current/grace kid or commitment conflicts with protected configuration. Throwing it aborts the transaction, so every ACK, issued-high-water, presence, registration, lifecycle, and cursor mutation rolls back. Only after rollback does the repository boundary translate it into the exported detail-free `CursorRegistryIntegrityFailure`; that failure contains no cause, SQL, kid, commitment, configuration value, or arbitrary message, and application services propagate it unchanged. Task 13 is the sole boundary that maps it to the existing fixed retryable `INTERNAL_ERROR` `ToolErrorPayload` and emits the closed `cursor_registry_integrity` internal-failure category. No new public error code or registry detail is exposed. Readiness may still return its internal `registry_mismatch` status because that is not a tool result. Tests are staged by executable surface: Task 8 forces list mismatch and proves full rollback; Task 11 forces sync and registration mismatch and proves full rollback; Task 13 proves the fixed public mapping plus exactly one categorized event; Task 15 proves that logs contain only the closed category and no failure detail.

- [ ] **Step 7: Add explicit key-maintenance commands**

Provide:

~~~text
agentmesh cursor-key rotate --new-kid KID
agentmesh agent-key retire-sessions --confirm-all-projects
~~~

`loadCursorKeyMaintenanceConfig` requires `MIGRATION_DATABASE_URL`, `MAINTENANCE_MODE=true`, the prospective current `CURSOR_CURRENT_KID/KEY`, and the expected old current as `CURSOR_GRACE_KID/KEY`; all pair/grammar/independence rules are exact and it never falls back to runtime/admin configuration. `loadAgentKeyMaintenanceConfig` requires `MIGRATION_DATABASE_URL`, `MAINTENANCE_MODE=true`, `AGENT_SESSION_SIGNING_KEY` as the current key, and a distinct canonical 32-byte `AGENT_SESSION_NEXT_SIGNING_KEY`; missing, malformed, equal, or fallback values fail before any database call. CLI import tests prove key commands can reach only the two typed database operator entry points, not runtime repositories or internal SQL. The runbook drains the one hosted replica before either command.

`apps/server` calls only the typed `rotateCursorKey` and `retireAllSessionsForAgentKeyRotation` operator entry points and never imports a pool/SQL/Drizzle handle. Cursor rotation validates --new-kid against configured current and requires configured grace to name the expected persisted old current. The CLI derives both commitments; no secret crosses into the database operator command. The operator transaction locks registry rows in kid order, verifies the old commitment, changes the old current row to grace with `grace_expires_at = clock_timestamp() + gracePeriodMs`, and inserts the configured new current kid/commitment. A retry that finds exactly that current/grace pair and both commitments returns `already_rotated` without extending the original expiry; every other state returns `registry_mismatch` without mutation. Agent-key maintenance validates current/next material in the CLI, then passes no secret to the database operator. It locks every project by project_id ascending in one operator transaction, then each project's agents and delivery states in the normative order, retires every active session, and expires outstanding deliveries. Its typed result contains only aggregate bigint counts; a retry returns zero new transitions. Only after commit does the operator deploy the exact previously validated `AGENT_SESSION_NEXT_SIGNING_KEY` as `AGENT_SESSION_SIGNING_KEY`, remove the next-key variable, and restart; failure before commit leaves the old runtime key active. Initialization is automatic only for a completely empty registry; rotation never occurs automatically at startup.

- [ ] **Step 8: Run lifecycle and key gates**

Run:

~~~bash
pnpm build
pnpm -r --sort typecheck:local
pnpm --filter @agentmesh/config test
pnpm --filter @agentmesh/protocol test
pnpm exec vitest run packages/database/tests/cursor-keys.integration.test.ts packages/database/tests/agent-retirement.integration.test.ts packages/database/tests/agent-list.integration.test.ts apps/server/tests/cli/key-commands.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: PASS, including registry persistence across a complete runtime recreation.

- [ ] **Step 9: Commit lifecycle completion**

~~~bash
git add packages/config packages/protocol packages/database apps/server
git commit -m "feat: add agent retirement discovery and key rotation"
~~~

---

### Task 9: Implement atomic direct messaging and send idempotency

**Files:**
- Create: packages/database/src/repositories/messages/types.ts
- Create: packages/database/src/repositories/messages/quota-policy.ts
- Create: packages/database/src/repositories/messages/reply-visibility.ts
- Create: packages/database/src/repositories/messages/send-atomic.ts
- Modify: packages/database/src/runtime.ts
- Create: apps/server/src/messages/send-message.ts
- Create: apps/server/src/messages/index.ts
- Test: packages/database/tests/send-direct.integration.test.ts
- Test: packages/database/tests/send-idempotency.integration.test.ts
- Test: packages/database/tests/reply-visibility.integration.test.ts
- Test: apps/server/tests/messages/send-message.test.ts

**Interfaces:**

~~~ts
export type ProjectQuotaLimits = Readonly<{
  messageCount: bigint;
  deliveryCount: bigint;
  logicalPayloadBytes: bigint;
  broadcastFanout: number;
}>;

export type ProjectQuotaCounters = Readonly<{
  messageCount: bigint;
  deliveryCount: bigint;
  logicalPayloadBytes: bigint;
}>;

export function assertQuotaAvailable(
  current: ProjectQuotaCounters,
  delta: ProjectQuotaCounters,
  limits: ProjectQuotaLimits,
): void;

export type SendMessageCommand = Readonly<{
  project: PresentedProjectToken;
  caller: PresentedAgentSession;
  prepared: PreparedSendPayload;
  idempotencyKey: string;
  proposedMessageId: MessageId;
  lifecycle: AgentLifecyclePolicy;
  quotas: ProjectQuotaLimits;
  signal: AbortSignal;
}>;

export type AtomicSendResult = Readonly<{
  messageId: MessageId;
  projectSeq: bigint;
  createdAt: Date;
  deliveriesCreated: number;
  recipientStatus?: "online" | "idle" | "offline";
  deduplicated: boolean;
}>;

export type SendAttemptOutcome =
  | RepositoryOutcome<AtomicSendResult>
  | { ok: false; reason: "public_id_collision" };

export interface MessageRepository {
  sendAtomic(command: SendMessageCommand): Promise<SendAttemptOutcome>;
}
~~~

- [ ] **Step 1: Add the failing direct-send happy-path test**

Create two agents in one project, make the recipient offline but non-retired, and assert one send creates one immutable message, one delivery, one idempotency result, project_seq 1, and recipient_status offline.

- [ ] **Step 2: Add failing idempotency tests**

The same sender/key/fingerprint must return the stored message ID, sequence, timestamp, delivery count, and original recipient status with deduplicated true. A changed fingerprint returns IDEMPOTENCY_CONFLICT. A deduplicated retry after the recipient retires still returns the stored original success.

- [ ] **Step 3: Add the reply-target oracle test**

Create missing, cross-project, and same-project-invisible reply IDs. Require byte-identical error JSON with code REPLY_TARGET_INVALID, message The reply target is not available., and retryable false. The query must combine existence and sender visibility in one project-scoped predicate.

Run:

~~~bash
pnpm exec vitest run packages/database/tests/send-direct.integration.test.ts packages/database/tests/send-idempotency.integration.test.ts packages/database/tests/reply-visibility.integration.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: FAIL because sendAtomic is absent.

- [ ] **Step 4: Implement the locked send skeleton**

Pass `command.signal` into the Task 4 transaction wrapper. Within that one READ COMMITTED transaction:

~~~text
project row
presented project-token row
clock_timestamp()
sorted lifecycle agent union including sender and direct target
matching delivery-state rows
lazy retirement
sender session digest revalidation
idempotency row
reply and target predicates
message and delivery children
~~~

Do not touch last_seen_at. All predicates include project_id.

- [ ] **Step 5: Implement the locked idempotency lookup and child savepoint**

Look for a committed result only after all parent lifecycle locks and reach `after_idempotency_lookup`. Return it immediately for an equal fingerprint; return IDEMPOTENCY_CONFLICT for a different fingerprint. For an absent key, the already-held project lock is the only logical reservation—do not insert a placeholder row. Open the send child savepoint before subsequent validation/mutations. If validation fails, roll back that savepoint and commit any lifecycle retirement already required by the outer transaction.

- [ ] **Step 6: Apply target, reply, wire, and direct-quota validation before counters**

Reject missing or retired targets with AGENT_NOT_FOUND. Accept offline non-retired targets. Call assertSingleMessageWireFit(command.prepared), which substitutes the conservative envelope internally, then apply deltas of one message, one delivery, and one canonical logical-payload byte count against the locked counters before changing a project counter or sequence.

- [ ] **Step 7: Insert the direct message atomically**

After quota availability is confirmed, increment last_message_seq and all three counters, insert the message and direct delivery, then insert exactly one complete immutable idempotency row containing its fingerprint and full success result. Release the savepoint and commit. The project lock serializes same-project lookup through this final insert; message_idempotency remains SELECT/INSERT-only and has no nullable/in-progress state. Catch only the named message public-ID uniqueness constraint: roll back the complete send child savepoint including counters/sequence/message/deliveries and return public_id_collision. The application service supplies a new proposedMessageId and retries the same prepared payload/idempotency key at most three times; exhaustion returns the fixed INTERNAL_ERROR. Add deterministic one-collision success and three-collision exhaustion tests proving no losing result or partial state.

- [ ] **Step 8: Add rollback injection tests**

Use the shared TransactionProbe stages after_idempotency_lookup, after_counter_update, after_message_insert, and after_delivery_insert. Expected business failures roll back the send child savepoint and commit already-required lifecycle maintenance. An unexpected database/probe failure aborts the complete outer transaction, including that maintenance. After each case, independently recount messages, deliveries, idempotency rows, sequence, counters, and retired rows against the expected class; no partial send state may survive.

- [ ] **Step 9: Run direct-message gates**

Run:

~~~bash
pnpm --filter @agentmesh/database typecheck
pnpm --filter @agentmesh/server typecheck
pnpm exec vitest run packages/database/tests/send-direct.integration.test.ts packages/database/tests/send-idempotency.integration.test.ts packages/database/tests/reply-visibility.integration.test.ts apps/server/tests/messages/send-message.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: PASS.

- [ ] **Step 10: Commit direct messaging**

~~~bash
git add packages/database apps/server
git commit -m "feat: add atomic direct messaging"
~~~

---

### Task 10: Add broadcasts and persisted project quotas

**Files:**
- Create: packages/config/src/quota-config.ts
- Modify: packages/config/src/server-config.ts
- Modify: packages/config/src/index.ts
- Modify: packages/config/tests/config.test.ts
- Modify: packages/database/src/repositories/messages/quota-policy.ts
- Create: packages/database/src/repositories/messages/select-recipients.ts
- Modify: packages/database/src/repositories/messages/send-atomic.ts
- Test: packages/database/tests/send-broadcast.integration.test.ts
- Test: packages/database/tests/send-quotas.integration.test.ts
- Test: packages/database/tests/quota-recount.integration.test.ts

**Extends the Task 9 interfaces:**

~~~ts
export type ProjectQuotaLimits = Readonly<{
  messageCount: bigint;
  deliveryCount: bigint;
  logicalPayloadBytes: bigint;
  broadcastFanout: number;
}>;

export type ProjectQuotaCounters = Readonly<{
  messageCount: bigint;
  deliveryCount: bigint;
  logicalPayloadBytes: bigint;
}>;

export function assertQuotaAvailable(
  current: ProjectQuotaCounters,
  delta: ProjectQuotaCounters,
  limits: ProjectQuotaLimits,
): void;
~~~

Hosted defaults are 50,000 messages, 500,000 deliveries, 512 MiB logical payload, and the configured fan-out default 100. Counts and byte limits parse as positive safe integers and become bigint before repository use.

- [ ] **Step 1: Add failing quota-config tests**

Cover exact hosted defaults, invalid zero/negative/fractional/unsafe values, and prove immutable wire limits are not configurable through quota environment variables.

- [ ] **Step 2: Add failing broadcast membership tests**

Create online, idle, offline, retired, and sender agents. Assert broadcasts include only online/idle non-retired agents excluding the sender. A zero-recipient broadcast succeeds with one message, no deliveries, and a stable idempotency result.

- [ ] **Step 3: Add failing fan-out boundary tests**

At exactly BROADCAST_FANOUT_LIMIT, all recipients receive a delivery. With one additional eligible agent, the complete send fails with PROJECT_QUOTA_EXCEEDED and creates no message, sequence, counter, idempotency, or delivery state.

Run:

~~~bash
pnpm exec vitest run packages/config/tests/config.test.ts packages/database/tests/send-broadcast.integration.test.ts packages/database/tests/send-quotas.integration.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: FAIL on missing quota configuration and broadcast selector.

- [ ] **Step 4: Implement recipient selection under the project lock**

While holding the project lock, extend the lifecycle union to every potentially eligible broadcast recipient plus overdue rows, lock all of those agents by public ID and delivery states in the same order, and recheck presence at the captured lifecycle_now. Select eligible agents in ascending public-ID order with LIMIT fanoutLimit + 1. Never truncate a broadcast or take a second application-time snapshot.

- [ ] **Step 5: Implement quota deltas from the canonical payload**

For every new message use:

~~~text
message_count delta = 1
delivery_count delta = complete recipient count
logical_payload_bytes delta = prepared canonical UTF-8 byte length
~~~

Count logical bytes once, regardless of fan-out. Compare locked current + delta <= limit before sequence allocation or counter mutation.

- [ ] **Step 6: Add exact-boundary and recount tests**

For each persisted quota, assert exact remaining capacity commits and one byte/row beyond fails. Independently recount messages, deliveries, and SUM(messages.logical_payload_bytes) after every case. A deduplicated retry changes no counter.

- [ ] **Step 7: Implement atomic multi-row broadcast insertion**

Reuse the Task 9 send transaction and child savepoint. Insert all delivery rows and one stored result or none. A zero-recipient broadcast still increments sequence, message count, and logical bytes.

- [ ] **Step 8: Run broadcast and quota gates**

Run:

~~~bash
pnpm --filter @agentmesh/config typecheck
pnpm --filter @agentmesh/database typecheck
pnpm exec vitest run packages/config/tests/config.test.ts packages/database/tests/send-broadcast.integration.test.ts packages/database/tests/send-quotas.integration.test.ts packages/database/tests/quota-recount.integration.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: PASS with counters equal to independent recounts.

- [ ] **Step 9: Commit broadcast delivery and quotas**

~~~bash
git add packages/config packages/database
git commit -m "feat: add broadcast delivery and project quotas"
~~~

---

### Task 11: Implement one-transaction sync, ACK, and durable redelivery

**Files:**
- Modify: packages/database/src/repositories/agents/register.ts
- Create: packages/database/src/repositories/messages/sync-agent-deliveries.ts
- Create: packages/database/src/repositories/messages/delivery-ack.ts
- Modify: packages/database/src/repositories/cursor-keys.ts
- Modify: packages/database/src/runtime.ts
- Create: apps/server/src/messages/sync-agent-deliveries.ts
- Modify: apps/server/src/agents/register-agent.ts
- Create: apps/server/src/agents/sync-agent.ts
- Test: packages/database/tests/registration-sync.integration.test.ts
- Test: packages/database/tests/delivery-sync.integration.test.ts
- Test: packages/database/tests/delivery-restart.integration.test.ts
- Test: packages/database/tests/cursor-rotation-recovery.integration.test.ts
- Test: apps/server/tests/messages/sync-agent-deliveries.test.ts
- Test: apps/server/tests/agents/register-sync.test.ts

**Interfaces:**

~~~ts
export type SyncAgentDeliveriesCommand = Readonly<{
  project: PresentedProjectToken;
  caller: PresentedAgentSession;
  ackCursor: string | null;
  lifecycle: AgentLifecyclePolicy;
  cursorCodec: CursorCodec;
  cursorKeys: CursorKeyConfig;
  signal: AbortSignal;
}>;

export interface AgentSyncRepository {
  registerAndSyncAtomic(
    command: RegisterAgentCommand & Readonly<{
      cursorCodec: CursorCodec;
      cursorKeys: CursorKeyConfig;
    }>,
  ): Promise<
    | RepositoryOutcome<
        Omit<AgentMeshRegistrationOutput, "agent_session_token">
      >
    | { ok: false; reason: "public_id_collision" }
  >;
  syncAgentAndDeliveriesAtomic(
    command: SyncAgentDeliveriesCommand,
  ): Promise<RepositoryOutcome<AgentMeshSyncOutput>>;
}
~~~

This is one repository call and one transaction. It passes the required caller signal to the Task 4 wrapper and checks it before ACK, issued high-water, delivery-status, lifecycle, and presence mutations. There is no separate touchPresence followed by fetchDeliveries path.

- [ ] **Step 1: Add the failing lost-response redelivery test**

Send one direct message, call sync without ACK, discard the result, and call again without ACK. Require the same message ID, project sequence, and earliest page. Neither call may mark the delivery acknowledged.

- [ ] **Step 2: Add failing ACK-state tests**

Cover valid advancement, stale no-op, future/unissued, cross-project, cross-agent, forged, retired-session, and malformed cursors. Caller authentication/lazy retirement takes precedence: an invalid cursor plus invalid agent returns AGENT_AUTH_INVALID; an invalid cursor plus a caller retired by this sweep returns AGENT_RETIRED. Cursor failures after a valid caller return INVALID_CURSOR or CURSOR_KEY_ROTATED and leave ACK/issued/delivery/last_seen state unchanged while already-required retirement of other due agents remains committed.

- [ ] **Step 3: Add failing page-boundary tests**

Create 26 small messages plus one byte-heavy page. Assert order by project_seq, maximum 25, byte-budget stopping, exact has_more, issued_through_seq through only the last included message, and an empty-page cursor at the acknowledged high-water mark.

Run:

~~~bash
pnpm exec vitest run packages/database/tests/delivery-sync.integration.test.ts apps/server/tests/messages/sync-agent-deliveries.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: FAIL because syncAgentAndDeliveriesAtomic is absent.

- [ ] **Step 4: Parse and verify the cursor only after locked caller validation**

Pass the raw bounded ackCursor into syncAgentAndDeliveriesAtomic. After project/token locks, lifecycle_now, sorted agent/delivery-state locks, lazy retirement, and caller digest validation, parse its envelope. Lock the referenced and current cursor-key registry rows in kid order, then capture a distinct `cursor_key_now` with a separate `SELECT clock_timestamp()` after those locks return. Lazily transition grace where `grace_expires_at <= cursor_key_now`, use the shared Task 8 verifier to compare every usable locked kid/commitment with protected configuration, choose matching protected key material, verify MAC, then validate project/agent scope. A commitment/config mismatch throws the private rollback-only `CursorRegistryMismatch` and maps to retryable INTERNAL_ERROR; known retired key IDs without secrets return CURSOR_KEY_ROTATED; unknown/future IDs and invalid signatures return INVALID_CURSOR. Hold key locks until commit. Add a waited-key-lock test that crosses grace expiry and rejects the old key using post-wait time.

- [ ] **Step 5: Implement the locked synchronization transaction**

Use the common lock sequence, lazily retire due sessions, and reject a caller retired by that sweep before cursor handling. After the locked verification above, require throughSeq <= issued_through_seq, advance ACK monotonically, mark only pending deliveries through that sequence acknowledged, and reach after_ack_update. Cursor business errors occur before ACK mutation.

- [ ] **Step 6: Pack and issue the next page inside the same transaction**

Fetch the earliest 26 pending rows, pass them to packSyncPage, derive active_agents within the remaining result budget, recheck the locked durable current kid and commitment through the shared verifier, issue next_cursor, advance issued_through_seq only through the last returned message, and reach after_issued_update. A mismatch rolls back the entire sync. Refresh last_seen_at only after the whole sync succeeds.

- [ ] **Step 7: Integrate registration with the atomic sync result**

Refactor Task 7 registration into `registerAndSyncAtomic` rather than composing two transactions. In the same project/token/lifecycle transaction, resolve or create the registration, then reuse the Task 11 cursor-key/page assembler to return the exact token-free `AgentMeshRegistrationOutput`: project, authenticated agent profile/status, earliest pending messages, next cursor, active agents, both has_more flags, and server_time. A newly created agent normally has an empty page; an idempotent UUID retry may have messages committed after an earlier lost registration response and must receive them without ACK. The shared verifier checks the locked current/grace commitments before any cursor issuance; mismatch throws inside the transaction and rolls back even a newly inserted registration. Hold key locks through cursor issuance and refresh presence only on complete success. Force both sync and registration mismatches in Task 11 integration tests and prove ACK, issued-high-water, presence, lifecycle, delivery, and newly inserted registration state all roll back before the detail-free failure crosses the repository boundary.

`apps/server/src/agents/register-agent.ts` performs the existing three public-ID attempts against this one method, derives the reproducible plaintext session token only from the committed agent ID plus raw UUID, merges it into the dedicated `agent_session_token` output field, and never starts a second sync transaction. Test new registration, same-UUID lost response, messages arriving before retry, byte/result limits, cursor issuance, token reproducibility, and a forced page-assembly failure rolling back the new agent/delivery-state row.

- [ ] **Step 8: Prove restart durability**

Recreate the database runtime and server services between send, first delivery, and ACK. Require the page, key registry, issued high-water, and ACK state to survive without process-local storage.

- [ ] **Step 9: Prove K1 to K2 recovery**

Accept K1 during K2 grace. Retire K1, remove its secret, recreate the runtime, and present the old cursor: return CURSOR_KEY_ROTATED without ACK advancement. Retry without ACK, redeliver under K2, then ACK K2. An ACK committed before rotation is not redelivered. Deterministically interleave sync ACK/page issuance with key rotation in both lock orders; registry locks serialize them and every emitted cursor names the key current at commit. Also deterministically interleave readiness with sync during active grace in both acquisition orders; both operations must complete without a deadlock and observe one serialized registry state.

- [ ] **Step 10: Run delivery gates**

Run:

~~~bash
pnpm --filter @agentmesh/database typecheck
pnpm --filter @agentmesh/server typecheck
pnpm exec vitest run packages/database/tests/registration-sync.integration.test.ts packages/database/tests/delivery-sync.integration.test.ts packages/database/tests/delivery-restart.integration.test.ts packages/database/tests/cursor-rotation-recovery.integration.test.ts apps/server/tests/agents/register-sync.test.ts apps/server/tests/messages/sync-agent-deliveries.test.ts --hookTimeout=60000 --testTimeout=60000
~~~

Expected: PASS.

- [ ] **Step 11: Commit durable synchronization**

~~~bash
git add packages/database apps/server
git commit -m "feat: add durable delivery sync and acknowledgement"
~~~

---

### Task 12: Close concurrency, rollback, and tenant-isolation gates

**Files:**
- Modify: packages/database/src/testing/transaction-probe.ts
- Modify: packages/database/tests/support/controlled-transaction-probe.ts
- Modify: packages/database/src/repositories/projects/auth.ts
- Modify: packages/database/src/repositories/agents/retire.ts
- Modify: packages/database/src/repositories/cursor-keys.ts
- Modify: packages/database/src/repositories/messages/send-atomic.ts
- Modify: packages/database/src/repositories/messages/sync-agent-deliveries.ts
- Test: packages/database/tests/send-sequence.concurrent.test.ts
- Test: packages/database/tests/send-idempotency.concurrent.test.ts
- Test: packages/database/tests/send-quota.concurrent.test.ts
- Test: packages/database/tests/send-sync.concurrent.test.ts
- Test: packages/database/tests/send-retire.concurrent.test.ts
- Test: packages/database/tests/sync-ack.concurrent.test.ts
- Test: packages/database/tests/broadcast-cutoff.concurrent.test.ts
- Test: packages/database/tests/token-revocation.concurrent.test.ts
- Test: packages/database/tests/repository-tenant-matrix.integration.test.ts
- Test: packages/database/tests/transaction-rollback.integration.test.ts
- Test: packages/database/tests/request-abort.integration.test.ts

This task consumes the shared `TransactionProbe` and complete stage union introduced in Task 7; it must not define a second probe or a competing stage vocabulary. Production continues to use the no-op implementation. Probe context contains no credentials, cursor, profile, message, metadata, or raw arguments.

- [ ] **Step 1: Build a bounded deterministic test probe**

Extend the Task 7 test probe with `reached(stage)`, `release(stage)`, and `fail(stage)`. Capture each transaction's PostgreSQL backend PID. Add a helper that queries `pg_stat_activity` and `pg_locks` through a separate observer connection and resolves only when the expected waiter is actually blocked on the expected row lock. Every probe and lock-observation wait has an explicit timeout of at most five seconds; a timeout fails with the operation ID and stage rather than retrying.

- [ ] **Step 2: Prove commit-safe project sequence**

Pause T1 after its project lock, start T2, wait until the observer proves T2 is blocked on that same project row lock, then release T1. Require committed sequences 1 then 2 and forbid a lower sequence from committing after a higher sequence. Apply the same observed-wait discipline to every test that claims serialization rather than merely overlapping promises.

- [ ] **Step 3: Prove same-key serialization**

Run same-key/equal-fingerprint sends concurrently: exactly one message, delivery, and idempotency row; one result is deduplicated false and the other true. Repeat with different fingerprints: one commit and one IDEMPOTENCY_CONFLICT.

- [ ] **Step 4: Prove all three quota races**

For message count, delivery count, and logical bytes, leave capacity for exactly one of two different-key sends. Require one commit, one PROJECT_QUOTA_EXCEEDED, one consumed sequence, no losing idempotency row, and counters equal to an independent recount.

- [ ] **Step 5: Prove send/sync and send/retire lock compatibility**

Run each pair twice, first with operation A holding the project lock and then B. Require bounded completion without deadlock and the documented winner state: a delivery is either retrievable or terminally expired, never skipped or half-created.

- [ ] **Step 6: Prove concurrent ACK monotonicity**

Interleave two sync calls with stale and newer issued cursors. acked_through_seq never moves backward or past issued_through_seq; duplicate pages are allowed, skipped pages are not.

- [ ] **Step 7: Prove broadcast commit-order membership**

Interleave registration/sync commits around a waiting broadcast. An online/idle change committed before the broadcast obtains the project lock affects membership; one committed afterward does not.

- [ ] **Step 8: Prove token-revocation revalidation**

Pause a tool transaction after read-only authentication but before the project lock. Revoke under project -> token locks, release the tool transaction, and require locked revalidation to fail without any agent/message/delivery/idempotency mutation. Run the inverse order and require the already locked operation to commit before revocation.

- [ ] **Step 9: Run the exported repository tenant matrix**

For every exported repository read, insert, update, and delete accepting an object ID, supply a valid Project A principal with the corresponding Project B ID. Require only the repository's bounded not-found or invalid domain outcome, never Project B data and never a raw SQLSTATE or driver error. Include agents, messages, replies, cursors, deliveries, idempotency rows, tokens, and list pages. Direct SQL tests in Task 3 may assert SQLSTATE 23503 to prove the schema boundary; exported repository tests may not.

- [ ] **Step 10: Run forced rollback at every mutable stage**

Inject classified send business failures after the idempotency lookup/savepoint, message insert, and delivery insert. Require the send child savepoint to roll back while required lazy lifecycle maintenance that preceded it commits. Separately inject an unexpected outer-transaction failure at every mutable send stage and require the entire transaction, including lifecycle maintenance, to roll back. For sync, inject failures after `after_ack_update` and `after_issued_update`; require ACK, issued high-water, presence refresh, and lifecycle maintenance all to roll back together. Abort the exact signal before BEGIN, while waiting for the project row, during a long query, immediately before each mutable probe stage, and at the pre-commit gate for register/list/retire/send/sync. Require bounded cancellation, full rollback, no later mutation, and either a healthy reused connection or a deliberately destroyed/replaced one. Then abort after COMMIT starts and require the documented uncertain-outcome retry to return/derive the same committed state without duplication or skipped delivery. Unclassified PostgreSQL errors surface only as DATABASE_UNAVAILABLE or INTERNAL_ERROR.

- [ ] **Step 11: Run the full PostgreSQL correctness gate**

Run:

~~~bash
for run in 1 2 3; do
  pnpm exec vitest run packages/database/tests --hookTimeout=60000 --testTimeout=60000
done
pnpm --filter @agentmesh/database typecheck
~~~

Expected: PASS in all three explicitly executed runs with no deadlock, flake retry, or mock database.

- [ ] **Step 12: Commit concurrency proof**

~~~bash
git add packages/database
git commit -m "test: prove AgentMesh transaction invariants"
~~~

---

### Task 13: Expose exactly three tools through the MCP v2 per-request factory

**Files:**
- Modify: apps/server/package.json
- Create: apps/server/src/mcp/types.ts
- Create: apps/server/src/mcp/instructions.ts
- Create: apps/server/src/mcp/error-boundary.ts
- Create: apps/server/src/mcp/tools/sync.ts
- Create: apps/server/src/mcp/tools/send.ts
- Create: apps/server/src/mcp/tools/list-agents.ts
- Create: apps/server/src/mcp/create-server.ts
- Create: apps/server/src/mcp/create-handler.ts
- Create: apps/server/src/mcp/index.ts
- Test: apps/server/tests/mcp/tools.contract.test.ts
- Test: apps/server/tests/mcp/errors.contract.test.ts
- Test: apps/server/tests/mcp/per-request-factory.test.ts

**Interfaces:**

~~~ts
export type ProjectRequestPrincipal = Readonly<{
  project: ProjectPrincipal;
  requestId: string;
  signal: AbortSignal;
}>;

export interface AgentMeshMcpUseCases {
  register(principal: ProjectRequestPrincipal, input: RegisterAgentInput): Promise<AgentMeshSyncOutput>;
  sync(principal: ProjectRequestPrincipal, input: ContinueSyncInput): Promise<AgentMeshSyncOutput>;
  retire(principal: ProjectRequestPrincipal, input: RetireAgentInput): Promise<RetireAgentResult>;
  send(principal: ProjectRequestPrincipal, input: AgentMeshSendInput): Promise<AgentMeshSendOutput>;
  listAgents(principal: ProjectRequestPrincipal, input: AgentMeshListAgentsInput): Promise<AgentMeshListAgentsOutput>;
}

export type InternalFailureCategory =
  | "database"
  | "timeout"
  | "cursor_registry_integrity"
  | "unexpected";

export interface McpEventSink {
  toolCompleted(event: {
    tool: "agentmesh_sync" | "agentmesh_send" | "agentmesh_list_agents";
    resultCode: ToolResultCode;
    durationMs: number;
  }): void;
  internalFailure(category: InternalFailureCategory): void;
}

export interface AgentMeshMcpDependencies {
  readonly useCases: AgentMeshMcpUseCases;
  readonly events: McpEventSink;
}

export function createAgentMeshMcpServer(
  deps: AgentMeshMcpDependencies,
  principal: ProjectRequestPrincipal,
): McpServer;

export function createAgentMeshMcpHandler(
  deps: AgentMeshMcpDependencies,
): ReturnType<typeof createMcpHandler>;
~~~

- [ ] **Step 1: Install the current split MCP server package**

Run:

~~~bash
pnpm --filter @agentmesh/server add --save-exact @modelcontextprotocol/server@2.0.0
~~~

Do not import @modelcontextprotocol/sdk, @modelcontextprotocol/core-internal, or v1 transport classes.

- [ ] **Step 2: Add the failing tool-discovery contract**

Build an in-process handler and assert tools/list exposes only:

~~~text
agentmesh_sync
agentmesh_send
agentmesh_list_agents
~~~

Assert each advertised input/output schema is strict, bounded, and derived from the Task 5 Zod v4 schema. No prompts, resources, subscriptions, task board, execution, or push tool is registered.

- [ ] **Step 3: Add failing exact-result tests**

For every success shape, require TextContent.text to be byte-identical to JSON.stringify(structuredContent). For every stable business error, require isError true, one TextContent block, and no structuredContent. Import and test the single `buildSuccessToolResult` / `buildErrorToolResult` serializer from `@agentmesh/protocol`; the server must not grow a second result serializer.

- [ ] **Step 4: Implement the three tool adapters**

Register through McpServer.registerTool with the complete Zod object as inputSchema and outputSchema. Each adapter returns the shared protocol serializer result directly and contains no local JSON.stringify path. Every application service forwards `principal.signal` unchanged into its repository command; a contract test passes a sentinel AbortSignal and asserts object identity at the repository boundary. The sync adapter dispatches register, sync, or retire after the already validated mode refinement. It never trusts a caller-provided sender ID.

- [ ] **Step 5: Implement the bounded error boundary**

Pass through known ToolErrorPayload values. Map temporary PostgreSQL unavailability to DATABASE_UNAVAILABLE with retryable true. A project token that became invalid after the read-only HTTP lookup maps for that already-dispatched call to the fixed INTERNAL_ERROR payload with retryable true; its next HTTP request is rejected with the ordinary 401 challenge. Recognize only the exported `CursorRegistryIntegrityFailure`, emit exactly one `internalFailure("cursor_registry_integrity")` event, and map it to the fixed retryable INTERNAL_ERROR payload without logging or serializing the error object. Map all other unknown failures to the fixed INTERNAL_ERROR payload; never use arbitrary error messages, stacks, SQL fields, or raw arguments.

- [ ] **Step 6: Build the per-request handler**

Use:

~~~ts
createMcpHandler(
  ({ authInfo }) =>
    createAgentMeshMcpServer(deps, requireProjectPrincipal(authInfo)),
  {
    legacy: "stateless",
    responseMode: "json",
  },
);
~~~

The factory creates a fresh McpServer for every request. Pools, immutable config, repositories, metrics, and event sinks are process-scoped injected dependencies. No protocol session or process-local delivery state exists.

- [ ] **Step 7: Add per-request isolation tests**

Call two requests with different principals and assert two McpServer instances, no leaked principal or handler state, and repository calls scoped to the correct project. Task 14 owns HTTP/shutdown abort wiring and tests it through both transport eras.

- [ ] **Step 8: Run MCP factory gates**

Run:

~~~bash
pnpm --filter @agentmesh/server typecheck
pnpm exec vitest run apps/server/tests/mcp/tools.contract.test.ts apps/server/tests/mcp/errors.contract.test.ts apps/server/tests/mcp/per-request-factory.test.ts
~~~

Expected: PASS with exactly three tools and lossless success text.

- [ ] **Step 9: Commit the MCP surface**

~~~bash
git add apps/server pnpm-lock.yaml
git commit -m "feat: expose AgentMesh MCP tools"
~~~

---

### Task 14: Secure the Fastify HTTP boundary and pass a non-secret principal

**Files:**
- Create: packages/config/src/http-config.ts
- Modify: packages/config/src/server-config.ts
- Modify: packages/config/src/index.ts
- Modify: packages/config/tests/config.test.ts
- Modify: apps/server/package.json
- Create: apps/server/src/http/types.ts
- Create: apps/server/src/http/create-app.ts
- Create: apps/server/src/http/mcp-route.ts
- Create: apps/server/src/http/project-auth.ts
- Create: apps/server/src/http/auth-info.ts
- Create: apps/server/src/http/json-rpc-id.ts
- Create: apps/server/src/http/http-errors.ts
- Create: apps/server/src/http/concurrency-gate.ts
- Create: apps/server/src/http/token-bucket.ts
- Create: apps/server/src/http/rate-limits.ts
- Create: apps/server/src/http/request-signal.ts
- Create: apps/server/src/http/bounded-mcp-handler.ts
- Create: apps/server/src/http/shutdown.ts
- Create: apps/server/src/app.ts
- Create: apps/server/src/index.ts
- Modify: apps/server/src/main.ts
- Modify: apps/server/src/cli/program.ts
- Test: apps/server/tests/http/security.test.ts
- Test: apps/server/tests/http/auth.test.ts
- Test: apps/server/tests/http/limits.test.ts
- Test: apps/server/tests/http/response-limit.test.ts
- Test: apps/server/tests/http/request-id.test.ts
- Test: apps/server/tests/http/revocation-race.test.ts
- Test: apps/server/tests/http/shutdown.test.ts

**Interfaces:**

~~~ts
export type HttpConfig = Readonly<{
  host: string;
  port: number;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  trustedProxyCidrs: readonly string[];
  operatorAllowedCidrs: readonly string[];
  bodyLimitBytes: 65_536;
  requestTimeoutMs: number;
  handlerTimeoutMs: number;
  maxInflightRequests: number;
  rateLimitState: Readonly<{
    idleTtlMs: number;
    maxEntries: number;
  }>;
  rateLimits: Readonly<{
    preAuthPerMinute: number;
    projectPerMinute: number;
    projectBurst: number;
    agentPerMinute: number;
  }>;
}>;

export interface TokenBucket {
  consume(key: string, nowMs: number):
    | { allowed: true }
    | { allowed: false; retryAfterSeconds: number };
}

export const PROJECT_REQUEST_PRINCIPAL: unique symbol;

export function buildSafeAuthInfo(
  principal: ProjectRequestPrincipal,
): AuthInfo;

export function withBoundedResponseBody(
  handler: ReturnType<typeof createMcpHandler>,
  limitBytes: number,
): ReturnType<typeof createMcpHandler>;
~~~

- [ ] **Step 1: Install the exact Fastify and MCP adapters**

Run:

~~~bash
pnpm --filter @agentmesh/server add --save-exact fastify@5.12.1 @modelcontextprotocol/node@2.0.0 @modelcontextprotocol/fastify@2.0.0
~~~

- [ ] **Step 2: Add failing HTTP-config tests**

Reject wildcard trust proxies, empty public host allowlists when binding all interfaces, invalid CIDRs, browser-origin wildcards, port/range errors, and maxInflightRequests outside 1..10,000. bodyLimitBytes remains the immutable 64 KiB protocol constant. Request and handler timeout default to 30 seconds, must be equal, and are configurable from 1 to 120 seconds; Task 1 database connection timeout must not exceed them. Rate defaults are pre-auth 120/minute, project 600/minute with burst 100, and agent 120/minute; each configurable rate must be a positive safe integer and project burst cannot exceed its per-minute rate. Rate-limit state defaults to a ten-minute idle TTL and 100,000 total live entries; validate a 1..60 minute TTL and 1,000..1,000,000 entries.

Every required bind-address and security-allowlist input introduced by this task is a fatal bootstrap input when missing or malformed; fields explicitly documented as empty-by-default remain valid when empty.

- [ ] **Step 3: Add failing Host/Origin and body tests**

Require an invalid Host or present disallowed Origin to return 403 before token lookup. An absent Origin passes. A parsed body of 64 KiB passes and 64 KiB plus one byte returns 413 before MCP dispatch.

- [ ] **Step 4: Build Fastify with explicit server controls**

Create Fastify directly so all server options are supplied:

~~~ts
Fastify({
  bodyLimit: PROTOCOL_LIMITS.requestBodyBytes,
  requestTimeout: config.requestTimeoutMs,
  handlerTimeout: config.handlerTimeoutMs,
  trustProxy: config.trustedProxyCidrs,
  requestIdHeader: false,
  genReqId: () => randomUUID(),
  disableRequestLogging: true,
  logger: false,
});
~~~

Mount the official @modelcontextprotocol/fastify hostHeaderValidation and originValidation hooks with the configured hostname allowlists.
Add the agentmesh server subcommand to the existing binary; it loads only ServerConfig and composes process-scoped dependencies. Composition wires only Task 8 `ensureInitializedAndCompatible` for the initial and every later readiness probe: initialize only a completely empty table, require exact current and active-grace commitments on restart, retire elapsed grace with post-lock database time, leave any other non-empty mismatch untouched, and classify transient database/migration failure for a later readiness retry rather than crashing the liveness-only process. Task 15 replaces logger false with the safe Pino instance.

- [ ] **Step 5: Implement uniform bearer authentication**

Parse exactly one Bearer credential. Missing, malformed, unknown, expired, and revoked credentials return byte-identical 401 responses with:

~~~http
WWW-Authenticate: Bearer realm="agentmesh"
~~~

Database failure during authentication returns 503. Never include a token, digest, or reason-specific detail.

- [ ] **Step 6: Pass only a safe AuthInfo object to the Node adapter**

At the first hook create exactly one `request.operationSignal = AbortSignal.any([request.signal, shutdownSignal])`; Fastify aborts `request.signal` on client disconnect or `handlerTimeout`. Pass that same object to read-only authentication and later repository commands. Build the complete `ProjectRequestPrincipal`: project comes from read-only authentication, requestId is `request.id`, and signal is `request.operationSignal`. Attach that full principal under a unique non-enumerable symbol on AuthInfo. Set ordinary AuthInfo fields to bounded constants only (`token: "agentmesh-redacted"`, `clientId: "agentmesh-http"`, and an empty scopes array); never forward the raw bearer token, its digest, or a project-derived credential. The MCP factory retrieves the symbol and rejects its absence.

Mount once:

~~~ts
const boundedHandler = withBoundedResponseBody(
  mcpHandler,
  PROTOCOL_LIMITS.jsonRpcResponseBytes,
);
const nodeHandler = toNodeHandler(boundedHandler);
app.all("/mcp", async (request, reply) => {
  const principal = buildProjectRequestPrincipal(request, shutdownSignal);
  Object.assign(request.raw, { auth: buildSafeAuthInfo(principal) });
  return nodeHandler(request.raw, reply.raw, request.body);
});
~~~

Declare the request/auth augmentation in `http/types.ts`; do not use an unchecked cast at the route. Tests enumerate ordinary AuthInfo properties and prove the sentinel bearer credential is absent.

- [ ] **Step 7: Validate JSON-RPC IDs before tool dispatch**

Allow an absent notification ID, a safe integer, or a 1..128-byte ASCII string. Reject null, floats, unsafe integers, objects, arrays/batches, non-ASCII strings, and 129 bytes as invalid request with id null. The 129-byte case must not create the per-request MCP server or call a repository.

- [ ] **Step 8: Implement bounded in-process gates**

Apply hooks in this order; the first gate also constructs `request.operationSignal`, and authentication receives it rather than a new controller:

~~~text
in-flight concurrency
Host
Origin
pre-auth source-IP bucket
read-only project authentication
project bucket
JSON-RPC ID
presented agent-token bucket when applicable
MCP adapter
~~~

Derive token-bucket capacity/refill pairs from validated configuration: capacity equals the pre-auth or agent per-minute value with refill rate divided by 60; project capacity equals projectBurst with refill projectPerMinute divided by 60. The hosted defaults therefore produce pre-auth 120 and 2/second, project 100 and 10/second, and agent token 120 and 2/second. Store buckets in one access-ordered bounded map. Purge only idle-expired least-recently-used entries; when all entries are live and the cap is reached, do not admit a new key and charge the request to a per-tier overflow bucket. Hash a presented agent token for its in-memory bucket key and never log or persist the hash. Add clock-driven expiry, unique-key churn, overflow-throttling, and memory-cap tests. Return 429 with an integer Retry-After. Saturation and handler timeout return bounded 503 and abort the use-case signal. Tests prove an abort observed before the transaction commit gate rolls back; a timeout after COMMIT begins is deliberately exercised as a retry-safe uncertain response rather than claimed to be reversible.

- [ ] **Step 9: Add the locked-revocation HTTP test**

Authenticate read-only, pause before repository project lock, revoke the token, then resume. The already-dispatched MCP call must return INTERNAL_ERROR with retryable true and no structuredContent, perform no business mutation, and receive the ordinary challenged 401 on its next request. Verify both lock acquisition orders complete without deadlock.

- [ ] **Step 10: Enforce the final serialized-response bound before the Node adapter**

Wrap `mcpHandler.fetch` before passing the handler to `toNodeHandler`; a Fastify `onSend` hook is insufficient because the Node adapter writes to `reply.raw`. The wrapper incrementally reads at most 100 KiB plus one byte from the finite response body. At or below the limit it reconstructs a Response with identical status, headers, and byte-identical body. On overflow it cancels the reader and returns the fixed compact HTTP 500 invariant response; it never truncates or emits a partial success. Cover ordinary modern JSON and each finite legacy SSE response, including multibyte chunk boundaries, an exact-limit body, and limit-plus-one. Compression, if later enabled, runs only after this uncompressed wrapper.

- [ ] **Step 11: Implement abort-first graceful shutdown**

On SIGINT/SIGTERM, atomically reject new work, abort the shared shutdown signal and every request principal, wait only the configured drain deadline, then close the Fastify listener, MCP handler, and database runtime in that order. A second signal shortens the drain but never skips resource-close attempts. Through both modern JSON and legacy finite SSE, hold a transaction before its first business mutation, trigger timeout and shutdown separately, and prove the signal reaches the use case, the transaction rolls back, the client receives only a bounded failure/connection close, and every close method runs exactly once.

- [ ] **Step 12: Run HTTP security gates**

Run:

~~~bash
pnpm --filter @agentmesh/config typecheck
pnpm --filter @agentmesh/config test
pnpm --filter @agentmesh/server typecheck
pnpm exec vitest run apps/server/tests/http
~~~

Expected: PASS for 401/403/413/429/500/503 mappings, trusted-proxy behavior, bounded rate state, timeout/shutdown abort, both response eras, request-ID bounds, and revocation race.

- [ ] **Step 13: Commit the HTTP boundary**

~~~bash
git add packages/config apps/server pnpm-lock.yaml
git commit -m "feat: secure the MCP HTTP boundary"
~~~

---

### Task 15: Add safe observability, health, readiness, and operator-only routes

**Files:**
- Modify: packages/config/src/server-config.ts
- Modify: packages/config/src/index.ts
- Modify: packages/config/tests/config.test.ts
- Modify: apps/server/package.json
- Create: apps/server/src/observability/types.ts
- Create: apps/server/src/observability/logger.ts
- Create: apps/server/src/observability/safe-events.ts
- Create: apps/server/src/observability/audit.ts
- Create: apps/server/src/observability/metrics.ts
- Create: apps/server/src/observability/redaction.ts
- Create: apps/server/src/health/readiness.ts
- Create: apps/server/src/health/operator-access.ts
- Create: apps/server/src/health/deployment-identity.ts
- Create: apps/server/src/health/routes.ts
- Modify: apps/server/src/app.ts
- Create: packages/database/src/repositories/observability.ts
- Modify: packages/database/src/runtime.ts
- Test: apps/server/tests/observability/redaction.test.ts
- Test: apps/server/tests/observability/metrics.test.ts
- Test: apps/server/tests/observability/audit.test.ts
- Test: apps/server/tests/health/routes.test.ts
- Test: apps/server/tests/health/readiness.test.ts
- Test: apps/server/tests/health/deployment-identity.test.ts

**Interfaces:**

~~~ts
export interface SafeEventSink extends McpEventSink {
  toolCompleted(event: {
    tool: "agentmesh_sync" | "agentmesh_send" | "agentmesh_list_agents";
    resultCode: ToolResultCode;
    durationMs: number;
  }): void;
  requestCompleted(event: {
    requestId: string;
    tokenId?: string;
    projectId?: string;
    tool?: "agentmesh_sync" | "agentmesh_send" | "agentmesh_list_agents";
    agentId?: string;
    resultCode: RequestResultCode;
    durationMs: number;
  }): void;
  internalFailure(category: InternalFailureCategory): void;
  audit(event: SafeAuditEvent): void;
}

export type RequestResultCode =
  | ToolResultCode
  | "HTTP_UNAUTHORIZED"
  | "HTTP_FORBIDDEN"
  | "HTTP_INVALID_REQUEST"
  | "HTTP_PAYLOAD_TOO_LARGE"
  | "HTTP_RATE_LIMITED"
  | "HTTP_UNAVAILABLE"
  | "HTTP_INTERNAL_FAILURE";

export type OperatorAccessConfig = Readonly<{
  metricsBearerToken: string | null;
}>;

export type DeploymentIdentity = Readonly<{
  commitSha: string;
  imageDigest: `sha256:${string}`;
}>;

export interface ReadinessProbe {
  check(signal: AbortSignal): Promise<
    | { ready: true }
    | {
        ready: false;
        failedChecks: readonly (
          | "config"
          | "database"
          | "migration"
          | "cursor_key_registry"
          | "maintenance"
          | "deployment_identity"
        )[];
      }
  >;
}
~~~

- [ ] **Step 1: Install pinned logging and metrics dependencies**

Run:

~~~bash
pnpm --filter @agentmesh/server add --save-exact pino@10.3.1 prom-client@15.1.3
~~~

- [ ] **Step 2: Add a failing sentinel redaction test**

Generate unique sentinels for bearer token, registration UUID, registration digest, agent token, cursor, message text, metadata, agent display name, raw JSON-RPC ID, raw tool arguments, and a forced exception message. The raw JSON-RPC ID must occur exactly once, only as the mandatory outer JSON-RPC response `id`; it must be absent from logs, audit events, metric exposition, evidence, error `message`/`data`, and every nested result. Every other sentinel must be absent from all combined application/access logs, audit events, metric exposition, tool errors, HTTP errors, and captured test evidence. Force one `CursorRegistryIntegrityFailure` through the Task 13 boundary and require exactly one `cursor_registry_integrity` event while the failure object, stack, cause, kid, commitment, and configuration sentinels remain absent from every log and response.

- [ ] **Step 3: Implement allowlist-only structured logging**

Construct log objects from typed SafeEvent values, never by spreading request/error/domain objects. `ToolResultCode`, `RequestResultCode`, audit actions, and every metric label are closed unions with runtime membership checks; no caller-supplied string can become a result code. internalFailure records only a normalized category. Instantiate one safe Pino logger and pass it to Fastify through `loggerInstance: safePino` with automatic request logging disabled; do not pass a Pino instance through the boolean/object `logger` option. Emit one completion event with the server-generated request ID.

- [ ] **Step 4: Implement bounded audit events**

Record project create/delete, token create/rotate/revoke, aggregate authentication failure, quota decision, and agent retirement. Fields are public IDs, non-secret token_id, bounded enums, counts, and timestamps only. Message payloads and credential material are forbidden by type and runtime assertions.

- [ ] **Step 5: Implement aggregate metrics with bounded labels**

Use only:

~~~text
tool
result_code
http_status_class
presence_state
message_kind
quota_kind
~~~

Expose agent presence counts, committed messages, acknowledged deliveries, delivery latency, MCP calls, status classes, duration, PostgreSQL readiness, and quota utilization. Project/agent/token/message identifiers and agent-provided strings are never labels.

- [ ] **Step 6: Add failing readiness matrix tests**

Cover valid config, a non-empty Task 1 readinessIssues list, unavailable PostgreSQL, empty/wrong schema version, configured current cursor kid/commitment missing or mismatched in the registry, persisted non-expired grace with missing/wrong/exact configured grace secret, active key-maintenance mode, and release-evidence mode with absent/half/malformed/exact deployment identity. Fatal DSN/secret/bind/allowlist/identity-format defects still refuse bootstrap; semantic lifecycle/quota/rate/timeout defects allow only /health plus /ready=503 and keep /mcp closed. MAINTENANCE_MODE is a strict boolean defaulting to false; true keeps /ready at 503 while operator key commands run.

- [ ] **Step 7: Implement the four operator/health routes**

- /health returns only 200 plus {"status":"ok"} while the process event loop can serve.
- /ready returns 200 or 503 from the readiness matrix.
- /metrics returns Prometheus text.
- /identity returns only the validated fixed-shape `{commit_sha,image_digest}` pair, or a fixed 503 when the pair is unavailable.

/ready, /metrics, and /identity require a source address in operatorAllowedCidrs. Load `METRICS_BEARER_TOKEN` as the exact optional `metricsBearerToken` field; when configured, compare the complete presented operator token in constant time after equal-length decoding and return one uniform challenge on missing/malformed/mismatched input. Add absent/configured/mutated/length-mismatch tests. Identity tests reject arbitrary fields and prove the route returns the exact immutable startup pair only. Public reverse-proxy examples later expose only /mcp, never /identity.

- [ ] **Step 8: Run observability and health gates**

Run:

~~~bash
pnpm --filter @agentmesh/config typecheck
pnpm --filter @agentmesh/config test
pnpm --filter @agentmesh/server typecheck
pnpm exec vitest run apps/server/tests/observability apps/server/tests/health
~~~

Expected: PASS; the sentinel corpus is absent from every captured surface and all metric labels are from closed enums.

- [ ] **Step 9: Commit safe operations surfaces**

~~~bash
git add packages/config packages/database apps/server pnpm-lock.yaml
git commit -m "feat: add safe observability and readiness"
~~~

---

### Task 16: Verify real MCP eras, credentials, and HTTP envelopes

**Files:**
- Modify: apps/server/package.json
- Create: apps/server/tests/contract/support/live-server.ts
- Create: apps/server/tests/contract/support/mcp-client.ts
- Create: apps/server/tests/contract/support/faulting-fetch.ts
- Test: apps/server/tests/contract/protocol-eras.test.ts
- Test: apps/server/tests/contract/http-envelope.test.ts
- Test: apps/server/tests/contract/credential-isolation.test.ts
- Test: apps/server/tests/contract/project-token-rotation.test.ts
- Test: apps/server/tests/contract/cursor-rotation.test.ts
- Test: apps/server/tests/contract/restart-config.test.ts
- Test: apps/server/tests/contract/redaction.test.ts
- Test: apps/server/tests/contract/lost-response.test.ts

**Interfaces:**

~~~ts
export async function createTestClient(input: {
  endpoint: URL;
  bearerToken: string;
  protocolVersion:
    | "2025-03-26"
    | "2025-06-18"
    | "2025-11-25"
    | "2026-07-28";
}): Promise<{ client: Client; close(): Promise<void> }>;
~~~

- [ ] **Step 1: Install the exact MCP client package**

Run:

~~~bash
pnpm --filter @agentmesh/server add -D --save-exact @modelcontextprotocol/client@2.0.0
~~~

- [ ] **Step 2: Start a real loopback TCP server in contract tests**

Use a real Fastify listener and `StreamableHTTPClientTransport`, not only app.inject. Construct the modern client with `versionNegotiation: { mode: { pin: "2026-07-28" } }`. Construct each legacy client with `supportedProtocolVersions: [revision]` and `versionNegotiation: { mode: "legacy" }`. Do not rely on package defaults or mutate an internal protocol-version field.

- [ ] **Step 3: Verify all declared protocol revisions**

For each of the four revisions, discover exactly three tools and run register, list, direct send, lost-response sync, ACK, and final empty sync. Validate each success against the strict Task 5 root output schema, assert TextContent.text is byte-identical to the same root structuredContent JSON, and forbid an SDK-added wrapper object. Assert no Mcp-Session-Id and no standalone legacy SSE endpoint.

- [ ] **Step 4: Verify credential isolation over the real handler**

Attempt sender-ID substitution, mixed agent-token halves, mutated tokens, and Project A bearer plus Project B agent token. Require stable AGENT_AUTH_INVALID with no component-validity oracle. Present one exact authentic retired token: every non-retire operation returns AGENT_RETIRED and only retire returns the stored `already_retired: true` terminal result. Create a replacement project bearer through the operator API, prove old and replacement credentials work before explicit revocation, revoke the old token, then require its uniform challenged 401 and replacement success without restarting the process.

- [ ] **Step 5: Verify actual response envelopes and ID bounds**

Capture raw uncompressed bytes for the worst accepted single message, 25-small-message page, every success/error shape, and every declared protocol revision. Require at most 100 KiB, byte parity with the conservative Task 5 checker, and exact-limit/limit-plus-one behavior through the Task 14 fetch wrapper. Use the actual immutable 64 KiB request, 100 KiB response, 25-delivery, message-text, metadata, and cursor limits rather than reduced test-only values. A 128-byte ASCII request ID succeeds; 129 bytes is rejected before tool execution.

- [ ] **Step 6: Verify wire-oversized send rollback**

Send a schema-valid candidate that fails the one-message fixture. Require MESSAGE_TOO_LARGE and independently prove no message, delivery, idempotency row, sequence increment, or quota delta.

- [ ] **Step 7: Verify cursor rotation after restart**

Exercise K1 current, K2 current/K1 grace, K1 retired with secret removed and runtime restarted, CURSOR_KEY_ROTATED without ACK, redelivery under K2, and final K2 ACK. Unknown/future/forged kids remain INVALID_CURSOR.

- [ ] **Step 8: Verify secrets stay absent on forced failures**

Force conflicts, database failure, timeout, and an unexpected exception through the real HTTP boundary. Search tool results, raw HTTP, logs, audit, metrics, and test artifacts for the sentinel corpus. Permit the request-ID sentinel exactly once in the outer JSON-RPC response `id` and nowhere in logs, audit, metrics, evidence, error `message`/`data`, or nested result content; every other sentinel is absent everywhere. Restart the complete server runtime against the same PostgreSQL state with freshly loaded equivalent configuration and prove durable agent/delivery/cursor behavior plus byte-identical wire limits; then change only a permitted lifecycle setting and prove schemas and immutable protocol caps do not drift.

- [ ] **Step 9: Run the contract suite**

Add package script test:contract, then run:

~~~bash
pnpm --filter @agentmesh/server test:contract
~~~

Expected: PASS for all four protocol revisions and real raw-body limits.

- [ ] **Step 10: Commit real protocol proof**

~~~bash
git add apps/server pnpm-lock.yaml
git commit -m "test: verify MCP eras and HTTP contracts"
~~~

---

### Task 17: Package the secure self-hosted distribution and operator documentation

**Files:**
- Create: Dockerfile
- Create: .dockerignore
- Create: docker-compose.yml
- Create: .env.example
- Create: scripts/init-env
- Create: scripts/inspect-image-identity
- Create: scripts/smoke-self-host
- Create: deploy/postgres/init/001-create-app-role.sh
- Create: deploy/caddy/Caddyfile
- Create: deploy/nginx/agentmesh.conf
- Create: README.md
- Create: LICENSE
- Create: docs/self-hosting.md
- Create: docs/security.md
- Create: docs/data-handling.md
- Create: docs/operations/token-rotation.md
- Create: docs/operations/cursor-key-rotation.md
- Create: docs/operations/agent-key-rotation.md
- Create: docs/operations/project-deletion.md
- Test: apps/server/tests/deployment/init-env.test.ts
- Test: apps/server/tests/deployment/compose-static.test.ts
- Test: apps/server/tests/deployment/compose-smoke.test.ts

**Deployment contract:**

~~~text
postgres  -> internal database network only
migrate   -> same application image, migration DSN only, one-shot command
agentmesh -> application DSN only, long-running server
~~~

- [ ] **Step 1: Add failing init-env safety tests**

Execute the file under Node 24 and test a symlink target, a symlink swapped in after inspection, wrong owner, modes 0644 and 0660, non-regular target, pre-existing operator values, forced interruption at each write/fsync/rename boundary, and a valid regular file owned by the effective user with mode 0600. Every failure before atomic rename leaves the original byte-identical and no temporary file. A failure/signal after rename may leave the complete new file and reports only a bounded `durability_uncertain` code; every observed target is either the complete old bytes or complete new bytes, never partial, and no path prints a secret.

- [ ] **Step 2: Implement scripts/init-env**

Implement `scripts/init-env` as a Node 24 executable with `#!/usr/bin/env node`, set `process.umask(0o077)`, and use `lstat`, no-follow open, and `fstat` to require an existing regular target owned by `process.geteuid()` with exact mode 0600. Replace only the exact documented template markers for runtime/migration database credentials plus independent TOKEN_PEPPER, AGENT_SESSION_SIGNING_KEY, and current cursor secret. Generate each value independently with `crypto.randomBytes(32).toString("base64url")`. Refuse already-replaced or unknown markers. Open one unpredictable same-directory temporary path with exclusive create and mode 0600, write fully, fsync and close the file, atomically rename over the revalidated target, then open and fsync the parent directory before reporting success. Track a `renamed` state: before it, signal/error handlers close and unlink only the exact temp path; after it, they never claim rollback and emit only the bounded durability-uncertain exit. The operator reruns a documented marker/permission validation before using that file. Never print a generated value.

- [ ] **Step 3: Add failing image/Compose static tests**

Assert the Dockerfile is multi-stage Node 24, copies compiled production output plus the exact committed `packages/database/drizzle` migration directory, runs as non-root, and has:

~~~dockerfile
ENV PATH=/app/node_modules/.bin:$PATH
CMD ["agentmesh", "server"]
~~~

It must not define an AgentMesh ENTRYPOINT, because the approved migration command replaces CMD.

The build accepts exactly one non-secret `ARG AGENTMESH_BUILD_COMMIT` and writes it only to the OCI `org.opencontainers.image.revision` label; no digest is guessed or embedded into the image itself. Static tests reject any credential build argument and require release builds to supply a canonical commit.

- [ ] **Step 4: Implement the hardened image**

Use a frozen pnpm lockfile, production-only runtime dependencies, USER node, read-only-compatible directories, a bounded stop signal, and no project/database/signing secret in any layer or build argument. Resolve migrations from the image-bundled read-only directory; static and container tests compare its migration/checksum manifest to the source tree and prove `agentmesh db migrate` works without TypeScript source or a bind mount. Implement `scripts/inspect-image-identity --image REF` as a bounded Docker-inspect wrapper that validates and returns only the actual image configuration digest (`.Id`) plus `org.opencontainers.image.revision`; it accepts no caller-supplied identity values.

- [ ] **Step 5: Implement the three-service Compose topology**

- postgres: expose 5432 only to db_internal, no host ports.
- migrate: same image as agentmesh, only MIGRATION_DATABASE_URL, db_internal, no published port.
- agentmesh: only DATABASE_URL plus runtime cryptographic secrets and the optional complete non-secret observed deployment-identity pair, db_internal and edge, loopback publish 127.0.0.1:host-port:3000 by default.
- db_internal: internal true.
- application services: read_only, tmpfs /tmp, cap_drop ALL, no-new-privileges, non-root.

agentmesh may depend on PostgreSQL health but not on an automatically run migration. Before migration, /ready remains 503.

- [ ] **Step 6: Add the exact credential-separation smoke assertions**

Run containers that check only variable presence:

~~~bash
docker compose run --rm migrate sh -ceu \
  ': "${MIGRATION_DATABASE_URL:?missing migration DSN}"; test "${DATABASE_URL+x}" != x'
docker compose exec -T agentmesh sh -ceu \
  ': "${DATABASE_URL:?missing application DSN}"; test "${MIGRATION_DATABASE_URL+x}" != x'
~~~

The checks use only shell parameter expansion and never enumerate the environment. Also assert migrate and agentmesh have the same image ID and PostgreSQL has no published host port.

- [ ] **Step 7: Implement and execute the clean-install smoke**

The script performs exactly:

~~~bash
cp .env.example .env
chmod 600 .env
./scripts/init-env .env
docker compose up -d postgres
docker compose run --rm migrate agentmesh db migrate
docker compose up -d agentmesh
docker compose exec agentmesh agentmesh project create --name "My project"
~~~

Then connect two independent Task 16 official MCP SDK client instances, labeled only with test profiles `codex` and `claude-code`; this smoke does not depend on the checked-in real-CLI configuration files introduced in Task 18. Register/discover both, commit/ACK a message, restart agentmesh, prove state persists, create a replacement project token, revoke the old token, verify old 401/replacement success, and perform exact-target project deletion. Cleanup uses the unique Compose project name created by the test.

- [ ] **Step 8: Add TLS reverse-proxy examples**

Caddy and Nginx examples terminate TLS, forward only /mcp publicly, preserve a validated Host, set explicit proxy source trust, and keep /ready, /metrics, and /identity internal. Their public identity-path response is the fixed 404 later required by the physical harness.

- [ ] **Step 9: Write operator and data-handling documentation**

Document:

- hosted and self-hosted modes use the same image/schema;
- no end-to-end encryption and operator DB visibility;
- hosted HTTPS, PostgreSQL volumes, and backups are encrypted;
- the hosted alpha runs one application replica; horizontal scaling is forbidden until rate limiting is shared;
- self-hosted operators may change validated lifecycle, quota, rate, timeout, and token-expiry defaults, but never immutable wire limits;
- hosted primary deletion within seven days, backups within thirty, logs fourteen, redacted test evidence thirty;
- self-host operators own backups and retention;
- token pepper replacement semantics;
- cursor current/grace/retired rotation and recovery;
- agent-key maintenance sequence with service removed from readiness;
- remote access requires TLS;
- tokens belong only in protected environment variables.

Publish Apache License 2.0 in LICENSE and identify excluded alpha scope in README.

- [ ] **Step 10: Run deployment gates**

Run:

~~~bash
pnpm exec vitest run apps/server/tests/deployment/init-env.test.ts apps/server/tests/deployment/compose-static.test.ts
pnpm exec vitest run apps/server/tests/deployment/compose-smoke.test.ts --hookTimeout=120000 --testTimeout=120000
~~~

Expected: PASS from a clean temporary Compose project with no secret in stdout/stderr.

- [ ] **Step 11: Commit the self-hosted distribution**

~~~bash
git add Dockerfile .dockerignore docker-compose.yml .env.example scripts deploy README.md LICENSE docs apps/server/tests/deployment
git commit -m "feat: add secure self-hosted distribution"
~~~

---

### Task 18: Add Codex/Claude instructions and the physical interoperability harness

**Files:**
- Modify: package.json
- Modify: vitest.config.ts
- Create: examples/AGENTS.md
- Create: examples/CLAUDE.md
- Create: examples/mcp-configs/claude-code.mcp.json
- Create: examples/mcp-configs/codex.md
- Create: docs/client-setup.md
- Create: docs/interop-runbook.md
- Create: packages/protocol/src/release/evidence.ts
- Modify: packages/protocol/src/index.ts
- Test: packages/protocol/tests/release-evidence.test.ts
- Create: packages/database/src/operator/acceptance-report.ts
- Create: apps/server/src/cli/acceptance-report.ts
- Modify: apps/server/src/cli/program.ts
- Create: tests/interop/package.json
- Create: tests/interop/tsconfig.json
- Create: tests/interop/src/index.ts
- Create: tests/interop/client-sandbox/Dockerfile
- Create: tests/interop/client-sandbox/codex-seccomp.json
- Create: tests/interop/client-sandbox/runtime-manifest.json
- Create: tests/interop/src/harness/client-sandbox.ts
- Create: tests/interop/src/harness/crypto-mcp-server.ts
- Create: tests/interop/src/harness/client-preflight.ts
- Create: tests/interop/src/harness/fault-proxy.ts
- Create: tests/interop/src/harness/operator-control.ts
- Create: tests/interop/src/harness/prepare-run.ts
- Create: tests/interop/src/harness/read-deployment-identity.ts
- Create: tests/interop/src/harness/run-physical.ts
- Create: tests/interop/src/harness/verify-run.ts
- Create: tests/interop/src/harness/summarize-runs.ts
- Create: tests/interop/fixture/package.json
- Create: tests/interop/fixture/src/contract.ts
- Create: tests/interop/fixture/test/contract.test.ts
- Create: tests/interop/prompts/codex.txt
- Create: tests/interop/prompts/claude.txt
- Test: tests/interop/tests/config-examples.test.ts
- Test: tests/interop/tests/evidence-redaction.test.ts
- Test: tests/interop/tests/harness.test.ts

**Acceptance-report contract:**

Add the exact command `agentmesh acceptance-report --project-id ID --m-ab-digest DIGEST --m-ba-digest DIGEST`. Like every Task 6 CLI command, success is one compact JSON value on stdout without a separate `--json` flag. It accepts one exact project ID plus the run manifest's expected payload/hash digests, compares payload expectations inside the process, and returns only booleans, public agent/message IDs, project sequences, direct-delivery recipient IDs/statuses, fixed idempotency labels, ACK high-waters, and aggregate counts. It never returns message text, metadata, payload digests, credentials, registration values, cursors, or arbitrary conversations.

**Redacted evidence contract:**

~~~ts
export type ReleaseEvidenceType =
  | "automated"
  | "self_host"
  | "token_drill"
  | "interop";

export type ReleaseCriterion =
  | "automated_clean_checkout"
  | "both_clients_registered"
  | "mutual_discovery"
  | "uncertain_send_deduplicated"
  | "lost_sync_redelivered_applied_acked"
  | "return_message_hash_verified_acked"
  | "final_empty_syncs"
  | "exact_database_state"
  | "no_manual_steering"
  | "self_host_restart"
  | "token_rotation_drill"
  | "hosted_image_identity";

export const RELEASE_CRITERIA_BY_TYPE = {
  automated: ["automated_clean_checkout"],
  self_host: ["self_host_restart"],
  token_drill: ["token_rotation_drill", "hosted_image_identity"],
  interop: [
    "both_clients_registered",
    "mutual_discovery",
    "uncertain_send_deduplicated",
    "lost_sync_redelivered_applied_acked",
    "return_message_hash_verified_acked",
    "final_empty_syncs",
    "exact_database_state",
    "no_manual_steering",
  ],
} as const satisfies Readonly<
  Record<ReleaseEvidenceType, readonly ReleaseCriterion[]>
>;

export type ReleaseCriteriaFor<T extends ReleaseEvidenceType> =
  (typeof RELEASE_CRITERIA_BY_TYPE)[T];

export type ReleaseEvidenceEnvelope<
  T extends Exclude<ReleaseEvidenceType, "interop">,
  R,
> = Readonly<{
  schemaVersion: "1";
  evidenceType: T;
  commitSha: string;
  imageDigest: string;
  startedAt: string;
  finishedAt: string;
  criteria: ReleaseCriteriaFor<T>;
  results: R;
}>;

export type ClientTokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}>;

export type InteropFailureStage =
  | "identity_preflight"
  | "client_preflight"
  | "project_provision"
  | "registration"
  | "discovery"
  | "uncertain_send"
  | "redelivery"
  | "fixture"
  | "return_message"
  | "final_sync"
  | "acceptance_report"
  | "identity_postflight"
  | "timeout"
  | "client_exit"
  | "cleanup";

export type InteropFailureObservations = Readonly<{
  identityPreflightPassed: boolean;
  clientIsolationPreflightPassed: boolean;
  clientsStarted: 0 | 1 | 2;
  clientsExited: 0 | 1 | 2;
  registrationsObserved: 0 | 1 | 2;
  sendsObserved: 0 | 1 | 2 | 3;
  droppedResponsesObserved: 0 | 1 | 2;
  fixtureTestPassed: boolean;
  acceptanceReportAvailable: boolean;
  cleanupCompleted: boolean;
}>;

export type InteropPassedResults = Readonly<{
  status: "passed";
  identityStable: boolean;
  clientSandboxImageDigest: `sha256:${string}`;
  codexUsage: ClientTokenUsage;
  claudeUsage: ClientTokenUsage;
  preflightUsage: Readonly<{
    codex: ClientTokenUsage;
    claude: ClientTokenUsage;
  }>;
  codexIsolationPreflightPassed: true;
  claudeIsolationPreflightPassed: true;
  codexUuidProvenanceVerified: true;
  claudeUuidProvenanceVerified: true;
  markerProvenanceVerified: true;
  agentIds: Readonly<{ a: string; b: string }>;
  messageIds: Readonly<{ mAb: string; mBa: string }>;
  projectSequences: Readonly<{ mAb: string; mBa: string }>;
  transitions: readonly InteropTransition[];
  messageRows: 2;
  directDeliveryRows: 2;
  idempotencyRows: 2;
  uncertainSendDeduplicated: boolean;
  redeliveryBeforeAck: boolean;
  fixtureTestPassed: boolean;
  returnHashMatched: boolean;
  bothInboundAcknowledged: boolean;
  finalEmptySyncs: boolean;
  noThirdSend: boolean;
  noManualSteering: boolean;
}>;

export type InteropFailedResults = Readonly<{
  status: "failed";
  failureStage: InteropFailureStage;
  observations: InteropFailureObservations;
  codexUsage: ClientTokenUsage | null;
  claudeUsage: ClientTokenUsage | null;
  preflightUsage: Readonly<{
    codex: ClientTokenUsage | null;
    claude: ClientTokenUsage | null;
  }>;
}>;

export type InteropEvidenceResults =
  | InteropPassedResults
  | InteropFailedResults;

export type ObservedDeploymentIdentity = Readonly<{
  commitSha: string;
  imageDigest: string;
}>;

type InteropEvidenceBase = Readonly<{
  schemaVersion: "1";
  evidenceType: "interop";
  startedAt: string;
  finishedAt: string;
}>;

export type InteropEvidenceEnvelope =
  | (InteropEvidenceBase & Readonly<{
      observedIdentity: null;
      criteria: readonly [];
      results: InteropFailedResults & Readonly<{
        failureStage: "identity_preflight";
      }>;
    }>)
  | (InteropEvidenceBase & Readonly<{
      observedIdentity: ObservedDeploymentIdentity;
      criteria: readonly [];
      results: InteropFailedResults & Readonly<{
        failureStage: Exclude<
          InteropFailureStage,
          "identity_preflight"
        >;
      }>;
    }>)
  | (InteropEvidenceBase & Readonly<{
      observedIdentity: ObservedDeploymentIdentity;
      criteria: ReleaseCriteriaFor<"interop">;
      results: InteropPassedResults;
    }>);

export type InteropTransition =
  | "send_response_dropped_after_commit"
  | "deduplicated_retry_observed"
  | "sync_response_dropped"
  | "redelivery_observed_before_ack"
  | "final_empty_sync_observed";
~~~

The Zod schema fixes SHA/image-digest syntax, canonical UTC timestamps, maximum durations, branded public-ID syntax, canonical positive-decimal project sequences, safe-integer token totals, and closed boolean/count/result shapes for every evidence type. Each successful producer emits exactly its ordered tuple from `RELEASE_CRITERIA_BY_TYPE`; Zod uses exact tuple schemas rather than accepting an arbitrary subset or permutation. Tests flatten the four ownership tuples and prove that every `ReleaseCriterion` occurs exactly once, while missing, reordered, duplicated, unknown, or cross-owner criteria fail parsing. An `identity_preflight` failure is schema-valid only with `observedIdentity: null`; every later failure and every pass requires the exact observed pair. Any interop failure requires `results.status = "failed"`, exactly one closed `failureStage`, the exact bounded observations object, nullable closed participant/preflight usage totals, and `criteria: []`; it never fabricates identity, IDs, transitions, or literal success counts. A passing result requires the complete `InteropPassedResults` shape and exact `ReleaseCriteriaFor<"interop">` tuple. No index signature or passthrough object is permitted. Unknown fields and arbitrary detail/message fields fail validation. Evidence contains no raw process output, headers, bodies, environment, workspace content, tokens, UUID registration keys, agent-session tokens, cursors, message text, metadata, or payload hashes.

- [ ] **Step 1: Recheck current Codex and Claude MCP setup documentation**

Use Context7 first. If unavailable, use only the current official Codex and Claude Code documentation linked in Authoritative API References and record the checked CLI versions, pinned Linux/architecture client-sandbox base, complete `--help` output hashes, binary hashes, and official documentation URLs in docs/client-setup.md and the closed runtime manifest. Freeze the verified non-interactive, MCP-required, permission-profile, bare-mode, permission, and structured-output flags in harness tests; the physical gate uses only the committed digest-built client-sandbox image and never an ambient host CLI. For the alpha Codex path, freeze the official per-invocation `codex exec` API-key contract: the runner accepts exactly `CODEX_API_KEY`, supplies it separately only to the two fixed model-backed parent processes (one security preflight and one participant invocation), and rejects `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN` in either constructed Codex environment. The credential-free `codex sandbox -P` capability probe receives no provider key. The runner does not invoke `codex login`, seed `auth.json`, or silently fall back to an ambient user login. For the alpha Claude path, the runner accepts exactly `ANTHROPIC_API_KEY` as its sole provider credential, supplies it separately only to the two fixed model-backed `claude -p --bare` parent processes (one security preflight and one participant invocation), and rejects `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and every alternative provider-routing credential or flag in both constructed Claude environments. It does not invoke interactive login, use `apiKeyHelper`, or fall back to ambient authentication. Freeze the exact beta permission-profile schema supported by the recorded Codex version; an unrecognized profile key or unsupported capability is a hard preflight failure, not a reason to fall back to the legacy sandbox or weaken an isolation claim. Do not copy a provider or project bearer token into any committed file.

- [ ] **Step 2: Add failing configuration-example tests**

Parse the Claude JSON, inspect the Codex commands, and require environment references only. Reject literal am_proj_ values. Require both instruction files to name the exact three tools and the same registration, stage-sync, process-before-ACK, CURSOR_KEY_ROTATED, uncertain-send-idempotency, and final-sync rules.

- [ ] **Step 3: Write ready-to-copy agent instructions**

Include every normative rule from spec Section 14: OS CSPRNG UUIDv4, session-local secret handling, sync after meaningful stages and before final response, process before ACK, one retry without ACK after CURSOR_KEY_ROTATED, concise context messages, shared-contract notifications, no infinite polling, and untrusted-message treatment. The physical prompts additionally require the version-frozen test-only `harness_crypto` MCP tools for each registration UUID, marker, and marker hash; neither prompt may supply one of those values. These three evaluation tools are not AgentMesh product tools and never appear in the ready-to-copy production MCP examples.

- [ ] **Step 4: Create a deterministic two-copy fixture**

Create `@agentmesh/interop` with `tsconfig.json`, `src/index.ts`, every TypeScript harness module under `src/harness`, tests under `tests`, `dist`-only package exports, and the complete Task 1 build/typecheck/test script contract. Its root scripts execute only built `dist/harness/*.js` entry points after the topological build; no release or physical command runs source through tsx. Declare exact workspace dependencies on `@agentmesh/protocol` and `@agentmesh/server`, plus exact direct runtime dependencies `@modelcontextprotocol/server@2.0.0` and `zod@4.5.4` used by the compiled test-only crypto stdio server, and import no server internals; runtime control invokes only the built CLI/HTTP surface. This makes `tests/interop` an explicit node in the root topological build graph instead of an unbuilt scripts directory. The fixture package is private and standalone. Root Vitest has one exact exclusion for `tests/interop/fixture/**` because its pristine contract test is intentionally red; the ordinary harness test copies that fixture, executes its own package test, and requires the pristine copy to fail and a correctly marked copy to pass. No other production or harness test is excluded.

~~~json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "pnpm --workspace-root build && pnpm run typecheck:local",
    "typecheck:local": "tsc -p tsconfig.json --noEmit",
    "test": "pnpm --workspace-root build && vitest run --config ../../vitest.config.ts tests",
    "interop:run": "pnpm --workspace-root build && node dist/harness/run-physical.js",
    "interop:summary": "pnpm --workspace-root build && node dist/harness/summarize-runs.js"
  }
}
~~~

The root manifest delegates `interop:run` and `interop:summary` to those two package scripts with `pnpm --filter @agentmesh/interop run ... --`, so CLI arguments reach only compiled entry points.

Before making either working copy, `prepare-run` copies the pristine fixture into a protected temporary template, materializes `examples/AGENTS.md` byte-for-byte as the template root `AGENTS.md`, and verifies both files have the recorded identical SHA-256. It rejects a symlink, an `AGENTS.override.md`, any second `AGENTS.md`, any `.rules` file, or any other supported project instruction/config file in the template. Only after that verification does it create the two independent git-root working copies. Each copy must contain exactly the one root `AGENTS.md` and the verifier rechecks its bytes immediately before client spawn.

Implement `tests/interop/src/harness/crypto-mcp-server.ts` as a version-frozen stdio MCP server advertising exactly `uuid_v4`, `marker`, and `sha256_marker`. The first returns only `crypto.randomUUID()`; the second uses `crypto.randomBytes()` plus rejection sampling over `A-Z0-9` to return exact `^AM-[A-Z0-9]{32}$`; the third accepts only one marker matching that grammar and returns its lowercase SHA-256. Schemas are closed and reject unknown fields. The source may import only the pinned MCP stdio primitives, pinned Zod, and `node:crypto`; static tests forbid `process.env`, filesystem, network, child-process, dynamic import, eval, and arbitrary command/path functionality. The topological TypeScript build emits `dist/harness/crypto-mcp-server.js`; tests hash both the reviewed source and compiled output and reject a stale or independently copied helper. The client image contains the exact frozen-lock evaluation dependency tree at `/opt/agentmesh-eval/node_modules`; `prepare-run` mounts only the compiled helper, read-only, at `/opt/agentmesh-eval/server/crypto-mcp-server.js`, whose parent resolves that in-image dependency tree without any host-absolute symlink. Each client starts it through `/usr/bin/env -i /opt/agentmesh-runtime/node/bin/node /opt/agentmesh-eval/server/crypto-mcp-server.js`, so the helper receives no project or automation credential. Before any provider credential enters a container, a startup probe invokes real MCP `tools/list` through this exact launcher and requires only the three frozen tools. Source/output/dependency hashes and modes are rechecked after each client exits.

The committed client-sandbox Dockerfile uses a digest-pinned minimal Linux base and installs exactly the recorded Codex, Claude Code, Node 24, pnpm 11.24.0, and evaluation dependency artifacts into closed `/opt/agentmesh-runtime` and `/opt/agentmesh-eval` roots. The runtime manifest records architecture, package versions, executable/dependency-tree hashes, canonical paths, and the committed `codex-seccomp.json` hash; image build and startup fail if any byte or resolved path differs. The seccomp profile permits only the reviewed syscall set required by Codex's bundled bubblewrap to create its unprivileged user/mount/PID/network namespaces, with argument filters where supported. Static launch tests forbid `--privileged`, `SYS_ADMIN`, any added capability, `seccomp=unconfined`, host PID/network namespaces, and a mutable/unhashed profile. Before credentials, the runner directly proves the pinned kernel/image support unprivileged user namespaces and the exact nested Codex sandbox under `--cap-drop ALL`, `no-new-privileges`, and `--security-opt seccomp=<verified profile>`; failure blocks the run rather than widening privileges.

The harness builds this separate test-utility image once, inspects its immutable configuration digest, and launches each client in a distinct non-root container with a read-only root filesystem, dropped capabilities, `no-new-privileges`, bounded PID/memory/CPU limits, a private PID namespace, private empty tmpfs mounts, no Docker socket, and only that client's working copy plus the exact protected MCP/config assets mounted. The Codex container alone receives the verified narrow nested-sandbox seccomp profile; Claude retains Docker's default seccomp policy. Host temporary roots, the sibling copy, operator state, release evidence, and user homes are never mounted. This client image is not the AgentMesh server release image; its observed digest is recorded separately in passing interop evidence. A host may run Docker Desktop, but acceptance is against the pinned Linux/architecture sandbox semantics, not the ambient macOS CLI.

The fixture begins with the literal placeholder `AM-PLACEHOLDER` and its test fails until Agent B writes one marker matching exact ASCII `^AM-[A-Z0-9]{32}$` to the expected artifact. Agent A, not the harness, invents the marker after launch through `harness_crypto.marker`; it is absent from B's files and prompt. Exact equality is later proven by comparing in-process digests of the crypto-tool marker, proxied M_AB value, B's artifact, crypto-tool hash, and M_BA hash, while the fixture test independently proves the edited module compiles and accepts the marker grammar. `prepare-run` creates two isolated working copies plus a separately protected asset root; real-path checks prove neither asset nor sibling copy is inside B's working root or any configured writable root, and no writable parent permits replacement. It creates exactly two participant prompts, two fixed send-idempotency keys, and a bounded manifest containing only non-secret labels. Project provisioning is delegated to the fixed operator-control adapter in Step 8. The proxy adds only internal expected digests after observing M_AB and never writes marker text. Raw crypto-tool results live only in bounded parser memory; secret-bearing client configs and working copies stay in their dedicated temporary roots and are deleted on success, failure, timeout, and signal. `.agentmesh-runs` receives only schema-validated redacted evidence for every attempt, including failures.

- [ ] **Step 5: Implement the response-dropping proxy**

Expose separate Codex and Claude AgentMesh MCP URLs. Forward without logging headers or bodies. Buffer only each bounded MCP request/response in process memory long enough to parse the strict schema and correlate the first registration UUID, the two send payloads, and fault transitions; then zero/drop every raw reference without persistence. The client stream parsers independently observe only the three closed `harness_crypto` tool-result shapes and join them in memory with the proxy observations: each crypto-tool UUID must equal that client's first registration request and satisfy UUIDv4 version/variant bits; the crypto-tool marker must equal M_AB; and the crypto-tool hash must equal M_BA. Persist only the three closed provenance booleans from a passing run, never the UUID, marker, hash, request, response, or crypto-tool output.

After M_AB commits, close Agent A's downstream connection before sending response bytes. On Agent B's first sync response containing M_AB, close before response bytes. Emit only the five closed `InteropTransition` values, canonical timestamps, bounded booleans, and public IDs joined later from the acceptance report: `send_response_dropped_after_commit`, `deduplicated_retry_observed`, `sync_response_dropped`, `redelivery_observed_before_ack`, and `final_empty_sync_observed`.

- [ ] **Step 6: Implement the exact two-message verifier**

Require:

~~~text
2 message rows
2 direct delivery rows
2 idempotency results
M_AB.project_seq < M_BA.project_seq
M_AB retry returned same ID/sequence with deduplicated true
Agent B received M_AB twice before ACK
Agent B applied the exact marker and passed the fixture test
M_BA contains the SHA-256 marker hash
both inbound sequences acknowledged
both final sync calls contain no unacknowledged deliveries
no third send
each client's crypto-tool UUID equals its first registration UUID and passes UUIDv4 version/variant validation
the crypto-tool marker/hash provenance chain matches M_AB, the edited fixture, and M_BA
~~~

The acceptance-report command performs expected marker/payload comparisons inside the process and exposes only match booleans. The verifier combines that redacted report, the five proxy transitions, the three helper-provenance booleans, the fixture test exit status, and the evidence envelope; it never opens raw agent output or MCP traffic. A passing report uses the complete `InteropPassedResults`; any failure uses the minimal `InteropFailedResults`, has `criteria: []`, and never fills absent observations with invented success values.

- [ ] **Step 7: Test harness fault logic without real agents**

Drive the proxy with scripted MCP clients and prove each response is dropped exactly once, retry behavior is at-least-once, each required transition is emitted from observable traffic rather than invented by the verifier, extra sends fail verification, and the evidence sentinel corpus is absent. Unit-test the crypto MCP server's exact three-tool discovery, closed schemas, OS-CSPRNG UUIDv4 version/variant, marker grammar/entropy source, SHA-256 result, recorded file hash, protected mode, empty environment launcher, and rejection of unknown tools/arguments. Static-import tests enforce its crypto/stdio-only source boundary. Mutated crypto output, a crypto-tool UUID different from the first registration request, a non-v4 UUID, or a marker/hash not observed from the tool fails closed and persists no raw value.

Assert the frozen Codex argv inside the digest-built client sandbox contains `--ignore-user-config`, `--ignore-rules`, `--strict-config`, `--ephemeral`, JSONL output, `approval_policy="never"`, non-login shell, and `shell_environment_policy.inherit="none"` with only a fixed non-secret PATH/locale/CI set. PATH may name only platform-minimal commands and the manifest-verified Node/pnpm entry points. It must select one exact `agentmesh_interop` permission profile which extends `:workspace`, denies `:root`, reopens `:minimal` plus only the canonical hash-pinned Node/pnpm roots as read-only, and keeps command network disabled. Neither `--sandbox`, `sandbox_mode`, nor `sandbox_workspace_write` may appear because legacy sandbox settings override and do not compose with permission profiles. Configuration parsing alone is not enforcement evidence: Step 8 must observe every required allow and denial on the exact image/CLI/OS tuple. Assert the immutable client image digest and launch flags, private empty temp mounts, mount allowlist, fresh empty mode-0700 `CODEX_HOME`, parent-only `CODEX_API_KEY`, no other Codex/OpenAI credential variable, byte-verified root `AGENTS.md`, and absence of every ambient instruction/config file before spawn. `auth.json` must remain absent, and home/asset/runtime cleanup plus post-run hashes are mandatory on every exit path. No model-spawned Codex shell receives `CODEX_API_KEY`, the private-network proxy bearer, operator values, or any secret canary; the real project bearer is absent from the client container entirely.

Assert the Claude argv contains bare mode, the hashed checked-in instruction file, strict MCP configuration, `dontAsk`, an empty built-in availability list encoded as the exact two argv entries `--tools`, `""`, exactly the three AgentMesh plus three `harness_crypto` MCP tools in `--allowedTools`, the isolated working directory, and streaming JSON output. Its constructed environment contains parent-only `ANTHROPIC_API_KEY` and no `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, apiKeyHelper, cloud-provider routing input, or ambient credential. Bash, Read, Edit, Write, file search, and every other built-in must be absent, not merely unapproved. Freeze the current verified availability, permission, authentication, and bare-mode flags in tests. Removing or broadening any constraint fails the harness test. Static and fake-Docker tests also freeze the digest-built client-sandbox/runtime/seccomp manifests; exact in-image evaluation dependency resolution and pre-credential three-tool `tools/list`; read-only/capability/PID/temp/mount launch contract; absence of Docker socket and host paths; rejection of privileged/SYS_ADMIN/unconfined-seccomp variants; identical normalized Codex probe/participant permission overrides; and the non-internal, unpublished, three-member bridge lifecycle plus credential-free egress probes. Validate wrong/mutating deployment identity, public identity-route exposure, null identity outside `identity_preflight`, fabricated identity on preflight failure, wrong commit SHA, wrong image digest, malformed client-sandbox digest, noncanonical timestamps, malformed passed/failed evidence, non-empty criteria on failure, missing/malformed participant or preflight usage events, unknown result keys, and a secret-bearing field as hard failures.

Run:

~~~bash
pnpm build
pnpm -r --sort typecheck:local
pnpm exec vitest run packages/protocol/tests/release-evidence.test.ts tests/interop/tests/config-examples.test.ts tests/interop/tests/evidence-redaction.test.ts tests/interop/tests/harness.test.ts
~~~

Expected: PASS before any real-agent attempt; a failing automated harness/schema/config gate forbids Step 8.

- [ ] **Step 8: Implement the physical runner and, optionally, run an uncounted preflight**

Implement `run-physical.ts` as the sole physical entry point with fixed roles: Claude is Agent A, which registers/discovers and performs the uncertain idempotent send; Codex is Agent B, which receives the redelivery, edits the fixture, runs its exact `pnpm test`, ACKs, and returns the marker hash. It creates protected temporary client configs, the crypto MCP asset, a fresh empty mode-0700 Codex home, and the two verified working copies; builds and inspects the committed client-sandbox image on the explicit local client Docker context; then creates one fresh user-defined bridge with `internal=false`, no published ports, and fixed per-run DNS aliases. Before credentials, an ephemeral container from the same image proves DNS/TLS reachability to the documented OpenAI and Anthropic API origins plus the public MCP origin, observes only the expected unauthenticated HTTP classes, and is removed. Participant phase permits exactly three network members—Codex, Claude, and the isolated fault proxy. Proxy readiness/control and closed observations travel only through bounded `docker exec`/stdout adapters; no host port is published. The runner then launches both participant containers concurrently with distinct filesystem/PID/temp namespaces, exactly one initial prompt each, closed stdin, and no follow-up channel. The container launcher is fixed argv without a shell, validates the complete context/mount/environment/network/security option set, and never mounts a Docker socket, sibling copy, host temp root, operator asset, or evidence directory. Codex `permissions.*.network.enabled=false` governs model-generated commands, while the parent model and MCP clients retain bridge egress; the deterministic probe must prove that separation.

Require five explicit operator inputs: `AGENTMESH_PUBLIC_MCP_URL`, `AGENTMESH_OPERATOR_IDENTITY_URL`, `AGENTMESH_DOCKER_CONTEXT`, `AGENTMESH_COMPOSE_PROJECT`, and `AGENTMESH_CLIENT_DOCKER_CONTEXT`. The server context may be remote; the client context must be a separately validated local engine that can bind-mount runner-created files, and a canary mount/namespace probe must pass before any credential enters it. The operator identity URL is a separate value and is never derived from, rewritten from, or replaced by the public MCP URL. Accept only HTTPS, or loopback HTTP reached through an already established SSH LocalForward; documentation also permits HTTPS reached through the operator VPN/control host. The harness neither creates a tunnel nor accepts a generic remote-command environment variable. Before any client-security preflight or participant starts, request `/identity` through the explicit internal URL with the protected bearer and require success, while a request to `/identity` on the public MCP origin must be unavailable with the fixed public 404. A failure emits the null-identity `identity_preflight` branch and stops; a fake-server test requires that exact public-404/internal-success topology. The identity URL, both Docker contexts, Compose project, operator bearer, and any control-plane output are never placed in either coding-client environment or prompt.

Implement `operator-control.ts` as a no-shell, fixed-argv Docker adapter. It validates context, Compose project, run label, public IDs, and digests against closed grammars and may spawn only these command families:

~~~text
docker --context CONTEXT compose --project-name PROJECT exec -T agentmesh agentmesh project create --name RUN_LABEL
docker --context CONTEXT compose --project-name PROJECT exec -T agentmesh agentmesh acceptance-report --project-id PROJECT_ID --m-ab-digest DIGEST --m-ba-digest DIGEST
docker --context CONTEXT compose --project-name PROJECT run --rm migrate agentmesh project delete --project-id PROJECT_ID --confirm-name RUN_LABEL
~~~

After identity and real-client isolation preflights pass, the adapter provisions one fresh project and parses the bounded Task 6 compact-JSON create result in memory. The runner launches the fault proxy as the third and final member of the fresh non-internal client bridge, with no published port; the real project bearer exists only in that proxy container's upstream authorization state and never enters either coding-agent environment, config, prompt, argv, or working copy. Each coding-agent MCP config instead uses a distinct short-lived bridge-network-only proxy bearer and the fixed proxy DNS alias; the proxy validates it and substitutes the real upstream authorization without logging either value. A protected bounded stdout/control adapter returns only the closed transition/provenance observations to the runner. The adapter drops its raw create buffer and plaintext project token after proxy initialization. After the participants exit it runs the acceptance report through the same narrow adapter and exact project ID; cleanup uses only the fixed exact-target deletion command. No database DSN or database credential leaves the Docker host/container, and neither a general `docker exec` wrapper nor arbitrary command string exists. This works with a preconfigured remote Docker SSH context or operator-VPN control host without widening the harness interface.

After Step 1 verifies the installed versions, build the Codex argv from `codex exec --ignore-user-config --ignore-rules --strict-config --ephemeral --json -C CODEX_WORKING_COPY`, the initial B prompt, and these exact typed overrides:

~~~text
mcp_servers.agentmesh.url=<JSON.stringify(proxyUrl.href)>
mcp_servers.agentmesh.bearer_token_env_var="AGENTMESH_PROXY_BEARER_CODEX"
mcp_servers.agentmesh.required=true
mcp_servers.agentmesh.enabled=true
mcp_servers.agentmesh.enabled_tools=["agentmesh_sync","agentmesh_send","agentmesh_list_agents"]
mcp_servers.agentmesh.default_tools_approval_mode="approve"
mcp_servers.harness_crypto.command="/usr/bin/env"
mcp_servers.harness_crypto.args=["-i","/opt/agentmesh-runtime/node/bin/node","/opt/agentmesh-eval/server/crypto-mcp-server.js"]
mcp_servers.harness_crypto.required=true
mcp_servers.harness_crypto.enabled=true
mcp_servers.harness_crypto.enabled_tools=["uuid_v4","marker","sha256_marker"]
mcp_servers.harness_crypto.default_tools_approval_mode="approve"
approval_policy="never"
allow_login_shell=false
default_permissions="agentmesh_interop"
permissions.agentmesh_interop.extends=":workspace"
permissions.agentmesh_interop.filesystem={":root"="deny",":minimal"="read","/opt/agentmesh-runtime/node"="read","/opt/agentmesh-runtime/pnpm"="read"}
permissions.agentmesh_interop.network.enabled=false
shell_environment_policy.inherit="none"
shell_environment_policy.ignore_default_excludes=false
shell_environment_policy.set=<fixed TOML inline table containing only safe PATH, CI, NO_COLOR, and locale values>
agents.enabled=false
tools.web_search=false
tools.view_image=false
~~~

Every dynamic path/value is encoded as a typed TOML value, never shell-concatenated. The two explicit runtime roots are fixed canonical paths whose closed manifest and image bytes were verified; no ancestor, package cache, symlink escape, or unrelated executable root is reopened. The harness rejects any loaded or argv-supplied legacy `sandbox_mode`/`sandbox_workspace_write` setting before spawn. `approval_policy="never"` is the non-interactive hard stop: no automatic reviewer or escalation route exists. The inner profile is intended to make only B's working copy writable, permit reads only from `:minimal` and the two protected runtime roots, deny the mounted Codex home and crypto assets to model-spawned commands, and disable command network. The outer read-only OCI boundary independently ensures that the sibling copy, host/user homes, operator assets, evidence, Docker socket, and host temp roots do not exist in the container; `/tmp` and `$TMPDIR` are fresh private tmpfs mounts containing no host data. The runner must observe those semantics rather than infer them from accepted configuration. Parent Codex receives `CODEX_API_KEY` only for this official model-backed `codex exec` invocation and the private-network proxy bearer only for its MCP transport, while model-spawned processes receive only the fixed safe shell environment. No repository setup, dependency installation, or harness hook runs in the credential-bearing parent environment.

Set `CODEX_HOME` to the fresh empty mode-0700 directory; do not inherit a user config, auth store, hooks, plugins, or execpolicy rules. The harness verifies no `AGENTS.override.md`, alternate `AGENTS.md`, agent-specific config, or `.rules` file exists and re-hashes the sole root `AGENTS.md`, crypto server, and protected siblings immediately before and after spawn. The Codex prompt names only the expected fixture artifact, exact `pnpm test` command, and three `harness_crypto` tool names; it requires `uuid_v4` for registration and `sha256_marker` for the return message. Any approval request, TTY read, missing MCP connection, UUID/hash provenance mismatch, out-of-root access, failure to edit, or failure to run the test fails and remains in the denominator. The temporary Codex home is removed on success, failure, timeout, and signal.

Build the Claude argv from `claude -p INITIAL_A_PROMPT --bare --append-system-prompt-file CHECKED_IN_CLAUDE_MD --mcp-config PROTECTED_CONFIG --strict-mcp-config --no-session-persistence --permission-mode dontAsk --tools "" --output-format stream-json --verbose`. The strict protected config contains only the private-network AgentMesh proxy and `/usr/bin/env -i /opt/agentmesh-runtime/node/bin/node /opt/agentmesh-eval/server/crypto-mcp-server.js`; no user/project MCP server is discovered. Its `--allowedTools` list contains exactly:

~~~text
mcp__agentmesh__agentmesh_sync
mcp__agentmesh__agentmesh_send
mcp__agentmesh__agentmesh_list_agents
mcp__harness_crypto__uuid_v4
mcp__harness_crypto__marker
mcp__harness_crypto__sha256_marker
~~~

Verify the instruction/config/crypto-server recorded SHA-256 values before and after spawn. Bare mode plus the explicit file/config are mandatory so hooks, plugins, skills, auto-memory, ambient CLAUDE.md, and user MCP configuration cannot help the attempt. The exact empty string following `--tools` removes every built-in, including Bash and its read-only commands, Read, Edit, Write, Glob, and Grep; `dontAsk` denies any unlisted MCP call. Claude A uses the crypto MCP tools for its registration UUID, marker, and marker hash.

After identity succeeds but before project provisioning, `client-preflight.ts` runs two ordered gates against the exact digest-built client sandbox. First, a deterministic Codex capability probe invokes the recorded binary's `codex sandbox -P agentmesh_interop` path with no provider credential, model request, or AgentMesh project. It uses the same typed `buildCodexPermissionOverrides` output as the participant—complete named-profile definition, `--strict-config`, exact `-C` probe workspace, approval/shell environment, runtime roots, and network setting—rather than relying on the empty `CODEX_HOME`; only MCP definitions and the initial prompt are omitted. Tests structurally compare the normalized effective profile/override object used by the probe and participant and reject a missing, reordered, or broadened setting. The probe must directly observe a write inside the dedicated workspace; successful read/execute of only the manifest-verified Node/pnpm roots and successful execution of the exact probe-fixture `pnpm test`; denial of reads, writes, chmod, rename, and execution against the mounted crypto assets and isolated Codex home; absence of every unmounted sibling/operator/evidence/host-temp canary; a private writable temp namespace with no host sentinel; denial of socket/network access; and denial of process inspection outside the probe tree. Parsing the profile or matching expected stderr is insufficient. Before this command, the launcher has already verified the hash-pinned seccomp profile, unprivileged user-namespace prerequisites, and the exact no-capability/no-privilege container flags. If the pinned image/CLI/kernel tuple cannot simultaneously enforce those properties, the gate emits `failureStage: "client_preflight"`, provisions no project, and blocks acceptance and release without a legacy or weakened fallback.

Only after the deterministic gate passes, run one non-participant model-backed security probe for each real CLI with the real `CODEX_API_KEY` and `ANTHROPIC_API_KEY`; fake values never substitute for provider credentials. Additional independently generated canary values test environment and proxy isolation without replacing either actual key. These probes use dedicated strict preflight MCP configurations with no AgentMesh project or production AgentMesh server. Codex must perform a workspace write and the exact `pnpm test`, observe denial rather than review for protected-path and permission-escalation attempts, expose an empty model-shell credential environment, fail to recover the actual provider key or canaries through environment/process inspection, and leave `auth.json` absent. Claude must prove from the version-frozen initialization/tool stream that `--tools ""` yields an empty built-in inventory and Bash, Read, Edit, Write, filesystem search, and environment access cannot be invoked. The harness scans bounded raw probe streams in memory for the actual credentials and canary corpus, persists none of them, discards the streams immediately, and records preflight usage separately from participant usage. Either failure is `client_preflight`; these sessions are security gates, not either of the exactly two collaboration participants.

Construct each coding-client container environment from a platform-minimum allowlist rather than spreading the host environment. The Codex parent receives exactly `CODEX_API_KEY`, its private-network proxy bearer, the fresh isolated `CODEX_HOME`, and non-secret runtime necessities; it rejects and omits `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, and every unrelated parent value. The Claude parent receives exactly `ANTHROPIC_API_KEY`, its distinct private-network proxy bearer, isolated config paths, and non-secret runtime necessities; it rejects and omits `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, alternative provider-routing credentials and flags, and every unrelated parent value. The real project bearer, operator bearer/URL, Docker control inputs, sibling credential, and host Docker socket are absent from both. Each crypto MCP process is independently launched with an empty environment. Stream-parse Codex JSONL and Claude stream-json with exact ceilings of 1 MiB per line, 2 MiB parser buffer, 50,000 events, 64 MiB total stdout, and 16 MiB consumed stderr per child; overflow kills the attempt rather than buffering. Validate the version-frozen usage and crypto-tool event shapes, join crypto outputs to proxy observations only in process memory, add only non-negative safe-integer input/output/cache token totals capped at one billion per field to the closed evidence result, keep preflight totals separate from participant totals, and immediately discard every raw event and stderr chunk. Absent/overflowing usage or provenance makes the attempt fail. Set one overall timeout; on any exit/failure/signal send SIGTERM and then bounded SIGKILL to both client containers, their stdio MCP descendants, the proxy container, and the private network. Never persist or print raw child stdout/stderr.

Use exactly two real isolated collaboration sessions and the one freshly provisioned remotely reachable alpha project; the preceding security probes are disconnected prerequisite checks. The harness reads the operator credential only from protected `AGENTMESH_OPERATOR_BEARER_TOKEN` process environment, never forwards it to a coding client, and drops each bounded identity-response buffer immediately after validation. Take `observedIdentity` only from that response rather than CLI flags. Supply only the two participant prompts; after that provide no follow-up, reminder, copied message, or manual steering. When both exit, fetch the same explicit internal identity URL again and require the pair to be unchanged, then run the narrow acceptance report, fixture test, verifier, and exact-target cleanup automatically. Atomically write a schema-valid passing or failed `interop` envelope and securely remove temporary configs, crypto server, Codex home, and working copies. Keep only redacted evidence for every failed attempt.

Each invocation requires a previously absent mode-0700 attempt directory, writes exactly one terminal `attempt.json` atomically, fsyncs it and the directory, makes the terminal file read-only, and refuses to reuse or overwrite that directory regardless of pass/fail. A parent release run stores every invocation in a distinct numbered child and never deletes failed attempts. This gives the Task 19 verifier a complete enumerable attempt set rather than a caller-selected success file.

Step 8 may be exercised once as an uncounted engineering preflight after the automated harness tests, but any artifact produced before the Task 18 and Task 19 policy commits is stored only under a preflight-only location and must never be supplied to `verify-release`; no unmodeled eligibility field is added to the strict evidence schema. Release-eligible physical evidence is generated only in Task 19 from a fresh checkout of its already committed policy.

Run:

~~~bash
pnpm interop:run --evidence-dir .agentmesh-runs/run-01
~~~

Expected for an optional preflight: the complete normative flow passes and redacted evidence contains no token, UUID, marker, hash, session token, cursor, message text, metadata, or unrelated conversation. An engineering preflight completed before a product-hypothesis campaign is outside that campaign and is never release evidence; once a five-run campaign is declared, every attempt in it, including failures, is irrevocably counted and cannot be selected after seeing its result.

- [ ] **Step 9: Implement the five-run hypothesis summary**

`summarize-runs` parses both strict passing and strict failed interop envelopes, counts every schema-valid attempt in the denominator, and reports separate protocol, instruction-adherence, usefulness, participant versus security-preflight per-client input/output/cache token totals, and latency outcomes through bounded enums/counts. Nullable failure usage is reported as unavailable rather than zero; preflight usage is never added to participant cost. It opens post-alpha product work only when total is exactly five and at least four pass the complete normative flow.

Run: pnpm interop:summary --runs-dir .agentmesh-runs

- [ ] **Step 10: Commit instructions and the harness, not private run evidence**

Add .agentmesh-runs/ to .gitignore. Commit only code, fixture, public instructions, and the tested redacted evidence schema; never commit an actual run directory.

~~~bash
git add .gitignore package.json vitest.config.ts examples docs/client-setup.md docs/interop-runbook.md packages/protocol packages/database apps/server/src/cli tests/interop pnpm-lock.yaml
git commit -m "test: add Codex and Claude acceptance harness"
~~~

---

### Task 19: Add clean-checkout CI and the closed-alpha release gate

**Files:**
- Create: .github/workflows/ci.yml
- Create: scripts/verify-source-boundaries
- Create: scripts/run-automated-gate
- Create: scripts/deploy-hosted-alpha
- Create: scripts/inspect-running-compose-identity
- Create: scripts/run-token-drill
- Create: scripts/verify-release
- Modify: scripts/smoke-self-host
- Create: packages/protocol/src/release/compose-pin.ts
- Modify: packages/protocol/src/release/evidence.ts
- Modify: packages/protocol/src/index.ts
- Modify: packages/protocol/tests/release-evidence.test.ts
- Test: packages/protocol/tests/release-compose-pin.test.ts
- Modify: tests/interop/src/harness/operator-control.ts
- Modify: tests/interop/src/harness/run-physical.ts
- Modify: tests/interop/src/harness/verify-run.ts
- Modify: tests/interop/src/harness/summarize-runs.ts
- Modify: tests/interop/tests/evidence-redaction.test.ts
- Modify: tests/interop/tests/harness.test.ts
- Create: docs/release-readiness.md
- Create: docs/hosted-alpha-runbook.md
- Modify: package.json
- Modify: README.md
- Test: apps/server/tests/architecture/source-boundaries.test.ts
- Test: apps/server/tests/architecture/three-tool-scope.test.ts
- Test: apps/server/tests/release/evidence-producers.test.ts
- Test: apps/server/tests/release/verify-release.test.ts

**Release contract:**

No script or CI result marks the product ready from unit tests alone. Closed-alpha readiness requires the complete automated gates, one passing physical run, the token replacement/revocation drill, and the self-host restart smoke. Expansion beyond closed alpha additionally requires the separately recorded four-of-five product hypothesis gate.

~~~ts
export type ReleaseComposePin = Readonly<{
  schemaVersion: "1";
  dockerContext: string;
  composeProject: string;
  commitSha: string;
  imageDigest: `sha256:${string}`;
}>;
~~~

The strict `ReleaseComposePin` schema uses closed context/project grammars, canonical commit and configuration-digest syntax, and no unknown fields. Task 19 extends `InteropPassedResults` with `releaseComposePinValidated: boolean`: an ordinary engineering or hypothesis run emits `false`, while a release run may emit `true` only after the protected pin and independently observed pre/post runtime identity agree. The shared strict schema accepts both honest modes, but the release verifier requires literal `true`. Task 19 updates the pass producer, verifier, summary, and all strict-schema/redaction fixtures; tests reject a missing/non-boolean field, accept an ordinary false run, reject false at the release verifier, and accept true only from the independently validated pin path.

- [ ] **Step 1: Add source-boundary tests**

Fail when:

- apps/server imports pg, drizzle-orm, SQL, or packages/database/src/internal;
- packages/protocol imports database or server;
- packages/database imports apps/server;
- a fourth MCP tool is registered;
- forbidden packages or deferred features appear in production dependency manifests.

Source inspection does not claim to prove absence of process-memory correctness state. The Task 11/16 restart suites and Task 17 self-host restart smoke are mandatory `pnpm check`/release inputs and provide that runtime proof.

- [ ] **Step 2: Add the frozen-lock clean-check script**

Root scripts must provide:

~~~text
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:deployment
pnpm check
~~~

`check` starts by topologically building the workspace, then runs no-emit typecheck, all non-physical automated suites including the restart contracts, source boundaries, `git diff --check`, and an unfinished-marker scan over production source, executable scripts, manifests, deployment files, examples, and tests (historical design/plan prose is outside that scan). The scan has a closed path-and-value allowlist only for the exact `.env.example` generation markers consumed by `scripts/init-env` and `tests/interop/fixture/src/contract.ts` literal `AM-PLACEHOLDER`; any TODO/FIXME/TBD or the same marker elsewhere fails. In a clean checkout gate, `scripts/run-automated-gate` first proves no workspace `dist` directory existed, invokes that frozen command set, sends every Docker operation through its validated `--docker-context` (defaulting only to the explicit local context in CI), builds the production image exactly once with the canonical HEAD passed only as the OCI revision-label build arg, reads the actual `sha256:` configuration digest and revision label through `scripts/inspect-image-identity`, and atomically writes a schema-validated `automated` evidence envelope only after every command passes. Tests fail if stale dist is necessary, contexts differ, or a second Docker build occurs.

- [ ] **Step 3: Implement CI on Node 24**

The workflow checks out source, asserts no `dist` exists, enables Corepack, verifies pnpm 11.24.0, installs with --frozen-lockfile, invokes `scripts/run-automated-gate`, validates Compose against that exact already-built image with `--no-build`, and runs the clean self-host smoke on a Linux runner with Docker. Extend `scripts/smoke-self-host` to derive identity by inspecting the one running container and its revision label (never expected identity flags), compare it with the protected `/identity` response, and atomically produce the strict `self_host` evidence envelope after migration, two independent client registrations, committed/ACKed message, restart, unchanged container image identity, and durability checks pass. Upload only those two schema-validated redacted reports; never upload .env, container environment, database dumps, raw MCP traffic, working copies, or interop run directories.

- [ ] **Step 4: Add the hosted-alpha operator drill**

`scripts/deploy-hosted-alpha` accepts a Docker context, image reference, Compose project, and one previously absent `--release-compose-pin-out PATH`, but no caller-supplied commit/digest and no generic remote command. It requires the output parent to be an operator-owned mode-0700 directory and rejects an existing path or symlink. Hosted release mode refuses an absent operator CIDR allowlist, `METRICS_BEARER_TOKEN`, or explicit `AGENTMESH_OPERATOR_IDENTITY_URL`; the internal identity URL is never derived from the public MCP URL and must satisfy the Task 18 HTTPS-or-loopback rule. After inspecting the selected image through the named Docker context, the script atomically writes and directory-fsyncs one mode-0400 strict `ReleaseComposePin` containing only the validated context, project, observed OCI revision label, and observed `sha256:` configuration digest. That digest is the immutable Compose image reference, and the release-scoped pin remains present for every later control and cleanup command rather than being deleted after deployment.

Before every hosted Compose spawn, the deployer reopens the pin without following symlinks, verifies owner/mode/inode/bytes and strict schema, then constructs a child environment with exactly these non-secret overrides from the validated pin: `AGENTMESH_IMAGE=pin.imageDigest`, `AGENTMESH_BUILD_COMMIT=pin.commitSha`, `AGENTMESH_IMAGE_DIGEST=pin.imageDigest`, and `RELEASE_EVIDENCE_MODE=true`. It runs migration and the single-replica deployment with `--no-build`, then requires `scripts/inspect-running-compose-identity` to prove that the single healthy agentmesh container, its image ID/revision label, the protected internal `/identity` response, and the pin all match while the public `/identity` probe is 404. The pin controls Compose selection only and is never accepted as evidence of runtime identity.

The physical harness provisions and cleans up its own exact fresh project through the Task 18 narrow Docker control plane. In a release run `pnpm interop:run` requires `--release-compose-pin PATH`; Task 19 extends `operator-control.ts` to validate the protected mode-0400 pin before every Docker spawn, match its context/project and identity to the fixed inputs plus independently observed deployment identity, and supply the exact four non-secret Compose overrides above. The pin path or values never enter either coding-client environment or prompt. Project cleanup refuses to run if the pin disappears, changes inode/bytes, or no longer matches the observed deployment; the failed release retains the pin for explicit operator recovery.

Independently, `scripts/run-token-drill` requires the same `--release-compose-pin PATH`, Docker context, Compose project, fixed no-shell Compose argv families, and explicit internal identity URL; it accepts no project/token input, DSN, caller-supplied identity, or generic command string. It validates the pin plus independently inspected running-container/internal-route identity before every spawn and supplies the same exact four overrides. After its first identity/readiness check, it creates a separate fresh drill project inside `agentmesh`, captures the initial token only in bounded memory, issues a replacement, verifies both before revocation, revokes the initial token, verifies old 401 and replacement success, checks readiness/identity again, and always exact-target deletes that drill project through the pinned `compose run --rm migrate ... project delete --project-id ... --confirm-name ...` command. Cleanup failure or any pin mutation/mismatch fails the producer and writes no release report. Tokens enter only bounded in-memory control output and protected HTTP headers and are removed before report construction; no database credential leaves the host/container. Only after successful cleanup does it atomically emit the strict `token_drill` envelope using the unchanged observed identity. The report contains only public IDs and bounded booleans/status enums, including `runtimeIdentityMatched: true`. Fake-Docker/fake-server tests require deployment, interop control/cleanup, and token-drill spawns to receive the same four overrides and cover missing, symlinked, replaced, wrong-mode, wrong-context, wrong-project, wrong-commit, and wrong-image pins. No evidence producer accepts commit/image values as a substitute for observation.

- [ ] **Step 5: Implement scripts/verify-release**

The script accepts the expected checked-out commit SHA, paths to redacted automated/self-host/token-drill artifacts, and one complete `--interop-dir`; it accepts no individual interop-file or expected-image flag. It rejects symlinks, non-regular files, unknown entries, and noncanonical attempt names, then enumerates every numbered child and parses its sole `attempt.json` through the committed shared strict Zod schema. Release readiness requires exactly one terminal attempt in the directory and that attempt must have non-null `observedIdentity`, `results.status = "passed"`, both isolation-preflight literals, `releaseComposePinValidated: true`, the complete provenance/pass shape, and the exact interop ownership tuple. Any failed attempt, missing attempt, or additional attempt fails this commit-named release directory even if a later attempt passed.

Require automated.commitSha to equal the supplied checkout commit, take the canonical image configuration digest only from the successfully parsed automated clean-build evidence, and require self-host/token-drill plus interop `observedIdentity` to name that same commit/image. Require self-host and token-drill runtime-attestation booleans plus interop pre/post identity stability and release-pin validation; require each artifact to finish after it starts, be no more than seven days old and no more than five minutes in the future. Ownership is exact and ordered: automated emits only `[automated_clean_checkout]`; self-host emits only `[self_host_restart]`; token drill emits only `[token_rotation_drill, hosted_image_identity]`; interop emits only `[both_clients_registered, mutual_discovery, uncertain_send_deduplicated, lost_sync_redelivered_applied_acked, return_message_hash_verified_acked, final_empty_syncs, exact_database_state, no_manual_steering]`. The verifier checks each tuple against `RELEASE_CRITERIA_BY_TYPE`, then flattens them and proves all twelve criteria occur exactly once. Every required boolean/result must pass. Missing, reordered, duplicate, cross-owner, stale, malformed, caller-supplied/unattested identity, wrong-commit, wrong-image, unknown-field, or secret-pattern-bearing evidence fails closed and prints only a bounded reason code.

Producer tests run every script against success/failure fixtures and prove no report is written on partial failure. Verifier tests cover each fail-closed branch plus one all-green set and the mandatory `failed attempt -> second passed attempt -> verify still fails` regression; runner tests prove a terminal attempt directory can never be reused or overwritten. No test may bypass parsing by importing an internal unchecked function.

- [ ] **Step 6: Test and commit CI, producers, verifier, and release policy**

Run every architecture test, producer test with fake Docker/fake servers, verifier fail-closed branch, and one disposable non-release clean-gate preflight. A disposable preflight report is test output only and cannot be copied into the operator evidence directory. Then commit the entire release implementation before generating any release-eligible artifact:

~~~bash
git add .github scripts package.json README.md docs/release-readiness.md docs/hosted-alpha-runbook.md packages/protocol tests/interop apps/server/tests/architecture apps/server/tests/release
git commit -m "ci: enforce AgentMesh closed-alpha gates"
~~~

Require a clean status and record this exact committed HEAD. From this point until release verification completes, no source, test, manifest, lockfile, script, documentation, commit, tag, or evidence schema may change. If any does, discard the release attempt and restart Step 7 from the new committed HEAD.

- [ ] **Step 7: Generate automated and self-host evidence from the exact committed HEAD**

Create a fresh detached checkout of the Task 19 commit. Require the operator to supply `AGENTMESH_RELEASE_EVIDENCE_DIR` on durable protected operator storage outside every checkout; create one previously absent commit-named child with mode 0700, reject symlinks/non-empty targets, and give it no automatic deletion trap. It persists through and after verification. Execute the Step 7-9 blocks in one continuous fail-fast shell so their validated immutable variables cannot be silently reconstructed differently. All release commands run from the fresh checkout. Build exactly one production image on the explicitly named `AGENTMESH_DOCKER_CONTEXT`; every later gate uses that already-built image with `--no-build` and verifies its observed configuration digest/revision label.

~~~bash
set -euo pipefail
umask 077
: "${AGENTMESH_RELEASE_EVIDENCE_DIR:?required}"
: "${AGENTMESH_DOCKER_CONTEXT:?required}"
: "${AGENTMESH_COMPOSE_PROJECT:?required}"
: "${AGENTMESH_CLIENT_DOCKER_CONTEXT:?required}"
: "${AGENTMESH_PUBLIC_MCP_URL:?required}"
: "${AGENTMESH_OPERATOR_IDENTITY_URL:?required}"
: "${AGENTMESH_OPERATOR_BEARER_TOKEN:?required}"
release_commit="$(git rev-parse HEAD)"
release_checkout="$(mktemp -d)"
release_evidence_dir="$AGENTMESH_RELEASE_EVIDENCE_DIR/$release_commit"
test ! -e "$release_evidence_dir"
test ! -L "$release_evidence_dir"
mkdir -m 700 "$release_evidence_dir"
chmod 700 "$release_checkout"
git clone --no-local "$(git rev-parse --show-toplevel)" "$release_checkout/source"
git -C "$release_checkout/source" checkout --detach "$release_commit"
cd "$release_checkout/source"
test "$(git rev-parse HEAD)" = "$release_commit"
test -z "$(git status --porcelain)"
corepack enable
pnpm install --frozen-lockfile
release_image="agentmesh-release:${release_commit}"
./scripts/run-automated-gate \
  --docker-context "$AGENTMESH_DOCKER_CONTEXT" \
  --image-tag "$release_image" \
  --output "$release_evidence_dir/automated.json"
AGENTMESH_IMAGE="$release_image" ./scripts/smoke-self-host \
  --docker-context "$AGENTMESH_DOCKER_CONTEXT" \
  --compose-project "${AGENTMESH_COMPOSE_PROJECT}-self-host-proof" \
  --no-build \
  --output "$release_evidence_dir/self-host.json"
~~~

Expected: the clean checkout remains byte-clean; the Docker-event assertion proves exactly one build; automated and self-host envelopes name the same observed commit/image; and the protected evidence directory remains available for Steps 8-9. The generated image, not a mutable re-build of its source, is the only release candidate.

- [ ] **Step 8: Deploy that same image and generate hosted physical evidence**

Deploy the already-built release image to the hosted Compose project through the same Docker context. `deploy-hosted-alpha` uses `--no-build` and pins the observed image ID. With the explicit public MCP URL, separate operator identity URL, fixed Docker context/project, and protected operator bearer, run the real Codex-plus-Claude session again against that hosted container and then run the hosted token drill. Both producers re-observe the running identity before and after their operation; neither accepts it from the caller.

~~~bash
set -euo pipefail
release_compose_pin="$release_evidence_dir/release-compose-pin.json"
test ! -e "$release_compose_pin"
test ! -L "$release_compose_pin"
./scripts/deploy-hosted-alpha \
  --docker-context "$AGENTMESH_DOCKER_CONTEXT" \
  --compose-project "$AGENTMESH_COMPOSE_PROJECT" \
  --image "$release_image" \
  --release-compose-pin-out "$release_compose_pin" \
  --no-build
mkdir -m 700 "$release_evidence_dir/interop"
pnpm interop:run \
  --release-compose-pin "$release_compose_pin" \
  --evidence-dir "$release_evidence_dir/interop/attempt-0001"
./scripts/run-token-drill \
  --docker-context "$AGENTMESH_DOCKER_CONTEXT" \
  --compose-project "$AGENTMESH_COMPOSE_PROJECT" \
  --release-compose-pin "$release_compose_pin" \
  --output "$release_evidence_dir/token-drill.json"
unlink "$release_compose_pin"
~~~

Copy no private process output: the interop runner atomically leaves exactly one strict terminal envelope at `$release_evidence_dir/interop/attempt-0001/attempt.json`. If deployment, interop cleanup, or token-drill cleanup fails, `set -e` stops before `unlink`; retain the protected pin for explicit exact-target operator recovery and do not write a passing artifact. Only after both projects are successfully deleted is the non-secret pin removed. Never delete a failed attempt child or create a replacement pass for the same commit-named evidence directory. Expected: self-host, hosted identity, the sole passing physical interop attempt, and token drill all attest the one image produced in Step 7.

- [ ] **Step 9: Verify the persistent evidence set**

Run from the unchanged fresh checkout:

~~~bash
./scripts/verify-release \
  --commit "$release_commit" \
  --automated "$release_evidence_dir/automated.json" \
  --self-host "$release_evidence_dir/self-host.json" \
  --token-drill "$release_evidence_dir/token-drill.json" \
  --interop-dir "$release_evidence_dir/interop"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$release_commit"
~~~

Expected: `closed_alpha_ready true` only when every independently parsed artifact passes and attests the same committed source and actual image. Preserve the protected evidence directory according to the documented retention policy. The five-run summary remains a separate expansion gate and is not synthesized from the release verifier.

---

## Specification Coverage Matrix

| Approved design section | Implementation tasks |
|---|---|
| 1-3 Purpose, product model, scope | Global Constraints, 17, 18, 19 |
| 4-6 stack, transport, repository structure | 1, 3, 4, 13, 14, 17 |
| 7 project authentication and token lifecycle | 2, 6, 8, 12, 14, 16, 17, 19 |
| 8 identity, registration, presence, retirement | 2, 7, 8, 11, 12, 18 |
| 9 message model | 5, 9, 10 |
| 10 commit-safe ordering and atomic send | 7, 9, 10, 12 |
| 11 cursor and delivery semantics | 5, 8, 11, 12, 16 |
| 12 tool contracts | 5, 13, 16 |
| 13 error and HTTP contract | 5, 13, 14, 16 |
| 14 checked-in agent instructions | 18 |
| 15 persistence and multi-tenant invariants | 3, 4, 6-12, 19 |
| 16 limits and abuse controls | 1, 5, 10, 14-16 |
| 17 HTTP and deployment security | 4, 14, 15, 17 |
| 18 hosted data handling | 15, 17-19 |
| 19 observability and audit | 6, 8, 10, 15, 16 |
| 20 testing strategy | 1-19 |
| 21 release readiness | 16-19 |
| 22 product hypothesis gate | 18, 19 |
| 23 deferred evolution | Global Constraints and source-boundary tests in 19 |

## Final Implementation Review

Before calling the implementation complete:

- [ ] Read the approved design and this plan from beginning to end.
- [ ] Confirm the MCP server still advertises exactly three tools.
- [ ] Confirm every tenant repository method requires projectId and no raw database handle crosses into apps/server.
- [ ] Confirm all lifecycle-sensitive paths share project -> token -> sorted agents -> delivery states locking and capture clock_timestamp() afterward.
- [ ] Confirm send validation and real MCP responses share the same result serializer and immutable limits.
- [ ] Confirm server, migration, administration, and deletion commands load only their intended credentials.
- [ ] Confirm the long-running container has no migration DSN and the one-shot migration container has no runtime DSN.
- [ ] Search source, tests, logs, evidence, and documentation for token/UUID/cursor sentinels and remove every occurrence outside dedicated input/output fixtures.
- [ ] Run the complete clean-checkout, real PostgreSQL, real MCP, Docker, token-drill, and physical interoperability gates.
- [ ] Record failures honestly; do not call one successful run proof of reliable agent behavior or open deferred product scope before four of five independent physical runs pass.
