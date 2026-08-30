import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { agents, messages, projects } from "../src/db/schema.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";

const database = createDatabase(databaseUrl);

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

describe("PostgreSQL tenant invariants", () => {
  it("migrates an empty database to the four-table MVP schema", async () => {
    const result = await database.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('projects', 'project_tokens', 'agents', 'messages')
        ORDER BY table_name`,
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "agents",
      "messages",
      "project_tokens",
      "projects",
    ]);
  });

  it("enforces registration uniqueness within a project but not across projects", async () => {
    const projectA = randomUUID();
    const projectB = randomUUID();
    const registrationDigest = Buffer.alloc(32, 7);
    await database.db.insert(projects).values([
      { id: projectA, name: "alpha" },
      { id: projectB, name: "beta" },
    ]);

    await database.db.insert(agents).values({
      id: randomUUID(),
      projectId: projectA,
      registrationDigest,
      name: "codex-a",
      client: "codex",
      capabilities: ["backend"],
    });

    await expect(
      database.db.insert(agents).values({
        id: randomUUID(),
        projectId: projectA,
        registrationDigest,
        name: "claude-a",
        client: "claude-code",
        capabilities: ["review"],
      }),
    ).rejects.toThrow();

    await expect(
      database.db.insert(agents).values({
        id: randomUUID(),
        projectId: projectB,
        registrationDigest,
        name: "codex-b",
        client: "codex",
        capabilities: [],
      }),
    ).resolves.toBeDefined();
  });

  it("enforces send idempotency per project and sender", async () => {
    const projectA = randomUUID();
    const projectB = randomUUID();
    const [senderA, recipientA, senderB, recipientB] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const idempotencyKey = randomUUID();

    await database.db.insert(projects).values([
      { id: projectA, name: "alpha" },
      { id: projectB, name: "beta" },
    ]);
    await database.db.insert(agents).values([
      {
        id: senderA,
        projectId: projectA,
        registrationDigest: Buffer.alloc(32, 1),
        name: "sender-a",
        client: "codex",
        capabilities: [],
      },
      {
        id: recipientA,
        projectId: projectA,
        registrationDigest: Buffer.alloc(32, 2),
        name: "recipient-a",
        client: "claude-code",
        capabilities: [],
      },
      {
        id: senderB,
        projectId: projectB,
        registrationDigest: Buffer.alloc(32, 3),
        name: "sender-b",
        client: "codex",
        capabilities: [],
      },
      {
        id: recipientB,
        projectId: projectB,
        registrationDigest: Buffer.alloc(32, 4),
        name: "recipient-b",
        client: "claude-code",
        capabilities: [],
      },
    ]);

    await database.db.insert(messages).values({
      id: randomUUID(),
      projectId: projectA,
      senderAgentId: senderA,
      recipientAgentId: recipientA,
      text: "first",
      idempotencyKey,
    });

    await expect(
      database.db.insert(messages).values({
        id: randomUUID(),
        projectId: projectA,
        senderAgentId: senderA,
        recipientAgentId: recipientA,
        text: "duplicate",
        idempotencyKey,
      }),
    ).rejects.toThrow();

    await expect(
      database.db.insert(messages).values({
        id: randomUUID(),
        projectId: projectB,
        senderAgentId: senderB,
        recipientAgentId: recipientB,
        text: "same key, other project",
        idempotencyKey,
      }),
    ).resolves.toBeDefined();
  });
});
