import { createHash, createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAdminAuth } from "../src/admin/auth.js";
import { createAdminQueryService, type AdminQueryService } from "../src/admin/query-service.js";
import { createDatabase, type AgentMeshDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents, agents, messages, projects } from "../src/db/schema.js";
import { buildHttpApp } from "../src/http.js";
import { createProjectService } from "../src/projects/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const projectService = createProjectService({ db: database.db });
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const adminToken = Buffer.alloc(32, 9).toString("base64url");
const adminAuth = createAdminAuth({
  tokenDigest: createHash("sha256").update(adminToken, "utf8").digest(),
  sessionSigningKey: createHmac("sha256", signingKey)
    .update("agentmesh-admin-session-v1", "utf8")
    .digest(),
  secureCookies: false,
});
const queryService = createAdminQueryService({ db: database.db });

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await database.pool.query(
    "TRUNCATE TABLE activity_events, messages, agents, project_tokens, projects RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await database.pool.end();
});

function buildAdminApp(queries: AdminQueryService = queryService) {
  return buildHttpApp({
    db: database.db,
    signingKey,
    projectService,
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    logger: { write: () => {} },
    admin: { auth: adminAuth, queryService: queries },
  } as Parameters<typeof buildHttpApp>[0]);
}

function expectNoStore(response: { headers: Record<string, unknown> }) {
  expect(response.headers["cache-control"]).toBe("no-store");
}

async function login(app: ReturnType<typeof buildHttpApp>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/admin/session",
    payload: { token: adminToken },
  });
  expect(response.statusCode).toBe(204);
  expectNoStore(response);
  expect(response.headers["set-cookie"]).toContain("HttpOnly");
  return (response.headers["set-cookie"] as string).split(";", 1)[0] ?? "";
}

async function seedFixture() {
  const fixture = {
    projectA: randomUUID(),
    projectB: randomUUID(),
    agentA: randomUUID(),
    agentB: randomUUID(),
    messageA: randomUUID(),
    messageB: randomUUID(),
  };
  const recipientA = randomUUID();
  const recipientB = randomUUID();

  await database.db.insert(projects).values([
    { id: fixture.projectA, name: "alpha", createdAt: new Date("2026-08-29T10:00:00.000Z") },
    { id: fixture.projectB, name: "beta", createdAt: new Date("2026-08-30T10:00:00.000Z") },
  ]);
  await database.db.insert(agents).values([
    {
      id: fixture.agentA,
      projectId: fixture.projectA,
      registrationDigest: Buffer.alloc(32, 1),
      name: "alpha-sender",
      client: "codex",
      capabilities: ["plan"],
      lastSeenAt: new Date(),
    },
    {
      id: recipientA,
      projectId: fixture.projectA,
      registrationDigest: Buffer.alloc(32, 2),
      name: "alpha-recipient",
      client: "claude-code",
      capabilities: [],
      lastSeenAt: new Date(),
    },
    {
      id: fixture.agentB,
      projectId: fixture.projectB,
      registrationDigest: Buffer.alloc(32, 3),
      name: "beta-sender",
      client: "codex",
      capabilities: [],
      lastSeenAt: new Date(),
    },
    {
      id: recipientB,
      projectId: fixture.projectB,
      registrationDigest: Buffer.alloc(32, 4),
      name: "beta-recipient",
      client: "claude-code",
      capabilities: [],
      lastSeenAt: new Date(),
    },
  ]);
  await database.db.insert(messages).values([
    {
      id: fixture.messageA,
      projectId: fixture.projectA,
      senderAgentId: fixture.agentA,
      recipientAgentId: recipientA,
      text: "alpha message",
      idempotencyKey: randomUUID(),
    },
    {
      id: fixture.messageB,
      projectId: fixture.projectB,
      senderAgentId: fixture.agentB,
      recipientAgentId: recipientB,
      text: "beta private text",
      idempotencyKey: randomUUID(),
    },
  ]);
  await database.db.insert(activityEvents).values({
    id: randomUUID(),
    projectId: fixture.projectA,
    requestId: randomUUID(),
    eventType: "message.sent",
    outcome: "success",
    actorAgentId: fixture.agentA,
    targetAgentId: recipientA,
    messageId: fixture.messageA,
    metadata: { message_bytes: 13 },
  });
  return fixture;
}

describe("authenticated read-only admin HTTP API", () => {
  it("requires the signed admin cookie and safely manages the local session", async () => {
    const app = buildAdminApp();
    try {
      const page = await app.inject({ method: "GET", url: "/admin" });
      expect(page.statusCode).toBe(200);
      expectNoStore(page);
      expect(page.headers["content-security-policy"]).toMatch(/script-src 'nonce-[A-Za-z0-9+/]+={0,2}'/);
      expect(page.body).toContain("AgentMesh administration");

      const unauthorized = await app.inject({ method: "GET", url: "/api/admin/projects" });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toEqual({ error: "unauthorized" });
      expectNoStore(unauthorized);

      const bearerOnly = await app.inject({
        method: "GET",
        url: "/api/admin/projects",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(bearerOnly.statusCode).toBe(401);
      expect(bearerOnly.json()).toEqual({ error: "unauthorized" });
      expectNoStore(bearerOnly);

      const malformedLogin = await app.inject({
        method: "POST",
        url: "/admin/session",
        payload: { token: adminToken, ignored: true },
      });
      expect(malformedLogin.statusCode).toBe(400);
      expect(malformedLogin.json()).toEqual({ error: "invalid_request" });
      expectNoStore(malformedLogin);

      const invalidLogin = await app.inject({
        method: "POST",
        url: "/admin/session",
        payload: { token: "not-the-admin-token" },
      });
      expect(invalidLogin.statusCode).toBe(401);
      expect(invalidLogin.json()).toEqual({ error: "unauthorized" });
      expectNoStore(invalidLogin);

      const cookie = await login(app);
      const authenticatedPage = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { cookie },
      });
      expect(authenticatedPage.statusCode).toBe(200);
      expect(authenticatedPage.body).toContain('id="app"');
      expectNoStore(authenticatedPage);

      const logout = await app.inject({
        method: "DELETE",
        url: "/admin/session",
        headers: { cookie },
      });
      expect(logout.statusCode).toBe(204);
      expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
      expectNoStore(logout);

      const unsupportedPageMethod = await app.inject({ method: "POST", url: "/admin" });
      expect(unsupportedPageMethod.statusCode).toBe(404);
      expect(unsupportedPageMethod.json()).toEqual({ error: "not_found" });
      expectNoStore(unsupportedPageMethod);

      const unknownAdminPath = await app.inject({ method: "GET", url: "/admin/unknown" });
      expect(unknownAdminPath.statusCode).toBe(404);
      expect(unknownAdminPath.json()).toEqual({ error: "not_found" });
      expectNoStore(unknownAdminPath);
    } finally {
      await app.close();
    }
  });

  it("exposes only project-isolated read models and maps safe request failures", async () => {
    const fixture = await seedFixture();
    const app = buildAdminApp();
    try {
      const cookie = await login(app);
      const request = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

      const projectsResponse = await request("/api/admin/projects?limit=1");
      expect(projectsResponse.statusCode).toBe(200);
      expect(projectsResponse.json()).toEqual({
        items: [expect.objectContaining({ id: fixture.projectB, name: "beta" })],
        next_cursor: expect.any(String),
      });
      expectNoStore(projectsResponse);

      const summary = await request(`/api/admin/projects/${fixture.projectA}/summary`);
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toEqual(expect.objectContaining({
        project: expect.objectContaining({ id: fixture.projectA, name: "alpha" }),
      }));
      expectNoStore(summary);

      const malformedSummary = await request(`/api/admin/projects/${fixture.projectA}/summary?unexpected=true`);
      expect(malformedSummary.statusCode).toBe(400);
      expect(malformedSummary.json()).toEqual({ error: "invalid_request" });
      expectNoStore(malformedSummary);

      const agentsResponse = await request(`/api/admin/projects/${fixture.projectA}/agents`);
      expect(agentsResponse.statusCode).toBe(200);
      expect(agentsResponse.json()).toEqual(expect.objectContaining({ items: expect.arrayContaining([
        expect.objectContaining({ id: fixture.agentA, name: "alpha-sender" }),
      ]) }));
      expectNoStore(agentsResponse);

      const messagesResponse = await request(`/api/admin/projects/${fixture.projectA}/messages?acknowledged=false`);
      expect(messagesResponse.statusCode).toBe(200);
      expect(messagesResponse.json()).toEqual(expect.objectContaining({ items: [
        expect.objectContaining({ id: fixture.messageA, preview: "alpha message" }),
      ] }));
      expectNoStore(messagesResponse);

      const message = await request(`/api/admin/projects/${fixture.projectA}/messages/${fixture.messageA}`);
      expect(message.statusCode).toBe(200);
      expect(message.json()).toEqual(expect.objectContaining({ id: fixture.messageA, text: "alpha message" }));
      expectNoStore(message);

      const malformedDetail = await request(
        `/api/admin/projects/${fixture.projectA}/messages/${fixture.messageA}?unexpected=true`,
      );
      expect(malformedDetail.statusCode).toBe(400);
      expect(malformedDetail.json()).toEqual({ error: "invalid_request" });
      expectNoStore(malformedDetail);

      const eventsResponse = await request(`/api/admin/projects/${fixture.projectA}/events?event_type=message.sent`);
      expect(eventsResponse.statusCode).toBe(200);
      expect(eventsResponse.json()).toEqual(expect.objectContaining({ items: [
        expect.objectContaining({ event_type: "message.sent", message_id: fixture.messageA }),
      ] }));
      expectNoStore(eventsResponse);

      const malformed = await request("/api/admin/projects?limit=not-a-number");
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: "invalid_request" });
      expectNoStore(malformed);

      const missing = await request(`/api/admin/projects/${fixture.projectA}/messages/${fixture.messageB}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "not_found" });
      expect(JSON.stringify(missing.json())).not.toContain("beta private text");
      expectNoStore(missing);

      const nonGet = await app.inject({
        method: "POST",
        url: "/api/admin/projects",
        headers: { cookie },
      });
      expect(nonGet.statusCode).toBe(404);
      expect(nonGet.json()).toEqual({ error: "not_found" });
      expectNoStore(nonGet);

      const unknownApiPath = await app.inject({
        method: "GET",
        url: "/api/admin/unknown",
        headers: { cookie },
      });
      expect(unknownApiPath.statusCode).toBe(404);
      expect(unknownApiPath.json()).toEqual({ error: "not_found" });
      expectNoStore(unknownApiPath);

      const head = await app.inject({
        method: "HEAD",
        url: "/api/admin/projects",
        headers: { cookie },
      });
      expect(head.statusCode).toBe(404);
      expectNoStore(head);
    } finally {
      await app.close();
    }
  });

  it("returns safe no-store 404s for all admin surfaces without admin configuration", async () => {
    const app = buildHttpApp({
      db: database.db,
      signingKey,
      projectService,
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1", "localhost"],
      logger: { write: () => {} },
      admin: null,
    } as Parameters<typeof buildHttpApp>[0]);
    try {
      for (const request of [
        { method: "GET" as const, url: "/admin" },
        { method: "POST" as const, url: "/admin/session" },
        { method: "GET" as const, url: "/api/admin/projects" },
        { method: "POST" as const, url: "/api/admin/projects" },
        { method: "GET" as const, url: "/api/admin/unknown" },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "not_found" });
        expectNoStore(response);
      }
    } finally {
      await app.close();
    }
  });

  it("hides database failures behind the stable unavailable response", async () => {
    const secret = "database internals must never escape";
    const unavailableDb = new Proxy(database.db, {
      get() {
        return () => {
          throw new Error(secret);
        };
      },
    }) as AgentMeshDatabase;
    const app = buildAdminApp(createAdminQueryService({ db: unavailableDb }));
    try {
      const cookie = await login(app);
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/projects",
        headers: { cookie },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "temporarily_unavailable" });
      expect(response.body).not.toContain(secret);
      expectNoStore(response);
    } finally {
      await app.close();
    }
  });
});
