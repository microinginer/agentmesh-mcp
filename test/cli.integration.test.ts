import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { projects } from "../src/db/schema.js";
import { createProjectService } from "../src/projects/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const projectService = createProjectService({ db: database.db });
const usage = [
  "Usage: agentmesh project create --name <name>",
  "Usage: agentmesh db observer ensure",
];

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

describe("agentmesh project create CLI", () => {
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
    await expect(projectService.authenticateProject(String(output.token))).resolves.toBe(
      output.project_id,
    );
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
