import Fastify, { type FastifyInstance } from "fastify";
import { and, count, eq, isNull } from "drizzle-orm";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClientRequest } from "node:http";
import type { PoolClient } from "pg";

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
const safeErrorMessages = {
  AUTH_REQUIRED: "Authentication is required",
  AUTH_UNAVAILABLE: "Authentication is temporarily unavailable",
  CSRF_FORBIDDEN: "Request validation failed",
  OPERATOR_FORBIDDEN: "Operator access is required",
} as const;
const errorForbiddenText = [
  "fake-cookie-value",
  "fake-session-token",
  "fake-csrf-token",
  "fake-digest-value",
  "database-error-cause",
];
const DATABASE_LOCK_TIMEOUT_MS = 2_000;
const LOOPBACK_REQUEST_TIMEOUT_MS = 1_000;
const MAX_LOOPBACK_RESPONSE_BYTES = 64 * 1_024;

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

function expectSafeError(
  response: { body: string; statusCode: number; json(): unknown },
  status: number,
  code: keyof typeof safeErrorMessages,
) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({
    error: {
      code,
      message: safeErrorMessages[code],
      request_id: expect.stringMatching(/^req-[a-z0-9]+$/),
    },
  });
  for (const forbidden of errorForbiddenText) {
    expect(response.body).not.toContain(forbidden);
  }
}

async function waitForDatabaseLocks(queryFragment: string, expectedCount: number): Promise<void> {
  const deadline = Date.now() + DATABASE_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await database.pool.query<{ waiting: number }>(`
      SELECT count(*)::int AS waiting
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state = 'active'
         AND wait_event_type = 'Lock'
         AND query ILIKE $1
    `, [`%${queryFragment}%`]);
    if (result.rows[0]?.waiting === expectedCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for session lock contenders");
}

interface HeldSessionLock {
  client: PoolClient;
  released: boolean;
}

async function lockSession(sessionId: string): Promise<HeldSessionLock> {
  const client = await database.pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query('SELECT id FROM web_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    return { client, released: false };
  } catch (error) {
    if (began) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    client.release();
    throw error;
  }
}

async function releaseSessionLock(lock: HeldSessionLock): Promise<void> {
  if (lock.released) return;
  lock.released = true;
  try {
    await lock.client.query("ROLLBACK");
  } finally {
    lock.client.release();
  }
}

async function rawHeaderRequest(
  app: FastifyInstance,
  method: "GET" | "POST",
  path: string,
  headers: readonly string[],
  body = "",
): Promise<{ body: string; statusCode: number }> {
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Loopback listener did not expose a TCP address");
    }
    return await new Promise((resolve, reject) => {
      let completed = false;
      let request: ClientRequest | null = null;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (error?: Error, value?: { body: string; statusCode: number }) => {
        if (completed) return;
        completed = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (request !== null && !request.destroyed) request.destroy();
        if (error !== undefined) reject(error);
        else if (value !== undefined) resolve(value);
      };
      request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method,
        path,
        headers: ["Host", "127.0.0.1", ...headers],
      }, (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
          if (Buffer.byteLength(responseBody, "utf8") > MAX_LOOPBACK_RESPONSE_BYTES) {
            finish(new Error("Loopback response exceeded test limit"));
          }
        });
        response.once("aborted", () => finish(new Error("Loopback response aborted")));
        response.once("error", (error) => finish(error));
        response.once("end", () => finish(undefined, { body: responseBody, statusCode: response.statusCode ?? 0 }));
      });
      request.once("error", (error) => finish(error));
      timeout = setTimeout(() => finish(new Error("Loopback request timed out")), LOOPBACK_REQUEST_TIMEOUT_MS);
      request.end(body);
    });
  } finally {
    await app.close();
  }
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
    const sensitiveProperties = ["sessionToken", "csrfToken", "sessionDigest", "csrfDigest"] as const;
    const serialized = JSON.stringify(issued);
    const spread = { ...issued };
    const enumerableKeys = Object.keys(issued);
    const errorText = new Error(serialized).message;
    const bodyText = JSON.stringify({ issued });
    for (const property of sensitiveProperties) {
      const value = issued[property];
      expect(value).toBeDefined();
      expect(serialized).not.toContain(Buffer.isBuffer(value) ? value.toString("base64url") : value);
      expect(spread).not.toHaveProperty(property);
      expect(enumerableKeys).not.toContain(property);
      expect(errorText).not.toContain(Buffer.isBuffer(value) ? value.toString("base64url") : value);
      expect(bodyText).not.toContain(Buffer.isBuffer(value) ? value.toString("base64url") : value);
    }
  });

  it("does not create sessions for missing or blocked users", async () => {
    const clock = createTestClock("2026-08-01T00:00:00Z");
    const service = createWebSessionService({ db: database.db, keys, clock: clock.now });
    const blocked = await seedUser({ githubUserId: "4343", blockedAt: clock.now() });

    await expect(service.issue("00000000-0000-4000-8000-000000000000")).resolves.toBeNull();
    await expect(service.issue(blocked.id)).resolves.toBeNull();
    const eligible = await seedUser({ githubUserId: "4545" });
    const invalidClock = createTestClock("invalid");
    await expect(createWebSessionService({ db: database.db, keys, clock: invalidClock.now }).issue(eligible.id)).resolves.toBeNull();
    await expect(service.issue(eligible.id, new Date(8.64e15))).resolves.toBeNull();
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

  it("rejects invalid-clock revocation without changing durable session rows", async () => {
    const user = await seedUser();
    const validClock = createTestClock("2026-08-01T00:00:00Z");
    const validService = createWebSessionService({ db: database.db, keys, clock: validClock.now });
    const single = await validService.issue(user.id);
    const bulk = await validService.issue(user.id);
    expect(single).not.toBeNull();
    expect(bulk).not.toBeNull();
    if (single === null || bulk === null) return;

    const invalidClock = createTestClock("invalid");
    const invalidService = createWebSessionService({ db: database.db, keys, clock: invalidClock.now });
    const singleFailure = await invalidService.revoke(single.sessionId).catch((error: unknown) => error);
    expect(singleFailure).toMatchObject({
      name: "WebSessionServiceUnavailableError",
      message: "Web session service unavailable",
    });
    expect(singleFailure).not.toHaveProperty("cause");
    await expect(invalidService.revokeAllForUser(user.id)).rejects.toThrow("Web session service unavailable");
    const [active] = await database.db.select({ total: count() }).from(webSessions).where(and(
      eq(webSessions.userId, user.id),
      isNull(webSessions.revokedAt),
    ));
    expect(active?.total).toBe(2);

    const restarted = createWebSessionService({ db: database.db, keys, clock: validClock.now });
    await expect(restarted.authenticate(single.sessionToken)).resolves.toMatchObject({ sessionId: single.sessionId });
    await expect(restarted.authenticate(bulk.sessionToken)).resolves.toMatchObject({ sessionId: bulk.sessionId });
    await restarted.revoke(single.sessionId);
    await expect(restarted.authenticate(single.sessionToken)).resolves.toBeNull();
  });

  it("serializes concurrent exact-five-minute touches and queued revocation before authentication", async () => {
    const issueClock = createTestClock("2026-08-01T00:00:00Z");
    const user = await seedUser();
    const issueService = createWebSessionService({ db: database.db, keys, clock: issueClock.now });
    const issued = await issueService.issue(user.id);
    expect(issued).not.toBeNull();
    if (issued === null) return;

    const clockA = createTestClock("2026-08-01T00:05:00.000Z");
    const clockB = createTestClock("2026-08-01T00:05:00.001Z");
    const serviceA = createWebSessionService({ db: database.db, keys, clock: clockA.now });
    const serviceB = createWebSessionService({ db: database.db, keys, clock: clockB.now });
    const started: Promise<unknown>[] = [];
    let touchLock: HeldSessionLock | null = null;
    let revokeLock: HeldSessionLock | null = null;
    try {
      touchLock = await lockSession(issued.sessionId);
      const contenderA = serviceA.authenticate(issued.sessionToken);
      started.push(contenderA);
      await waitForDatabaseLocks('from "web_sessions"', 1);
      const contenderB = serviceB.authenticate(issued.sessionToken);
      started.push(contenderB);
      await waitForDatabaseLocks('from "web_sessions"', 2);
      await releaseSessionLock(touchLock);
      touchLock = null;
      const [first, second] = await Promise.all([contenderA, contenderB]);
      expect(first?.idleExpiresAt.toISOString()).toBe("2026-08-08T00:05:00.000Z");
      expect(second?.idleExpiresAt.toISOString()).toBe("2026-08-08T00:05:00.000Z");
      const [storedTouch] = await database.db.select().from(webSessions).where(eq(webSessions.id, issued.sessionId));
      expect(storedTouch?.lastSeenAt.toISOString()).toBe("2026-08-01T00:05:00.000Z");
      expect(storedTouch?.idleExpiresAt.toISOString()).toBe("2026-08-08T00:05:00.000Z");

      revokeLock = await lockSession(issued.sessionId);
      const queuedRevoke = serviceA.revoke(issued.sessionId);
      started.push(queuedRevoke);
      await waitForDatabaseLocks('update "web_sessions"', 1);
      const afterQueuedRevoke = serviceB.authenticate(issued.sessionToken);
      started.push(afterQueuedRevoke);
      await releaseSessionLock(revokeLock);
      revokeLock = null;
      await queuedRevoke;
      await expect(afterQueuedRevoke).resolves.toBeNull();
    } finally {
      if (touchLock !== null) await releaseSessionLock(touchLock);
      if (revokeLock !== null) await releaseSessionLock(revokeLock);
      await Promise.allSettled(started);
    }
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
    const csrfDigest = authenticated!.csrfDigest;
    expect(csrfDigest).toBeDefined();
    expect(JSON.stringify(authenticated)).not.toContain(csrfDigest.toString("base64url"));
    expect({ ...authenticated! }).not.toHaveProperty("csrfDigest");
    expect(Object.keys(authenticated!)).not.toContain("csrfDigest");
    expect(new Error(JSON.stringify(authenticated)).message).not.toContain(csrfDigest.toString("base64url"));
    expect(JSON.stringify({ session: authenticated })).not.toContain(csrfDigest.toString("base64url"));
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

  it("rejects repeated raw Cookie, Origin, and CSRF header fields over a loopback listener", async () => {
    const user = await seedUser();
    const service = createWebSessionService({ db: database.db, keys });
    const issued = await service.issue(user.id);
    expect(issued).not.toBeNull();
    if (issued === null) return;
    const cookie = `agentmesh_session=${issued.sessionToken}`;

    const cookieApp = createProtectedApp({ service });
    const duplicateCookie = await rawHeaderRequest(cookieApp, "GET", "/session", [
      "Cookie", cookie,
      "Cookie", cookie,
    ]);
    expectSafeError({ ...duplicateCookie, json: () => JSON.parse(duplicateCookie.body) }, 401, "AUTH_REQUIRED");

    const originApp = createProtectedApp({ service });
    const duplicateOrigin = await rawHeaderRequest(originApp, "POST", "/mutation", [
      "Cookie", cookie,
      "Origin", publicOrigin.origin,
      "Origin", publicOrigin.origin,
      "X-CSRF-Token", issued.csrfToken,
      "Content-Type", "application/json",
      "Content-Length", "2",
    ], "{}");
    expectSafeError({ ...duplicateOrigin, json: () => JSON.parse(duplicateOrigin.body) }, 403, "CSRF_FORBIDDEN");

    const csrfApp = createProtectedApp({ service });
    const duplicateCsrf = await rawHeaderRequest(csrfApp, "POST", "/mutation", [
      "Cookie", cookie,
      "Origin", publicOrigin.origin,
      "X-CSRF-Token", issued.csrfToken,
      "X-CSRF-Token", issued.csrfToken,
      "Content-Type", "application/json",
      "Content-Length", "2",
    ], "{}");
    expectSafeError({ ...duplicateCsrf, json: () => JSON.parse(duplicateCsrf.body) }, 403, "CSRF_FORBIDDEN");
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
      authenticate: async () => { throw new Error("database-error-cause fake-cookie-value fake-session-token fake-csrf-token fake-digest-value"); },
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
