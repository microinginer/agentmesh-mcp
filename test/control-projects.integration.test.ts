import { randomUUID } from "node:crypto";

import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { projectListResponseSchema, projectResponseSchema } from "../shared/control-api.js";
import { createAuditService, type AuditService } from "../src/audit/service.js";
import type { WebAuthConfig } from "../src/config.js";
import { createControlProjectService } from "../src/control/project-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { auditEvents, oauthIdentities, projects, users } from "../src/db/schema.js";
import { buildHttpApp } from "../src/http.js";
import { createProjectService } from "../src/projects/service.js";
import type { GitHubOAuthClient } from "../src/web-auth/github-client.js";
import { createIdentityService } from "../src/web-auth/identity-service.js";
import { createWebSessionService } from "../src/web-auth/session-service.js";
import { deriveWebAuthKeys } from "../src/web-auth/session-token.js";
import { resetDatabase } from "./support/database.js";
import { createTestClock } from "./support/hosted.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const webAuthKey = Buffer.alloc(32, 31);
const fixedNow = "2026-08-31T12:00:00.000Z";

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

async function createUser(displayName: string) {
  const [user] = await database.db.insert(users).values({ displayName }).returning();
  if (user === undefined) throw new Error("user insert failed");
  return user;
}

function serviceWith(input: {
  projectLimit: number;
  now?: () => Date;
  audit?: AuditService;
}) {
  const clock = input.now ?? (() => new Date(fixedNow));
  return createControlProjectService({
    db: database.db,
    audit: input.audit ?? createAuditService({ db: database.db, clock }),
    projectLimit: input.projectLimit,
    clock,
  });
}

function createInput(ownerUserId: string, index: number, idempotencyKey = randomUUID()) {
  return {
    ownerUserId,
    name: `project-${index}`,
    description: null,
    idempotencyKey,
    requestId: randomUUID(),
  };
}

function ownerHeaders(owner: { cookie: string; csrf: string }) {
  return {
    cookie: owner.cookie,
    origin: "http://127.0.0.1",
    "x-csrf-token": owner.csrf,
  };
}

describe("owner project lifecycle service", () => {
  it("never exceeds five active projects under eight concurrent creates", async () => {
    const owner = await createUser("Owner");
    const service = serviceWith({ projectLimit: 5 });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => service.create(createInput(owner.id, index))),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "PROJECT_LIMIT_REACHED" });
      }
    }
    const [active] = await database.db.select({ value: count() }).from(projects).where(and(
      eq(projects.ownerUserId, owner.id),
      eq(projects.status, "active"),
    ));
    const [audits] = await database.db.select({ value: count() }).from(auditEvents).where(
      eq(auditEvents.eventType, "project.created"),
    );
    expect(active?.value).toBe(5);
    expect(audits?.value).toBe(5);
  });

  it("treats limit zero as unlimited", async () => {
    const owner = await createUser("Self-hosted owner");
    const service = serviceWith({ projectLimit: 0 });

    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) => service.create(createInput(owner.id, index))),
    );

    expect(created).toHaveLength(8);
    const listed = await service.list({ ownerUserId: owner.id, limit: 100 });
    expect(listed.projects).toHaveLength(8);
    expect(listed.activeCount).toBe(8);
    expect(listed.projectLimit).toBe(0);
  });

  it("returns a canonical active project independently of paginated recent projects", async () => {
    const owner = await createUser("Owner with archive history");
    const olderActiveId = "00000000-0000-4000-8000-000000000010";
    const newerArchivedId = "00000000-0000-4000-8000-000000000011";
    await database.db.insert(projects).values([
      {
        id: olderActiveId,
        ownerUserId: owner.id,
        name: "Older active",
        status: "active",
        createdAt: new Date("2026-08-30T10:00:00.000Z"),
        updatedAt: new Date("2026-08-30T10:00:00.000Z"),
      },
      {
        id: newerArchivedId,
        ownerUserId: owner.id,
        name: "Newer archived",
        status: "archived",
        archivedAt: new Date("2026-08-31T10:00:00.000Z"),
        createdAt: new Date("2026-08-31T10:00:00.000Z"),
        updatedAt: new Date("2026-08-31T10:00:00.000Z"),
      },
    ]);
    const service = serviceWith({ projectLimit: 5 });

    const first = await service.list({ ownerUserId: owner.id, limit: 1 });
    expect(first.projects.map((item) => item.id)).toEqual([newerArchivedId]);
    expect(first.defaultProject?.id).toBe(olderActiveId);
    expect(first.nextCursor).toEqual(expect.any(String));
    if (first.nextCursor === null) throw new Error("Expected a second project page");

    const second = await service.list({
      ownerUserId: owner.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.projects.map((item) => item.id)).toEqual([olderActiveId]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns an idempotent create before a new limit decision and audits only once", async () => {
    const owner = await createUser("Owner");
    const service = serviceWith({ projectLimit: 1 });
    const key = randomUUID();
    const first = await service.create(createInput(owner.id, 1, key));

    const replay = await service.create({
      ...createInput(owner.id, 999, key),
      name: "must-not-replace-original",
    });

    expect(replay).toEqual(first);
    await expect(service.create(createInput(owner.id, 2))).rejects.toMatchObject({
      code: "PROJECT_LIMIT_REACHED",
    });
    const rows = await database.db.select().from(projects);
    const audits = await database.db.select().from(auditEvents).where(
      eq(auditEvents.eventType, "project.created"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("project-1");
    expect(audits).toHaveLength(1);
  });

  it("collapses concurrent retries of one idempotency key to one project and one audit", async () => {
    const owner = await createUser("Retry owner");
    const service = serviceWith({ projectLimit: 5 });
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => service.create(
      createInput(owner.id, index, key),
    )));

    expect(new Set(results.map((project) => project.id)).size).toBe(1);
    expect(await database.db.select().from(projects)).toHaveLength(1);
    expect(await database.db.select().from(auditEvents).where(
      eq(auditEvents.eventType, "project.created"),
    )).toHaveLength(1);
  });

  it("serializes restores on the owner row and admits exactly five active projects", async () => {
    const owner = await createUser("Restore owner");
    const unlimited = serviceWith({ projectLimit: 0 });
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) => unlimited.create(createInput(owner.id, index))),
    );
    await Promise.all(created.map((project) => unlimited.archive({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    })));

    const limited = serviceWith({ projectLimit: 5 });
    const results = await Promise.allSettled(created.map((project) => limited.restore({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    const [active] = await database.db.select({ value: count() }).from(projects).where(and(
      eq(projects.ownerUserId, owner.id),
      eq(projects.status, "active"),
    ));
    expect(active?.value).toBe(5);
  });

  it("keeps ownerless and cross-owner projects invisible", async () => {
    const ownerA = await createUser("Owner A");
    const ownerB = await createUser("Owner B");
    const service = serviceWith({ projectLimit: 5 });
    const projectA = await service.create(createInput(ownerA.id, 1));
    const legacyId = randomUUID();
    await database.db.insert(projects).values({ id: legacyId, name: "legacy" });

    expect(await service.get({ ownerUserId: ownerB.id, projectId: projectA.id })).toBeNull();
    expect(await service.get({ ownerUserId: ownerA.id, projectId: legacyId })).toBeNull();
    expect((await service.list({ ownerUserId: ownerA.id, limit: 50 })).projects.map((row) => row.id)).toEqual([
      projectA.id,
    ]);
    await expect(service.archive({
      ownerUserId: ownerB.id,
      projectId: projectA.id,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("returns conflicts for repeated archive and restore without duplicate audit", async () => {
    const owner = await createUser("Owner");
    const service = serviceWith({ projectLimit: 5 });
    const project = await service.create(createInput(owner.id, 1));

    const archived = await service.archive({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });
    expect(archived.status).toBe("archived");
    await expect(service.archive({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "PROJECT_STATE_CONFLICT" });

    const restored = await service.restore({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });
    expect(restored.status).toBe("active");
    await expect(service.restore({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "PROJECT_STATE_CONFLICT" });

    const lifecycleAudits = await database.db.select().from(auditEvents).where(
      eq(auditEvents.projectId, project.id),
    );
    expect(lifecycleAudits).toHaveLength(3);
    expect(lifecycleAudits.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "project.created",
      "project.archived",
      "project.restored",
    ]));
  });

  it("requires exact case-sensitive confirmation and authentication from the last fifteen minutes", async () => {
    const owner = await createUser("Owner");
    const service = serviceWith({ projectLimit: 5 });
    const project = await service.create({
      ...createInput(owner.id, 1),
      name: "Case Sensitive Project",
    });
    const recent = new Date("2026-08-31T11:45:00.000Z");

    await expect(service.delete({
      ownerUserId: owner.id,
      projectId: project.id,
      confirmName: "case sensitive project",
      authenticatedAt: recent,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "PROJECT_CONFIRMATION_MISMATCH" });
    await expect(service.delete({
      ownerUserId: owner.id,
      projectId: project.id,
      confirmName: project.name,
      authenticatedAt: new Date("2026-08-31T11:44:59.999Z"),
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    await expect(service.delete({
      ownerUserId: owner.id,
      projectId: project.id,
      confirmName: project.name,
      authenticatedAt: new Date("2026-08-31T12:00:00.001Z"),
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });

    await expect(service.delete({
      ownerUserId: owner.id,
      projectId: project.id,
      confirmName: project.name,
      authenticatedAt: recent,
      requestId: randomUUID(),
    })).resolves.toBeUndefined();
    expect(await service.get({ ownerUserId: owner.id, projectId: project.id })).toBeNull();
    const [deletedAudit] = await database.db.select().from(auditEvents).where(
      eq(auditEvents.eventType, "project.deleted"),
    );
    expect(deletedAudit).toMatchObject({
      userId: owner.id,
      projectId: project.id,
      metadata: { project_name: "Case Sensitive Project" },
    });
  });

  it("fails closed when the lifecycle clock is invalid", async () => {
    const owner = await createUser("Owner");
    const valid = serviceWith({ projectLimit: 5 });
    const project = await valid.create(createInput(owner.id, 1));
    const invalid = serviceWith({ projectLimit: 5, now: () => new Date(Number.NaN) });

    await expect(invalid.delete({
      ownerUserId: owner.id,
      projectId: project.id,
      confirmName: project.name,
      authenticatedAt: new Date(fixedNow),
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect(await valid.get({ ownerUserId: owner.id, projectId: project.id })).not.toBeNull();
  });

  it("rolls back both domain mutation and its audit when transactional auditing fails", async () => {
    const owner = await createUser("Owner");
    const realAudit = createAuditService({ db: database.db, clock: () => new Date(fixedNow) });
    const failingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        await realAudit.record(...args);
        throw new Error("forced audit failure");
      },
    } satisfies AuditService;
    const service = serviceWith({ projectLimit: 5, audit: failingAudit });

    await expect(service.create(createInput(owner.id, 1))).rejects.toThrow("forced audit failure");
    expect(await database.db.select().from(projects)).toHaveLength(0);
    expect(await database.db.select().from(auditEvents)).toHaveLength(0);
  });
});

describe("owner project HTTP routes", () => {
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

  it("keeps owner project routes absent in headless mode", async () => {
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
      expect((await app.inject({ method: "GET", url: "/api/v1/projects" })).statusCode).toBe(404);
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "must-not-exist" },
      })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  const unusedGitHub: GitHubOAuthClient = {
    authorizationUrl: () => new URL("https://github.example.test/authorize"),
    exchangeCode: async () => { throw new Error("not used"); },
    fetchProfile: async () => { throw new Error("not used"); },
  };

  async function buildOwnerApp() {
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
      projectService: createProjectService({ db: database.db }),
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

    async function owner(displayName: string, githubId: string) {
      const user = await createUser(displayName);
      await database.db.insert(oauthIdentities).values({
        userId: user.id,
        provider: "github",
        providerUserId: githubId,
        login: `owner-${githubId}`,
      });
      const issued = await sessionService.issue(user.id, clock.now());
      if (issued === null) throw new Error("session issue failed");
      return {
        user,
        cookie: `agentmesh_session=${issued.sessionToken}`,
        csrf: issued.csrfToken,
      };
    }

    return { app, clock, owner };
  }

  it("exposes no-store owner CRUD while keeping foreign and legacy rows indistinguishable", async () => {
    const { app, owner } = await buildOwnerApp();
    try {
      const ownerA = await owner("Owner A", "1001");
      const ownerB = await owner("Owner B", "1002");
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...ownerHeaders(ownerA), "idempotency-key": randomUUID() },
        payload: { name: "  Alpha  ", description: "  First project  " },
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(() => projectResponseSchema.parse(created.json())).not.toThrow();
      expect(created.json()).toMatchObject({
        project: {
          name: "Alpha",
          description: "First project",
          status: "active",
        },
      });
      expect(JSON.stringify(created.json())).not.toMatch(/digest|token|secret|owner_user_id/i);
      const projectId = created.json().project.id as string;

      const foreign = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}`,
        headers: { cookie: ownerB.cookie },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.headers["cache-control"]).toBe("no-store");
      expect(foreign.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });

      const legacyId = randomUUID();
      await database.db.insert(projects).values({ id: legacyId, name: "legacy" });
      const legacy = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${legacyId}`,
        headers: { cookie: ownerA.cookie },
      });
      expect(legacy.statusCode).toBe(404);
      expect(legacy.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });

      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/projects?limit=50",
        headers: { cookie: ownerA.cookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(() => projectListResponseSchema.parse(listed.json())).not.toThrow();
      expect(listed.json()).toMatchObject({
        projects: [{ id: projectId, status: "active" }],
        active_count: 1,
        project_limit: 5,
      });

      const archived = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/archive`,
        headers: ownerHeaders(ownerA),
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ project: { id: projectId, status: "archived" } });
      const archiveAgain = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/archive`,
        headers: ownerHeaders(ownerA),
      });
      expect(archiveAgain.statusCode).toBe(409);
      expect(archiveAgain.json()).toMatchObject({ error: { code: "PROJECT_STATE_CONFLICT" } });

      const restored = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/restore`,
        headers: ownerHeaders(ownerA),
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ project: { id: projectId, status: "active" } });

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${projectId}`,
        headers: ownerHeaders(ownerA),
        payload: { confirm_name: "Alpha" },
      });
      expect(deleted.statusCode).toBe(204);
      expect(deleted.headers["cache-control"]).toBe("no-store");
      expect(deleted.body).toBe("");
    } finally {
      await app.close();
    }
  });

  it("enforces auth, CSRF, UUIDv4 paths, bounded exact bodies, headers, and queries", async () => {
    const { app, owner } = await buildOwnerApp();
    try {
      const current = await owner("Owner", "2001");
      const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/projects" });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.headers["cache-control"]).toBe("no-store");

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: {
          cookie: current.cookie,
          "idempotency-key": randomUUID(),
        },
        payload: { name: "Alpha", description: null },
      });
      expect(missingCsrf.statusCode).toBe(403);

      for (const request of [
        { headers: {}, payload: { name: "Alpha", description: null } },
        { headers: { "idempotency-key": "not-a-v4-uuid" }, payload: { name: "Alpha", description: null } },
        { headers: { "idempotency-key": randomUUID() }, payload: { name: "   ", description: null } },
        { headers: { "idempotency-key": randomUUID() }, payload: { name: "a".repeat(101), description: null } },
        { headers: { "idempotency-key": randomUUID() }, payload: { name: "Alpha", description: "a".repeat(501) } },
        { headers: { "idempotency-key": randomUUID() }, payload: { name: "Alpha", description: null, extra: true } },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: { ...ownerHeaders(current), ...request.headers },
          payload: request.payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
        expect(response.json().error.request_id).toBeTypeOf("string");
      }

      const duplicatedKey = randomUUID();
      const duplicateHeader = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: {
          ...ownerHeaders(current),
          "idempotency-key": [duplicatedKey, duplicatedKey],
        },
        payload: { name: "Alpha", description: null },
      });
      expect(duplicateHeader.statusCode).toBe(400);
      expect(duplicateHeader.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

      const malformedJson = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: {
          ...ownerHeaders(current),
          "idempotency-key": randomUUID(),
          "content-type": "application/json",
        },
        payload: "{not-json",
      });
      expect(malformedJson.statusCode).toBe(400);
      expect(malformedJson.headers["cache-control"]).toBe("no-store");
      expect(malformedJson.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

      for (const suffix of ["?limit=0", "?limit=101", "?limit=01", "?limit=x", "?extra=1", "?limit=1&limit=2"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/projects${suffix}`,
          headers: { cookie: current.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      }

      for (const invalidId of ["not-a-uuid", "00000000-0000-4000-8000-0000000000000", "550e8400-e29b-11d4-a716-446655440000"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/projects/${invalidId}`,
          headers: { cookie: current.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      }
    } finally {
      await app.close();
    }
  });
});
