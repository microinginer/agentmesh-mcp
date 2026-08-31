import { randomUUID } from "node:crypto";

import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditService, type AuditService } from "../src/audit/service.js";
import { createProjectToken } from "../src/auth/project-token.js";
import type { WebAuthConfig } from "../src/config.js";
import { createOperatorService } from "../src/control/operator-service.js";
import { createControlProjectService } from "../src/control/project-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  auditEvents,
  messages,
  oauthIdentities,
  projectTokens,
  projects,
  users,
  webSessions,
} from "../src/db/schema.js";
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
const fixedNow = "2026-08-31T12:00:00.000Z";
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const webAuthKey = Buffer.alloc(32, 51);

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

const unusedGitHub: GitHubOAuthClient = {
  authorizationUrl: () => new URL("https://github.example.test/authorize"),
  exchangeCode: async () => { throw new Error("not used"); },
  fetchProfile: async () => { throw new Error("not used"); },
};

function webConfig(operatorIds: ReadonlySet<string>): WebAuthConfig {
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

async function createIdentity(input: {
  githubId: string;
  login: string;
  displayName: string;
}) {
  const [user] = await database.db.insert(users).values({ displayName: input.displayName }).returning();
  if (user === undefined) throw new Error("user insert failed");
  await database.db.insert(oauthIdentities).values({
    userId: user.id,
    provider: "github",
    providerUserId: input.githubId,
    login: input.login,
  });
  return user;
}

async function buildOperatorFixture(auditService?: AuditService) {
  const clock = createTestClock(fixedNow);
  const config = webConfig(new Set(["9001"]));
  const sessionService = createWebSessionService({
    db: database.db,
    keys: deriveWebAuthKeys(config.authKey),
    clock: clock.now,
  });
  const operator = await createIdentity({ githubId: "9001", login: "shared-login", displayName: "Operator" });
  const lookalike = await createIdentity({ githubId: "9002", login: "shared-login", displayName: "Not operator" });
  const target = await createIdentity({ githubId: "9100", login: "target", displayName: "Target" });
  const issuedOperator = await sessionService.issue(operator.id, clock.now());
  const issuedLookalike = await sessionService.issue(lookalike.id, clock.now());
  const issuedTarget = await sessionService.issue(target.id, clock.now());
  if (issuedOperator === null || issuedLookalike === null || issuedTarget === null) {
    throw new Error("session issue failed");
  }

  const projectId = randomUUID();
  const token = createProjectToken();
  await database.db.insert(projects).values({
    id: projectId,
    ownerUserId: target.id,
    name: "private-project-name",
  });
  await database.db.insert(projectTokens).values({
    id: token.tokenId,
    projectId,
    tokenDigest: token.digest,
    label: "target-computer",
    createdByUserId: target.id,
  });
  const secondProjectId = randomUUID();
  await database.db.insert(projects).values({
    id: secondProjectId,
    ownerUserId: target.id,
    name: "second-project",
  });

  const audit = auditService ?? createAuditService({ db: database.db, clock: clock.now });
  const projectService = createProjectService({ db: database.db, clock: clock.now });
  const app = buildHttpApp({
    db: database.db,
    signingKey,
    projectService,
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
      auditService: audit,
      clock: clock.now,
    },
  });

  return {
    app,
    audit,
    clock,
    config,
    operator,
    lookalike,
    target,
    projectId,
    secondProjectId,
    token,
    projectService,
    sessionService,
    operatorAuth: {
      cookie: `agentmesh_session=${issuedOperator.sessionToken}`,
      csrf: issuedOperator.csrfToken,
    },
    lookalikeAuth: {
      cookie: `agentmesh_session=${issuedLookalike.sessionToken}`,
      csrf: issuedLookalike.csrfToken,
    },
    targetSession: issuedTarget,
  };
}

function mutationHeaders(auth: { cookie: string; csrf: string }) {
  return {
    cookie: auth.cookie,
    origin: "http://127.0.0.1",
    "x-csrf-token": auth.csrf,
  };
}

describe("metadata-only operator HTTP", () => {
  it("authorizes only the immutable numeric GitHub ID and never exposes private content", async () => {
    const fixture = await buildOperatorFixture();
    const privateBody = "planted private message body 7dbfeaf7";
    const [agentA, agentB] = await database.pool.query<{ id: string }>(
      `INSERT INTO agents (project_id, registration_digest, name, client)
       VALUES ($1, $2, 'sender', 'codex'), ($1, $3, 'recipient', 'codex')
       RETURNING id`,
      [fixture.projectId, Buffer.alloc(32, 5), Buffer.alloc(32, 6)],
    ).then((result) => result.rows);
    if (agentA === undefined || agentB === undefined) throw new Error("agent insert failed");
    await database.db.insert(messages).values({
      projectId: fixture.projectId,
      senderAgentId: agentA.id,
      recipientAgentId: agentB.id,
      text: privateBody,
      idempotencyKey: randomUUID(),
    });
    try {
      const denied = await fixture.app.inject({
        method: "GET",
        url: "/api/v1/ops/users",
        headers: { cookie: fixture.lookalikeAuth.cookie },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.headers["cache-control"]).toBe("no-store");

      for (const path of [
        "/api/v1/ops/users?limit=100",
        "/api/v1/ops/projects?limit=100",
        `/api/v1/ops/projects/${fixture.projectId}`,
      ]) {
        const response = await fixture.app.inject({
          method: "GET",
          url: path,
          headers: { cookie: fixture.operatorAuth.cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        const serialized = JSON.stringify(response.json());
        expect(serialized).not.toContain(privateBody);
        expect(serialized).not.toContain('"text"');
        expect(serialized).not.toContain('"preview"');
        expect(serialized).not.toMatch(/token_digest|csrf_digest|session_digest|oauth.*token/i);
      }
      const firstPage = await fixture.app.inject({
        method: "GET",
        url: "/api/v1/ops/users?limit=1",
        headers: { cookie: fixture.operatorAuth.cookie },
      });
      const firstJson = firstPage.json() as { items: Array<{ id: string }>; next_cursor: string | null };
      expect(firstJson.items).toHaveLength(1);
      expect(firstJson.next_cursor).toEqual(expect.any(String));
      const secondPage = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/ops/users?limit=1&cursor=${encodeURIComponent(firstJson.next_cursor ?? "")}`,
        headers: { cookie: fixture.operatorAuth.cookie },
      });
      expect(secondPage.statusCode).toBe(200);
      expect((secondPage.json() as { items: Array<{ id: string }> }).items[0]?.id)
        .not.toBe(firstJson.items[0]?.id);

      const absentContentRoute = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/ops/projects/${fixture.projectId}/messages`,
        headers: { cookie: fixture.operatorAuth.cookie },
      });
      expect(absentContentRoute.statusCode).toBe(404);
      expect(absentContentRoute.headers["cache-control"]).toBe("no-store");
      expect(JSON.stringify(absentContentRoute.json())).not.toContain(privateBody);

      for (const suffix of ["?limit=0", "?limit=101", `?cursor=${"x".repeat(700)}`, "?extra=1", "?limit=1&limit=2"]) {
        const invalid = await fixture.app.inject({
          method: "GET",
          url: `/api/v1/ops/users${suffix}`,
          headers: { cookie: fixture.operatorAuth.cookie },
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.headers["cache-control"]).toBe("no-store");
      }
    } finally {
      await fixture.app.close();
    }
  });

  it("blocks and unblocks atomically while revoking all target sessions", async () => {
    const fixture = await buildOperatorFixture();
    try {
      const blocked = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/ops/users/${fixture.target.id}/block`,
        headers: mutationHeaders(fixture.operatorAuth),
      });
      expect(blocked.statusCode).toBe(200);
      expect(blocked.headers["cache-control"]).toBe("no-store");
      expect(blocked.json()).toMatchObject({ user: { id: fixture.target.id, blocked_at: fixedNow } });
      expect(await fixture.sessionService.authenticate(fixture.targetSession.sessionToken)).toBeNull();
      await expect(fixture.projectService.authenticateProject(fixture.token.token)).rejects.toMatchObject({
        code: "PROJECT_AUTH_INVALID",
      });
      const [activeSessions] = await database.db.select({ value: count() }).from(webSessions).where(and(
        eq(webSessions.userId, fixture.target.id),
        isNull(webSessions.revokedAt),
      ));
      expect(activeSessions?.value).toBe(0);

      const repeated = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/ops/users/${fixture.target.id}/block`,
        headers: mutationHeaders(fixture.operatorAuth),
      });
      expect(repeated.statusCode).toBe(409);

      const unblocked = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/ops/users/${fixture.target.id}/unblock`,
        headers: mutationHeaders(fixture.operatorAuth),
      });
      expect(unblocked.statusCode).toBe(200);
      expect(unblocked.json()).toMatchObject({ user: { id: fixture.target.id, blocked_at: null } });
      expect(await fixture.sessionService.authenticate(fixture.targetSession.sessionToken)).toBeNull();

      const audits = await database.db.select().from(auditEvents).where(eq(auditEvents.userId, fixture.target.id));
      expect(audits.map((event) => event.eventType)).toEqual([
        "operator.user_blocked",
        "operator.user_unblocked",
      ]);
    } finally {
      await fixture.app.close();
    }
  });

  it("requires both CSRF and the operator allowlist for mutations", async () => {
    const fixture = await buildOperatorFixture();
    try {
      const noCsrf = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/ops/users/${fixture.target.id}/block`,
        headers: { cookie: fixture.operatorAuth.cookie },
      });
      expect(noCsrf.statusCode).toBe(403);
      const nonOperator = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/ops/users/${fixture.target.id}/block`,
        headers: {
          cookie: fixture.lookalikeAuth.cookie,
          origin: "http://127.0.0.1",
          "x-csrf-token": fixture.lookalikeAuth.csrf,
        },
      });
      expect(nonOperator.statusCode).toBe(403);
      const [target] = await database.db.select({ blockedAt: users.blockedAt }).from(users)
        .where(eq(users.id, fixture.target.id));
      expect(target?.blockedAt).toBeNull();
    } finally {
      await fixture.app.close();
    }
  });

  it("archives through the operator route under the project lock", async () => {
    const fixture = await buildOperatorFixture();
    try {
      const archived = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/ops/projects/${fixture.projectId}/archive`,
        headers: mutationHeaders(fixture.operatorAuth),
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.headers["cache-control"]).toBe("no-store");
      expect(archived.json()).toMatchObject({
        project: { id: fixture.projectId, status: "archived", archived_at: fixedNow },
      });
      const [audit] = await database.db.select().from(auditEvents).where(
        eq(auditEvents.eventType, "operator.project_archived"),
      );
      expect(audit).toMatchObject({
        userId: fixture.target.id,
        projectId: fixture.projectId,
        metadata: {
          project_name: "private-project-name",
          actor_kind: "user",
          actor_user_id: fixture.operator.id,
          subject_user_id: fixture.target.id,
          request_id: expect.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/),
        },
      });
      await expect(fixture.projectService.authenticateProject(fixture.token.token)).rejects.toMatchObject({
        code: "PROJECT_AUTH_INVALID",
      });
    } finally {
      await fixture.app.close();
    }
  });
});

describe("operator transactional services", () => {
  it("attributes the same subject to two distinct authenticated operators", async () => {
    const fixture = await buildOperatorFixture();
    await fixture.app.close();
    const secondOperator = await createIdentity({
      githubId: "9003",
      login: "second-operator",
      displayName: "Second operator",
    });
    const service = createOperatorService({
      db: database.db,
      audit: fixture.audit,
      projectLimit: 5,
      clock: fixture.clock.now,
    });
    const blockRequestId = randomUUID();
    const unblockRequestId = randomUUID();

    await service.blockUser({
      operatorUserId: fixture.operator.id,
      targetUserId: fixture.target.id,
      requestId: blockRequestId,
    });
    await service.unblockUser({
      operatorUserId: secondOperator.id,
      targetUserId: fixture.target.id,
      requestId: unblockRequestId,
    });

    const events = await database.db.select().from(auditEvents).where(
      eq(auditEvents.userId, fixture.target.id),
    );
    const byType = Object.fromEntries(events.map((event) => [event.eventType, event]));
    expect(byType["operator.user_blocked"]?.metadata).toEqual({
      actor_kind: "user",
      actor_user_id: fixture.operator.id,
      subject_user_id: fixture.target.id,
      request_id: blockRequestId,
    });
    expect(byType["operator.user_unblocked"]?.metadata).toEqual({
      actor_kind: "user",
      actor_user_id: secondOperator.id,
      subject_user_id: fixture.target.id,
      request_id: unblockRequestId,
    });
  });

  it("rolls back block, session revocation, archive, and audit when auditing fails", async () => {
    const fixture = await buildOperatorFixture();
    await fixture.app.close();
    const realAudit = createAuditService({ db: database.db, clock: fixture.clock.now });
    const failingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        await realAudit.record(...args);
        throw new Error("forced audit failure");
      },
    } satisfies AuditService;
    const service = createOperatorService({
      db: database.db,
      audit: failingAudit,
      projectLimit: 5,
      clock: fixture.clock.now,
    });

    await expect(service.blockUser({
      operatorUserId: fixture.operator.id,
      targetUserId: fixture.target.id,
      requestId: randomUUID(),
    })).rejects.toThrow("forced audit failure");
    expect(await fixture.sessionService.authenticate(fixture.targetSession.sessionToken)).not.toBeNull();
    const [target] = await database.db.select({ blockedAt: users.blockedAt }).from(users)
      .where(eq(users.id, fixture.target.id));
    expect(target?.blockedAt).toBeNull();
    expect(await database.db.select().from(auditEvents)).toEqual([]);

    await expect(service.archiveProject({
      operatorUserId: fixture.operator.id,
      projectId: fixture.projectId,
      requestId: randomUUID(),
    })).rejects.toThrow("forced audit failure");
    const [project] = await database.db.select({ status: projects.status }).from(projects)
      .where(eq(projects.id, fixture.projectId));
    expect(project?.status).toBe("active");
    expect(await database.db.select().from(auditEvents)).toEqual([]);
  });

  it("serializes competing operator archives to one transition and one audit", async () => {
    const fixture = await buildOperatorFixture();
    await fixture.app.close();
    const service = createOperatorService({
      db: database.db,
      audit: fixture.audit,
      projectLimit: 5,
      clock: fixture.clock.now,
    });

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.archiveProject({
      operatorUserId: fixture.operator.id,
      projectId: fixture.projectId,
      requestId: randomUUID(),
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5);
    expect(await database.db.select().from(auditEvents).where(
      eq(auditEvents.eventType, "operator.project_archived"),
    )).toHaveLength(1);
  });

  it("serializes an owner archive racing the operator archive", async () => {
    const fixture = await buildOperatorFixture();
    await fixture.app.close();
    const operatorService = createOperatorService({
      db: database.db,
      audit: fixture.audit,
      projectLimit: 5,
      clock: fixture.clock.now,
    });
    const ownerService = createControlProjectService({
      db: database.db,
      audit: fixture.audit,
      projectLimit: 5,
      clock: fixture.clock.now,
    });

    const results = await Promise.allSettled([
      operatorService.archiveProject({
        operatorUserId: fixture.operator.id,
        projectId: fixture.projectId,
        requestId: randomUUID(),
      }),
      ownerService.archive({
        ownerUserId: fixture.target.id,
        projectId: fixture.projectId,
        requestId: randomUUID(),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const audits = await database.db.select().from(auditEvents).where(eq(auditEvents.projectId, fixture.projectId));
    expect(audits).toHaveLength(1);
    expect(["operator.project_archived", "project.archived"]).toContain(audits[0]?.eventType);
  });

  it("makes an in-flight project authentication wait for the owner block recheck", async () => {
    const fixture = await buildOperatorFixture();
    await fixture.app.close();
    let signalAudit!: () => void;
    let releaseAudit!: () => void;
    const auditReached = new Promise<void>((resolve) => { signalAudit = resolve; });
    const auditRelease = new Promise<void>((resolve) => { releaseAudit = resolve; });
    const realAudit = createAuditService({ db: database.db, clock: fixture.clock.now });
    const pausingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        signalAudit();
        await auditRelease;
        await realAudit.record(...args);
      },
    } satisfies AuditService;
    const service = createOperatorService({
      db: database.db,
      audit: pausingAudit,
      projectLimit: 5,
      clock: fixture.clock.now,
    });

    const blocking = service.blockUser({
      operatorUserId: fixture.operator.id,
      targetUserId: fixture.target.id,
      requestId: randomUUID(),
    });
    await auditReached;
    let authenticationSettled = false;
    const authentication = fixture.projectService.authenticateProject(fixture.token.token)
      .finally(() => { authenticationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(authenticationSettled).toBe(false);

    releaseAudit();
    await blocking;
    await expect(authentication).rejects.toMatchObject({ code: "PROJECT_AUTH_INVALID" });
  });
});
