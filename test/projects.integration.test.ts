import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { projectTokens } from "../src/db/schema.js";
import { createProjectService } from "../src/projects/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const service = createProjectService({ db: database.db });

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await database.pool.query(
    "TRUNCATE TABLE messages, agents, project_tokens, projects RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await database.pool.end();
});

describe("project provisioning and bearer authentication", () => {
  it("prints a usable token while persisting only its digest", async () => {
    const created = await service.createProject("My project");

    expect(created.project.name).toBe("My project");
    expect(created.token).toMatch(/^am_proj_/);
    await expect(service.authenticateProject(created.token)).resolves.toBe(created.project.id);

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
});
