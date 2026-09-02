import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  agents,
  messages,
  projectMemberships,
  projects,
  projectTokens,
  users,
} from "../src/db/schema.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";

const database = createDatabase(databaseUrl);

beforeAll(async () => {
  await migrateDatabase(database.db);
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

describe("PostgreSQL tenant invariants", () => {
  it("migrates an empty database to the hosted control-plane journal schema", async () => {
    const result = await database.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('users', 'oauth_identities', 'web_sessions', 'audit_events', 'projects', 'project_tokens', 'project_invitations', 'agents', 'messages', 'activity_events', 'agent_progress_reports')
        ORDER BY table_name`,
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "activity_events",
      "agent_progress_reports",
      "agents",
      "audit_events",
      "messages",
      "oauth_identities",
      "project_invitations",
      "project_tokens",
      "projects",
      "users",
      "web_sessions",
    ]);
  });

  it("enforces digest-only single-use viewer invitation state", async () => {
    const ownerId = randomUUID();
    const viewerId = randomUUID();
    const projectId = randomUUID();
    await database.pool.query(
      "INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4)",
      [ownerId, "Invitation owner", viewerId, "Invitation viewer"],
    );
    await database.pool.query(
      "INSERT INTO projects (id, owner_user_id, name) VALUES ($1, $2, $3)",
      [projectId, ownerId, "invited"],
    );

    await database.pool.query(
      `INSERT INTO project_invitations
        (project_id, role, token_digest, created_by, expires_at)
       VALUES ($1, 'viewer', $2, $3, $4)`,
      [projectId, Buffer.alloc(32, 1), ownerId, new Date("2026-09-09T00:00:00.000Z")],
    );

    await expect(database.pool.query(
      `INSERT INTO project_invitations
        (project_id, role, token_digest, created_by, expires_at)
       VALUES ($1, 'owner', $2, $3, $4)`,
      [projectId, Buffer.alloc(32, 2), ownerId, new Date("2026-09-09T00:00:00.000Z")],
    )).rejects.toMatchObject({ constraint: "project_invitations_role_check" });
    await expect(database.pool.query(
      `INSERT INTO project_invitations
        (project_id, role, token_digest, created_by, expires_at)
       VALUES ($1, 'viewer', $2, $3, $4)`,
      [projectId, Buffer.alloc(31, 3), ownerId, new Date("2026-09-09T00:00:00.000Z")],
    )).rejects.toMatchObject({ constraint: "project_invitations_digest_length_check" });
    await expect(database.pool.query(
      `INSERT INTO project_invitations
        (project_id, role, token_digest, created_by, expires_at, redeemed_by)
       VALUES ($1, 'viewer', $2, $3, $4, $5)`,
      [projectId, Buffer.alloc(32, 4), ownerId, new Date("2026-09-09T00:00:00.000Z"), viewerId],
    )).rejects.toMatchObject({ constraint: "project_invitations_redemption_pair_check" });
    await expect(database.pool.query(
      `INSERT INTO project_invitations
        (project_id, role, token_digest, created_by, expires_at, redeemed_by, redeemed_at, revoked_at)
       VALUES ($1, 'viewer', $2, $3, $4, $5, $6, $7)`,
      [
        projectId,
        Buffer.alloc(32, 5),
        ownerId,
        new Date("2026-09-09T00:00:00.000Z"),
        viewerId,
        new Date("2026-09-02T00:00:00.000Z"),
        new Date("2026-09-02T00:01:00.000Z"),
      ],
    )).rejects.toMatchObject({ constraint: "project_invitations_terminal_state_check" });
    await expect(database.pool.query(
      `INSERT INTO project_invitations
        (project_id, role, token_digest, created_by, expires_at)
       VALUES ($1, 'viewer', $2, $3, $4)`,
      [projectId, Buffer.alloc(32, 1), ownerId, new Date("2026-09-09T00:00:00.000Z")],
    )).rejects.toMatchObject({ constraint: "project_invitations_token_digest_unique" });

    await database.pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    const remaining = await database.pool.query<{ total: string }>(
      "SELECT count(*) AS total FROM project_invitations",
    );
    expect(remaining.rows).toEqual([{ total: "0" }]);
  });

  it("enforces project membership roles and one membership per user and project", async () => {
    const [owner, viewer] = await database.db.insert(users).values([
      { displayName: "Owner" },
      { displayName: "Viewer" },
    ]).returning();
    if (owner === undefined || viewer === undefined) throw new Error("user insert failed");
    const [project] = await database.db.insert(projects).values({
      ownerUserId: owner.id,
      name: "shared",
    }).returning();
    if (project === undefined) throw new Error("project insert failed");

    await expect(database.db.insert(projectMemberships).values({
      projectId: project.id,
      userId: viewer.id,
      role: "viewer",
      createdBy: owner.id,
    })).resolves.toBeDefined();

    await expect(database.db.insert(projectMemberships).values({
      projectId: project.id,
      userId: viewer.id,
      role: "owner",
      createdBy: owner.id,
    })).rejects.toMatchObject({ cause: { code: "23505" } });

    await expect(database.db.insert(projectMemberships).values({
      projectId: project.id,
      userId: owner.id,
      role: "editor",
      createdBy: owner.id,
    })).rejects.toMatchObject({ cause: { code: "23514" } });
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

  it("permits agent provenance only from a token in the same project", async () => {
    const projectA = randomUUID();
    const projectB = randomUUID();
    const tokenId = randomUUID();
    await database.db.insert(projects).values([
      { id: projectA, name: "alpha" },
      { id: projectB, name: "beta" },
    ]);
    await database.db.insert(projectTokens).values({
      id: tokenId,
      projectId: projectA,
      tokenDigest: Buffer.alloc(32, 9),
    });

    await expect(database.db.insert(agents).values({
      id: randomUUID(),
      projectId: projectA,
      registeredViaTokenId: tokenId,
      registrationDigest: Buffer.alloc(32, 10),
      name: "same-project",
      client: "codex",
      capabilities: [],
    })).resolves.toBeDefined();

    await expect(database.db.insert(agents).values({
      id: randomUUID(),
      projectId: projectB,
      registeredViaTokenId: tokenId,
      registrationDigest: Buffer.alloc(32, 11),
      name: "cross-project",
      client: "codex",
      capabilities: [],
    })).rejects.toThrow();
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
