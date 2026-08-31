import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { createProjectToken } from "../src/auth/project-token.js";
import { projectTokens, projects, users } from "../src/db/schema.js";
import { createProjectService } from "../src/projects/service.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const service = createProjectService({ db: database.db });

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

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

describe("project provisioning and bearer authentication", () => {
  it("prints a usable token while persisting only its digest", async () => {
    const created = await service.createProject("My project");

    expect(created.project.name).toBe("My project");
    expect(created.token).toMatch(/^am_proj_/);
    await expect(service.authenticateProject(created.token)).resolves.toEqual({
      projectId: created.project.id,
      connectionTokenId: created.token_id,
    });

    const [stored] = await database.db.select().from(projectTokens);
    expect(stored?.id).toBe(created.token_id);
    expect(stored?.tokenDigest).toHaveLength(32);
    expect(stored?.tokenDigest.toString("utf8")).not.toContain("am_proj_");
  });

  it.each(["not-a-token", "mutated"])('rejects an invalid bearer token: %s', async (kind) => {
    const created = await service.createProject("My project");
    const token =
      kind === "mutated"
        ? `${created.token.slice(0, -1)}${created.token.endsWith("A") ? "B" : "A"}`
        : kind;

    await expect(service.authenticateProject(token)).rejects.toMatchObject({
      code: "PROJECT_AUTH_INVALID",
    });
  });

  it("checks exact expiry, revocation, project lifecycle, owner blocking, and updates last use only on success", async () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const [owner] = await database.db.insert(users).values({ displayName: "Owner" }).returning();
    if (owner === undefined) throw new Error("owner insert failed");
    const [project] = await database.db.insert(projects).values({
      ownerUserId: owner.id,
      name: "Hosted project",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (project === undefined) throw new Error("project insert failed");
    const exactExpiry = createProjectToken();
    const afterExpiry = createProjectToken();
    const revoked = createProjectToken();
    await database.db.insert(projectTokens).values([
      {
        id: exactExpiry.tokenId,
        projectId: project.id,
        tokenDigest: exactExpiry.digest,
        expiresAt: now,
        createdAt: now,
      },
      {
        id: afterExpiry.tokenId,
        projectId: project.id,
        tokenDigest: afterExpiry.digest,
        expiresAt: new Date(now.getTime() + 1),
        createdAt: now,
      },
      {
        id: revoked.tokenId,
        projectId: project.id,
        tokenDigest: revoked.digest,
        revokedAt: now,
        createdAt: now,
      },
    ]);
    const fixedService = createProjectService({ db: database.db, clock: () => new Date(now) });

    await expect(fixedService.authenticateProject(exactExpiry.token)).rejects.toMatchObject({
      code: "PROJECT_AUTH_INVALID",
      message: "Project authentication failed",
    });
    await expect(fixedService.authenticateProject(revoked.token)).rejects.toMatchObject({
      code: "PROJECT_AUTH_INVALID",
      message: "Project authentication failed",
    });
    await expect(fixedService.authenticateProject(afterExpiry.token)).resolves.toEqual({
      projectId: project.id,
      connectionTokenId: afterExpiry.tokenId,
    });
    const [used] = await database.db.select({ lastUsedAt: projectTokens.lastUsedAt })
      .from(projectTokens).where(eq(projectTokens.id, afterExpiry.tokenId));
    expect(used?.lastUsedAt).toEqual(now);
    const failures = await database.db.select({ id: projectTokens.id, lastUsedAt: projectTokens.lastUsedAt })
      .from(projectTokens).where(inArray(projectTokens.id, [exactExpiry.tokenId, revoked.tokenId]));
    expect(failures.every((row) => row.lastUsedAt === null)).toBe(true);

    await database.db.update(projects).set({ status: "archived", archivedAt: now })
      .where(eq(projects.id, project.id));
    await expect(fixedService.authenticateProject(afterExpiry.token)).rejects.toMatchObject({
      code: "PROJECT_AUTH_INVALID",
      message: "Project authentication failed",
    });
    await database.db.update(projects).set({ status: "active", archivedAt: null })
      .where(eq(projects.id, project.id));
    await database.db.update(users).set({ blockedAt: now }).where(eq(users.id, owner.id));
    await expect(fixedService.authenticateProject(afterExpiry.token)).rejects.toMatchObject({
      code: "PROJECT_AUTH_INVALID",
      message: "Project authentication failed",
    });
  });

  it("keeps active ownerless CLI tokens compatible and fails closed on invalid clocks", async () => {
    const created = await service.createProject("Legacy ownerless");
    const invalidClock = createProjectService({ db: database.db, clock: () => new Date(Number.NaN) });

    await expect(service.authenticateProject(created.token)).resolves.toEqual({
      projectId: created.project.id,
      connectionTokenId: created.token_id,
    });
    await database.db.update(projectTokens).set({ lastUsedAt: null })
      .where(eq(projectTokens.id, created.token_id));
    await expect(invalidClock.authenticateProject(created.token)).rejects.toMatchObject({
      code: "PROJECT_AUTH_INVALID",
      message: "Project authentication failed",
    });
    const [stored] = await database.db.select({ lastUsedAt: projectTokens.lastUsedAt })
      .from(projectTokens).where(eq(projectTokens.id, created.token_id));
    expect(stored?.lastUsedAt).toBeNull();
  });

  it("rechecks exact expiry with a fresh clock after waiting for the project lock", async () => {
    const created = await service.createProject("Expiry race");
    const expiresAt = new Date("2026-08-31T12:00:00.000Z");
    await database.db.update(projectTokens).set({ expiresAt, lastUsedAt: null })
      .where(eq(projectTokens.id, created.token_id));
    let current = new Date(expiresAt.getTime() - 1);
    const racingService = createProjectService({
      db: database.db,
      clock: () => new Date(current),
    });
    const blocker = await database.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [created.project.id]);
      const authenticating = racingService.authenticateProject(created.token);
      await waitForProjectLockWait();
      current = new Date(expiresAt);
      await blocker.query("COMMIT");

      await expect(authenticating).rejects.toMatchObject({
        code: "PROJECT_AUTH_INVALID",
        message: "Project authentication failed",
      });
      const [stored] = await database.db.select({ lastUsedAt: projectTokens.lastUsedAt })
        .from(projectTokens).where(eq(projectTokens.id, created.token_id));
      expect(stored?.lastUsedAt).toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });
});
