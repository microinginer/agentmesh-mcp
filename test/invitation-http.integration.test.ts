import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditService } from "../src/audit/service.js";
import { DEFAULT_RATE_LIMITS, type RateLimitConfig, type WebAuthConfig } from "../src/config.js";
import { createProjectMembershipService } from "../src/control/membership-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { oauthIdentities, projectMemberships, projects, users } from "../src/db/schema.js";
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
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const webAuthKey = Buffer.alloc(32, 52);
const fixedNow = "2026-09-02T12:00:00.000Z";

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers["set-cookie"];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" ? [value] : [];
}

function cookiePair(response: { headers: Record<string, unknown> }, name: string): string {
  const value = setCookies(response).find((item) => item.startsWith(`${name}=`));
  return value?.split(";", 1)[0] ?? "";
}

function webConfig(secureCookies = false): WebAuthConfig {
  const origin = secureCookies ? "https://agentmesh.example" : "http://127.0.0.1";
  const config = {
    clientId: "test-client-id",
    callbackUrl: new URL(`${origin}/auth/github/callback`),
    publicOrigin: new URL(origin),
    operatorGitHubIds: new Set<string>(),
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

function githubClient(): GitHubOAuthClient {
  return {
    authorizationUrl: (state, challenge) => new URL(
      `https://github.example.test/authorize?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`,
    ),
    exchangeCode: async () => "provider-access-token",
    fetchProfile: async () => ({
      id: "8202",
      login: "invited-viewer",
      name: "Invited Viewer",
      avatarUrl: "https://avatars.githubusercontent.com/u/8202?v=4",
    }),
  };
}

async function fixture(secureCookies = false, rateLimits?: RateLimitConfig) {
  const clock = createTestClock(fixedNow);
  const config = webConfig(secureCookies);
  const audit = createAuditService({ db: database.db, clock: clock.now });
  const sessionService = createWebSessionService({
    db: database.db,
    keys: deriveWebAuthKeys(config.authKey),
    clock: clock.now,
  });
  const [owner] = await database.db.insert(users).values({ displayName: "Invitation owner" }).returning();
  if (owner === undefined) throw new Error("owner fixture failed");
  await database.db.insert(oauthIdentities).values({
    userId: owner.id,
    provider: "github",
    providerUserId: "8201",
    login: "invitation-owner",
  });
  const [project] = await database.db.insert(projects).values({
    ownerUserId: owner.id,
    name: "Invited project",
  }).returning();
  if (project === undefined) throw new Error("project fixture failed");
  await database.db.insert(projectMemberships).values({
    projectId: project.id,
    userId: owner.id,
    role: "owner",
    createdBy: owner.id,
  });
  const memberships = createProjectMembershipService({
    db: database.db,
    audit,
    publicOrigin: config.publicOrigin,
    clock: clock.now,
  });
  const invitation = await memberships.createInvitation({
    ownerUserId: owner.id,
    projectId: project.id,
    requestId: randomUUID(),
  });
  const rawToken = new URL(invitation.url).pathname.split("/").at(-1) ?? "";
  const app = buildHttpApp({
    db: database.db,
    signingKey,
    projectService: createProjectService({ db: database.db, clock: clock.now }),
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost", "agentmesh.example"],
    admin: null,
    logger: { write: () => {} },
    ...(rateLimits === undefined ? {} : { rateLimits }),
    web: {
      db: database.db,
      config,
      githubClient: githubClient(),
      identityService: createIdentityService({ db: database.db, clock: clock.now }),
      sessionService,
      auditService: audit,
      clock: clock.now,
    },
  });
  return { app, clock, config, invitation, rawToken, project, owner, sessionService };
}

describe("project invitation HTTP and OAuth flow", () => {
  it("captures a valid token without mutating membership and uses a short-lived HttpOnly cookie", async () => {
    const { app, rawToken, project } = await fixture();
    try {
      const captured = await app.inject({ method: "GET", url: `/invite/${rawToken}` });
      expect(captured.statusCode).toBe(303);
      expect(captured.headers.location).toBe("/app/invitations/accept");
      expect(captured.headers["cache-control"]).toBe("no-store");
      const inviteSetCookie = setCookies(captured).find((value) => value.startsWith("agentmesh_invite="));
      expect(inviteSetCookie).toContain("HttpOnly");
      expect(inviteSetCookie).toContain("SameSite=Lax");
      expect(inviteSetCookie).toContain("Path=/");
      expect(inviteSetCookie).toContain("Max-Age=1800");
      expect(inviteSetCookie).not.toContain("Domain=");
      expect(inviteSetCookie).not.toContain("Secure");
      expect(await database.db.select().from(projectMemberships).where(eq(projectMemberships.projectId, project.id)))
        .toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("uses the __Host cookie prefix in secure production mode", async () => {
    const { app, rawToken } = await fixture(true);
    try {
      const captured = await app.inject({
        method: "GET",
        url: `/invite/${rawToken}`,
        headers: { host: "agentmesh.example" },
      });
      const inviteSetCookie = setCookies(captured).find((value) => value.startsWith("__Host-agentmesh_invite="));
      expect(inviteSetCookie).toContain("Secure");
      expect(inviteSetCookie).toContain("HttpOnly");
      expect(inviteSetCookie).not.toContain("Domain=");
    } finally {
      await app.close();
    }
  });

  it("does not retain unavailable tokens in an invitation cookie", async () => {
    const { app, rawToken, invitation, clock } = await fixture();
    try {
      for (const token of ["not-a-token", `${rawToken}=`, "A".repeat(43)]) {
        const response = await app.inject({ method: "GET", url: `/invite/${token}` });
        expect(response.statusCode).toBe(303);
        expect(response.headers.location).toBe("/app/invitations/accept");
        expect(setCookies(response)).toContainEqual(expect.stringContaining("agentmesh_invite=;"));
      }
      clock.set(invitation.expiresAt);
      const expired = await app.inject({ method: "GET", url: `/invite/${rawToken}` });
      expect(setCookies(expired)).toContainEqual(expect.stringContaining("agentmesh_invite=;"));
    } finally {
      await app.close();
    }
  });

  it("rate limits public capture by IP and redemption by authenticated session", async () => {
    const limits = { ...DEFAULT_RATE_LIMITS, inviteCapture: 1, inviteRedeem: 1 };
    const { app, rawToken, sessionService, owner } = await fixture(false, limits);
    try {
      const firstCapture = await app.inject({ method: "GET", url: `/invite/${rawToken}` });
      expect(firstCapture.statusCode).toBe(303);
      const secondCapture = await app.inject({ method: "GET", url: `/invite/${rawToken}` });
      expect(secondCapture.statusCode).toBe(429);

      const session = await sessionService.issue(owner.id, new Date(fixedNow));
      if (session === null) throw new Error("session issue failed");
      const headers = {
        cookie: `agentmesh_session=${session.sessionToken}`,
        origin: "http://127.0.0.1",
        "x-csrf-token": session.csrfToken,
      };
      const firstRedeem = await app.inject({
        method: "POST",
        url: "/api/v1/project-invitations/redeem",
        headers,
      });
      expect(firstRedeem.statusCode).toBe(409);
      const secondRedeem = await app.inject({
        method: "POST",
        url: "/api/v1/project-invitations/redeem",
        headers,
      });
      expect(secondRedeem.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("creates the GitHub user and viewer membership only after CSRF-protected redemption", async () => {
    const { app, rawToken, project } = await fixture();
    try {
      const captured = await app.inject({ method: "GET", url: `/invite/${rawToken}` });
      const inviteCookie = cookiePair(captured, "agentmesh_invite");

      const started = await app.inject({
        method: "GET",
        url: "/auth/github/start?return_to=%2Fapp%2Finvitations%2Faccept",
        headers: { cookie: inviteCookie },
      });
      const authorization = new URL(started.headers.location ?? "");
      const state = authorization.searchParams.get("state");
      const oauthCookie = cookiePair(started, "agentmesh_oauth");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const callback = await app.inject({
        method: "GET",
        url: `/auth/github/callback?code=one-use&state=${state}`,
        headers: { cookie: `${oauthCookie}; ${inviteCookie}` },
      });
      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe("/app/invitations/accept");
      const sessionCookie = cookiePair(callback, "agentmesh_session");

      const session = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: sessionCookie },
      });
      const csrf = session.json().csrf_token as string;
      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/project-invitations/redeem",
        headers: { cookie: `${sessionCookie}; ${inviteCookie}` },
      });
      expect(missingCsrf.statusCode).toBe(403);

      const redeemed = await app.inject({
        method: "POST",
        url: "/api/v1/project-invitations/redeem",
        headers: {
          cookie: `${sessionCookie}; ${inviteCookie}`,
          origin: "http://127.0.0.1",
          "x-csrf-token": csrf,
        },
      });
      expect(redeemed.statusCode).toBe(200);
      expect(redeemed.json()).toEqual({ project_id: project.id });
      expect(setCookies(redeemed)).toContainEqual(expect.stringContaining("agentmesh_invite=;"));

      const viewerUserId = session.json().user.id as string;
      expect(await database.db.select().from(projectMemberships).where(and(
        eq(projectMemberships.projectId, project.id),
        eq(projectMemberships.userId, viewerUserId),
      ))).toEqual([expect.objectContaining({ role: "viewer" })]);

      const readable = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}`,
        headers: { cookie: sessionCookie },
      });
      expect(readable.statusCode).toBe(200);
      expect(readable.json()).toMatchObject({ project: { id: project.id, can_edit: false } });
      const writeDenied = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/archive`,
        headers: {
          cookie: sessionCookie,
          origin: "http://127.0.0.1",
          "x-csrf-token": csrf,
        },
      });
      expect(writeDenied.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects duplicate invitation cookies and clears replayed credentials", async () => {
    const { app, rawToken, sessionService, owner } = await fixture();
    try {
      const captured = await app.inject({ method: "GET", url: `/invite/${rawToken}` });
      const inviteCookie = cookiePair(captured, "agentmesh_invite");
      const session = await sessionService.issue(owner.id, new Date(fixedNow));
      if (session === null) throw new Error("session issue failed");
      const sessionCookie = `agentmesh_session=${session.sessionToken}`;
      const headers = {
        cookie: `${sessionCookie}; ${inviteCookie}; ${inviteCookie}`,
        origin: "http://127.0.0.1",
        "x-csrf-token": session.csrfToken,
      };

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/v1/project-invitations/redeem",
        headers,
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(setCookies(duplicate)).toContainEqual(expect.stringContaining("agentmesh_invite=;"));
    } finally {
      await app.close();
    }
  });
});
