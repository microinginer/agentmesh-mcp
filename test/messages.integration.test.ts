import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAgentService } from "../src/agents/service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { messages, projects } from "../src/db/schema.js";
import { createMessageService } from "../src/messages/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const fixedNow = new Date("2026-08-30T12:00:00.000Z");
const agentService = createAgentService({
  db: database.db,
  signingKey,
  clock: () => fixedNow,
});
const messageService = createMessageService({
  db: database.db,
  agentService,
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
  });
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
    });
    const second = await messageService.sendMessage(projectId, {
      agent_token: sender.agent_token,
      to_agent_id: recipient.agent.id,
      text: "second",
      idempotency_key: randomUUID(),
    });

    expect(first.deduplicated).toBe(false);
    expect(second.message.sequence).toBeGreaterThan(first.message.sequence);

    const inbox = await agentService.syncAgent(projectId, {
      mode: "poll",
      agent_token: recipient.agent_token,
      acknowledge: [],
      limit: 50,
    });
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
        }),
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

    const first = await messageService.sendMessage(projectId, input);
    const retry = await messageService.sendMessage(projectId, input);

    expect(retry).toEqual({ ...first, deduplicated: true });
    const stored = await database.db.select({ id: messages.id }).from(messages);
    expect(stored).toEqual([{ id: first.message.id }]);
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
    });

    await expect(
      messageService.sendMessage(projectId, {
        agent_token: sender.agent_token,
        to_agent_id: recipient.agent.id,
        text: "changed",
        idempotency_key: idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
