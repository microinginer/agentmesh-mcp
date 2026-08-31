import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuditService } from "../src/audit/service.js";
import type { RateLimitConfig, WebAuthConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { oauthIdentities, projects, users } from "../src/db/schema.js";
import { buildHttpApp } from "../src/http.js";
import { createSafeLogger } from "../src/logging.js";
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
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const webAuthKey = Buffer.alloc(32, 63);
const fixedNow = "2026-08-31T12:00:00.000Z";

const unusedGitHub: GitHubOAuthClient = {
  authorizationUrl: () => new URL("https://github.example.test/authorize"),
  exchangeCode: async () => { throw new Error("not used"); },
  fetchProfile: async () => { throw new Error("not used"); },
};

const testLimits: RateLimitConfig = {
  oauthStart: 2,
  ownerRead: 2,
  ownerMutation: 20,
  connectionCreate: 2,
  mcp: 2,
};

class CapturingStore {
  static readonly keys: string[] = [];
  readonly counters = new Map<string, { current: number; startedAt: number }>();

  child(): CapturingStore {
    return new CapturingStore();
  }

  incr(
    key: string,
    callback: (error: Error | null, result: { current: number; ttl: number }) => void,
    timeWindow: number,
  ): void {
    CapturingStore.keys.push(key);
    const now = Date.now();
    const previous = this.counters.get(key);
    const current = previous === undefined || previous.startedAt + timeWindow <= now
      ? { current: 1, startedAt: now }
      : { current: previous.current + 1, startedAt: previous.startedAt };
    this.counters.set(key, current);
    callback(null, { current: current.current, ttl: Math.max(1, timeWindow - (now - current.startedAt)) });
  }
}

class FailingStore {
  child(): FailingStore {
    return new FailingStore();
  }

  incr(
    _key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
  ): void {
    callback(new Error("planted rate-store failure must not escape"));
  }
}

function webConfig(): WebAuthConfig {
  const config = {
    clientId: "test-client-id",
    callbackUrl: new URL("http://127.0.0.1/auth/github/callback"),
    publicOrigin: new URL("http://127.0.0.1"),
    operatorGitHubIds: new Set<string>(),
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

async function buildFixture(input: {
  limits?: RateLimitConfig;
  readinessCheck?: () => Promise<boolean>;
  logger?: { write(event: never): void };
  store?: typeof CapturingStore;
} = {}) {
  const clock = createTestClock(fixedNow);
  const config = webConfig();
  const sessionService = createWebSessionService({
    db: database.db,
    keys: deriveWebAuthKeys(config.authKey),
    clock: clock.now,
  });
  const [user] = await database.db.insert(users).values({ displayName: "Security owner" }).returning();
  if (user === undefined) throw new Error("user insert failed");
  await database.db.insert(oauthIdentities).values({
    userId: user.id,
    provider: "github",
    providerUserId: "99001",
    login: "security-owner",
  });
  const session = await sessionService.issue(user.id, clock.now());
  if (session === null) throw new Error("session issue failed");
  const [project] = await database.db.insert(projects).values({
    ownerUserId: user.id,
    name: "Security project",
  }).returning();
  if (project === undefined) throw new Error("project insert failed");

  const app = buildHttpApp({
    db: database.db,
    signingKey,
    projectService: createProjectService({ db: database.db, clock: clock.now }),
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    admin: null,
    logger: input.logger as never,
    rateLimits: input.limits ?? testLimits,
    ...(input.store === undefined ? {} : { rateLimitStore: input.store }),
    ...(input.readinessCheck === undefined ? {} : { readinessCheck: input.readinessCheck }),
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

  return {
    app,
    project,
    session,
    user,
    headers: {
      cookie: `agentmesh_session=${session.sessionToken}`,
      origin: "http://127.0.0.1",
      "x-csrf-token": session.csrfToken,
    },
  };
}

function expectSecurityHeaders(headers: Record<string, unknown>): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["content-security-policy"]).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

async function listenLoopback(app: FastifyInstance): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback listener");
  return address.port;
}

async function rawDuplicateIdempotencyRequest(input: {
  port: number;
  projectId: string;
  cookie: string;
  csrf: string;
  firstKey: string;
  secondKey: string;
}): Promise<{ statusCode: number; body: string }> {
  let socket: Socket | undefined;
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket?.destroy();
      reject(new Error("raw request timed out"));
    }, 2_000);
    socket = connect({ host: "127.0.0.1", port: input.port }, () => {
      const body = JSON.stringify({ label: "Raw duplicate" });
      socket?.write([
        `POST /api/v1/projects/${input.projectId}/connections HTTP/1.1`,
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        `Cookie: ${input.cookie}`,
        "Origin: http://127.0.0.1",
        `X-CSRF-Token: ${input.csrf}`,
        `Idempotency-Key: ${input.firstKey}`,
        `Idempotency-Key: ${input.secondKey}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"));
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      const response = Buffer.concat(chunks).toString("utf8");
      const [head = "", body = ""] = response.split("\r\n\r\n", 2);
      const status = /^HTTP\/1\.1 (\d{3})\b/.exec(head)?.[1];
      if (status === undefined) return reject(new Error("missing raw response status"));
      resolve({ statusCode: Number(status), body });
    });
  }).finally(() => socket?.destroy());
}

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  CapturingStore.keys.length = 0;
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

describe("hosted release security controls", () => {
  it("keeps OAuth start and callback IP buckets independent and opaque", async () => {
    const fixture = await buildFixture({ store: CapturingStore });
    const cookies: string[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const started = await fixture.app.inject({ method: "GET", url: "/auth/github/start" });
        expect(started.statusCode).toBe(302);
        const cookie = String(started.headers["set-cookie"] ?? "");
        cookies.push(cookie);
      }
      const limitedStart = await fixture.app.inject({ method: "GET", url: "/auth/github/start" });
      expect(limitedStart.statusCode).toBe(429);

      expect((await fixture.app.inject({ method: "GET", url: "/auth/github/callback?error=cancelled" })).statusCode).toBe(303);
      expect((await fixture.app.inject({ method: "GET", url: "/auth/github/callback?error=cancelled" })).statusCode).toBe(303);
      const limitedCallback = await fixture.app.inject({ method: "GET", url: "/auth/github/callback?error=cancelled" });
      expect(limitedCallback.statusCode).toBe(429);
      expect(limitedCallback.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });

      expect(CapturingStore.keys.some((key) => key.startsWith("oauth-start:"))).toBe(true);
      expect(CapturingStore.keys.some((key) => key.startsWith("oauth-callback:"))).toBe(true);
      for (const key of CapturingStore.keys) {
        for (const cookie of cookies) expect(key).not.toContain(cookie);
      }
    } finally {
      await fixture.app.close();
    }
  });

  it("rate limits connection creation independently after authentication without storing raw credentials", async () => {
    const fixture = await buildFixture({ store: CapturingStore });
    const secrets = [fixture.session.sessionToken, fixture.session.csrfToken];
    try {
      for (let index = 0; index < 2; index += 1) {
        const response = await fixture.app.inject({
          method: "POST",
          url: `/api/v1/projects/${fixture.project.id}/connections`,
          headers: { ...fixture.headers, "idempotency-key": randomUUID() },
          payload: { label: `Computer ${index + 1}` },
        });
        expect(response.statusCode).toBe(201);
        const secret = response.json().secret;
        if (typeof secret === "string") secrets.push(secret);
      }

      const limited = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/projects/${fixture.project.id}/connections`,
        headers: { ...fixture.headers, "idempotency-key": randomUUID() },
        payload: { label: "Computer 3" },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          request_id: limited.json().error.request_id,
        },
      });
      expect(limited.json().error.request_id).toBeTypeOf("string");
      expectSecurityHeaders(limited.headers);

      const independentRead = await fixture.app.inject({
        method: "GET",
        url: "/api/v1/projects?limit=50",
        headers: { cookie: fixture.headers.cookie },
      });
      expect(independentRead.statusCode).toBe(200);
      expect(CapturingStore.keys.length).toBeGreaterThan(0);
      for (const key of CapturingStore.keys) {
        expect(key).toMatch(/^[a-z-]+:[a-f0-9]{64}$/);
        for (const secret of secrets) expect(key).not.toContain(secret);
      }
      expect(JSON.stringify({ headers: limited.headers, body: limited.json() })).not.toContain(fixture.session.sessionToken);
    } finally {
      await fixture.app.close();
    }
  });

  it("does not admit unknown web or MCP credentials to authenticated buckets", async () => {
    const fixture = await buildFixture({ store: CapturingStore });
    try {
      const before = CapturingStore.keys.length;
      const web = await fixture.app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { cookie: `agentmesh_session=${"x".repeat(43)}` },
      });
      const mcp = await fixture.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer am_proj_${randomUUID()}.${"a".repeat(43)}`,
          "content-type": "application/json",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(web.statusCode).toBe(401);
      expect(mcp.statusCode).toBe(401);
      expect(CapturingStore.keys).toHaveLength(before);
    } finally {
      await fixture.app.close();
    }
  });

  it("rate limits MCP independently for each authenticated connection token", async () => {
    const fixture = await buildFixture({
      store: CapturingStore,
      limits: { ...testLimits, connectionCreate: 10 },
    });
    const tokens: string[] = [];
    try {
      for (const label of ["MCP A", "MCP B"]) {
        const issued = await fixture.app.inject({
          method: "POST",
          url: `/api/v1/projects/${fixture.project.id}/connections`,
          headers: { ...fixture.headers, "idempotency-key": randomUUID() },
          payload: { label },
        });
        expect(issued.statusCode).toBe(201);
        tokens.push(issued.json().secret as string);
      }
      const port = await listenLoopback(fixture.app);
      const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
      const request = async (token: string) => fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

      expect((await request(tokens[0]!)).status).toBe(200);
      expect((await request(tokens[0]!)).status).toBe(200);
      const limited = await request(tokens[0]!);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          request_id: expect.any(String),
        },
      });
      expect((await request(tokens[1]!)).status).toBe(200);
      for (const key of CapturingStore.keys) {
        for (const token of tokens) expect(key).not.toContain(token);
      }
    } finally {
      await fixture.app.close();
    }
  });

  it("applies security headers to status, auth, API, MCP, 404, and readiness failure paths", async () => {
    const fixture = await buildFixture({ readinessCheck: async () => false });
    try {
      const responses = [
        await fixture.app.inject({ method: "GET", url: "/health" }),
        await fixture.app.inject({ method: "GET", url: "/ready" }),
        await fixture.app.inject({ method: "GET", url: "/missing" }),
        await fixture.app.inject({ method: "GET", url: "/api/v1/projects" }),
        await fixture.app.inject({ method: "POST", url: "/mcp" }),
      ];
      expect(responses.map((response) => response.statusCode)).toEqual([200, 503, 404, 401, 401]);
      for (const response of responses) expectSecurityHeaders(response.headers);
      expect(responses[1]?.json()).toEqual({ status: "unavailable" });
      expect(responses[0]?.json()).toEqual({ status: "ok" });
    } finally {
      await fixture.app.close();
    }
  });

  it("fails safely when the in-memory abuse-control store is unavailable", async () => {
    const fixture = await buildFixture({ store: FailingStore as never });
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { cookie: fixture.headers.cookie },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("planted rate-store failure");
      expect(response.json()).toEqual({
        error: {
          code: "CONTROL_UNAVAILABLE",
          message: "Control plane is temporarily unavailable",
          request_id: expect.any(String),
        },
      });
    } finally {
      await fixture.app.close();
    }
  });

  it("accepts a current migration even when a newer additive migration row exists", async () => {
    const fakeHash = `future-${randomUUID()}`;
    await database.pool.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       VALUES ($1, (SELECT max(created_at) + 1 FROM drizzle.__drizzle_migrations))`,
      [fakeHash],
    );
    const fixture = await buildFixture();
    try {
      const ready = await fixture.app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready" });
    } finally {
      await fixture.app.close();
      await database.pool.query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1", [fakeHash]);
    }
  });

  it("drops unexpected and secret-shaped logger fields at runtime", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const planted = `am_proj_${randomUUID()}.${"a".repeat(43)}`;
    try {
      const logger = createSafeLogger();
      logger.write({
        event: "http.request_failed",
        request_id: planted,
        project_id: planted,
        user_id: planted,
        connection_id: planted,
        error_code: "INTERNAL_ERROR",
        authorization: planted,
        cookie: planted,
        text: planted,
        metadata: { planted },
      } as never);
      expect(write).toHaveBeenCalledTimes(1);
      const rendered = String(write.mock.calls[0]?.[0]);
      expect(JSON.parse(rendered)).toEqual({
        event: "http.request_failed",
        error_code: "INTERNAL_ERROR",
      });
      expect(rendered).not.toContain(planted);
    } finally {
      write.mockRestore();
    }
  });

  it("rejects real duplicate Idempotency-Key fields without creating a connection or reflecting secrets", async () => {
    const fixture = await buildFixture();
    const port = await listenLoopback(fixture.app);
    try {
      const response = await rawDuplicateIdempotencyRequest({
        port,
        projectId: fixture.project.id,
        cookie: fixture.headers.cookie,
        csrf: fixture.headers["x-csrf-token"],
        firstKey: randomUUID(),
        secondKey: randomUUID(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(fixture.session.sessionToken);
      expect(response.body).not.toContain(fixture.session.csrfToken);
      const rows = await database.pool.query(
        "SELECT id FROM project_tokens WHERE project_id = $1",
        [fixture.project.id],
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps hostile headers, cookies, origins, and bodies out of responses and safe logs", async () => {
    const logged: unknown[] = [];
    const planted = `am_proj_${randomUUID()}.${"b".repeat(43)}`;
    const fixture = await buildFixture({ logger: { write: (event: never) => logged.push(event) } });
    try {
      const responses = [
        await fixture.app.inject({
          method: "POST",
          url: `/api/v1/projects/${fixture.project.id}/connections`,
          headers: {
            cookie: `agentmesh_session=${planted}`,
            origin: `https://${planted}.invalid`,
            "x-csrf-token": planted,
            "idempotency-key": randomUUID(),
          },
          payload: { label: planted, unexpected: planted },
        }),
        await fixture.app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${planted}`, "content-type": "application/json" },
          payload: { jsonrpc: "2.0", id: planted, method: "tools/call", params: { text: planted } },
        }),
      ];
      for (const response of responses) {
        expect(response.body).not.toContain(planted);
        expect(JSON.stringify(response.headers)).not.toContain(planted);
        expectSecurityHeaders(response.headers);
      }
      expect(JSON.stringify(logged)).not.toContain(planted);
    } finally {
      await fixture.app.close();
    }
  });
});
