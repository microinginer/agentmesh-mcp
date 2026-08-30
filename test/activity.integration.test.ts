import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createActivityService } from "../src/activity/service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents, agents, messages, projects } from "../src/db/schema.js";
import type { AgentMeshErrorCode } from "../src/errors.js";
import type { ActivityMetadata } from "../src/activity/types.js";
import { createSafeLogger } from "../src/logging.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";

const database = createDatabase(databaseUrl);

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function createProjectMessageFixture() {
  const projectId = randomUUID();
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const messageId = randomUUID();

  await database.db.insert(projects).values({ id: projectId, name: "alpha" });
  await database.db.insert(agents).values([
    {
      id: senderId,
      projectId,
      registrationDigest: Buffer.alloc(32, 1),
      name: "sender",
      client: "codex",
      capabilities: [],
    },
    {
      id: recipientId,
      projectId,
      registrationDigest: Buffer.alloc(32, 2),
      name: "recipient",
      client: "claude-code",
      capabilities: [],
    },
  ]);
  await database.db.insert(messages).values({
    id: messageId,
    projectId,
    senderAgentId: senderId,
    recipientAgentId: recipientId,
    text: "persisted message",
    idempotencyKey: randomUUID(),
  });

  return { projectId, senderId, recipientId, messageId };
}

describe("activity journal persistence", () => {
  it("writes only the closed safe logger DTO as one stderr JSON line", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const logger = createSafeLogger();

    logger.write({
      event: "mcp.request_failed",
      request_id: "request-123",
      project_id: "project-456",
      error_code: "INTERNAL_ERROR",
      ...({
        text: "attempted message must not be logged",
        authorization: "Bearer secret-token",
        error: new Error("raw error must not be logged"),
      } as object),
    });

    expect(writes).toEqual([
      '{"event":"mcp.request_failed","request_id":"request-123","project_id":"project-456","error_code":"INTERNAL_ERROR"}\n',
    ]);
  });

  it("stores only explicitly selected activity fields", async () => {
    const { projectId, senderId, recipientId, messageId } =
      await createProjectMessageFixture();
    const activity = createActivityService({ db: database.db });
    const requestId = randomUUID();

    await activity.record({
      projectId,
      requestId,
      eventType: "message.sent",
      outcome: "success",
      actorAgentId: senderId,
      targetAgentId: recipientId,
      messageId,
      metadata: { message_bytes: 17, deduplicated: false },
      ...({ agent_token: "must-not-persist", text: "must-not-duplicate" } as object),
    });

    const [stored] = await database.db.select().from(activityEvents);
    expect(stored?.metadata).toEqual({ message_bytes: 17, deduplicated: false });
    expect(JSON.stringify(stored)).not.toContain("must-not");
  });

  it("drops unsafe runtime metadata and error codes before persistence", async () => {
    const { projectId } = await createProjectMessageFixture();
    const activity = createActivityService({ db: database.db });

    await activity.record({
      projectId,
      requestId: randomUUID(),
      eventType: "message.send_failed",
      outcome: "failure",
      errorCode: "must-not-persist" as unknown as AgentMeshErrorCode,
      metadata: {
        message_bytes: 17,
        deduplicated: false,
        agent_token: "must-not-persist",
        text: "must-not-duplicate",
        arbitrary: { authorization: "must-not-persist" },
      } as unknown as ActivityMetadata,
    });

    const [stored] = await database.db.select().from(activityEvents);
    expect(stored?.metadata).toEqual({ message_bytes: 17, deduplicated: false });
    expect(stored?.errorCode).toBeNull();
    expect(JSON.stringify(stored)).not.toContain("must-not");
  });

  it("accepts message, actor, and target references from the event project", async () => {
    const { projectId, senderId, recipientId, messageId } =
      await createProjectMessageFixture();
    const activity = createActivityService({ db: database.db });

    await expect(
      activity.record({
        projectId,
        requestId: randomUUID(),
        eventType: "message.acknowledged",
        outcome: "success",
        actorAgentId: senderId,
        targetAgentId: recipientId,
        messageId,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects actor, target, and message references from another project", async () => {
    const fixture = await createProjectMessageFixture();
    const otherProjectId = randomUUID();
    const otherAgentId = randomUUID();
    const otherRecipientId = randomUUID();
    const otherMessageId = randomUUID();
    await database.db.insert(projects).values({ id: otherProjectId, name: "beta" });
    await database.db.insert(agents).values([
      {
        id: otherAgentId,
        projectId: otherProjectId,
        registrationDigest: Buffer.alloc(32, 3),
        name: "other-agent",
        client: "codex",
        capabilities: [],
      },
      {
        id: otherRecipientId,
        projectId: otherProjectId,
        registrationDigest: Buffer.alloc(32, 4),
        name: "other-recipient",
        client: "claude-code",
        capabilities: [],
      },
    ]);
    await database.db.insert(messages).values({
      id: otherMessageId,
      projectId: otherProjectId,
      senderAgentId: otherAgentId,
      recipientAgentId: otherRecipientId,
      text: "not valid",
      idempotencyKey: randomUUID(),
    });
    const activity = createActivityService({ db: database.db });
    const base = {
      projectId: fixture.projectId,
      requestId: randomUUID(),
      eventType: "message.sent" as const,
      outcome: "success" as const,
    };

    await expect(activity.record({ ...base, actorAgentId: otherAgentId })).rejects.toThrow();
    await expect(activity.record({ ...base, targetAgentId: otherAgentId })).rejects.toThrow();
    await expect(activity.record({ ...base, messageId: otherMessageId })).rejects.toThrow();
  });

  it("reports persistence failures with only safe journal context", async () => {
    const reports: Array<{ event: string; request_id: string }> = [];
    const activity = createActivityService({
      db: database.db,
      onPersistFailure: (report) => reports.push(report),
    });
    const requestId = randomUUID();

    await expect(
      activity.recordBestEffort({
        projectId: randomUUID(),
        requestId,
        eventType: "mcp.request_failed",
        outcome: "failure",
        errorCode: "INTERNAL_ERROR",
      }),
    ).resolves.toBeUndefined();

    expect(reports).toEqual([{ event: "activity.persist_failed", request_id: requestId }]);
  });

  it("does not reject when a best-effort persistence callback throws", async () => {
    const activity = createActivityService({
      db: database.db,
      onPersistFailure: () => {
        throw new Error("logger unavailable");
      },
    });

    await expect(
      activity.recordBestEffort({
        projectId: randomUUID(),
        requestId: randomUUID(),
        eventType: "mcp.request_failed",
        outcome: "failure",
        errorCode: "INTERNAL_ERROR",
      }),
    ).resolves.toBeUndefined();
  });
});
