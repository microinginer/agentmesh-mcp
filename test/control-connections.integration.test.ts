import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectionListResponseSchema,
  connectionResponseSchema,
  issueConnectionResponseSchema,
} from "../shared/control-api.js";
import { createAuditService, type AuditService } from "../src/audit/service.js";
import type { WebAuthConfig } from "../src/config.js";
import {
  ConnectionControlError,
  createConnectionService,
} from "../src/control/connection-service.js";
import { createControlProjectService } from "../src/control/project-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  auditEvents,
  oauthIdentities,
  projectTokens,
  projects,
  users,
} from "../src/db/schema.js";
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
const webAuthKey = Buffer.alloc(32, 47);
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

async function createUser(displayName: string, blockedAt: Date | null = null) {
  const [user] = await database.db.insert(users).values({ displayName, blockedAt }).returning();
  if (user === undefined) throw new Error("user insert failed");
  return user;
}

async function createOwnedProject(ownerUserId: string, status: "active" | "archived" = "active") {
  const now = new Date(fixedNow);
  const [project] = await database.db.insert(projects).values({
    ownerUserId,
    name: `project-${randomUUID()}`,
    status,
    archivedAt: status === "archived" ? now : null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (project === undefined) throw new Error("project insert failed");
  return project;
}

function serviceWith(input: {
  tokenTtlDays?: number;
  now?: () => Date;
  audit?: AuditService;
} = {}) {
  const clock = input.now ?? (() => new Date(fixedNow));
  return createConnectionService({
    db: database.db,
    audit: input.audit ?? createAuditService({ db: database.db, clock }),
    tokenTtlDays: input.tokenTtlDays ?? 90,
    clock,
  });
}

function issueInput(ownerUserId: string, projectId: string, idempotencyKey = randomUUID()) {
  return {
    ownerUserId,
    projectId,
    label: "Main Mac",
    idempotencyKey,
    requestId: randomUUID(),
  };
}

function projectAuthFailure() {
  return { code: "PROJECT_AUTH_INVALID", message: "Project authentication failed" };
}

function mutationHeaders(owner: { cookie: string; csrf: string }, idempotencyKey?: string) {
  return {
    cookie: owner.cookie,
    origin: "http://127.0.0.1",
    "x-csrf-token": owner.csrf,
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForProjectLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await database.pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND lower(query) LIKE '%from "projects"%'
          AND lower(query) LIKE '%for update%'
      ) AS waiting
    `);
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("project authentication did not reach the project lock");
}

async function waitForConnectionLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await database.pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND lower(query) LIKE '%from "project_tokens"%'
          AND lower(query) LIKE '%for update%'
      ) AS waiting
    `);
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("connection revocation did not reach the connection lock");
}

function queryText(query: unknown): string | null {
  if (typeof query === "string") return query;
  if (query === null || typeof query !== "object") return null;
  const text = (query as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

describe("named connection service", () => {
  it("returns exactly one secret under concurrent same-key issue and never repeats or persists it", async () => {
    const owner = await createUser("Owner");
    const project = await createOwnedProject(owner.id);
    const key = randomUUID();
    const service = serviceWith();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => service.issue({
        ...issueInput(owner.id, project.id, key),
        label: index === 0 ? "  Main Mac  " : "Changed label must be ignored",
      })),
    );

    const secretResults = results.filter((result) => result.secret !== null);
    expect(secretResults).toHaveLength(1);
    expect(secretResults[0]?.secret).toMatch(/^am_proj_/);
    expect(results.filter((result) => result.secretRecoverable)).toHaveLength(1);
    expect(new Set(results.map((result) => result.connectionId)).size).toBe(1);
    expect(results.every((result) => result.label === results[0]?.label)).toBe(true);
    expect(results[0]?.expiresAt).toBe("2026-11-29T12:00:00.000Z");

    const stored = await database.db.select().from(projectTokens);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      projectId: project.id,
      createdByUserId: owner.id,
      expiresAt: new Date("2026-11-29T12:00:00.000Z"),
    });
    const audits = await database.db.select().from(auditEvents);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: owner.id,
      projectId: project.id,
      eventType: "connection.created",
      metadata: { connection_label: results[0]?.label },
    });

    const replayWithChangedPolicy = await serviceWith({ tokenTtlDays: 1 }).issue({
      ...issueInput(owner.id, project.id, key),
      label: "Another label",
    });
    expect(replayWithChangedPolicy).toMatchObject({
      connectionId: results[0]?.connectionId,
      label: results[0]?.label,
      expiresAt: "2026-11-29T12:00:00.000Z",
      secret: null,
      secretRecoverable: false,
    });

    const listed = await service.list({ ownerUserId: owner.id, projectId: project.id, limit: 50 });
    expect(listed).toEqual([
      expect.objectContaining({ id: results[0]?.connectionId, status: "active" }),
    ]);
    const publicSerialization = JSON.stringify({ results, replayWithChangedPolicy, listed, audits });
    expect(publicSerialization).not.toMatch(/tokenDigest|token_digest|secret-[A-Za-z0-9_-]/);
    expect(publicSerialization.split("am_proj_")).toHaveLength(2);
  });

  it("reads safe connection metadata through one owner-and-block scoped database statement", async () => {
    const owner = await createUser("Scoped list owner");
    const active = await createOwnedProject(owner.id);
    const archivedWithoutConnections = await createOwnedProject(owner.id, "archived");
    const service = serviceWith();
    const issued = await service.issue(issueInput(owner.id, active.id));
    const querySpy = vi.spyOn(database.pool, "query");

    try {
      await expect(service.list({ ownerUserId: owner.id, projectId: active.id, limit: 50 }))
        .resolves.toEqual([expect.objectContaining({ id: issued.connectionId })]);
      await expect(service.list({
        ownerUserId: owner.id,
        projectId: archivedWithoutConnections.id,
        limit: 50,
      })).resolves.toEqual([]);

      const listStatements = querySpy.mock.calls
        .map(([query]) => queryText(query))
        .filter((text): text is string => text !== null && (
          text.includes('from "projects"') || text.includes('from "project_tokens"')
        ));
      expect(listStatements).toHaveLength(2);
      for (const statement of listStatements) {
        expect(statement).toContain('from "projects"');
        expect(statement).toContain('left join "project_tokens"');
        expect(statement).toMatch(/"projects"\."id" = \$\d+/);
        expect(statement).toMatch(/"projects"\."owner_user_id" = \$\d+/);
        expect(statement).toContain('"users"."blocked_at" is null');
        expect(statement).not.toContain('"project_tokens"."token_digest"');
      }
    } finally {
      querySpy.mockRestore();
    }
  });

  it("derives issue timestamps only after acquiring the project lock", async () => {
    const owner = await createUser("Issue clock owner");
    const project = await createOwnedProject(owner.id);
    const blocker = await database.pool.connect();
    let transactionOpen = true;
    let currentNow = "2026-08-31T12:00:00.000Z";
    let issuing: ReturnType<ReturnType<typeof serviceWith>["issue"]> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query('SELECT id FROM "projects" WHERE id = $1 FOR UPDATE', [project.id]);
      issuing = serviceWith({
        tokenTtlDays: 1,
        now: () => new Date(currentNow),
      }).issue(issueInput(owner.id, project.id));
      await waitForProjectLockWait();
      currentNow = "2026-09-01T12:00:00.000Z";
      await blocker.query("COMMIT");
      transactionOpen = false;

      await expect(issuing).resolves.toMatchObject({
        createdAt: "2026-09-01T12:00:00.000Z",
        expiresAt: "2026-09-02T12:00:00.000Z",
      });
      const [stored] = await database.db.select({
        createdAt: projectTokens.createdAt,
        expiresAt: projectTokens.expiresAt,
      }).from(projectTokens);
      expect(stored).toEqual({
        createdAt: new Date("2026-09-01T12:00:00.000Z"),
        expiresAt: new Date("2026-09-02T12:00:00.000Z"),
      });
    } finally {
      if (transactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await issuing?.catch(() => undefined);
    }
  });

  it("rolls back token and audit together when audit persistence fails before disclosure", async () => {
    const owner = await createUser("Owner");
    const project = await createOwnedProject(owner.id);
    const realAudit = createAuditService({ db: database.db, clock: () => new Date(fixedNow) });
    const failingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        await realAudit.record(...args);
        throw new Error("forced safe audit failure");
      },
    } satisfies AuditService;

    await expect(serviceWith({ audit: failingAudit }).issue(issueInput(owner.id, project.id)))
      .rejects.toThrow("forced safe audit failure");
    expect(await database.db.select().from(projectTokens)).toEqual([]);
    expect(await database.db.select().from(auditEvents)).toEqual([]);
  });

  it("enforces owned active projects, trimmed label and UUID/list bounds, TTL, and valid clocks", async () => {
    const ownerA = await createUser("Owner A");
    const ownerB = await createUser("Owner B");
    const blocked = await createUser("Blocked", new Date(fixedNow));
    const active = await createOwnedProject(ownerA.id);
    const archived = await createOwnedProject(ownerA.id, "archived");
    const blockedProject = await createOwnedProject(blocked.id);
    const service = serviceWith();

    await expect(service.issue({ ...issueInput(ownerB.id, active.id) })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    await expect(service.issue(issueInput(ownerA.id, archived.id))).rejects.toMatchObject({
      code: "PROJECT_STATE_CONFLICT",
    });
    await expect(service.issue(issueInput(blocked.id, blockedProject.id))).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });

    for (const invalid of [
      { ...issueInput(ownerA.id, active.id), label: "   " },
      { ...issueInput(ownerA.id, active.id), label: "a".repeat(81) },
      { ...issueInput(ownerA.id, active.id), idempotencyKey: "not-a-uuid" },
      { ...issueInput(ownerA.id, "not-a-project") },
    ]) {
      await expect(service.issue(invalid)).rejects.toBeInstanceOf(ConnectionControlError);
      await expect(service.issue(invalid)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    for (const limit of [0, 101, 1.5]) {
      await expect(service.list({ ownerUserId: ownerA.id, projectId: active.id, limit }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    await expect(serviceWith({ tokenTtlDays: 0 }).issue(issueInput(ownerA.id, active.id)))
      .rejects.toMatchObject({ code: "CONTROL_UNAVAILABLE" });
    await expect(serviceWith({ now: () => new Date(Number.NaN) }).issue(issueInput(ownerA.id, active.id)))
      .rejects.toMatchObject({ code: "CONTROL_UNAVAILABLE" });
    expect(await database.db.select().from(projectTokens)).toEqual([]);
  });

  it("revokes only the selected owned connection once and keeps the other credential valid", async () => {
    const ownerA = await createUser("Owner A");
    const ownerB = await createUser("Owner B");
    const project = await createOwnedProject(ownerA.id);
    const service = serviceWith();
    const first = await service.issue(issueInput(ownerA.id, project.id));
    const second = await service.issue({
      ...issueInput(ownerA.id, project.id),
      label: "Second PC",
    });
    if (first.secret === null || second.secret === null) throw new Error("expected issued secrets");

    const revoked = await service.revoke({
      ownerUserId: ownerA.id,
      projectId: project.id,
      connectionId: first.connectionId,
      requestId: randomUUID(),
    });
    expect(revoked).toMatchObject({ id: first.connectionId, status: "revoked" });
    await expect(createProjectService({ db: database.db }).authenticateProject(first.secret))
      .rejects.toMatchObject(projectAuthFailure());
    await expect(createProjectService({ db: database.db }).authenticateProject(second.secret))
      .resolves.toEqual({ projectId: project.id, connectionTokenId: second.connectionId });

    await expect(service.revoke({
      ownerUserId: ownerA.id,
      projectId: project.id,
      connectionId: first.connectionId,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "CONNECTION_STATE_CONFLICT" });
    await expect(service.revoke({
      ownerUserId: ownerB.id,
      projectId: project.id,
      connectionId: second.connectionId,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(service.revoke({
      ownerUserId: ownerA.id,
      projectId: project.id,
      connectionId: randomUUID(),
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });

    expect(await database.db.select().from(auditEvents).where(
      eq(auditEvents.eventType, "connection.revoked"),
    )).toHaveLength(1);
  });

  it("derives the revocation timestamp only after acquiring project and connection locks", async () => {
    const owner = await createUser("Revoke clock owner");
    const project = await createOwnedProject(owner.id);
    const issued = await serviceWith().issue(issueInput(owner.id, project.id));
    const blocker = await database.pool.connect();
    let transactionOpen = true;
    let currentNow = "2026-08-31T12:00:00.000Z";
    let revoking: ReturnType<ReturnType<typeof serviceWith>["revoke"]> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query(
        'SELECT id FROM "project_tokens" WHERE id = $1 FOR UPDATE',
        [issued.connectionId],
      );
      revoking = serviceWith({ now: () => new Date(currentNow) }).revoke({
        ownerUserId: owner.id,
        projectId: project.id,
        connectionId: issued.connectionId,
        requestId: randomUUID(),
      });
      await waitForConnectionLockWait();
      currentNow = "2026-09-01T12:00:00.000Z";
      await blocker.query("COMMIT");
      transactionOpen = false;

      await expect(revoking).resolves.toMatchObject({
        id: issued.connectionId,
        revokedAt: "2026-09-01T12:00:00.000Z",
      });
      const [stored] = await database.db.select({ revokedAt: projectTokens.revokedAt })
        .from(projectTokens).where(eq(projectTokens.id, issued.connectionId));
      expect(stored?.revokedAt).toEqual(new Date("2026-09-01T12:00:00.000Z"));
    } finally {
      if (transactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await revoking?.catch(() => undefined);
    }
  });

  it("cannot authenticate after a revoke transaction wins the project-then-token race", async () => {
    const owner = await createUser("Race owner");
    const project = await createOwnedProject(owner.id);
    const realAudit = createAuditService({ db: database.db, clock: () => new Date(fixedNow) });
    const enteredAudit = deferred();
    const releaseAudit = deferred();
    const blockingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        await realAudit.record(...args);
        if (args[0].eventType === "connection.revoked") {
          enteredAudit.resolve();
          await releaseAudit.promise;
        }
      },
    } satisfies AuditService;
    const service = serviceWith({ audit: blockingAudit });
    const issued = await service.issue(issueInput(owner.id, project.id));
    if (issued.secret === null) throw new Error("expected issued secret");

    const revoking = service.revoke({
      ownerUserId: owner.id,
      projectId: project.id,
      connectionId: issued.connectionId,
      requestId: randomUUID(),
    });
    await enteredAudit.promise;
    const authenticating = createProjectService({
      db: database.db,
      clock: () => new Date(fixedNow),
    }).authenticateProject(issued.secret);
    await waitForProjectLockWait();
    releaseAudit.resolve();

    await revoking;
    await expect(authenticating).rejects.toMatchObject(projectAuthFailure());
  });

  it("rolls back revocation and its audit together when audit persistence fails", async () => {
    const owner = await createUser("Rollback owner");
    const project = await createOwnedProject(owner.id);
    const issued = await serviceWith().issue(issueInput(owner.id, project.id));
    if (issued.secret === null) throw new Error("expected issued secret");
    const realAudit = createAuditService({ db: database.db, clock: () => new Date(fixedNow) });
    const failingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        await realAudit.record(...args);
        throw new Error("forced revoke audit failure");
      },
    } satisfies AuditService;

    await expect(serviceWith({ audit: failingAudit }).revoke({
      ownerUserId: owner.id,
      projectId: project.id,
      connectionId: issued.connectionId,
      requestId: randomUUID(),
    })).rejects.toThrow("forced revoke audit failure");
    const [stored] = await database.db.select({ revokedAt: projectTokens.revokedAt })
      .from(projectTokens).where(eq(projectTokens.id, issued.connectionId));
    expect(stored?.revokedAt).toBeNull();
    expect(await database.db.select().from(auditEvents).where(
      eq(auditEvents.eventType, "connection.revoked"),
    )).toEqual([]);
    await expect(createProjectService({ db: database.db }).authenticateProject(issued.secret))
      .resolves.toEqual({ projectId: project.id, connectionTokenId: issued.connectionId });
  });

  it("cannot authenticate after an archive transaction wins the project lock race", async () => {
    const owner = await createUser("Archive race owner");
    const project = await createOwnedProject(owner.id);
    const realAudit = createAuditService({ db: database.db, clock: () => new Date(fixedNow) });
    const enteredAudit = deferred();
    const releaseAudit = deferred();
    const blockingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        await realAudit.record(...args);
        if (args[0].eventType === "project.archived") {
          enteredAudit.resolve();
          await releaseAudit.promise;
        }
      },
    } satisfies AuditService;
    const connectionService = serviceWith();
    const issued = await connectionService.issue(issueInput(owner.id, project.id));
    if (issued.secret === null) throw new Error("expected issued secret");
    const projectControl = createControlProjectService({
      db: database.db,
      audit: blockingAudit,
      projectLimit: 5,
      clock: () => new Date(fixedNow),
    });

    const archiving = projectControl.archive({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });
    await enteredAudit.promise;
    const authenticating = createProjectService({
      db: database.db,
      clock: () => new Date(fixedNow),
    }).authenticateProject(issued.secret);
    await waitForProjectLockWait();
    releaseAudit.resolve();

    await archiving;
    await expect(authenticating).rejects.toMatchObject(projectAuthFailure());
  });
});

describe("connection HTTP routes", () => {
  const unusedGitHub: GitHubOAuthClient = {
    authorizationUrl: () => new URL("https://github.example.test/authorize"),
    exchangeCode: async () => { throw new Error("not used"); },
    fetchProfile: async () => { throw new Error("not used"); },
  };

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

  it("keeps connection routes absent in headless mode", async () => {
    const projectId = randomUUID();
    const connectionId = randomUUID();
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
      expect((await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/connections`,
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/connections`,
        payload: { label: "must not exist" },
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/connections/${connectionId}/revoke`,
      })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

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
    return { app, owner };
  }

  it("issues once, lists only safe metadata, revokes independently, and hides foreign projects", async () => {
    const { app, owner } = await buildOwnerApp();
    try {
      const ownerA = await owner("Owner A", "7001");
      const ownerB = await owner("Owner B", "7002");
      const project = await createOwnedProject(ownerA.user.id);
      const key = randomUUID();
      const issued = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/connections`,
        headers: mutationHeaders(ownerA, key),
        payload: { label: "  Main Mac  " },
      });
      expect(issued.statusCode).toBe(201);
      expect(issued.headers["cache-control"]).toBe("no-store");
      expect(() => issueConnectionResponseSchema.parse(issued.json())).not.toThrow();
      expect(issued.json()).toMatchObject({
        connection: { label: "Main Mac", status: "active" },
        secret_recoverable: true,
      });
      expect(issued.json().secret).toMatch(/^am_proj_/);
      const connectionId = issued.json().connection.id as string;

      const replay = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/connections`,
        headers: mutationHeaders(ownerA, key),
        payload: { label: "Changed" },
      });
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["cache-control"]).toBe("no-store");
      expect(() => issueConnectionResponseSchema.parse(replay.json())).not.toThrow();
      expect(replay.json()).toMatchObject({
        connection: { id: connectionId, label: "Main Mac" },
        secret: null,
        secret_recoverable: false,
      });

      const list = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/connections?limit=50`,
        headers: { cookie: ownerA.cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.headers["cache-control"]).toBe("no-store");
      expect(() => connectionListResponseSchema.parse(list.json())).not.toThrow();
      expect(list.json()).toEqual({ connections: [replay.json().connection] });
      expect(JSON.stringify(list.json())).not.toMatch(/digest|secret|am_proj_/i);

      const foreign = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/connections`,
        headers: { cookie: ownerB.cookie },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.headers["cache-control"]).toBe("no-store");
      expect(foreign.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });

      const revoked = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/connections/${connectionId}/revoke`,
        headers: mutationHeaders(ownerA),
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.headers["cache-control"]).toBe("no-store");
      expect(() => connectionResponseSchema.parse(revoked.json())).not.toThrow();
      expect(revoked.json()).toMatchObject({
        connection: { id: connectionId, status: "revoked" },
      });
      expect(JSON.stringify(revoked.json())).not.toContain(issued.json().secret as string);

      const conflict = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/connections/${connectionId}/revoke`,
        headers: mutationHeaders(ownerA),
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.headers["cache-control"]).toBe("no-store");
      expect(conflict.json()).toMatchObject({ error: { code: "CONNECTION_STATE_CONFLICT" } });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed auth, IDs, queries, idempotency headers and exact bounded bodies with no-store", async () => {
    const { app, owner } = await buildOwnerApp();
    try {
      const current = await owner("Owner", "8001");
      const project = await createOwnedProject(current.user.id);
      const unauthenticated = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/connections`,
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.headers["cache-control"]).toBe("no-store");

      for (const request of [
        { key: undefined, payload: { label: "Main Mac" } },
        { key: "not-v4", payload: { label: "Main Mac" } },
        { key: randomUUID(), payload: { label: "   " } },
        { key: randomUUID(), payload: { label: "a".repeat(81) } },
        { key: randomUUID(), payload: { label: "Main Mac", extra: true } },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/connections`,
          headers: mutationHeaders(current, request.key),
          payload: request.payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      }

      const duplicateKey = randomUUID();
      const duplicateHeader = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/connections`,
        headers: {
          ...mutationHeaders(current),
          "idempotency-key": [duplicateKey, duplicateKey],
        },
        payload: { label: "Main Mac" },
      });
      expect(duplicateHeader.statusCode).toBe(400);
      expect(duplicateHeader.headers["cache-control"]).toBe("no-store");
      expect(duplicateHeader.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

      const bodyEnvelopeBytes = Buffer.byteLength('{"label":""}');
      const overLimitBody = `{"label":"${"a".repeat(4_097 - bodyEnvelopeBytes)}"}`;
      expect(Buffer.byteLength(overLimitBody)).toBe(4_097);
      const overLimit = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/connections`,
        headers: {
          ...mutationHeaders(current, randomUUID()),
          "content-type": "application/json",
        },
        payload: overLimitBody,
      });
      expect(overLimit.statusCode).toBe(413);
      expect(overLimit.headers["cache-control"]).toBe("no-store");
      expect(overLimit.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(await database.db.select().from(projectTokens)).toEqual([]);

      for (const suffix of ["?limit=0", "?limit=101", "?limit=01", "?limit=x", "?extra=1", "?limit=1&limit=2"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/projects/${project.id}/connections${suffix}`,
          headers: { cookie: current.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      for (const path of [
        "/api/v1/projects/not-a-uuid/connections",
        `/api/v1/projects/${project.id}/connections/not-a-uuid/revoke`,
      ]) {
        const response = await app.inject({
          method: path.endsWith("revoke") ? "POST" : "GET",
          url: path,
          headers: path.endsWith("revoke") ? mutationHeaders(current) : { cookie: current.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    } finally {
      await app.close();
    }
  });
});
