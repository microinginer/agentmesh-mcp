import Fastify, { type FastifyInstance } from "fastify";
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { oauthIdentities, users, webSessions } from "../src/db/schema.js";
import { createWebAuthMiddleware } from "../src/web-auth/middleware.js";
import { createWebSessionService, type WebSessionService } from "../src/web-auth/session-service.js";
import { deriveWebAuthKeys, verifyCsrfToken } from "../src/web-auth/session-token.js";
import { resetDatabase } from "./support/database.js";
import { createTestClock } from "./support/hosted.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const keys = deriveWebAuthKeys(Buffer.alloc(32, 7));
const publicOrigin = new URL("https://agentmesh.example");

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

async function seedUser(input: { githubUserId?: string; blockedAt?: Date | null } = {}) {
  const [user] = await database.db.insert(users).values({
    displayName: "Octocat",
    avatarUrl: "https://avatars.example/octocat.png",
    blockedAt: input.blockedAt,
  }).returning();
  if (user === undefined) {
    throw new Error("User fixture creation failed");
  }
  await database.db.insert(oauthIdentities).values({
    userId: user.id,
    provider: "github",
    providerUserId: input.githubUserId ?? "4242",
    login: "octocat",
  });
  return user;
}

function expectSafeError(response: { statusCode: number; json(): unknown }, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({
    error: {
      code,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
}

function createProtectedApp(input: {
  service: WebSessionService;
  operatorGitHubIds?: ReadonlySet<string>;
  sessionCookieName?: string;
}): FastifyInstance {
  const app = Fastify();
  const middleware = createWebAuthMiddleware({
    sessionService: input.service,
    sessionCookieName: input.sessionCookieName ?? "agentmesh_session",
    publicOrigin,
    operatorGitHubIds: input.operatorGitHubIds ?? new Set(["4242"]),
  });
  middleware.register(app);
  app.get("/session", { preHandler: middleware.requireSession }, (request) => ({
    user_id: request.webSession?.userId,
  }));
  app.post("/mutation", { preHandler: middleware.requireMutation }, async () => ({ ok: true }));
  app.get("/operator", { preHandler: middleware.requireOperator }, async () => ({ ok: true }));
  return app;
}

describe("database-backed web sessions", () => {
  it("stores only keyed digests and keeps issued credentials out of serialization", async () => {
    const user = await seedUser();
    const now = new Date("2026-08-01T00:00:00.000Z");
    const service = createWebSessionService({ db: database.db, keys, clock: () => now });

    const issued = await service.issue(user.id);
    const [stored] = await database.db.select().from(webSessions);
    expect(issued).not.toBeNull();
    if (issued === null) return;

    expect(stored?.tokenDigest).not.toEqual(Buffer.from(issued.sessionToken, "utf8"));
    expect(stored?.csrfDigest).not.toEqual(Buffer.from(issued.csrfToken, "utf8"));
    expect(stored?.tokenDigest).toEqual(issued.sessionDigest);
    expect(stored?.csrfDigest).toEqual(issued.csrfDigest);
    expect(JSON.stringify(issued)).not.toContain(issued.sessionToken);
    expect(JSON.stringify(issued)).not.toContain(issued.csrfToken);
    expect({ ...issued }).not.toHaveProperty("sessionToken");
    expect({ ...issued }).not.toHaveProperty("csrfToken");
  });

  it("does not create sessions for missing or blocked users", async () => {
    const clock = createTestClock("2026-08-01T00:00:00Z");
    const service = createWebSessionService({ db: database.db, keys, clock: clock.now });
    const blocked = await seedUser({ githubUserId: "4343", blockedAt: clock.now() });

    await expect(service.issue("00000000-0000-4000-8000-000000000000")).resolves.toBeNull();
    await expect(service.issue(blocked.id)).resolves.toBeNull();
    const invalidClock = createTestClock("invalid");
    await expect(createWebSessionService({ db: database.db, keys, clock: invalidClock.now }).issue(blocked.id)).resolves.toBeNull();
    const [sessions] = await database.db.select({ total: count() }).from(webSessions);
    expect(sessions?.total).toBe(0);
  });

  it("touches a session after five minutes without crossing its absolute expiry", async () => {
    const clock = createTestClock("2026-08-01T00:00:00Z");
    const user = await seedUser();
    const service = createWebSessionService({ db: database.db, keys, clock: clock.now });
    const issued = await service.issue(user.id);
    expect(issued).not.toBeNull();
    if (issued === null) return;

    clock.set("2026-08-01T00:04:59.999Z");
    const beforeThreshold = await service.authenticate(issued.sessionToken);
    expect(beforeThreshold?.idleExpiresAt.toISOString()).toBe("2026-08-08T00:00:00.000Z");

    clock.set("2026-08-07T23:00:00Z");
    const touched = await service.authenticate(issued.sessionToken);
    expect(touched?.idleExpiresAt.toISOString()).toBe("2026-08-14T23:00:00.000Z");
    expect(touched?.absoluteExpiresAt.toISOString()).toBe("2026-08-31T00:00:00.000Z");

    clock.set("2026-08-13T23:00:00Z");
    await expect(service.authenticate(issued.sessionToken)).resolves.toMatchObject({
      idleExpiresAt: new Date("2026-08-20T23:00:00.000Z"),
    });
    clock.set("2026-08-19T23:00:00Z");
    await expect(service.authenticate(issued.sessionToken)).resolves.toMatchObject({
      idleExpiresAt: new Date("2026-08-26T23:00:00.000Z"),
    });
    clock.set("2026-08-25T23:00:00Z");
    const capped = await service.authenticate(issued.sessionToken);
    expect(capped?.idleExpiresAt.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("rejects sessions at exact expiry, after revocation, blocking, or an invalid clock", async () => {
    const clock = createTestClock("2026-08-01T00:00:00Z");
    const user = await seedUser();
    const service = createWebSessionService({ db: database.db, keys, clock: clock.now });
    const issued = await service.issue(user.id);
    expect(issued).not.toBeNull();
    if (issued === null) return;

    clock.set("2026-08-08T00:00:00Z");
    await expect(service.authenticate(issued.sessionToken)).resolves.toBeNull();

    const absoluteBoundaryUser = await seedUser({ githubUserId: "4444" });
    const absoluteBoundary = await service.issue(absoluteBoundaryUser.id);
    expect(absoluteBoundary).not.toBeNull();
    if (absoluteBoundary === null) return;
    await database.db.update(webSessions).set({
      idleExpiresAt: new Date("2026-09-08T00:00:00.000Z"),
    }).where(eq(webSessions.id, absoluteBoundary.sessionId));
    clock.set("2026-09-07T00:00:00Z");
    await expect(service.authenticate(absoluteBoundary.sessionToken)).resolves.toBeNull();

    const replacement = await service.issue(user.id);
    expect(replacement).not.toBeNull();
    if (replacement === null) return;
    await service.revoke(replacement.sessionId);
    await expect(service.authenticate(replacement.sessionToken)).resolves.toBeNull();

    const active = await service.issue(user.id);
    expect(active).not.toBeNull();
    if (active === null) return;
    await database.db.update(users).set({ blockedAt: clock.now() }).where(eq(users.id, user.id));
    await expect(service.authenticate(active.sessionToken)).resolves.toBeNull();

    const invalidClockUser = await seedUser({ githubUserId: "4545" });
    const validClock = createTestClock("2026-08-02T00:00:00Z");
    const invalidClockService = createWebSessionService({ db: database.db, keys, clock: validClock.now });
    const invalidClockSession = await invalidClockService.issue(invalidClockUser.id);
    expect(invalidClockSession).not.toBeNull();
    if (invalidClockSession === null) return;
    validClock.set("invalid");
    await expect(invalidClockService.authenticate(invalidClockSession.sessionToken)).resolves.toBeNull();
  });

  it("keeps rotated credentials independent and bulk revocation idempotent", async () => {
    const user = await seedUser();
    const now = new Date("2026-08-01T00:00:00.000Z");
    const service = createWebSessionService({ db: database.db, keys, clock: () => now });
    const first = await service.issue(user.id);
    const second = await service.issue(user.id);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) return;

    expect(first.sessionToken).not.toBe(second.sessionToken);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    await Promise.all([service.revoke(first.sessionId), service.revoke(first.sessionId)]);
    await expect(service.authenticate(first.sessionToken)).resolves.toBeNull();
    await expect(service.authenticate(second.sessionToken)).resolves.toMatchObject({ sessionId: second.sessionId });

    await service.revokeAllForUser(user.id);
    await service.revokeAllForUser(user.id);
    await expect(service.authenticate(second.sessionToken)).resolves.toBeNull();
    const [active] = await database.db.select({ total: count() }).from(webSessions).where(and(
      eq(webSessions.userId, user.id),
      isNull(webSessions.revokedAt),
    ));
    expect(active?.total).toBe(0);
  });

  it("returns only identity and session snapshots while keeping the CSRF digest private", async () => {
    const user = await seedUser();
    const now = new Date("2026-08-01T00:00:00.000Z");
    const service = createWebSessionService({ db: database.db, keys, clock: () => now });
    const issued = await service.issue(user.id);
    expect(issued).not.toBeNull();
    if (issued === null) return;

    const authenticated = await service.authenticate(issued.sessionToken);
    expect(authenticated).toMatchObject({
      userId: user.id,
      githubUserId: "4242",
      githubLogin: "octocat",
      displayName: "Octocat",
      avatarUrl: "https://avatars.example/octocat.png",
      authenticatedAt: now,
    });
    expect(verifyCsrfToken(issued.csrfToken, authenticated!.csrfDigest, keys.csrfDigestKey)).toBe(true);
    expect(JSON.stringify(authenticated)).not.toContain(authenticated!.csrfDigest.toString("base64url"));
    expect({ ...authenticated! }).not.toHaveProperty("csrfDigest");
  });
});

describe("web session Fastify middleware", () => {
  it("requires only the selected AgentMesh cookie and rejects malformed or duplicate cookie input", async () => {
    const user = await seedUser();
    const service = createWebSessionService({ db: database.db, keys });
    const issued = await service.issue(user.id);
    expect(issued).not.toBeNull();
    if (issued === null) return;
    const app = createProtectedApp({ service });
    try {
      const validCookie = `agentmesh_session=${issued.sessionToken}`;
      expect((await app.inject({ method: "GET", url: "/session", headers: { cookie: validCookie } })).statusCode).toBe(200);
      expectSafeError(await app.inject({
        method: "GET", url: "/session", headers: { cookie: `agentmesh_admin_session=${issued.sessionToken}` },
      }), 401, "AUTH_REQUIRED");
      expectSafeError(await app.inject({
        method: "GET", url: "/session", headers: { cookie: `${validCookie}; agentmesh_session=${issued.sessionToken}` },
      }), 401, "AUTH_REQUIRED");
      expectSafeError(await app.inject({
        method: "GET", url: "/session", headers: { cookie: `${validCookie}; bare` },
      }), 401, "AUTH_REQUIRED");
      expectSafeError(await app.inject({
        method: "GET", url: "/session", headers: { cookie: `other=${"x".repeat(8_193)}` },
      }), 401, "AUTH_REQUIRED");
      expectSafeError(await app.inject({
        method: "GET", url: "/session", headers: { cookie: "agentmesh_session=not-canonical" },
      }), 401, "AUTH_REQUIRED");
    } finally {
      await app.close();
    }
  });

  it("requires an exact singleton Origin and canonical singleton CSRF header for mutations", async () => {
    const user = await seedUser();
    const service = createWebSessionService({ db: database.db, keys });
    const issued = await service.issue(user.id);
    expect(issued).not.toBeNull();
    if (issued === null) return;
    const app = createProtectedApp({ service });
    const cookie = `agentmesh_session=${issued.sessionToken}`;
    try {
      expect((await app.inject({
        method: "POST", url: "/mutation", headers: { cookie, origin: publicOrigin.origin, "x-csrf-token": issued.csrfToken },
      })).statusCode).toBe(200);
      expectSafeError(await app.inject({
        method: "POST", url: "/mutation", headers: { cookie, origin: "https://attacker.example", "x-csrf-token": issued.csrfToken },
      }), 403, "CSRF_FORBIDDEN");
      expectSafeError(await app.inject({
        method: "POST", url: "/mutation", headers: { cookie, "x-csrf-token": issued.csrfToken },
      }), 403, "CSRF_FORBIDDEN");
      expectSafeError(await app.inject({
        method: "POST", url: "/mutation", headers: { cookie, origin: publicOrigin.origin },
      }), 403, "CSRF_FORBIDDEN");
      expectSafeError(await app.inject({
        method: "POST", url: "/mutation", headers: { cookie, origin: publicOrigin.origin, "x-csrf-token": `${issued.csrfToken}x` },
      }), 403, "CSRF_FORBIDDEN");
      expectSafeError(await app.inject({
        method: "POST", url: "/mutation", headers: {
          cookie, origin: `${publicOrigin.origin}, ${publicOrigin.origin}`, "x-csrf-token": issued.csrfToken,
        } },
      ), 403, "CSRF_FORBIDDEN");
      expectSafeError(await app.inject({
        method: "POST", url: "/mutation", headers: {
          cookie, origin: publicOrigin.origin, "x-csrf-token": `${issued.csrfToken},${issued.csrfToken}`,
        } },
      ), 403, "CSRF_FORBIDDEN");
    } finally {
      await app.close();
    }
  });

  it("enforces immutable GitHub operator IDs and maps database failures to a safe 503", async () => {
    const operator = await seedUser({ githubUserId: "4242" });
    const nonOperator = await seedUser({ githubUserId: "4343" });
    const service = createWebSessionService({ db: database.db, keys });
    const operatorIssued = await service.issue(operator.id);
    const nonOperatorIssued = await service.issue(nonOperator.id);
    expect(operatorIssued).not.toBeNull();
    expect(nonOperatorIssued).not.toBeNull();
    if (operatorIssued === null || nonOperatorIssued === null) return;
    const app = createProtectedApp({ service, operatorGitHubIds: new Set(["4242"]) });
    const brokenService = {
      authenticate: async () => { throw new Error("database failure must stay private"); },
    } as unknown as WebSessionService;
    const brokenApp = createProtectedApp({ service: brokenService });
    try {
      expect((await app.inject({
        method: "GET", url: "/operator", headers: { cookie: `agentmesh_session=${operatorIssued.sessionToken}` },
      })).statusCode).toBe(200);
      expectSafeError(await app.inject({
        method: "GET", url: "/operator", headers: { cookie: `agentmesh_session=${nonOperatorIssued.sessionToken}` },
      }), 403, "OPERATOR_FORBIDDEN");
      const unavailable = await brokenApp.inject({
        method: "GET", url: "/session", headers: { cookie: `agentmesh_session=${operatorIssued.sessionToken}` },
      });
      expectSafeError(unavailable, 503, "AUTH_UNAVAILABLE");
      expect(unavailable.body).not.toContain("database failure");
    } finally {
      await app.close();
      await brokenApp.close();
    }
  });
});
