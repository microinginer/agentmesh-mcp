import { createHash } from "node:crypto";
import { connect } from "node:net";
import type { FastifyInstance } from "fastify";

import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuditService } from "../src/audit/service.js";
import type { WebAuthConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { auditEvents, oauthAttempts, oauthIdentities, users, webSessions } from "../src/db/schema.js";
import { buildHttpApp } from "../src/http.js";
import { createProjectService } from "../src/projects/service.js";
import type { GitHubOAuthClient, GitHubProfile } from "../src/web-auth/github-client.js";
import { createIdentityService, type IdentityService } from "../src/web-auth/identity-service.js";
import { createWebSessionService, type WebSessionService } from "../src/web-auth/session-service.js";
import { deriveWebAuthKeys } from "../src/web-auth/session-token.js";
import { resetDatabase } from "./support/database.js";
import { createTestClock, firstCookie } from "./support/hosted.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const webAuthKey = Buffer.alloc(32, 15);
const accessToken = "fake-github-access-token-never-persisted";
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const MAX_HTTP_HEADER_SIZE = 16_384;
const RAW_HTTP_TIMEOUT_MS = 1_500;

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bounded OAuth test timed out")), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function cookiePair(response: { headers: Record<string, unknown> }, name: string): string {
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const value = values.find((entry) => typeof entry === "string" && entry.startsWith(`${name}=`));
  return typeof value === "string" ? (value.split(";", 1)[0] ?? "") : "";
}

function cookies(response: { headers: Record<string, unknown> }): string[] {
  const setCookie = response.headers["set-cookie"];
  return Array.isArray(setCookie) ? setCookie.filter((entry): entry is string => typeof entry === "string")
    : typeof setCookie === "string" ? [setCookie] : [];
}

async function start(app: ReturnType<typeof buildHttpApp>, suffix = ""): Promise<{ state: string; cookie: string }> {
  const response = await app.inject({ method: "GET", url: `/auth/github/start${suffix}` });
  expect(response.statusCode).toBe(302);
  expect(response.headers["cache-control"]).toBe("no-store");
  const state = new URL(response.headers.location ?? "", "https://example.test").searchParams.get("state");
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { state: state!, cookie: firstCookie(response) };
}

async function listenLoopback(app: FastifyInstance): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback address");
  return address.port;
}

interface RawHttpResponse {
  statusCode: number;
  headers: Record<string, string[]>;
  body: string;
}

interface RawByteHeader {
  name: string;
  value: Buffer;
}

type RawTestHeader = string | RawByteHeader;

function rawHeaderLine(header: RawTestHeader): Buffer {
  if (typeof header === "string") return Buffer.from(header, "latin1");
  return Buffer.concat([
    Buffer.from(`${header.name}:`, "latin1"),
    header.value,
  ]);
}

async function rawHttpRequest(port: number, url: string, headers: RawTestHeader[]): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(Buffer.concat([
        Buffer.from(`GET ${url} HTTP/1.1\r\nHost:127.0.0.1\r\n`, "latin1"),
        ...headers.flatMap((header) => [rawHeaderLine(header), Buffer.from("\r\n", "latin1")]),
        Buffer.from("Connection:close\r\n\r\n", "latin1"),
      ]));
    });
    socket.setTimeout(RAW_HTTP_TIMEOUT_MS, () => socket.destroy(new Error("raw HTTP response timed out")));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      const rendered = Buffer.concat(chunks).toString("utf8");
      const [head = "", body = ""] = rendered.split("\r\n\r\n", 2);
      const lines = head.split("\r\n");
      const statusCode = /^HTTP\/1\.1 (\d{3})\b/.exec(lines[0] ?? "")?.[1];
      if (statusCode === undefined) return reject(new Error(`missing HTTP status: ${head}`));
      const parsedHeaders: Record<string, string[]> = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(":");
        if (separator <= 0) continue;
        const name = line.slice(0, separator).toLowerCase();
        (parsedHeaders[name] ??= []).push(line.slice(separator + 1).trim());
      }
      resolve({ statusCode: Number(statusCode), headers: parsedHeaders, body });
    });
  });
}

async function rawCookieCallback(port: number, url: string, cookieFields: string[]): Promise<RawHttpResponse> {
  return rawHttpRequest(port, url, cookieFields.map((value) => `Cookie:${value}`));
}

function paddedCookieField(attemptCookie: string, position: "first" | "middle" | "last", length: number): string {
  const remaining = length - attemptCookie.length;
  if (position === "first") return `${attemptCookie}; pad=${"x".repeat(remaining - 6)}`;
  if (position === "last") return `pad=${"x".repeat(remaining - 6)}; ${attemptCookie}`;
  const firstLength = Math.floor((remaining - 8) / 2);
  const secondLength = remaining - 8 - firstLength;
  return `a=${"x".repeat(firstLength)}; ${attemptCookie}; b=${"x".repeat(secondLength)}`;
}

function trackedHeaderBytes(url: string, headers: string[]): number {
  return Buffer.byteLength(url) + Buffer.byteLength("Host") + Buffer.byteLength("127.0.0.1")
    + Buffer.byteLength("Connection") + Buffer.byteLength("close")
    + headers.reduce((total, header) => {
      const separator = header.indexOf(":");
      if (separator <= 0) throw new Error("invalid raw test header");
      return total + Buffer.byteLength(header.slice(0, separator)) + Buffer.byteLength(header.slice(separator + 1));
    }, 0);
}

function trackedRawHeaderBytes(url: string, headers: RawByteHeader[]): number {
  return Buffer.byteLength(url, "latin1") + Buffer.byteLength("Host127.0.0.1Connectionclose", "latin1")
    + headers.reduce((total, header) => total + Buffer.byteLength(header.name, "latin1") + header.value.byteLength, 0);
}

function latin1CookieField(attemptCookie: string, length: number): Buffer {
  const prefix = Buffer.from(`${attemptCookie}; pad=`, "latin1");
  if (prefix.byteLength > length) throw new Error("OAuth cookie does not fit Latin-1 boundary fixture");
  return Buffer.concat([prefix, Buffer.alloc(length - prefix.byteLength, 0xe9)]);
}

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

describe("web OAuth HTTP routes", () => {
  function webConfig(secureCookies = false): WebAuthConfig {
    const config = {
      clientId: "test-client-id",
      callbackUrl: new URL(`${secureCookies ? "https://agentmesh.example" : "http://127.0.0.1"}/auth/github/callback`),
      publicOrigin: new URL(secureCookies ? "https://agentmesh.example" : "http://127.0.0.1"),
      operatorGitHubIds: new Set(["4242"]),
      projectLimit: 5,
      tokenTtlDays: 90,
      secureCookies,
    } as Omit<WebAuthConfig, "clientSecret" | "authKey">;
    Object.defineProperties(config, {
      clientSecret: { value: "test-client-secret", enumerable: false },
      authKey: { value: webAuthKey, enumerable: false },
    });
    return config as WebAuthConfig;
  }

  function fakeGitHub(initialProfile: GitHubProfile) {
    let profile = initialProfile;
    const exchanges: Array<{ code: string; verifier: string }> = [];
    const client: GitHubOAuthClient = {
      authorizationUrl: (state, challenge) => new URL(
        `https://github.example.test/authorize?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`,
      ),
      exchangeCode: async (code, verifier) => {
        exchanges.push({ code, verifier });
        if (code !== "one-use") throw new Error("provider code must not escape");
        return accessToken;
      },
      fetchProfile: async (token) => {
        if (token !== accessToken) throw new Error("unexpected token");
        return profile;
      },
    };
    return {
      client,
      exchanges,
      setProfile: (next: GitHubProfile) => { profile = next; },
    };
  }

  function buildWebApp(input: {
    github: GitHubOAuthClient;
    clock?: ReturnType<typeof createTestClock>;
    secureCookies?: boolean;
    wrapIdentityService?: (service: IdentityService) => IdentityService;
    wrapSessionService?: (service: WebSessionService) => WebSessionService;
  }) {
    const clock = input.clock ?? createTestClock("2026-08-01T00:00:00.000Z");
    const config = webConfig(input.secureCookies);
    const sessionService = createWebSessionService({
      db: database.db,
      keys: deriveWebAuthKeys(config.authKey),
      clock: clock.now,
    });
    const identityService = createIdentityService({ db: database.db, clock: clock.now });
    return {
      app: buildHttpApp({
        db: database.db,
        signingKey,
        projectService: createProjectService({ db: database.db }),
        host: "127.0.0.1",
        allowedHosts: ["127.0.0.1", "localhost"],
        admin: null,
        logger: { write: () => {} },
        web: {
          db: database.db,
          config,
          githubClient: input.github,
          identityService: input.wrapIdentityService?.(identityService) ?? identityService,
          sessionService: input.wrapSessionService?.(sessionService) ?? sessionService,
          auditService: createAuditService({ db: database.db, clock: clock.now }),
          clock: clock.now,
        },
      }),
      clock,
      sessionService,
      config,
    };
  }

  it("keeps web routes absent when hosted web authentication is disabled", async () => {
    const app = buildHttpApp({
      db: database.db,
      signingKey,
      projectService: createProjectService({ db: database.db }),
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1", "localhost"],
      admin: null,
      logger: { write: () => {} },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/auth/github/start" });
      expect(response.statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/v1/session" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("creates a local session from a sealed single-use OAuth attempt without persisting the provider token", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: "Octo Cat", avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const initiated = await app.inject({ method: "GET", url: "/auth/github/start?return_to=/app/projects?tab=active%23recent" });
      expect(initiated.statusCode).toBe(302);
      expect(initiated.headers["cache-control"]).toBe("no-store");
      const authorization = new URL(initiated.headers.location ?? "");
      const state = authorization.searchParams.get("state");
      const challenge = authorization.searchParams.get("code_challenge");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).not.toBe(state);
      const attemptCookie = firstCookie(initiated);
      const attemptSetCookie = cookies(initiated)[0] ?? "";
      expect(attemptCookie).toMatch(/^agentmesh_oauth=/);
      expect(attemptSetCookie).toContain("HttpOnly");
      expect(attemptSetCookie).toContain("SameSite=Lax");
      expect(attemptSetCookie).toContain("Path=/");
      expect(attemptSetCookie).toContain("Max-Age=300");
      expect(attemptSetCookie).not.toContain("Secure");
      expect(attemptSetCookie).not.toContain("Domain=");
      expect(attemptCookie).not.toContain(state!);

      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${encodeURIComponent(state!)}`,
        headers: { cookie: attemptCookie },
      });
      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe("/app/projects?tab=active#recent");
      expect(callback.headers["cache-control"]).toBe("no-store");
      const callbackCookies = cookies(callback);
      expect(callbackCookies).toContainEqual(expect.stringContaining("agentmesh_oauth=;"));
      expect(callbackCookies).toContainEqual(expect.stringContaining("agentmesh_session="));
      for (const cookie of callbackCookies) {
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).toContain("Path=/");
        expect(cookie).not.toContain("Domain=");
      }
      expect(callback.body).not.toContain(accessToken);
      expect(String(callback.headers.location)).not.toContain(accessToken);
      expect(github.exchanges).toHaveLength(1);
      expect(github.exchanges[0]?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).toBe(createHash("sha256").update(github.exchanges[0]?.verifier ?? "", "utf8").digest("base64url"));
      const [identityCount] = await database.db.select({ identities: count() }).from(oauthIdentities);
      const [sessionCount] = await database.db.select({ sessions: count() }).from(webSessions);
      expect(identityCount?.identities).toBe(1);
      expect(sessionCount?.sessions).toBe(1);
      await expect(database.pool.query("select access_token from oauth_identities")).rejects.toThrow();

      const replay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${encodeURIComponent(state!)}`,
        headers: { cookie: attemptCookie },
      });
      expect(replay.statusCode).toBe(303);
      expect(replay.headers.location).toBe("/?auth_error=github");
      expect(cookies(replay)).toContainEqual(expect.stringContaining("agentmesh_oauth=;"));
      const [replayedSessionCount] = await database.db.select({ sessions: count() }).from(webSessions);
      expect(replayedSessionCount?.sessions).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("records one truthful OAuth outcome only after durable session issuance", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const failed = buildWebApp({
      github: github.client,
      wrapSessionService: (service) => ({
        ...service,
        issue: async () => null,
      }),
    });
    try {
      const attempt = await start(failed.app);
      const callback = await failed.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: attempt.cookie },
      });
      expect(callback.headers.location).toBe("/?auth_error=github");
      expect(await database.db.select().from(auditEvents)).toEqual([
        expect.objectContaining({
          userId: null,
          eventType: "auth.login_failed",
          metadata: { provider: "github", oauth_failure_stage: "session" },
        }),
      ]);
    } finally {
      await failed.app.close();
    }

    await resetDatabase(database.pool);
    const successful = buildWebApp({ github: github.client });
    try {
      const attempt = await start(successful.app);
      const callback = await successful.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: attempt.cookie },
      });
      expect(callback.headers.location).toBe("/app");
      expect(await database.db.select().from(auditEvents)).toEqual([
        expect.objectContaining({
          userId: expect.any(String),
          eventType: "auth.login_succeeded",
          metadata: { provider: "github" },
        }),
      ]);
    } finally {
      await successful.app.close();
    }
  });

  it.each([
    {
      stage: "exchange",
      github: {
        authorizationUrl: (state: string, challenge: string) => new URL(
          `https://github.example.test/authorize?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`,
        ),
        exchangeCode: async () => { throw new Error("provider exchange failed"); },
        fetchProfile: async () => { throw new Error("must not fetch a profile"); },
      } satisfies GitHubOAuthClient,
      wrapIdentityService: undefined,
    },
    {
      stage: "profile",
      github: {
        authorizationUrl: (state: string, challenge: string) => new URL(
          `https://github.example.test/authorize?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`,
        ),
        exchangeCode: async () => accessToken,
        fetchProfile: async () => { throw new Error("provider profile failed"); },
      } satisfies GitHubOAuthClient,
      wrapIdentityService: undefined,
    },
    {
      stage: "identity",
      github: fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null }).client,
      wrapIdentityService: (service: IdentityService): IdentityService => ({
        ...service,
        upsertGitHub: async () => { throw new Error("identity persistence failed"); },
      }),
    },
  ])("records only the safe $stage stage when OAuth completion fails", async ({ stage, github, wrapIdentityService }) => {
    const { app } = buildWebApp({ github, ...(wrapIdentityService === undefined ? {} : { wrapIdentityService }) });
    try {
      const attempt = await start(app);
      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: attempt.cookie },
      });
      expect(callback.headers.location).toBe("/?auth_error=github");
      expect(await database.db.select().from(auditEvents)).toEqual([
        expect.objectContaining({
          userId: null,
          eventType: "auth.login_failed",
          metadata: { provider: "github", oauth_failure_stage: stage },
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("records one safe failure for a callback rejected before provider exchange", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const attempt = await start(app);
      const callback = await app.inject({
        method: "GET",
        url: "/auth/github/callback?error=access_denied",
        headers: { cookie: attempt.cookie },
      });
      expect(callback.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select().from(auditEvents)).toEqual([
        expect.objectContaining({
          userId: null,
          eventType: "auth.login_failed",
          metadata: {
            provider: "github",
            oauth_failure_stage: "callback_query",
            oauth_failure_reason: "query_keys",
          },
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      reason: "query_syntax",
      callbackUrl: (state: string) => `/auth/github/callback?code=one-use&state=${state}&state=${state}`,
    },
    {
      reason: "code_format",
      callbackUrl: (state: string) => `/auth/github/callback?code=&state=${state}`,
    },
    {
      reason: "state_format",
      callbackUrl: () => "/auth/github/callback?code=one-use&state=invalid",
    },
  ])("records only the safe $reason callback-query reason", async ({ reason, callbackUrl }) => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const attempt = await start(app);
      const callback = await app.inject({
        method: "GET",
        url: callbackUrl(attempt.state),
        headers: { cookie: attempt.cookie },
      });
      expect(callback.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select().from(auditEvents)).toEqual([
        expect.objectContaining({
          metadata: {
            provider: "github",
            oauth_failure_stage: "callback_query",
            oauth_failure_reason: reason,
          },
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("distinguishes a malformed callback cookie from a stale current session without retaining either value", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const malformedCookie = buildWebApp({ github: github.client });
    try {
      const attempt = await start(malformedCookie.app);
      const callback = await malformedCookie.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: `${attempt.cookie}; malformed` },
      });
      expect(callback.headers.location).toBe("/?auth_error=github");
      expect(await database.db.select().from(auditEvents)).toEqual([
        expect.objectContaining({
          metadata: { provider: "github", oauth_failure_stage: "callback_cookie" },
        }),
      ]);
    } finally {
      await malformedCookie.app.close();
    }

    await resetDatabase(database.pool);
    const staleSession = buildWebApp({ github: github.client });
    try {
      const attempt = await start(staleSession.app);
      const staleToken = Buffer.alloc(32, 7).toString("base64url");
      const callback = await staleSession.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: `${attempt.cookie}; agentmesh_session=${staleToken}` },
      });
      expect(callback.headers.location).toBe("/?auth_error=github");
      expect(await database.db.select().from(auditEvents)).toEqual([
        expect.objectContaining({
          metadata: { provider: "github", oauth_failure_stage: "current_session" },
        }),
      ]);
    } finally {
      await staleSession.app.close();
    }
  });

  it("uses exact host-only secure cookies without colliding with the emergency admin cookie", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client, secureCookies: true });
    try {
      const initiated = await app.inject({
        method: "GET",
        url: "/auth/github/start",
        headers: { cookie: "agentmesh_admin_session=emergency-cookie" },
      });
      expect(initiated.statusCode).toBe(302);
      const attemptSetCookie = cookies(initiated)[0] ?? "";
      expect(attemptSetCookie).toMatch(/^__Host-agentmesh_oauth=/);
      expect(attemptSetCookie).toContain("Secure");
      expect(attemptSetCookie).toContain("HttpOnly");
      expect(attemptSetCookie).toContain("SameSite=Lax");
      expect(attemptSetCookie).toContain("Path=/");
      expect(attemptSetCookie).not.toContain("Domain=");
      const state = new URL(initiated.headers.location ?? "").searchParams.get("state");
      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${state}`,
        headers: { cookie: firstCookie(initiated) },
      });
      const sessionSetCookie = cookies(callback).find((value) => value.startsWith("__Host-agentmesh_session=")) ?? "";
      expect(sessionSetCookie).toContain("Secure");
      expect(sessionSetCookie).toContain("HttpOnly");
      expect(sessionSetCookie).toContain("SameSite=Lax");
      expect(sessionSetCookie).toContain("Path=/");
      expect(sessionSetCookie).toContain("Max-Age=2592000");
      expect(sessionSetCookie).not.toContain("Domain=");
      expect(cookies(callback)).toContainEqual(expect.stringContaining("__Host-agentmesh_oauth=;"));
    } finally {
      await app.close();
    }
  });

  it("disables automatic cookie parsing while retaining callback cookie decorators", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    const callbackCookies: unknown[] = [];
    app.addHook("preHandler", async (request) => {
      if (request.raw.url?.startsWith("/auth/github/callback")) callbackCookies.push(request.cookies);
    });
    try {
      const attempt = await start(app);
      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: attempt.cookie },
      });

      expect(callback.statusCode).toBe(303);
      expect(callbackCookies).toEqual([null]);
      expect(cookies(callback)).toContainEqual(expect.stringContaining("agentmesh_oauth=;"));
      expect(cookies(callback)).toContainEqual(expect.stringMatching(/^agentmesh_session=[^;]/));
    } finally {
      await app.close();
    }
  });

  it("fails closed for unsafe return targets, ambiguous callbacks, and provider failures", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      for (const target of [
        "https://attacker.example/app",
        "//attacker.example/app",
        "/app%2F..%2Fsecret",
        "/app\\windows",
        "/app/%2e%2e/secret",
        "/app/%25252e%25252e/secret",
        "/app/%252525252e%252525252e/secret",
        "/app/%0d%0aLocation:evil",
      ]) {
        const initiated = await start(app, `?return_to=${target}`);
        const callback = await app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${initiated.state}`,
          headers: { cookie: initiated.cookie },
        });
        expect(callback.statusCode).toBe(303);
        expect(callback.headers.location).toBe("/app");
      }

      const initiated = await start(app);
      for (const url of [
        `/auth/github/callback?code=one-use&state=${initiated.state}&state=${initiated.state}`,
        `/auth/github/callback?code=one-use&state=${initiated.state}&provider_error=raw-provider-error`,
        `/auth/github/callback?error=access_denied`,
      ]) {
        const callback = await app.inject({ method: "GET", url, headers: { cookie: initiated.cookie } });
        expect(callback.statusCode).toBe(303);
        expect(callback.headers.location).toBe("/?auth_error=github");
        expect(callback.body).not.toContain("raw-provider-error");
        expect(callback.headers.location).not.toContain("raw-provider-error");
        expect(cookies(callback)).toContainEqual(expect.stringContaining("agentmesh_oauth=;"));
      }

      const duplicateCookie = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${initiated.state}`,
        headers: { cookie: `${initiated.cookie}; ${initiated.cookie}` },
      });
      expect(duplicateCookie.headers.location).toBe("/?auth_error=github");
      const bareCookie = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${initiated.state}`,
        headers: { cookie: `${initiated.cookie}; bare` },
      });
      expect(bareCookie.headers.location).toBe("/?auth_error=github");
    } finally {
      await app.close();
    }
  });

  it("rotates same-identity sessions, preserves a different identity session, and bootstraps a fresh CSRF token", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: "Octocat", avatarUrl: null });
    const { app, clock } = buildWebApp({ github: github.client });
    try {
      const firstAttempt = await start(app);
      const firstCallback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${firstAttempt.state}`,
        headers: { cookie: firstAttempt.cookie },
      });
      const firstSession = cookiePair(firstCallback, "agentmesh_session");
      expect(firstSession).not.toBe("");

      clock.set("2026-08-01T00:01:00.000Z");
      const reauthAttempt = await start(app);
      const reauthCallback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${reauthAttempt.state}`,
        headers: { cookie: `${reauthAttempt.cookie}; ${firstSession}` },
      });
      expect(reauthCallback.statusCode).toBe(303);
      const replacementSession = cookiePair(reauthCallback, "agentmesh_session");
      expect(replacementSession).not.toBe(firstSession);
      expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: firstSession } })).statusCode).toBe(401);

      const bootstrap = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: replacementSession } });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.headers["cache-control"]).toBe("no-store");
      expect(bootstrap.json()).toEqual({
        user: { id: expect.any(String), github_id: "4242", login: "octocat", display_name: "Octocat", avatar_url: null },
        operator: true,
        authenticated_at: "2026-08-01T00:01:00.000Z",
        csrf_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      const firstCsrf = (bootstrap.json() as { csrf_token: string }).csrf_token;
      const secondBootstrap = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: replacementSession } });
      const secondCsrf = (secondBootstrap.json() as { csrf_token: string }).csrf_token;
      expect(secondCsrf).not.toBe(firstCsrf);
      const csrfReuse = await app.inject({
        method: "DELETE",
        url: "/api/v1/session",
        headers: { cookie: replacementSession, origin: "http://127.0.0.1", "x-csrf-token": firstCsrf },
      });
      expect(csrfReuse.statusCode).toBe(403);
      expect(csrfReuse.headers["cache-control"]).toBe("no-store");
      expect(cookies(csrfReuse)).not.toContainEqual(expect.stringContaining("agentmesh_session=;"));

      await database.db.delete(auditEvents);
      github.setProfile({ id: "4343", login: "different", name: "Different", avatarUrl: null });
      const differentAttempt = await start(app);
      const differentCallback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${differentAttempt.state}`,
        headers: { cookie: `${differentAttempt.cookie}; ${replacementSession}` },
      });
      expect(differentCallback.statusCode).toBe(303);
      expect(differentCallback.headers.location).toBe("/?auth_error=github");
      expect(cookies(differentCallback).filter((value) => value.startsWith("agentmesh_session="))).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: replacementSession } })).statusCode).toBe(200);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_failed" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("clears an idle-expired session, consumes the attempt, and requires a fresh login attempt", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app, clock } = buildWebApp({ github: github.client });
    try {
      const loginAttempt = await start(app);
      const login = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${loginAttempt.state}`,
        headers: { cookie: loginAttempt.cookie },
      });
      const staleSession = cookiePair(login, "agentmesh_session");
      expect(staleSession).not.toBe("");
      expect(cookies(login).find((value) => value.startsWith("agentmesh_session=")))
        .toContain("Max-Age=2592000");
      await database.db.delete(auditEvents);

      clock.set("2026-08-08T00:00:00.000Z");
      const staleAttempt = await start(app);
      const stale = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${staleAttempt.state}`,
        headers: { cookie: `${staleAttempt.cookie}; ${staleSession}` },
      });

      expect(stale.statusCode).toBe(303);
      expect(stale.headers.location).toBe("/?auth_error=github");
      expect(cookies(stale)).toContain(
        "agentmesh_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax",
      );
      expect(JSON.stringify({ headers: stale.headers, body: stale.body }))
        .not.toContain(staleSession.split("=", 2)[1] ?? "missing-session");
      const attemptsAfterStale = await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts);
      expect(attemptsAfterStale).toHaveLength(1);
      expect(attemptsAfterStale.every((attempt) => attempt.consumedAt !== null)).toBe(true);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_failed" },
      ]);
      expect(github.exchanges).toHaveLength(1);

      const freshAttempt = await start(app);
      const fresh = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${freshAttempt.state}`,
        headers: { cookie: freshAttempt.cookie },
      });
      expect(fresh.headers.location).toBe("/app");
      expect(cookiePair(fresh, "agentmesh_session")).not.toBe("");
      const outcomes = await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents);
      expect(outcomes).toHaveLength(2);
      expect(outcomes).toEqual(expect.arrayContaining([
        { eventType: "auth.login_failed" },
        { eventType: "auth.login_succeeded" },
      ]));
      expect(github.exchanges).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("recovers from an explicitly revoked secure session only on a fresh attempt", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app, sessionService } = buildWebApp({ github: github.client, secureCookies: true });
    try {
      const loginAttempt = await start(app);
      const login = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${loginAttempt.state}`,
        headers: { cookie: loginAttempt.cookie },
      });
      const staleSession = cookiePair(login, "__Host-agentmesh_session");
      const authenticated = await sessionService.authenticate(staleSession.split("=", 2)[1] ?? "");
      expect(authenticated).not.toBeNull();
      if (authenticated === null) return;
      await sessionService.revoke(authenticated.sessionId);

      const staleAttempt = await start(app);
      const stale = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${staleAttempt.state}`,
        headers: { cookie: `${staleAttempt.cookie}; ${staleSession}` },
      });
      expect(stale.headers.location).toBe("/?auth_error=github");
      expect(cookies(stale)).toContain(
        "__Host-agentmesh_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax",
      );
      expect(github.exchanges).toHaveLength(1);

      const freshAttempt = await start(app);
      const fresh = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${freshAttempt.state}`,
        headers: { cookie: freshAttempt.cookie },
      });
      expect(fresh.headers.location).toBe("/app");
      expect(cookiePair(fresh, "__Host-agentmesh_session")).not.toBe("");
      expect(github.exchanges).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("requires a consumed blocked-session callback to restart after unblock", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app, clock, sessionService } = buildWebApp({ github: github.client });
    try {
      const loginAttempt = await start(app);
      const login = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${loginAttempt.state}`,
        headers: { cookie: loginAttempt.cookie },
      });
      const staleSession = cookiePair(login, "agentmesh_session");
      const authenticated = await sessionService.authenticate(staleSession.split("=", 2)[1] ?? "");
      expect(authenticated).not.toBeNull();
      if (authenticated === null) return;
      await database.db.update(users).set({ blockedAt: clock.now() }).where(eq(users.id, authenticated.userId));

      const blockedAttempt = await start(app);
      const blocked = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${blockedAttempt.state}`,
        headers: { cookie: `${blockedAttempt.cookie}; ${staleSession}` },
      });
      expect(blocked.headers.location).toBe("/?auth_error=github");
      expect(cookies(blocked)).toContainEqual(expect.stringContaining("agentmesh_session=;"));
      expect(github.exchanges).toHaveLength(1);

      await database.db.update(users).set({ blockedAt: null }).where(eq(users.id, authenticated.userId));
      const consumedRetry = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${blockedAttempt.state}`,
        headers: { cookie: blockedAttempt.cookie },
      });
      expect(consumedRetry.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(1);

      const freshAttempt = await start(app);
      const fresh = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${freshAttempt.state}`,
        headers: { cookie: freshAttempt.cookie },
      });
      expect(fresh.headers.location).toBe("/app");
      expect(github.exchanges).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("preserves a valid session cookie when callback authentication is transiently unavailable", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    let unavailable = false;
    const { app } = buildWebApp({
      github: github.client,
      wrapSessionService: (service) => ({
        ...service,
        authenticate: async (token) => {
          if (unavailable) throw new Error("transient session authentication failure");
          return service.authenticate(token);
        },
      }),
    });
    try {
      const loginAttempt = await start(app);
      const login = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${loginAttempt.state}`,
        headers: { cookie: loginAttempt.cookie },
      });
      const currentSession = cookiePair(login, "agentmesh_session");
      await database.db.delete(auditEvents);
      unavailable = true;
      const retryAttempt = await start(app);
      const unavailableCallback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${retryAttempt.state}`,
        headers: { cookie: `${retryAttempt.cookie}; ${currentSession}` },
      });

      expect(unavailableCallback.headers.location).toBe("/?auth_error=github");
      expect(cookies(unavailableCallback).filter((value) => value.startsWith("agentmesh_session="))).toEqual([]);
      expect(unavailableCallback.body).not.toContain("transient session authentication failure");
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_failed" },
      ]);
      unavailable = false;
      expect((await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: currentSession },
      })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("revokes before clearing the browser session cookie and records a safe logout", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const attempt = await start(app);
      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: attempt.cookie },
      });
      const session = cookiePair(callback, "agentmesh_session");
      const bootstrap = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: session } });
      const csrf = (bootstrap.json() as { csrf_token: string }).csrf_token;
      const logout = await app.inject({
        method: "DELETE",
        url: "/api/v1/session",
        headers: { cookie: session, origin: "http://127.0.0.1", "x-csrf-token": csrf },
      });
      expect(logout.statusCode).toBe(204);
      expect(logout.headers["cache-control"]).toBe("no-store");
      expect(cookies(logout)).toContainEqual(expect.stringContaining("agentmesh_session=;"));
      expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: session } })).statusCode).toBe(401);
      const [logoutCount] = await database.db.select({ total: count() }).from(auditEvents).where(eq(auditEvents.eventType, "auth.logout"));
      expect(logoutCount?.total).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("does not clear a session cookie when durable logout revocation is unavailable", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({
      github: github.client,
      wrapSessionService: (service) => ({
        ...service,
        revoke: async () => { throw new Error("database failure must not escape"); },
      }),
    });
    try {
      const attempt = await start(app);
      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: attempt.cookie },
      });
      const session = cookiePair(callback, "agentmesh_session");
      const bootstrap = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: session } });
      const csrf = (bootstrap.json() as { csrf_token: string }).csrf_token;
      const logout = await app.inject({
        method: "DELETE",
        url: "/api/v1/session",
        headers: { cookie: session, origin: "http://127.0.0.1", "x-csrf-token": csrf },
      });
      expect(logout.statusCode).toBe(503);
      expect(logout.headers["cache-control"]).toBe("no-store");
      expect(logout.body).not.toContain("database failure");
      expect(cookies(logout)).not.toContainEqual(expect.stringContaining("agentmesh_session=;"));
      expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: session } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("fails closed without clearing a session cookie when the logout clock is invalid", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const clock = createTestClock("2026-08-01T00:00:00.000Z");
    const { app } = buildWebApp({ github: github.client, clock });
    try {
      const attempt = await start(app);
      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
        headers: { cookie: attempt.cookie },
      });
      const session = cookiePair(callback, "agentmesh_session");
      const bootstrap = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: session } });
      const csrf = (bootstrap.json() as { csrf_token: string }).csrf_token;
      clock.set("invalid");
      const logout = await app.inject({
        method: "DELETE",
        url: "/api/v1/session",
        headers: { cookie: session, origin: "http://127.0.0.1", "x-csrf-token": csrf },
      });
      expect(logout.statusCode).toBe(503);
      expect(logout.headers["cache-control"]).toBe("no-store");
      expect(cookies(logout)).not.toContainEqual(expect.stringContaining("agentmesh_session=;"));
    } finally {
      await app.close();
    }
  });

  it("keeps a consumed OAuth attempt consumed across recreation and unrelated unexpired attempts", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const first = buildWebApp({ github: github.client });
    let initiated: { state: string; cookie: string };
    try {
      initiated = await start(first.app);
      const callback = await first.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${initiated.state}`,
        headers: { cookie: initiated.cookie },
      });
      expect(callback.statusCode).toBe(303);
      await database.pool.query(`
        INSERT INTO oauth_attempts (attempt_digest, expires_at, created_at)
        SELECT decode(lpad(to_hex(value), 64, '0'), 'hex'), $1, $2
          FROM generate_series(1, 1025) AS value
      `, [new Date("2026-08-01T00:05:00.000Z"), new Date("2026-08-01T00:00:00.000Z")]);
    } finally {
      await first.app.close();
    }

    const recreated = buildWebApp({ github: github.client });
    try {
      const replay = await recreated.app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${initiated!.state}`,
        headers: { cookie: initiated!.cookie },
      });
      expect(replay.statusCode).toBe(303);
      expect(replay.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(1);
    } finally {
      await recreated.app.close();
    }
  });

  it("allows exactly one concurrent callback to consume an OAuth attempt", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const initiated = await start(app);
      const responses = await Promise.all([
        app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${initiated.state}`,
          headers: { cookie: initiated.cookie },
        }),
        app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${initiated.state}`,
          headers: { cookie: initiated.cookie },
        }),
      ]);
      expect(responses.filter((response) => response.headers.location === "/app")).toHaveLength(1);
      expect(responses.filter((response) => response.headers.location === "/?auth_error=github")).toHaveLength(1);
      expect(github.exchanges).toHaveLength(1);
      const [sessions] = await database.db.select({ total: count() }).from(webSessions);
      expect(sessions?.total).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("consumes a valid OAuth attempt before cancellation or invalid session-cookie handling", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app, sessionService } = buildWebApp({ github: github.client });
    try {
      const cancelled = await start(app);
      const cancellation = await app.inject({
        method: "GET",
        url: "/auth/github/callback?error=access_denied",
        headers: { cookie: cancelled.cookie },
      });
      expect(cancellation.headers.location).toBe("/?auth_error=github");
      const cancelledReplay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${cancelled.state}`,
        headers: { cookie: cancelled.cookie },
      });
      expect(cancelledReplay.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(0);

      const malformedSession = await start(app);
      const malformed = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${malformedSession.state}`,
        headers: { cookie: `${malformedSession.cookie}; agentmesh_session=not-canonical` },
      });
      expect(malformed.headers.location).toBe("/?auth_error=github");
      expect(cookies(malformed).filter((value) => value.startsWith("agentmesh_session="))).toEqual([]);
      const malformedReplay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${malformedSession.state}`,
        headers: { cookie: malformedSession.cookie },
      });
      expect(malformedReplay.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(0);

      const loginAttempt = await start(app);
      const login = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${loginAttempt.state}`,
        headers: { cookie: loginAttempt.cookie },
      });
      const currentSession = cookiePair(login, "agentmesh_session");
      const duplicateSession = await start(app);
      const duplicated = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${duplicateSession.state}`,
        headers: { cookie: `${duplicateSession.cookie}; ${currentSession}; ${currentSession}` },
      });
      expect(duplicated.headers.location).toBe("/?auth_error=github");
      expect(cookies(duplicated).filter((value) => value.startsWith("agentmesh_session="))).toEqual([]);
      expect(github.exchanges).toHaveLength(1);

      const authenticated = await sessionService.authenticate(currentSession.split("=", 2)[1] ?? "");
      expect(authenticated).not.toBeNull();
      if (authenticated === null) return;
      await sessionService.revoke(authenticated.sessionId);
      const staleSession = await start(app);
      const stale = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${staleSession.state}`,
        headers: { cookie: `${staleSession.cookie}; ${currentSession}` },
      });
      expect(stale.headers.location).toBe("/?auth_error=github");
      const staleReplay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${staleSession.state}`,
        headers: { cookie: staleSession.cookie },
      });
      expect(staleReplay.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("consumes every valid OAuth candidate from repeated raw Cookie fields before safe rejection", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    const rawCookieFields: string[][] = [];
    app.addHook("onRequest", async (request) => {
      if (request.raw.url?.startsWith("/auth/github/callback")) {
        const values: string[] = [];
        for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
          if (request.raw.rawHeaders[index]?.toLowerCase() === "cookie") {
            values.push(request.raw.rawHeaders[index + 1] ?? "");
          }
        }
        rawCookieFields.push(values);
      }
    });
    try {
      const attemptWithMalformedSession = await start(app);
      const port = await listenLoopback(app);
      const repeatedMalformed = await rawCookieCallback(
        port,
        `/auth/github/callback?code=one-use&state=${attemptWithMalformedSession.state}`,
        [attemptWithMalformedSession.cookie, "agentmesh_session=not-canonical"],
      );
      expect(rawCookieFields[0]).toEqual([attemptWithMalformedSession.cookie, "agentmesh_session=not-canonical"]);
      expect(repeatedMalformed).toMatchObject({
        statusCode: 303,
        headers: { location: ["/?auth_error=github"], "cache-control": ["no-store"] },
      });
      expect(repeatedMalformed.headers["set-cookie"]?.some((value) => value.startsWith("agentmesh_oauth=;"))).toBe(true);
      expect(github.exchanges).toHaveLength(0);
      const malformedReplay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${attemptWithMalformedSession.state}`,
        headers: { cookie: attemptWithMalformedSession.cookie },
      });
      expect(malformedReplay.headers.location).toBe("/?auth_error=github");

      const firstAttempt = await start(app);
      const secondAttempt = await start(app);
      const repeatedOAuth = await rawCookieCallback(
        port,
        `/auth/github/callback?code=one-use&state=${firstAttempt.state}`,
        [firstAttempt.cookie, secondAttempt.cookie],
      );
      expect(rawCookieFields[2]).toEqual([firstAttempt.cookie, secondAttempt.cookie]);
      expect(repeatedOAuth.headers.location).toEqual(["/?auth_error=github"]);
      expect(github.exchanges).toHaveLength(0);
      for (const attempt of [firstAttempt, secondAttempt]) {
        const replay = await app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
          headers: { cookie: attempt.cookie },
        });
        expect(replay.headers.location).toBe("/?auth_error=github");
      }
      expect(github.exchanges).toHaveLength(0);
      const [sessions] = await database.db.select({ total: count() }).from(webSessions);
      expect(sessions?.total).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([0, 2, 4])("consumes a five-cookie target identically at position %i", async (targetPosition) => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const attempts = [];
      for (let index = 0; index < 5; index += 1) attempts.push(await start(app));
      const target = attempts[0]!;
      const ordered = attempts.slice(1);
      ordered.splice(targetPosition, 0, target);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();

      const ambiguous = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${target.state}`,
        headers: { cookie: ordered.map((attempt) => attempt.cookie).join("; ") },
      });
      const replay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${target.state}`,
        headers: { cookie: target.cookie },
      });

      expect([ambiguous.headers.location, replay.headers.location]).toEqual([
        "/?auth_error=github",
        "/?auth_error=github",
      ]);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
      const storedAttempts = await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts);
      expect(storedAttempts).toHaveLength(5);
      expect(storedAttempts.every((row) => row.consumedAt !== null)).toBe(true);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_failed" },
        { eventType: "auth.login_failed" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("consumes the maximum matching candidate set in one bounded transaction", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const shortestCandidate = "agentmesh_oauth=x";
      const candidateCount = Math.floor((MAX_COOKIE_HEADER_LENGTH + 2) / (shortestCandidate.length + 2));
      const cookieField = Array.from({ length: candidateCount }, () => shortestCandidate).join("; ");
      expect(candidateCount).toBe(431);
      expect(cookieField).toHaveLength(8_187);
      expect(`${cookieField}; ${shortestCandidate}`).toHaveLength(8_206);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();

      const callback = await within(app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${"s".repeat(43)}`,
        headers: { cookie: cookieField },
      }), 1_500);

      expect(callback.headers.location).toBe("/?auth_error=github");
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_failed" },
      ]);
      expect(await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("batch-consumes duplicate OAuth values once and rejects every replay", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const target = await start(app);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();
      const duplicated = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${target.state}`,
        headers: { cookie: Array.from({ length: 5 }, () => target.cookie).join("; ") },
      });
      const replay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${target.state}`,
        headers: { cookie: target.cookie },
      });

      expect([duplicated.headers.location, replay.headers.location]).toEqual([
        "/?auth_error=github",
        "/?auth_error=github",
      ]);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
      expect((await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts))[0]?.consumedAt)
        .not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("keeps overlapping concurrent OAuth batches single-use", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const attempts = [];
      for (let index = 0; index < 3; index += 1) attempts.push(await start(app));
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();
      const ambiguous = await Promise.all([
        app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${attempts[0]!.state}`,
          headers: { cookie: [attempts[0]!.cookie, attempts[1]!.cookie].join("; ") },
        }),
        app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${attempts[2]!.state}`,
          headers: { cookie: [attempts[1]!.cookie, attempts[2]!.cookie].join("; ") },
        }),
      ]);
      const replays = [];
      for (const attempt of attempts) {
        replays.push(await app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${attempt.state}`,
          headers: { cookie: attempt.cookie },
        }));
      }

      expect([...ambiguous, ...replays].map((response) => response.headers.location))
        .toEqual(Array.from({ length: 5 }, () => "/?auth_error=github"));
      expect(transaction).toHaveBeenCalledTimes(5);
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
      const storedAttempts = await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts);
      expect(storedAttempts).toHaveLength(3);
      expect(storedAttempts.every((row) => row.consumedAt !== null)).toBe(true);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents))
        .toEqual(Array.from({ length: 5 }, () => ({ eventType: "auth.login_failed" })));
    } finally {
      await app.close();
    }
  });

  it.each([0, 2, 4])("consumes OAuth candidates across five raw Cookie fields with target at %i", async (targetPosition) => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const attempts = [];
      for (let index = 0; index < 5; index += 1) attempts.push(await start(app));
      const target = attempts[0]!;
      const ordered = attempts.slice(1);
      ordered.splice(targetPosition, 0, target);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();
      const port = await listenLoopback(app);

      const ambiguous = await rawCookieCallback(
        port,
        `/auth/github/callback?code=one-use&state=${target.state}`,
        ordered.map((attempt) => attempt.cookie),
      );
      const replay = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${target.state}`,
        headers: { cookie: target.cookie },
      });

      expect(ambiguous).toMatchObject({ statusCode: 303, headers: { location: ["/?auth_error=github"] } });
      expect(replay.headers.location).toBe("/?auth_error=github");
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
      const storedAttempts = await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts);
      expect(storedAttempts).toHaveLength(5);
      expect(storedAttempts.every((attempt) => attempt.consumedAt !== null)).toBe(true);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents))
        .toEqual(Array.from({ length: 2 }, () => ({ eventType: "auth.login_failed" })));
    } finally {
      await app.close();
    }
  });

  it.each(["first", "middle", "last"] as const)(
    "consumes a target at the %s of one 8,193-byte Cookie field",
    async (position) => {
      const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
      const { app } = buildWebApp({ github: github.client });
      try {
        const target = await start(app);
        const cookieField = paddedCookieField(target.cookie, position, MAX_COOKIE_HEADER_LENGTH + 1);
        expect(Buffer.byteLength(cookieField)).toBe(8_193);
        const transaction = vi.spyOn(database.db, "transaction");
        transaction.mockClear();
        const port = await listenLoopback(app);

        const oversized = await rawCookieCallback(
          port,
          `/auth/github/callback?code=one-use&state=${target.state}`,
          [cookieField],
        );
        const replay = await app.inject({
          method: "GET",
          url: `/auth/github/callback?code=one-use&state=${target.state}`,
          headers: { cookie: target.cookie },
        });

        expect(oversized).toMatchObject({ statusCode: 303, headers: { location: ["/?auth_error=github"] } });
        expect(replay.headers.location).toBe("/?auth_error=github");
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(github.exchanges).toHaveLength(0);
        expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
        expect((await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts))[0]?.consumedAt)
          .not.toBeNull();
        expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents))
          .toEqual(Array.from({ length: 2 }, () => ({ eventType: "auth.login_failed" })));
      } finally {
        await app.close();
      }
    },
  );

  it("accepts exactly 8,192 Cookie bytes and completes the ordinary callback", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const target = await start(app);
      const cookieField = paddedCookieField(target.cookie, "middle", MAX_COOKIE_HEADER_LENGTH);
      expect(Buffer.byteLength(cookieField)).toBe(8_192);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();
      const port = await listenLoopback(app);

      const callback = await rawCookieCallback(
        port,
        `/auth/github/callback?code=one-use&state=${target.state}`,
        [cookieField],
      );

      expect(callback).toMatchObject({ statusCode: 303, headers: { location: ["/app"] } });
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(1);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents))
        .toEqual([{ eventType: "auth.login_succeeded" }]);
    } finally {
      await app.close();
    }
  });

  it("admits an unrelated 8,200-byte obs-text header without replaying a successful callback", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const target = await start(app);
      const url = `/auth/github/callback?code=one-use&state=${target.state}`;
      const headers: RawByteHeader[] = [
        { name: "Cookie", value: Buffer.from(target.cookie, "latin1") },
        { name: "X-Pad", value: Buffer.alloc(8_200, 0xe9) },
      ];
      expect(trackedRawHeaderBytes(url, headers)).toBeLessThan(MAX_HTTP_HEADER_SIZE);
      const port = await listenLoopback(app);

      const callback = await rawHttpRequest(port, url, headers);
      const replay = await app.inject({ method: "GET", url, headers: { cookie: target.cookie } });

      expect(callback).toMatchObject({ statusCode: 303, headers: { location: ["/app"] } });
      expect(replay.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(1);
      expect(await database.db.select({ id: oauthIdentities.id }).from(oauthIdentities)).toHaveLength(1);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_succeeded" },
        { eventType: "auth.login_failed" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("uses one raw Latin-1 byte per Cookie code unit at the 8,192/8,193 semantic boundary", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const acceptedAttempt = await start(app);
      const rejectedAttempt = await start(app);
      const acceptedUrl = `/auth/github/callback?code=one-use&state=${acceptedAttempt.state}`;
      const rejectedUrl = `/auth/github/callback?code=one-use&state=${rejectedAttempt.state}`;
      const acceptedCookie = latin1CookieField(acceptedAttempt.cookie, MAX_COOKIE_HEADER_LENGTH);
      const rejectedCookie = latin1CookieField(rejectedAttempt.cookie, MAX_COOKIE_HEADER_LENGTH + 1);
      expect(acceptedCookie.byteLength).toBe(8_192);
      expect(rejectedCookie.byteLength).toBe(8_193);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();
      const port = await listenLoopback(app);

      const accepted = await rawHttpRequest(port, acceptedUrl, [{ name: "Cookie", value: acceptedCookie }]);
      const rejected = await rawHttpRequest(port, rejectedUrl, [{ name: "Cookie", value: rejectedCookie }]);
      const replay = await app.inject({
        method: "GET",
        url: rejectedUrl,
        headers: { cookie: rejectedAttempt.cookie },
      });

      expect(accepted).toMatchObject({ statusCode: 303, headers: { location: ["/app"] } });
      expect(rejected).toMatchObject({ statusCode: 303, headers: { location: ["/?auth_error=github"] } });
      expect(replay.headers.location).toBe("/?auth_error=github");
      expect(transaction).toHaveBeenCalledTimes(5);
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(1);
      const attempts = await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts);
      expect(attempts).toHaveLength(2);
      expect(attempts.every((attempt) => attempt.consumedAt !== null)).toBe(true);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_succeeded" },
        { eventType: "auth.login_failed" },
        { eventType: "auth.login_failed" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("admits 16,383 tracked header bytes and rejects 16,384 before callback work", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const acceptedAttempt = await start(app);
      const acceptedUrl = `/auth/github/callback?code=one-use&state=${acceptedAttempt.state}`;
      const acceptedHeaders = [`Cookie:${acceptedAttempt.cookie}`, "X-Pad:"];
      const acceptedPadding = MAX_HTTP_HEADER_SIZE - 1 - trackedHeaderBytes(acceptedUrl, acceptedHeaders);
      acceptedHeaders[1] = `X-Pad:${"x".repeat(acceptedPadding)}`;
      expect(trackedHeaderBytes(acceptedUrl, acceptedHeaders)).toBe(16_383);
      const port = await listenLoopback(app);

      const accepted = await rawHttpRequest(port, acceptedUrl, acceptedHeaders);
      expect(accepted).toMatchObject({ statusCode: 303, headers: { location: ["/app"] } });
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(1);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toHaveLength(1);

      const rejectedAttempt = await start(app);
      const rejectedUrl = `/auth/github/callback?code=one-use&state=${rejectedAttempt.state}`;
      const rejectedHeaders = [`Cookie:${rejectedAttempt.cookie}`, "X-Pad:"];
      const rejectedPadding = MAX_HTTP_HEADER_SIZE - trackedHeaderBytes(rejectedUrl, rejectedHeaders);
      rejectedHeaders[1] = `X-Pad:${"x".repeat(rejectedPadding)}`;
      expect(trackedHeaderBytes(rejectedUrl, rejectedHeaders)).toBe(16_384);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();

      const rejected = await rawHttpRequest(port, rejectedUrl, rejectedHeaders);
      expect(rejected.statusCode).toBe(431);
      expect(rejected.body).not.toContain(rejectedAttempt.cookie);
      const aboveHeaders = [`Cookie:${rejectedAttempt.cookie}`, `X-Pad:${"x".repeat(rejectedPadding + 1)}`];
      expect(trackedHeaderBytes(rejectedUrl, aboveHeaders)).toBe(16_385);
      const above = await rawHttpRequest(port, rejectedUrl, aboveHeaders);
      expect(above.statusCode).toBe(431);
      expect(above.body).not.toContain(rejectedAttempt.cookie);
      expect(transaction).toHaveBeenCalledTimes(0);
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(1);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toHaveLength(1);
      const attemptsBeforeRetry = await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts);
      expect(attemptsBeforeRetry).toHaveLength(2);
      expect(attemptsBeforeRetry.filter((attempt) => attempt.consumedAt === null)).toHaveLength(1);

      const retry = await app.inject({
        method: "GET",
        url: rejectedUrl,
        headers: { cookie: rejectedAttempt.cookie },
      });
      expect(retry.headers.location).toBe("/app");
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(github.exchanges).toHaveLength(2);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(2);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("matches Node admission at 16,383/16,384/16,385 tracked bytes with obs-text values", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const acceptedAttempt = await start(app);
      const rejectedAttempt = await start(app);
      const acceptedUrl = `/auth/github/callback?code=one-use&state=${acceptedAttempt.state}`;
      const rejectedUrl = `/auth/github/callback?code=one-use&state=${rejectedAttempt.state}`;
      const withTrackedSize = (url: string, cookie: string, trackedSize: number): RawByteHeader[] => {
        const headers: RawByteHeader[] = [
          { name: "Cookie", value: Buffer.from(cookie, "latin1") },
          { name: "X-Pad", value: Buffer.alloc(0) },
        ];
        const padding = trackedSize - trackedRawHeaderBytes(url, headers);
        if (padding < 0) throw new Error("negative obs-text boundary padding");
        headers[1] = { name: "X-Pad", value: Buffer.alloc(padding, 0xe9) };
        expect(trackedRawHeaderBytes(url, headers)).toBe(trackedSize);
        return headers;
      };
      const port = await listenLoopback(app);
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();

      const accepted = await rawHttpRequest(port, acceptedUrl, withTrackedSize(acceptedUrl, acceptedAttempt.cookie, 16_383));
      expect(accepted).toMatchObject({ statusCode: 303, headers: { location: ["/app"] } });
      expect(transaction).toHaveBeenCalledTimes(3);

      const rejected = await rawHttpRequest(port, rejectedUrl, withTrackedSize(rejectedUrl, rejectedAttempt.cookie, 16_384));
      const above = await rawHttpRequest(port, rejectedUrl, withTrackedSize(rejectedUrl, rejectedAttempt.cookie, 16_385));
      expect([rejected.statusCode, above.statusCode]).toEqual([431, 431]);
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(1);
      expect(await database.db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(1);
      const attemptsBeforeRetry = await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts);
      expect(attemptsBeforeRetry.filter((attempt) => attempt.consumedAt === null)).toHaveLength(1);

      const retry = await app.inject({ method: "GET", url: rejectedUrl, headers: { cookie: rejectedAttempt.cookie } });
      expect(retry.headers.location).toBe("/app");
      expect(transaction).toHaveBeenCalledTimes(6);
      expect(github.exchanges).toHaveLength(2);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(2);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents))
        .toEqual(Array.from({ length: 2 }, () => ({ eventType: "auth.login_succeeded" })));
    } finally {
      await app.close();
    }
  });

  it("keeps injected Latin-1 admission in parity with the real HTTP parser", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const target = await start(app);
      const url = `/auth/github/callback?code=one-use&state=${target.state}`;

      const callback = await app.inject({
        method: "GET",
        url,
        headers: { cookie: target.cookie, "x-pad": "é".repeat(8_200) },
      });
      const replay = await app.inject({ method: "GET", url, headers: { cookie: target.cookie } });

      expect(callback.headers.location).toBe("/app");
      expect(replay.headers.location).toBe("/?auth_error=github");
      expect(github.exchanges).toHaveLength(1);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(1);
      expect(await database.db.select({ eventType: auditEvents.eventType }).from(auditEvents)).toEqual([
        { eventType: "auth.login_succeeded" },
        { eventType: "auth.login_failed" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("fails closed on injected non-Latin-1 headers before callback work", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const target = await start(app);
      const url = `/auth/github/callback?code=one-use&state=${target.state}`;
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();

      const rejected = await app.inject({
        method: "GET",
        url,
        headers: { cookie: target.cookie, "x-pad": "\u0100" },
      });

      expect(rejected.statusCode).toBe(431);
      expect(rejected.headers["cache-control"]).toBe("no-store");
      expect(rejected.json()).toEqual({ error: "request headers too large" });
      expect(transaction).toHaveBeenCalledTimes(0);
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
      expect(await database.db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(0);
      expect((await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts))[0]?.consumedAt)
        .toBeNull();

      const retry = await app.inject({ method: "GET", url, headers: { cookie: target.cookie } });
      expect(retry.headers.location).toBe("/app");
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(github.exchanges).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects injected headers at the hard cap before callback work", async () => {
    const github = fakeGitHub({ id: "4242", login: "octocat", name: null, avatarUrl: null });
    const { app } = buildWebApp({ github: github.client });
    try {
      const target = await start(app);
      const url = `/auth/github/callback?code=one-use&state=${target.state}`;
      const transaction = vi.spyOn(database.db, "transaction");
      transaction.mockClear();

      const rejected = await app.inject({
        method: "GET",
        url,
        headers: { cookie: target.cookie, "x-pad": "x".repeat(MAX_HTTP_HEADER_SIZE) },
      });

      expect(rejected.statusCode).toBe(431);
      expect(rejected.headers["cache-control"]).toBe("no-store");
      expect(rejected.json()).toEqual({ error: "request headers too large" });
      expect(rejected.body).not.toContain(target.cookie);
      expect(transaction).toHaveBeenCalledTimes(0);
      expect(github.exchanges).toHaveLength(0);
      expect(await database.db.select({ id: webSessions.id }).from(webSessions)).toHaveLength(0);
      expect(await database.db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(0);
      expect((await database.db.select({ consumedAt: oauthAttempts.consumedAt }).from(oauthAttempts))[0]?.consumedAt)
        .toBeNull();

      const retry = await app.inject({ method: "GET", url, headers: { cookie: target.cookie } });
      expect(retry.headers.location).toBe("/app");
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(github.exchanges).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
