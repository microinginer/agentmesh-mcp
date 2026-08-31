import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditService } from "../src/audit/service.js";
import type { WebAuthConfig } from "../src/config.js";
import { encodeAdminCursor } from "../src/admin/contracts.js";
import { createProjectReadService } from "../src/control/read-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents, agents, messages, oauthIdentities, projects, users } from "../src/db/schema.js";
import * as schema from "../src/db/schema.js";
import { buildHttpApp } from "../src/http.js";
import { createProjectService } from "../src/projects/service.js";
import type { GitHubOAuthClient } from "../src/web-auth/github-client.js";
import { createIdentityService } from "../src/web-auth/identity-service.js";
import { createWebSessionService } from "../src/web-auth/session-service.js";
import { deriveWebAuthKeys } from "../src/web-auth/session-token.js";
import { resetDatabase } from "./support/database.js";
import { createTestClock } from "./support/hosted.js";

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const now = new Date("2026-08-31T12:00:00.000Z");
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const webAuthKey = Buffer.alloc(32, 41);

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

interface ReadFixture {
  ownerA: string;
  ownerB: string;
  projectA: string;
  projectB: string;
  archivedA: string;
  agentA: string;
  agentA2: string;
  agentB: string;
  agentB2: string;
  messageA: string;
  messageB: string;
}

async function seedReadFixture(): Promise<ReadFixture> {
  const [ownerA, ownerB] = await database.db.insert(users).values([
    { displayName: "Owner A" },
    { displayName: "Owner B" },
  ]).returning();
  if (ownerA === undefined || ownerB === undefined) throw new Error("owner insert failed");

  const fixture = {
    ownerA: ownerA.id,
    ownerB: ownerB.id,
    projectA: randomUUID(),
    projectB: randomUUID(),
    archivedA: randomUUID(),
    agentA: randomUUID(),
    agentA2: randomUUID(),
    agentB: randomUUID(),
    agentB2: randomUUID(),
    messageA: randomUUID(),
    messageB: randomUUID(),
  };
  await database.db.insert(projects).values([
    { id: fixture.projectA, ownerUserId: fixture.ownerA, name: "alpha" },
    { id: fixture.projectB, ownerUserId: fixture.ownerB, name: "beta" },
    {
      id: fixture.archivedA,
      ownerUserId: fixture.ownerA,
      name: "archived-alpha",
      status: "archived",
      archivedAt: new Date("2026-08-31T11:00:00.000Z"),
    },
  ]);
  await database.db.insert(agents).values([
    {
      id: fixture.agentA,
      projectId: fixture.projectA,
      registrationDigest: Buffer.alloc(32, 1),
      name: "alpha-sender",
      client: "codex",
      capabilities: ["messages"],
      lastSeenAt: new Date("2026-08-31T11:59:00.000Z"),
    },
    {
      id: fixture.agentA2,
      projectId: fixture.projectA,
      registrationDigest: Buffer.alloc(32, 2),
      name: "alpha-recipient",
      client: "codex",
      lastSeenAt: new Date("2026-08-31T11:40:00.000Z"),
    },
    {
      id: fixture.agentB,
      projectId: fixture.projectB,
      registrationDigest: Buffer.alloc(32, 3),
      name: "beta-sender",
      client: "codex",
      lastSeenAt: new Date("2026-08-31T10:00:00.000Z"),
    },
    {
      id: fixture.agentB2,
      projectId: fixture.projectB,
      registrationDigest: Buffer.alloc(32, 4),
      name: "beta-recipient",
      client: "codex",
      lastSeenAt: new Date("2026-08-31T10:00:00.000Z"),
    },
  ]);
  await database.db.insert(messages).values([
    {
      id: fixture.messageA,
      projectId: fixture.projectA,
      senderAgentId: fixture.agentA,
      recipientAgentId: fixture.agentA2,
      text: "owner A private body",
      idempotencyKey: randomUUID(),
    },
    {
      id: fixture.messageB,
      projectId: fixture.projectB,
      senderAgentId: fixture.agentB,
      recipientAgentId: fixture.agentB2,
      text: "owner B planted private body",
      idempotencyKey: randomUUID(),
    },
  ]);
  await database.db.insert(activityEvents).values({
    projectId: fixture.projectA,
    requestId: randomUUID(),
    eventType: "message.sent",
    outcome: "success",
    actorAgentId: fixture.agentA,
    targetAgentId: fixture.agentA2,
    messageId: fixture.messageA,
    metadata: { message_bytes: 20 },
  });
  return fixture;
}

describe("scope-aware project reads", () => {
  it("keeps every owner child query scoped in SQL and preserves archived reads", async () => {
    const fixture = await seedReadFixture();
    const statements: string[] = [];
    const service = createProjectReadService({
      clock: () => now,
      db: drizzle({
        client: database.pool,
        logger: { logQuery(query) { statements.push(query); } },
        schema,
      }),
    });
    const ownerScope = { kind: "owner" as const, userId: fixture.ownerA };

    const overview = await service.getOverview(ownerScope, fixture.projectA);
    const listedAgents = await service.listAgents(ownerScope, fixture.projectA, { limit: 50 });
    const listedMessages = await service.listMessages(ownerScope, fixture.projectA, { limit: 50 });
    const detail = await service.getMessage(ownerScope, fixture.projectA, fixture.messageA);
    const events = await service.listEvents(ownerScope, fixture.projectA, { limit: 50 });
    const archived = await service.getOverview(ownerScope, fixture.archivedA);

    expect(overview).toMatchObject({ found: true, data: { project: { id: fixture.projectA } } });
    expect(listedAgents).toMatchObject({ found: true, data: { items: expect.any(Array) } });
    expect(listedMessages).toMatchObject({
      found: true,
      data: { items: [expect.objectContaining({ id: fixture.messageA, preview: "owner A private body" })] },
    });
    expect(detail).toMatchObject({ found: true, data: { id: fixture.messageA, text: "owner A private body" } });
    expect(events).toMatchObject({ found: true, data: { items: [expect.objectContaining({ message_id: fixture.messageA })] } });
    expect(archived).toMatchObject({ found: true, data: { project: { id: fixture.archivedA } } });

    const childStatements = statements.filter((statement) =>
      /\b(?:agents|messages|activity_events)\b/.test(statement),
    );
    expect(childStatements.length).toBeGreaterThanOrEqual(7);
    expect(childStatements.every((statement) => (
      /(?:from|join) "projects"/.test(statement)
      && /"projects"\."id" = \$\d+/.test(statement)
      && /"projects"\."owner_user_id" = \$\d+/.test(statement)
    ))).toBe(true);
  });

  it("never returns another owner's message before or after an ownership change", async () => {
    const fixture = await seedReadFixture();
    const service = createProjectReadService({ db: database.db, clock: () => now });
    const ownerA = { kind: "owner" as const, userId: fixture.ownerA };
    const ownerB = { kind: "owner" as const, userId: fixture.ownerB };

    expect(await service.listMessages(ownerB, fixture.projectA, { limit: 50 })).toEqual({ found: false });
    expect(await service.getMessage(ownerB, fixture.projectA, fixture.messageA)).toEqual({ found: false });

    await database.db.update(projects).set({ ownerUserId: fixture.ownerB }).where(
      eq(projects.id, fixture.projectA),
    );

    expect(await service.listMessages(ownerA, fixture.projectA, { limit: 50 })).toEqual({ found: false });
    expect(await service.getMessage(ownerA, fixture.projectA, fixture.messageA)).toEqual({ found: false });
    expect(await service.getMessage(ownerB, fixture.projectA, fixture.messageA)).toMatchObject({
      found: true,
      data: { text: "owner A private body" },
    });
  });

  it("omits message content from operator and legacy-compatible read DTOs", async () => {
    const fixture = await seedReadFixture();
    const service = createProjectReadService({ db: database.db, clock: () => now });

    const listed = await service.listMessages({ kind: "operator" }, fixture.projectA, { limit: 50 });
    const detail = await service.getMessage({ kind: "operator" }, fixture.projectA, fixture.messageA);
    const serialized = JSON.stringify({ listed, detail });

    expect(listed).toMatchObject({ found: true, data: { items: [expect.objectContaining({ id: fixture.messageA })] } });
    expect(detail).toMatchObject({ found: true, data: { id: fixture.messageA } });
    expect(serialized).not.toContain("owner A private body");
    expect(serialized).not.toContain('"text"');
    expect(serialized).not.toContain('"preview"');
  });

  it("keeps sequence cursors bounded and owner filters drainable", async () => {
    const fixture = await seedReadFixture();
    const service = createProjectReadService({ db: database.db, clock: () => now });
    const owner = { kind: "owner" as const, userId: fixture.ownerA };
    const first = await service.listMessages(owner, fixture.projectA, { limit: 1 });
    if (!first.found) throw new Error("project must be readable");
    const sequence = first.data.items[0]?.sequence ?? 0;
    const live = await service.listMessages(owner, fixture.projectA, {
      limit: 1,
      after: encodeAdminCursor({ kind: "sequence", sequence }),
    });
    expect(live).toMatchObject({ found: true, data: { items: [], has_more: false, next_cursor: null } });
  });
});

function webConfig(operatorIds: ReadonlySet<string> = new Set()): WebAuthConfig {
  const config = {
    clientId: "test-client-id",
    callbackUrl: new URL("http://127.0.0.1/auth/github/callback"),
    publicOrigin: new URL("http://127.0.0.1"),
    operatorGitHubIds: operatorIds,
    projectLimit: 5,
    tokenTtlDays: 90,
    secureCookies: false,
  } as Omit<WebAuthConfig, "clientSecret" | "authKey">;
  Object.defineProperties(config, {
    clientSecret: { value: "test-client-secret", enumerable: false },
    authKey: { value: webAuthKey, enumerable: false },
  });
  return config as WebAuthConfig;
}

const unusedGitHub: GitHubOAuthClient = {
  authorizationUrl: () => new URL("https://github.example.test/authorize"),
  exchangeCode: async () => { throw new Error("not used"); },
  fetchProfile: async () => { throw new Error("not used"); },
};

describe("owner read HTTP routes", () => {
  it("returns no-store safe envelopes, strict bounds, and indistinguishable 404s", async () => {
    const fixture = await seedReadFixture();
    await database.db.insert(oauthIdentities).values([
      { userId: fixture.ownerA, provider: "github", providerUserId: "7001", login: "owner-a" },
      { userId: fixture.ownerB, provider: "github", providerUserId: "7002", login: "owner-b" },
    ]);
    const clock = createTestClock(now.toISOString());
    const config = webConfig();
    const sessionService = createWebSessionService({
      db: database.db,
      keys: deriveWebAuthKeys(config.authKey),
      clock: clock.now,
    });
    const sessionA = await sessionService.issue(fixture.ownerA, clock.now());
    const sessionB = await sessionService.issue(fixture.ownerB, clock.now());
    if (sessionA === null || sessionB === null) throw new Error("session issue failed");
    const app = buildHttpApp({
      db: database.db,
      signingKey,
      projectService: createProjectService({ db: database.db, clock: clock.now }),
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1", "localhost"],
      admin: null,
      logger: { write: () => {} },
      web: {
        db: database.db,
        config,
        githubClient: unusedGitHub,
        identityService: createIdentityService({ db: database.db, clock: clock.now }),
        sessionService,
        auditService: createAuditService({ db: database.db, clock: clock.now }),
        clock: clock.now,
      },
    });
    try {
      const cookieA = `agentmesh_session=${sessionA.sessionToken}`;
      const cookieB = `agentmesh_session=${sessionB.sessionToken}`;
      for (const path of [
        `/api/v1/projects/${fixture.projectA}/overview`,
        `/api/v1/projects/${fixture.projectA}/agents`,
        `/api/v1/projects/${fixture.projectA}/messages`,
        `/api/v1/projects/${fixture.projectA}/messages/${fixture.messageA}`,
        `/api/v1/projects/${fixture.projectA}/events`,
        `/api/v1/projects/${fixture.archivedA}/overview`,
      ]) {
        const response = await app.inject({ method: "GET", url: path, headers: { cookie: cookieA } });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fixture.projectA}/messages/${fixture.messageA}`,
        headers: { cookie: cookieA },
      });
      expect(detail.json()).toMatchObject({ message: { text: "owner A private body" } });

      for (const cookie of [cookieB]) {
        const foreign = await app.inject({
          method: "GET",
          url: `/api/v1/projects/${fixture.projectA}/messages/${fixture.messageA}`,
          headers: { cookie },
        });
        expect(foreign.statusCode).toBe(404);
        expect(foreign.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
        expect(JSON.stringify(foreign.json())).not.toContain("owner A private body");
      }

      for (const suffix of [
        "?limit=0",
        "?limit=101",
        `?cursor=${"x".repeat(700)}`,
        "?after=bad%20cursor",
        "?unexpected=1",
        "?limit=1&limit=2",
      ]) {
        const invalid = await app.inject({
          method: "GET",
          url: `/api/v1/projects/${fixture.projectA}/messages${suffix}`,
          headers: { cookie: cookieA },
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.headers["cache-control"]).toBe("no-store");
        expect(invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      }
    } finally {
      await app.close();
    }
  });
});
