import { createHash } from "node:crypto";

import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditService } from "../src/audit/service.js";
import type { WebAuthConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { auditEvents, oauthIdentities, webSessions } from "../src/db/schema.js";
import { buildHttpApp } from "../src/http.js";
import { createProjectService } from "../src/projects/service.js";
import type { GitHubOAuthClient, GitHubProfile } from "../src/web-auth/github-client.js";
import { createIdentityService } from "../src/web-auth/identity-service.js";
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
    wrapSessionService?: (service: WebSessionService) => WebSessionService;
  }) {
    const clock = input.clock ?? createTestClock("2026-08-01T00:00:00.000Z");
    const config = webConfig(input.secureCookies);
    const sessionService = createWebSessionService({
      db: database.db,
      keys: deriveWebAuthKeys(config.authKey),
      clock: clock.now,
    });
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
          identityService: createIdentityService({ db: database.db, clock: clock.now }),
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

      github.setProfile({ id: "4343", login: "different", name: "Different", avatarUrl: null });
      const differentAttempt = await start(app);
      const differentCallback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${differentAttempt.state}`,
        headers: { cookie: `${differentAttempt.cookie}; ${replacementSession}` },
      });
      expect(differentCallback.statusCode).toBe(303);
      expect(differentCallback.headers.location).toBe("/?auth_error=github");
      expect((await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: replacementSession } })).statusCode).toBe(200);
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
      expect(github.exchanges).toHaveLength(1);

      const repeatedRawHeader = await start(app);
      const repeated = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${repeatedRawHeader.state}`,
        headers: {
          cookie: [repeatedRawHeader.cookie, "agentmesh_session=not-canonical"],
        } as never,
      });
      expect(repeated.headers.location).toBe("/?auth_error=github");
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
});
