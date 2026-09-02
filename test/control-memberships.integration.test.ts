import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditService } from "../src/audit/service.js";
import type { WebAuthConfig } from "../src/config.js";
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
const webAuthKey = Buffer.alloc(32, 42);
const fixedNow = "2026-09-02T12:00:00.000Z";

const unusedGitHub: GitHubOAuthClient = {
  authorizationUrl: () => new URL("https://github.example.test/authorize"),
  exchangeCode: async () => { throw new Error("not used"); },
  fetchProfile: async () => { throw new Error("not used"); },
};

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

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

async function buildFixture() {
  const clock = createTestClock(fixedNow);
  const config = webConfig();
  const sessionService = createWebSessionService({
    db: database.db,
    keys: deriveWebAuthKeys(config.authKey),
    clock: clock.now,
  });
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

  async function authenticatedUser(displayName: string, githubId: string) {
    const [user] = await database.db.insert(users).values({ displayName }).returning();
    if (user === undefined) throw new Error("user insert failed");
    await database.db.insert(oauthIdentities).values({
      userId: user.id,
      provider: "github",
      providerUserId: githubId,
      login: `login-${githubId}`,
    });
    const session = await sessionService.issue(user.id, clock.now());
    if (session === null) throw new Error("session issue failed");
    return {
      user,
      cookie: `agentmesh_session=${session.sessionToken}`,
      headers: {
        cookie: `agentmesh_session=${session.sessionToken}`,
        origin: "http://127.0.0.1",
        "x-csrf-token": session.csrfToken,
      },
    };
  }

  const owner = await authenticatedUser("Owner", "7101");
  const viewer = await authenticatedUser("Viewer", "7102");
  const outsider = await authenticatedUser("Outsider", "7103");
  const [project] = await database.db.insert(projects).values({
    ownerUserId: owner.user.id,
    name: "Managed members",
  }).returning();
  if (project === undefined) throw new Error("project insert failed");
  await database.db.insert(projectMemberships).values([
    {
      projectId: project.id,
      userId: owner.user.id,
      role: "owner",
      createdBy: owner.user.id,
    },
    {
      projectId: project.id,
      userId: viewer.user.id,
      role: "viewer",
      createdBy: owner.user.id,
    },
  ]);
  return { app, owner, viewer, outsider, project };
}

describe("owner project member-management HTTP API", () => {
  it("lists members and returns a raw invitation URL only at creation", async () => {
    const { app, owner, viewer, project } = await buildFixture();
    try {
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/invitations`,
        headers: owner.headers,
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.json()).toMatchObject({
        invitation: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          role: "viewer",
          created_at: fixedNow,
          expires_at: "2026-09-09T12:00:00.000Z",
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1\/invite\/[A-Za-z0-9_-]{43}$/),
        },
      });

      const listed = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/members`,
        headers: { cookie: owner.cookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(listed.json()).toMatchObject({
        members: [
          { user_id: owner.user.id, role: "owner", github_login: "login-7101", display_name: "Owner" },
          { user_id: viewer.user.id, role: "viewer", github_login: "login-7102", display_name: "Viewer" },
        ],
        invitations: [{ id: created.json().invitation.id, role: "viewer" }],
      });
      expect(JSON.stringify(listed.json())).not.toMatch(/token|digest|\/invite\//i);
    } finally {
      await app.close();
    }
  });

  it("revokes pending invitations and removes viewers", async () => {
    const { app, owner, viewer, project } = await buildFixture();
    try {
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/invitations`,
        headers: owner.headers,
      });
      const invitationId = created.json().invitation.id as string;
      const revoked = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${project.id}/invitations/${invitationId}`,
        headers: owner.headers,
      });
      expect(revoked.statusCode).toBe(204);
      expect(revoked.body).toBe("");

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${project.id}/members/${viewer.user.id}`,
        headers: owner.headers,
      });
      expect(removed.statusCode).toBe(204);
      expect(await database.db.select().from(projectMemberships).where(eq(projectMemberships.projectId, project.id)))
        .toEqual([expect.objectContaining({ userId: owner.user.id, role: "owner" })]);
    } finally {
      await app.close();
    }
  });

  it("returns indistinguishable not-found responses to viewers and outsiders", async () => {
    const { app, viewer, outsider, project } = await buildFixture();
    try {
      for (const actor of [viewer, outsider]) {
        for (const request of [
          { method: "GET" as const, url: `/api/v1/projects/${project.id}/members` },
          { method: "POST" as const, url: `/api/v1/projects/${project.id}/invitations` },
          { method: "DELETE" as const, url: `/api/v1/projects/${project.id}/invitations/${randomUUID()}` },
          { method: "DELETE" as const, url: `/api/v1/projects/${project.id}/members/${viewer.user.id}` },
        ]) {
          const response = await app.inject({ ...request, headers: actor.headers });
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
        }
      }
    } finally {
      await app.close();
    }
  });

  it("keeps owner membership immutable and validates CSRF, paths, bodies, and queries", async () => {
    const { app, owner, project } = await buildFixture();
    try {
      const ownerRemoval = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${project.id}/members/${owner.user.id}`,
        headers: owner.headers,
      });
      expect(ownerRemoval.statusCode).toBe(404);
      expect(ownerRemoval.json()).toMatchObject({ error: { code: "MEMBER_NOT_FOUND" } });

      const missingCsrf = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/invitations`,
        headers: { cookie: owner.cookie },
      });
      expect(missingCsrf.statusCode).toBe(403);

      for (const request of [
        { method: "GET" as const, url: `/api/v1/projects/${project.id}/members?extra=1`, headers: { cookie: owner.cookie } },
        { method: "POST" as const, url: `/api/v1/projects/${project.id}/invitations`, headers: owner.headers, payload: {} },
        { method: "DELETE" as const, url: `/api/v1/projects/${project.id}/invitations/not-a-uuid`, headers: owner.headers },
        { method: "DELETE" as const, url: `/api/v1/projects/${project.id}/members/not-a-uuid`, headers: owner.headers },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      }
    } finally {
      await app.close();
    }
  });
});
