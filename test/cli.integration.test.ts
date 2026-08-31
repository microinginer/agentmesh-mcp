import { randomUUID } from "node:crypto";

import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditService, type AuditService } from "../src/audit/service.js";
import { parseCliProjectLimit, runCli } from "../src/cli.js";
import { createOperatorService } from "../src/control/operator-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { auditEvents, oauthIdentities, projectTokens, projects, users } from "../src/db/schema.js";
import { createProjectService } from "../src/projects/service.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const projectService = createProjectService({ db: database.db });
const cliClock = () => new Date("2026-08-31T12:00:00.000Z");
const usage = [
  "Usage: agentmesh project create --name <name>",
  "Usage: agentmesh project assign-owner --project-id <uuid> --github-user-id <numeric-id>",
  "Usage: agentmesh db observer ensure",
];

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

describe("agentmesh project create CLI", () => {
  it("keeps headless CLI project limits independent from hosted OAuth configuration", () => {
    expect(parseCliProjectLimit(undefined)).toBe(0);
    expect(parseCliProjectLimit("")).toBe(0);
    expect(parseCliProjectLimit("0")).toBe(0);
    expect(parseCliProjectLimit("5")).toBe(5);
    expect(() => parseCliProjectLimit("101")).toThrow("Invalid AGENTMESH_PROJECT_LIMIT");
    expect(() => parseCliProjectLimit("not-a-number")).toThrow("Invalid AGENTMESH_PROJECT_LIMIT");
  });

  it("creates a project and prints one machine-readable credential", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["project", "create", "--name", "My project"],
      {
        projectService,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const output = JSON.parse(stdout[0] ?? "null") as Record<string, unknown>;
    expect(output).toMatchObject({ name: "My project" });
    expect(output.token).toMatch(/^am_proj_/);
    await expect(projectService.authenticateProject(String(output.token))).resolves.toEqual({
      projectId: output.project_id,
      connectionTokenId: output.token_id,
    });
    const [stored] = await database.db.select({ label: projectTokens.label })
      .from(projectTokens);
    expect(stored?.label).toBe("Legacy CLI token");
  });

  it("rejects an empty project name without creating state or printing a secret", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["project", "create", "--name", "   "], {
      projectService,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).not.toContain("am_proj_");
    expect(await database.db.select().from(projects)).toEqual([]);
  });
});

describe("agentmesh project assign-owner CLI", () => {
  async function githubUser(githubUserId: string, blocked = false) {
    const [user] = await database.db.insert(users).values({
      displayName: `user-${githubUserId}`,
      blockedAt: blocked ? cliClock() : null,
    }).returning();
    if (user === undefined) throw new Error("user insert failed");
    await database.db.insert(oauthIdentities).values({
      userId: user.id,
      provider: "github",
      providerUserId: githubUserId,
      login: `mutable-login-${githubUserId}`,
    });
    return user;
  }

  function service(projectLimit = 5, audit?: AuditService) {
    return createOperatorService({
      db: database.db,
      audit: audit ?? createAuditService({ db: database.db, clock: cliClock }),
      projectLimit,
      clock: cliClock,
    });
  }

  it("assigns an ownerless project by immutable numeric GitHub ID and audits once", async () => {
    const owner = await githubUser("123456789");
    const projectId = randomUUID();
    await database.db.insert(projects).values({ id: projectId, name: "legacy" });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli([
      "project",
      "assign-owner",
      "--project-id",
      projectId,
      "--github-user-id",
      "123456789",
    ], {
      projectService,
      operatorService: service(),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([JSON.stringify({
      ok: true,
      project_id: projectId,
      owner_user_id: owner.id,
      github_user_id: "123456789",
    })]);
    const [project] = await database.db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.ownerUserId).toBe(owner.id);
    expect(await database.db.select().from(auditEvents)).toEqual([
      expect.objectContaining({
        userId: owner.id,
        projectId,
        eventType: "operator.project_owner_assigned",
      }),
    ]);
  });

  it("rejects mutable login identity, malformed IDs, blocked users, and owned projects safely", async () => {
    const blocked = await githubUser("222", true);
    const blockedProject = randomUUID();
    const ownedProject = randomUUID();
    await database.db.insert(projects).values([
      { id: blockedProject, name: "blocked-target" },
      { id: ownedProject, ownerUserId: blocked.id, name: "already-owned" },
    ]);
    const attempts: Array<{ args: string[]; expected: string[] }> = [
      {
        args: ["project", "assign-owner", "--project-id", blockedProject, "--github-login", "mutable-login-222"],
        expected: usage,
      },
      {
        args: ["project", "assign-owner", "--project-id", "not-a-uuid", "--github-user-id", "222"],
        expected: ["Invalid project assignment arguments"],
      },
      {
        args: ["project", "assign-owner", "--project-id", blockedProject, "--github-user-id", "mutable-login-222"],
        expected: ["Invalid project assignment arguments"],
      },
      {
        args: ["project", "assign-owner", "--project-id", blockedProject, "--github-user-id", "222"],
        expected: ["Project owner assignment failed: user is blocked"],
      },
      {
        args: ["project", "assign-owner", "--project-id", ownedProject, "--github-user-id", "222"],
        expected: ["Project owner assignment failed: project not found or already owned"],
      },
      {
        args: ["project", "assign-owner", "--project-id", randomUUID(), "--github-user-id", "222"],
        expected: ["Project owner assignment failed: project not found or already owned"],
      },
    ];

    for (const attempt of attempts) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(attempt.args, {
        projectService,
        operatorService: service(),
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(attempt.expected);
      expect(stderr.join("\n")).not.toMatch(/token|digest|mutable-login-222/i);
    }
    expect(await database.db.select().from(auditEvents)).toEqual([]);
    const [stillOwnerless] = await database.db.select().from(projects)
      .where(eq(projects.id, blockedProject));
    expect(stillOwnerless?.ownerUserId).toBeNull();
  });

  it("serializes active assignments at five while limit zero remains unlimited", async () => {
    const limitedOwner = await githubUser("333");
    const limitedIds = Array.from({ length: 8 }, () => randomUUID());
    await database.db.insert(projects).values(limitedIds.map((id) => ({ id, name: `limited-${id}` })));
    const limited = service(5);
    const results = await Promise.allSettled(limitedIds.map((projectId) => limited.assignOwner({
      projectId,
      githubUserId: "333",
      requestId: randomUUID(),
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    const [active] = await database.db.select({ value: count() }).from(projects).where(and(
      eq(projects.ownerUserId, limitedOwner.id),
      eq(projects.status, "active"),
    ));
    expect(active?.value).toBe(5);

    const unlimitedOwner = await githubUser("444");
    const unlimitedIds = Array.from({ length: 8 }, () => randomUUID());
    await database.db.insert(projects).values(unlimitedIds.map((id) => ({ id, name: `unlimited-${id}` })));
    await expect(Promise.all(unlimitedIds.map((projectId) => service(0).assignOwner({
      projectId,
      githubUserId: "444",
      requestId: randomUUID(),
    })))).resolves.toHaveLength(8);
    const [unlimitedActive] = await database.db.select({ value: count() }).from(projects).where(and(
      eq(projects.ownerUserId, unlimitedOwner.id),
      eq(projects.status, "active"),
    ));
    expect(unlimitedActive?.value).toBe(8);
  });

  it("allows only one of two destination users to claim an ownerless project", async () => {
    const ownerA = await githubUser("777");
    const ownerB = await githubUser("888");
    const projectId = randomUUID();
    await database.db.insert(projects).values({ id: projectId, name: "single-owner" });
    const assignment = service(5);

    const results = await Promise.allSettled([
      assignment.assignOwner({ projectId, githubUserId: "777", requestId: randomUUID() }),
      assignment.assignOwner({ projectId, githubUserId: "888", requestId: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [project] = await database.db.select().from(projects).where(eq(projects.id, projectId));
    expect([ownerA.id, ownerB.id]).toContain(project?.ownerUserId);
    expect(await database.db.select().from(auditEvents).where(eq(auditEvents.projectId, projectId)))
      .toHaveLength(1);
  });

  it("does not count archived assignments and rolls assignment back on audit failure", async () => {
    const owner = await githubUser("555");
    await database.db.insert(projects).values(Array.from({ length: 5 }, (_, index) => ({
      ownerUserId: owner.id,
      name: `active-${index}`,
    })));
    const archivedId = randomUUID();
    await database.db.insert(projects).values({
      id: archivedId,
      name: "archived-legacy",
      status: "archived",
      archivedAt: cliClock(),
    });
    await expect(service(5).assignOwner({
      projectId: archivedId,
      githubUserId: "555",
      requestId: randomUUID(),
    })).resolves.toMatchObject({ projectId: archivedId, ownerUserId: owner.id });

    const rollbackId = randomUUID();
    await database.db.insert(projects).values({ id: rollbackId, name: "rollback" });
    const realAudit = createAuditService({ db: database.db, clock: cliClock });
    const failingAudit = {
      ...realAudit,
      record: async (...args: Parameters<AuditService["record"]>) => {
        await realAudit.record(...args);
        throw new Error("forced audit failure");
      },
    } satisfies AuditService;
    await expect(service(0, failingAudit).assignOwner({
      projectId: rollbackId,
      githubUserId: "555",
      requestId: randomUUID(),
    })).rejects.toThrow("forced audit failure");
    const [rollback] = await database.db.select().from(projects).where(eq(projects.id, rollbackId));
    expect(rollback?.ownerUserId).toBeNull();
    expect(await database.db.select().from(auditEvents).where(
      eq(auditEvents.projectId, rollbackId),
    )).toEqual([]);
  });
});

describe("agentmesh db observer ensure CLI", () => {
  it("passes the secret to provisioning but never writes it to stdout or stderr", async () => {
    const password = `observer-'-%-\\-${randomUUID()}-password`;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["db", "observer", "ensure"], {
      projectService,
      observerPassword: password,
      ensureObserverRole: async (receivedPassword) => {
        if (receivedPassword !== password) {
          throw new Error("CLI did not pass the configured observer password");
        }
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual(['{"ok":true,"role":"agentmesh_observer"}']);
    expect(stderr).toEqual([]);
    expect([...stdout, ...stderr].join("\n")).not.toContain(password);
  });

  it.each([undefined, "too-short"])(
    "rejects a missing or short observer password without calling provisioning",
    async (observerPassword) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(["db", "observer", "ensure"], {
        projectService,
        observerPassword,
        ensureObserverRole: async () => {
          throw new Error("Provisioning must not run with an invalid password");
        },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        "AGENTMESH_DB_OBSERVER_PASSWORD must contain at least 24 characters",
      ]);
      expect(stderr.join("\n")).not.toContain(observerPassword ?? "not-present");
    },
  );

  it("prints both supported usage forms for every unknown command", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["db", "observer"], {
      projectService,
      observerPassword: "not-printed-observer-password",
      ensureObserverRole: async () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(usage);
    expect(stderr.join("\n")).not.toContain("not-printed-observer-password");
  });
});
