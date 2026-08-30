import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAgentService } from "../src/agents/service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { messages, projects } from "../src/db/schema.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
let now = new Date("2026-08-30T12:00:00.000Z");
const service = createAgentService({
  db: database.db,
  signingKey,
  clock: () => now,
});

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  now = new Date("2026-08-30T12:00:00.000Z");
  await database.pool.query(
    "TRUNCATE TABLE messages, agents, project_tokens, projects RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await database.pool.end();
});

async function createProject(name: string): Promise<string> {
  const id = randomUUID();
  await database.db.insert(projects).values({ id, name });
  return id;
}

async function expectAgentMeshError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

describe("agent registration and discovery", () => {
  it("retries the same registration but rejects a changed profile", async () => {
    const projectId = await createProject("alpha");
    const sessionInstanceId = randomUUID();
    const input = {
      mode: "register" as const,
      session_instance_id: sessionInstanceId,
      name: "codex-backend",
      client: "codex",
      capabilities: ["backend", "testing"],
    };

    const first = await service.registerAgent(projectId, input);
    const retry = await service.registerAgent(projectId, {
      ...input,
      capabilities: ["testing", "backend"],
    });

    expect(retry).toEqual(first);
    await expectAgentMeshError(
      service.registerAgent(projectId, { ...input, name: "different" }),
      "REGISTRATION_CONFLICT",
    );
  });

  it("does not accept an agent token under another project", async () => {
    const projectA = await createProject("alpha");
    const projectB = await createProject("beta");
    const registered = await service.registerAgent(projectA, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "codex",
      client: "codex",
      capabilities: [],
    });

    await expectAgentMeshError(
      service.listAgents(projectB, registered.agent_token),
      "AGENT_AUTH_INVALID",
    );
  });

  it("derives online, idle, and offline from the last successful sync", async () => {
    const projectId = await createProject("alpha");
    const registered = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "codex",
      client: "codex",
      capabilities: [],
    });

    expect((await service.listAgents(projectId, registered.agent_token)).agents[0]?.status).toBe(
      "online",
    );
    now = new Date("2026-08-30T12:05:00.001Z");
    expect((await service.listAgents(projectId, registered.agent_token)).agents[0]?.status).toBe(
      "idle",
    );
    now = new Date("2026-08-30T12:30:00.001Z");
    expect((await service.listAgents(projectId, registered.agent_token)).agents[0]?.status).toBe(
      "offline",
    );

    await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: registered.agent_token,
      acknowledge: [],
      limit: 50,
    });
    expect((await service.listAgents(projectId, registered.agent_token)).agents[0]?.status).toBe(
      "online",
    );
  });
});

describe("durable inbox acknowledgement", () => {
  it("redelivers before ACK, then hides the acknowledged message", async () => {
    const projectId = await createProject("alpha");
    const sender = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "codex",
      client: "codex",
      capabilities: [],
    });
    const recipient = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "claude",
      client: "claude-code",
      capabilities: [],
    });
    const messageId = randomUUID();
    await database.db.insert(messages).values({
      id: messageId,
      projectId,
      senderAgentId: sender.agent.id,
      recipientAgentId: recipient.agent.id,
      text: "contract changed",
      idempotencyKey: randomUUID(),
      createdAt: now,
    });

    const first = await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [],
      limit: 50,
    });
    const retry = await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [],
      limit: 50,
    });

    expect(first.messages).toEqual([
      expect.objectContaining({
        id: messageId,
        from_agent_id: sender.agent.id,
        text: "contract changed",
      }),
    ]);
    expect(retry.messages).toEqual(first.messages);

    const acknowledged = await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [messageId],
      limit: 50,
    });
    expect(acknowledged.acknowledged).toBe(1);
    expect(acknowledged.messages).toEqual([]);
  });

  it("cannot acknowledge a message addressed to another agent", async () => {
    const projectId = await createProject("alpha");
    const sender = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "sender",
      client: "codex",
      capabilities: [],
    });
    const recipient = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "recipient",
      client: "claude-code",
      capabilities: [],
    });
    const bystander = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "bystander",
      client: "codex",
      capabilities: [],
    });
    const messageId = randomUUID();
    await database.db.insert(messages).values({
      id: messageId,
      projectId,
      senderAgentId: sender.agent.id,
      recipientAgentId: recipient.agent.id,
      text: "private",
      idempotencyKey: randomUUID(),
    });

    const attempted = await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: bystander.agent_token,
      acknowledge: [messageId],
      limit: 50,
    });
    expect(attempted.acknowledged).toBe(0);

    const realRecipient = await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [],
      limit: 50,
    });
    expect(realRecipient.messages.map((message) => message.id)).toEqual([messageId]);
  });
});
