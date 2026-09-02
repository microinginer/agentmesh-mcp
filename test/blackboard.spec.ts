import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createActivityService } from "../src/activity/service.js";
import { createAgentService } from "../src/agents/service.js";
import { createBlackboardService } from "../src/blackboard/service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents, blackboardEntries, projects } from "../src/db/schema.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const fixedNow = new Date("2026-09-02T10:00:00.000Z");
const activity = createActivityService({ db: database.db, clock: () => fixedNow });
const agentService = createAgentService({
  db: database.db,
  signingKey,
  activity,
  clock: () => fixedNow,
});
const blackboardService = createBlackboardService({
  db: database.db,
  agentService,
  activity,
  clock: () => fixedNow,
});

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

async function createProject(name: string): Promise<string> {
  const id = randomUUID();
  await database.db.insert(projects).values({ id, name });
  return id;
}

async function register(projectId: string, name: string) {
  return agentService.registerAgent(projectId, {
    mode: "register",
    session_instance_id: randomUUID(),
    name,
    client: "codex",
    capabilities: [],
  }, { requestId: randomUUID() });
}

describe("Blackboard persistence", () => {
  it("installs the Blackboard table and project-scoped unique key", async () => {
    const table = await database.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.blackboard_entries')::text AS name",
    );
    expect(table.rows).toEqual([{ name: "blackboard_entries" }]);

    const constraints = await database.pool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'blackboard_entries'::regclass
    `);
    expect(constraints.rows.map((row) => row.definition)).toContain(
      "UNIQUE (project_id, namespace, key)",
    );
  });

  it("creates a new fact with version one and its authenticated agent identity", async () => {
    const projectId = await createProject("alpha");
    const agent = await register(projectId, "writer");
    const requestId = randomUUID();

    const fact = await blackboardService.setFact(projectId, {
      agent_token: agent.agent_token,
      namespace: "contracts",
      key: "users.v2",
      value: "GET /api/v2/users",
      tags: ["api", "v2"],
      ttl_seconds: 60,
    }, { requestId });

    expect(fact).toEqual({
      id: expect.any(String),
      project_id: projectId,
      namespace: "contracts",
      key: "users.v2",
      value: "GET /api/v2/users",
      tags: ["api", "v2"],
      version: 1,
      ttl_seconds: 60,
      expires_at: "2026-09-02T10:01:00.000Z",
      created_by_type: "agent",
      created_by_id: agent.agent.id,
      last_updated_by_type: "agent",
      last_updated_by_id: agent.agent.id,
      created_at: fixedNow.toISOString(),
      updated_at: fixedNow.toISOString(),
    });

    const stored = await database.db.select().from(blackboardEntries);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: fact.id,
      projectId,
      version: 1,
      createdById: agent.agent.id,
      lastUpdatedById: agent.agent.id,
    });

    const events = await database.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.requestId, requestId));
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "blackboard.fact_set",
        outcome: "success",
        actorAgentId: agent.agent.id,
        metadata: {
          blackboard_namespace: "contracts",
          blackboard_key: "users.v2",
          blackboard_version: 1,
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(fact.value);
    expect(JSON.stringify(events)).not.toContain(agent.agent_token);
  });

  it("updates a fact and increments its version", async () => {
    const projectId = await createProject("alpha");
    const agent = await register(projectId, "writer");
    const initial = await blackboardService.setFact(projectId, {
      agent_token: agent.agent_token,
      namespace: "contracts",
      key: "users.v2",
      value: "GET /api/v2/users",
      tags: ["api"],
    }, { requestId: randomUUID() });

    const updated = await blackboardService.setFact(projectId, {
      agent_token: agent.agent_token,
      namespace: "contracts",
      key: "users.v2",
      value: "GET /api/v2/users?cursor=...",
      tags: ["api", "v2"],
      expected_version: 1,
    }, { requestId: randomUUID() });

    expect(updated).toMatchObject({
      id: initial.id,
      value: "GET /api/v2/users?cursor=...",
      tags: ["api", "v2"],
      version: 2,
      ttl_seconds: null,
      expires_at: null,
      created_by_id: agent.agent.id,
      last_updated_by_id: agent.agent.id,
    });
  });

  it("rejects stale or missing expected versions without changing stored data", async () => {
    const projectId = await createProject("alpha");
    const agent = await register(projectId, "writer");
    await blackboardService.setFact(projectId, {
      agent_token: agent.agent_token,
      namespace: "decisions",
      key: "database",
      value: "PostgreSQL",
      tags: [],
    }, { requestId: randomUUID() });
    await blackboardService.setFact(projectId, {
      agent_token: agent.agent_token,
      namespace: "decisions",
      key: "database",
      value: "PostgreSQL 18",
      tags: [],
      expected_version: 1,
    }, { requestId: randomUUID() });

    await expect(blackboardService.setFact(projectId, {
      agent_token: agent.agent_token,
      namespace: "decisions",
      key: "database",
      value: "SQLite",
      tags: [],
      expected_version: 1,
    }, { requestId: randomUUID() })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(blackboardService.setFact(projectId, {
      agent_token: agent.agent_token,
      namespace: "decisions",
      key: "missing",
      value: "none",
      tags: [],
      expected_version: 1,
    }, { requestId: randomUUID() })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const stored = await database.db
      .select()
      .from(blackboardEntries)
      .where(eq(blackboardEntries.key, "database"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ value: "PostgreSQL 18", version: 2 });
  });

  it("filters expired TTL facts, requires all tags, and isolates projects", async () => {
    const projectA = await createProject("alpha");
    const projectB = await createProject("beta");
    const agentA = await register(projectA, "reader-a");
    const agentB = await register(projectB, "reader-b");

    const set = async (
      projectId: string,
      agentToken: string,
      key: string,
      tags: string[],
      ttlSeconds?: number,
    ) => blackboardService.setFact(projectId, {
      agent_token: agentToken,
      namespace: "contracts",
      key,
      value: key,
      tags,
      ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
    }, { requestId: randomUUID() });

    await set(projectA, agentA.agent_token, "active", ["api", "v2"]);
    const equal = await set(projectA, agentA.agent_token, "equal", ["api", "v2"], 60);
    const expired = await set(projectA, agentA.agent_token, "expired", ["api", "v2"], 60);
    await set(projectA, agentA.agent_token, "future", ["api", "v2"], 60);
    await set(projectA, agentA.agent_token, "missing-tag", ["api"]);
    await set(projectB, agentB.agent_token, "other-project", ["api", "v2"]);

    await database.db
      .update(blackboardEntries)
      .set({ expiresAt: fixedNow })
      .where(eq(blackboardEntries.id, equal.id));
    await database.db
      .update(blackboardEntries)
      .set({ expiresAt: new Date(fixedNow.getTime() - 1) })
      .where(eq(blackboardEntries.id, expired.id));

    const result = await blackboardService.getFacts(projectA, {
      agent_token: agentA.agent_token,
      namespace: "contracts",
      keys: ["active", "equal", "expired", "future", "missing-tag", "other-project"],
      tags: ["api", "v2"],
    });

    expect(result.facts.map((fact) => fact.key)).toEqual(["active", "equal", "future"]);
    expect(result.facts.every((fact) => fact.project_id === projectA)).toBe(true);
  });

  it("deletes only the requested project fact and journals successful deletion", async () => {
    const projectA = await createProject("alpha");
    const projectB = await createProject("beta");
    const agentA = await register(projectA, "writer-a");
    const agentB = await register(projectB, "writer-b");
    for (const [projectId, token] of [
      [projectA, agentA.agent_token],
      [projectB, agentB.agent_token],
    ] as const) {
      await blackboardService.setFact(projectId, {
        agent_token: token,
        namespace: "notes",
        key: "handoff",
        value: projectId,
        tags: [],
      }, { requestId: randomUUID() });
    }

    const requestId = randomUUID();
    await expect(blackboardService.deleteFact(projectA, "notes", "handoff", {
      requestId,
      actorType: "agent",
      actorId: agentA.agent.id,
    })).resolves.toEqual({ deleted: true });
    await expect(blackboardService.deleteFact(projectA, "notes", "handoff", {
      requestId: randomUUID(),
      actorType: "agent",
      actorId: agentA.agent.id,
    })).resolves.toEqual({ deleted: false });

    const remaining = await database.db.select().from(blackboardEntries);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ projectId: projectB, value: projectB });

    const deletionEvents = await database.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventType, "blackboard.fact_deleted"));
    expect(deletionEvents).toEqual([
      expect.objectContaining({
        projectId: projectA,
        requestId,
        actorAgentId: agentA.agent.id,
        metadata: {
          blackboard_namespace: "notes",
          blackboard_key: "handoff",
          blackboard_version: 1,
        },
      }),
    ]);
  });
});
