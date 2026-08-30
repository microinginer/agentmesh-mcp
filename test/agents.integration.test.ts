import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createActivityService } from "../src/activity/service.js";
import { createAgentService } from "../src/agents/service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents, messages, projects } from "../src/db/schema.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
let now = new Date("2026-08-30T12:00:00.000Z");
const activity = createActivityService({ db: database.db, clock: () => now });
const service = createAgentService({
  db: database.db,
  signingKey,
  activity,
  clock: () => now,
});

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  now = new Date("2026-08-30T12:00:00.000Z");
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

async function expectAgentMeshError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

async function eventsFor(requestId: string) {
  return database.db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.requestId, requestId))
    .orderBy(asc(activityEvents.sequence));
}

function registerWithContext(
  projectId: string,
  input: Parameters<typeof service.registerAgent>[1],
  context: { requestId: string },
) {
  return service.registerAgent(projectId, input, context);
}

function syncWithContext(
  projectId: string,
  input: Parameters<typeof service.syncAgent>[1],
  context: { requestId: string },
) {
  return service.syncAgent(projectId, input, context);
}

function requestContext() {
  return { requestId: randomUUID() };
}

describe("agent activity journal", () => {
  it("records the final registered agent for its operation request", async () => {
    const projectId = await createProject("alpha");
    const context = { requestId: randomUUID() };
    const registered = await registerWithContext(
      projectId,
      {
        mode: "register",
        session_instance_id: randomUUID(),
        name: "codex-backend",
        client: "codex",
        capabilities: ["backend"],
      },
      context,
    );

    expect(await eventsFor(context.requestId)).toEqual([
      expect.objectContaining({
        eventType: "agent.registered",
        outcome: "success",
        actorAgentId: registered.agent.id,
        metadata: {},
      }),
    ]);
  });

  it("records a safe registration conflict without token-like metadata", async () => {
    const projectId = await createProject("alpha");
    const input = {
      mode: "register" as const,
      session_instance_id: randomUUID(),
      name: "codex-backend",
      client: "codex",
      capabilities: ["backend"],
    };
    await service.registerAgent(projectId, input, requestContext());
    const context = { requestId: randomUUID() };

    await expectAgentMeshError(
      registerWithContext(projectId, { ...input, name: "different" }, context),
      "REGISTRATION_CONFLICT",
    );

    const events = await eventsFor(context.requestId);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "agent.registration_failed",
        outcome: "failure",
        errorCode: "REGISTRATION_CONFLICT",
        actorAgentId: null,
        metadata: {},
      }),
    ]);
    expect(JSON.stringify(events[0]?.metadata)).not.toMatch(/token|digest/i);
  });

  it("keeps an empty poll out of the activity journal", async () => {
    const projectId = await createProject("alpha");
    const registered = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "codex",
      client: "codex",
      capabilities: [],
    }, requestContext());
    const context = { requestId: randomUUID() };

    await syncWithContext(
      projectId,
      { mode: "poll", agent_token: registered.agent_token, acknowledge: [], limit: 50 },
      context,
    );

    expect(await eventsFor(context.requestId)).toEqual([]);
  });

  it("records an unauthenticated poll failure without assigning an actor", async () => {
    const projectId = await createProject("alpha");
    const context = { requestId: randomUUID() };

    await expectAgentMeshError(
      syncWithContext(
        projectId,
        { mode: "poll", agent_token: "not-an-agent-token", acknowledge: [], limit: 50 },
        context,
      ),
      "AGENT_AUTH_INVALID",
    );

    expect(await eventsFor(context.requestId)).toEqual([
      expect.objectContaining({
        eventType: "agent.synced",
        outcome: "failure",
        errorCode: "AGENT_AUTH_INVALID",
        actorAgentId: null,
        metadata: {},
      }),
    ]);
  });

  it("records delivered messages for the polling request", async () => {
    const projectId = await createProject("alpha");
    const sender = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "sender",
      client: "codex",
      capabilities: [],
    }, requestContext());
    const recipient = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "recipient",
      client: "claude-code",
      capabilities: [],
    }, requestContext());
    await database.db.insert(messages).values({
      id: randomUUID(),
      projectId,
      senderAgentId: sender.agent.id,
      recipientAgentId: recipient.agent.id,
      text: "deliver once",
      idempotencyKey: randomUUID(),
    });
    const context = { requestId: randomUUID() };

    await syncWithContext(
      projectId,
      { mode: "poll", agent_token: recipient.agent_token, acknowledge: [], limit: 50 },
      context,
    );

    expect(await eventsFor(context.requestId)).toEqual([
      expect.objectContaining({
        eventType: "agent.synced",
        outcome: "success",
        actorAgentId: recipient.agent.id,
        metadata: { delivered_count: 1, acknowledged_count: 0, poll_limit: 50 },
      }),
    ]);
  });

  it("records one sync and acknowledgement event for a committed ACK", async () => {
    const projectId = await createProject("alpha");
    const sender = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "sender",
      client: "codex",
      capabilities: [],
    }, requestContext());
    const recipient = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "recipient",
      client: "claude-code",
      capabilities: [],
    }, requestContext());
    const messageId = randomUUID();
    await database.db.insert(messages).values({
      id: messageId,
      projectId,
      senderAgentId: sender.agent.id,
      recipientAgentId: recipient.agent.id,
      text: "acknowledge once",
      idempotencyKey: randomUUID(),
    });
    const context = { requestId: randomUUID() };

    const result = await syncWithContext(
      projectId,
      { mode: "poll", agent_token: recipient.agent_token, acknowledge: [messageId], limit: 50 },
      context,
    );

    expect(result).toMatchObject({ acknowledged: 1, messages: [] });
    expect(await eventsFor(context.requestId)).toEqual([
      expect.objectContaining({
        eventType: "agent.synced",
        outcome: "success",
        actorAgentId: recipient.agent.id,
        metadata: { delivered_count: 0, acknowledged_count: 1, poll_limit: 50 },
      }),
      expect.objectContaining({
        eventType: "message.acknowledged",
        outcome: "success",
        actorAgentId: recipient.agent.id,
        messageId,
        metadata: {},
      }),
    ]);
  });

  it("does not record a false acknowledgement for a bystander", async () => {
    const projectId = await createProject("alpha");
    const sender = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "sender",
      client: "codex",
      capabilities: [],
    }, requestContext());
    const recipient = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "recipient",
      client: "claude-code",
      capabilities: [],
    }, requestContext());
    const bystander = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "bystander",
      client: "codex",
      capabilities: [],
    }, requestContext());
    const messageId = randomUUID();
    await database.db.insert(messages).values({
      id: messageId,
      projectId,
      senderAgentId: sender.agent.id,
      recipientAgentId: recipient.agent.id,
      text: "private",
      idempotencyKey: randomUUID(),
    });
    const context = { requestId: randomUUID() };

    const result = await syncWithContext(
      projectId,
      { mode: "poll", agent_token: bystander.agent_token, acknowledge: [messageId], limit: 50 },
      context,
    );

    expect(result.acknowledged).toBe(0);
    expect(await eventsFor(context.requestId)).toEqual([]);
  });
});

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

    const first = await service.registerAgent(projectId, input, requestContext());
    const retry = await service.registerAgent(projectId, {
      ...input,
      capabilities: ["testing", "backend"],
    }, requestContext());

    expect(retry).toEqual(first);
    await expectAgentMeshError(
      service.registerAgent(projectId, { ...input, name: "different" }, requestContext()),
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
    }, requestContext());

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
    }, requestContext());

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
    }, requestContext());
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
    }, requestContext());
    const recipient = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "claude",
      client: "claude-code",
      capabilities: [],
    }, requestContext());
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
    }, requestContext());
    const retry = await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [],
      limit: 50,
    }, requestContext());

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
    }, requestContext());
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
    }, requestContext());
    const recipient = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "recipient",
      client: "claude-code",
      capabilities: [],
    }, requestContext());
    const bystander = await service.registerAgent(projectId, {
      mode: "register",
      session_instance_id: randomUUID(),
      name: "bystander",
      client: "codex",
      capabilities: [],
    }, requestContext());
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
    }, requestContext());
    expect(attempted.acknowledged).toBe(0);

    const realRecipient = await service.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [],
      limit: 50,
    }, requestContext());
    expect(realRecipient.messages.map((message) => message.id)).toEqual([messageId]);
  });
});
