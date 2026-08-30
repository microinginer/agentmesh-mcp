import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createActivityService } from "../src/activity/service.js";
import { createAgentService } from "../src/agents/service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents, messages, projects } from "../src/db/schema.js";
import { createMessageService } from "../src/messages/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const fixedNow = new Date("2026-08-30T12:00:00.000Z");
const activity = createActivityService({ db: database.db, clock: () => fixedNow });
const agentService = createAgentService({
  db: database.db,
  signingKey,
  activity,
  clock: () => fixedNow,
});
const messageService = createMessageService({
  db: database.db,
  agentService,
  activity,
  clock: () => fixedNow,
});

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

async function createProject(name: string): Promise<string> {
  const id = randomUUID();
  await database.db.insert(projects).values({ id, name });
  return id;
}

async function register(projectId: string, name: string, client = "codex") {
  return agentService.registerAgent(projectId, {
    mode: "register",
    session_instance_id: randomUUID(),
    name,
    client,
    capabilities: [],
  }, { requestId: randomUUID() });
}

async function eventByRequest(requestId: string) {
  const events = await database.db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.requestId, requestId));
  expect(events).toHaveLength(1);
  return events[0];
}

describe("durable direct messages", () => {
  it("delivers direct messages to the target inbox in sequence order", async () => {
    const projectId = await createProject("alpha");
    const sender = await register(projectId, "sender");
    const recipient = await register(projectId, "recipient", "claude-code");

    const first = await messageService.sendMessage(projectId, {
      agent_token: sender.agent_token,
      to_agent_id: recipient.agent.id,
      text: "first",
      idempotency_key: randomUUID(),
    }, { requestId: randomUUID() });
    const second = await messageService.sendMessage(projectId, {
      agent_token: sender.agent_token,
      to_agent_id: recipient.agent.id,
      text: "second",
      idempotency_key: randomUUID(),
    }, { requestId: randomUUID() });

    expect(first.deduplicated).toBe(false);
    expect(second.message.sequence).toBeGreaterThan(first.message.sequence);

    const inbox = await agentService.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [],
      limit: 50,
    }, { requestId: randomUUID() });
    expect(inbox.messages.map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("rejects self-send and a target from another project with the same safe code", async () => {
    const projectA = await createProject("alpha");
    const projectB = await createProject("beta");
    const sender = await register(projectA, "sender");
    const outsider = await register(projectB, "outsider");

    for (const target of [sender.agent.id, outsider.agent.id]) {
      await expect(
        messageService.sendMessage(projectA, {
          agent_token: sender.agent_token,
          to_agent_id: target,
          text: "not allowed",
          idempotency_key: randomUUID(),
        }, { requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: "TARGET_AGENT_INVALID" });
    }
  });

  it("deduplicates an identical retry without storing a second row", async () => {
    const projectId = await createProject("alpha");
    const sender = await register(projectId, "sender");
    const recipient = await register(projectId, "recipient");
    const input = {
      agent_token: sender.agent_token,
      to_agent_id: recipient.agent.id,
      text: "exactly once persistence",
      idempotency_key: randomUUID(),
    };

    const firstRequestId = randomUUID();
    const retryRequestId = randomUUID();
    const first = await messageService.sendMessage(projectId, input, { requestId: firstRequestId });
    const retry = await messageService.sendMessage(projectId, input, { requestId: retryRequestId });

    expect(retry).toEqual({ ...first, deduplicated: true });
    const stored = await database.db.select({ id: messages.id }).from(messages);
    expect(stored).toEqual([{ id: first.message.id }]);
    expect(await eventByRequest(firstRequestId)).toMatchObject({
      eventType: "message.sent",
      outcome: "success",
      messageId: first.message.id,
      actorAgentId: sender.agent.id,
      targetAgentId: recipient.agent.id,
      metadata: { message_bytes: 24, deduplicated: false },
    });
    expect(await eventByRequest(retryRequestId)).toMatchObject({
      eventType: "message.sent",
      metadata: { message_bytes: 24, deduplicated: true },
    });
  });

  it("rejects reuse of an idempotency key with different content", async () => {
    const projectId = await createProject("alpha");
    const sender = await register(projectId, "sender");
    const recipient = await register(projectId, "recipient");
    const idempotencyKey = randomUUID();
    await messageService.sendMessage(projectId, {
      agent_token: sender.agent_token,
      to_agent_id: recipient.agent.id,
      text: "original",
      idempotency_key: idempotencyKey,
    }, { requestId: randomUUID() });

    const requestId = randomUUID();
    await expect(
      messageService.sendMessage(projectId, {
        agent_token: sender.agent_token,
        to_agent_id: recipient.agent.id,
        text: "changed",
        idempotency_key: idempotencyKey,
      }, { requestId }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await eventByRequest(requestId)).toMatchObject({
      eventType: "message.send_failed",
      outcome: "failure",
      actorAgentId: sender.agent.id,
      targetAgentId: recipient.agent.id,
      errorCode: "IDEMPOTENCY_CONFLICT",
      metadata: { message_bytes: 7 },
    });
  });

  it("journals safe expected send failures without persisting attempted secrets", async () => {
    const projectA = await createProject("alpha");
    const projectB = await createProject("beta");
    const sender = await register(projectA, "sender");
    const outsider = await register(projectB, "outsider");
    const attemptedText = "do not persist this attempted message";
    const cases = [
      {
        requestId: randomUUID(),
        token: sender.agent_token,
        targetId: sender.agent.id,
        code: "TARGET_AGENT_INVALID",
        actorAgentId: sender.agent.id,
        targetAgentId: null,
      },
      {
        requestId: randomUUID(),
        token: sender.agent_token,
        targetId: outsider.agent.id,
        code: "TARGET_AGENT_INVALID",
        actorAgentId: sender.agent.id,
        targetAgentId: null,
      },
      {
        requestId: randomUUID(),
        token: "am_agent_not-a-real-token",
        targetId: sender.agent.id,
        code: "AGENT_AUTH_INVALID",
        actorAgentId: null,
        targetAgentId: null,
      },
    ] as const;

    for (const testCase of cases) {
      await expect(
        messageService.sendMessage(projectA, {
          agent_token: testCase.token,
          to_agent_id: testCase.targetId,
          text: attemptedText,
          idempotency_key: randomUUID(),
        }, { requestId: testCase.requestId }),
      ).rejects.toMatchObject({ code: testCase.code });
      expect(await eventByRequest(testCase.requestId)).toMatchObject({
        eventType: "message.send_failed",
        outcome: "failure",
        actorAgentId: testCase.actorAgentId,
        targetAgentId: testCase.targetAgentId,
        errorCode: testCase.code,
        metadata: { message_bytes: 37 },
      });
    }

    const events = await database.db.select().from(activityEvents);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(attemptedText);
    expect(serialized).not.toContain(sender.agent_token);
  });
});
