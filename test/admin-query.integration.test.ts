import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  adminListQuerySchema,
  decodeAdminCursor,
  encodeAdminCursor,
  eventListQuerySchema,
  messageListQuerySchema,
} from "../src/admin/contracts.js";
import { createAdminQueryService } from "../src/admin/query-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents, agents, messages, projects } from "../src/db/schema.js";
import * as schema from "../src/db/schema.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const now = new Date("2026-08-30T12:00:00.000Z");
const service = createAdminQueryService({ db: database.db, clock: () => now });

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

interface Fixture {
  projectA: string;
  projectB: string;
  alphaSender: string;
  alphaRecipient: string;
  alphaOffline: string;
  betaSender: string;
  imageMessage: string;
  longMessage: string;
  acknowledgedMessage: string;
  betaMessage: string;
}

async function seedFixture(): Promise<Fixture> {
  const fixture = {
    projectA: randomUUID(),
    projectB: randomUUID(),
    alphaSender: randomUUID(),
    alphaRecipient: randomUUID(),
    alphaOffline: randomUUID(),
    betaSender: randomUUID(),
    imageMessage: randomUUID(),
    longMessage: randomUUID(),
    acknowledgedMessage: randomUUID(),
    betaMessage: randomUUID(),
  };
  const betaRecipient = randomUUID();

  await database.db.insert(projects).values([
    { id: fixture.projectA, name: "alpha", createdAt: new Date("2026-08-29T10:00:00.000Z") },
    { id: fixture.projectB, name: "beta", createdAt: new Date("2026-08-30T10:00:00.000Z") },
  ]);
  await database.db.insert(agents).values([
    {
      id: fixture.alphaSender,
      projectId: fixture.projectA,
      registrationDigest: Buffer.alloc(32, 1),
      name: "alpha-sender",
      client: "codex",
      capabilities: ["plan"],
      lastSeenAt: new Date("2026-08-30T11:55:00.000Z"),
      createdAt: new Date("2026-08-29T10:00:00.000Z"),
    },
    {
      id: fixture.alphaRecipient,
      projectId: fixture.projectA,
      registrationDigest: Buffer.alloc(32, 2),
      name: "alpha-recipient",
      client: "claude-code",
      capabilities: [],
      lastSeenAt: new Date("2026-08-30T11:30:00.000Z"),
      createdAt: new Date("2026-08-30T09:00:00.000Z"),
    },
    {
      id: fixture.alphaOffline,
      projectId: fixture.projectA,
      registrationDigest: Buffer.alloc(32, 3),
      name: "alpha-offline",
      client: "codex",
      capabilities: [],
      lastSeenAt: new Date("2026-08-30T11:29:59.999Z"),
      createdAt: new Date("2026-08-30T08:00:00.000Z"),
    },
    {
      id: fixture.betaSender,
      projectId: fixture.projectB,
      registrationDigest: Buffer.alloc(32, 4),
      name: "beta-sender",
      client: "codex",
      capabilities: [],
      lastSeenAt: now,
      createdAt: new Date("2026-08-30T11:00:00.000Z"),
    },
    {
      id: betaRecipient,
      projectId: fixture.projectB,
      registrationDigest: Buffer.alloc(32, 5),
      name: "beta-recipient",
      client: "claude-code",
      capabilities: [],
      lastSeenAt: now,
      createdAt: new Date("2026-08-30T11:01:00.000Z"),
    },
  ]);
  await database.db.insert(messages).values([
    {
      id: fixture.imageMessage,
      projectId: fixture.projectA,
      senderAgentId: fixture.alphaSender,
      recipientAgentId: fixture.alphaRecipient,
      text: "<img src=x onerror=alert(1)>",
      idempotencyKey: randomUUID(),
      createdAt: new Date("2026-08-30T10:00:00.000Z"),
    },
    {
      id: fixture.longMessage,
      projectId: fixture.projectA,
      senderAgentId: fixture.alphaRecipient,
      recipientAgentId: fixture.alphaSender,
      text: "😀".repeat(161),
      idempotencyKey: randomUUID(),
      createdAt: new Date("2026-08-30T10:01:00.000Z"),
    },
    {
      id: fixture.acknowledgedMessage,
      projectId: fixture.projectA,
      senderAgentId: fixture.alphaSender,
      recipientAgentId: fixture.alphaRecipient,
      text: "acknowledged alpha message",
      idempotencyKey: randomUUID(),
      createdAt: new Date("2026-08-30T10:02:00.000Z"),
      acknowledgedAt: new Date("2026-08-30T10:03:00.000Z"),
    },
    {
      id: fixture.betaMessage,
      projectId: fixture.projectB,
      senderAgentId: fixture.betaSender,
      recipientAgentId: betaRecipient,
      text: "beta private text",
      idempotencyKey: randomUUID(),
      createdAt: new Date("2026-08-30T10:04:00.000Z"),
    },
  ]);
  await database.db.insert(activityEvents).values([
    {
      id: randomUUID(),
      projectId: fixture.projectA,
      requestId: randomUUID(),
      eventType: "message.sent",
      outcome: "success",
      actorAgentId: fixture.alphaSender,
      targetAgentId: fixture.alphaRecipient,
      messageId: fixture.imageMessage,
      metadata: { message_bytes: 28 },
      createdAt: new Date("2026-08-30T10:00:00.000Z"),
    },
    {
      id: randomUUID(),
      projectId: fixture.projectA,
      requestId: randomUUID(),
      eventType: "message.send_failed",
      outcome: "failure",
      actorAgentId: fixture.alphaSender,
      errorCode: "TARGET_AGENT_INVALID",
      metadata: { message_bytes: 12 },
      createdAt: new Date("2026-08-30T11:00:00.000Z"),
    },
    {
      id: randomUUID(),
      projectId: fixture.projectB,
      requestId: randomUUID(),
      eventType: "message.sent",
      outcome: "success",
      actorAgentId: fixture.betaSender,
      targetAgentId: betaRecipient,
      messageId: fixture.betaMessage,
      metadata: { message_bytes: 17 },
      createdAt: new Date("2026-08-30T11:00:00.000Z"),
    },
  ]);
  return fixture;
}

describe("admin query contracts", () => {
  it("rejects invalid strict paging and filter queries", () => {
    const sequenceCursor = encodeAdminCursor({ kind: "sequence", sequence: 1 });
    const invalid = [
      adminListQuerySchema.safeParse({ limit: 0 }),
      adminListQuerySchema.safeParse({ limit: 101 }),
      adminListQuerySchema.safeParse({ unexpected: true }),
      messageListQuerySchema.safeParse({ agent_id: "not-a-uuid" }),
      messageListQuerySchema.safeParse({ cursor: sequenceCursor, after: sequenceCursor }),
      messageListQuerySchema.safeParse({ cursor: "bad cursor" }),
      eventListQuerySchema.safeParse({ event_type: "not-an-event" }),
    ];

    expect(invalid.every((result) => !result.success)).toBe(true);
    expect(() => encodeAdminCursor({ kind: "sequence", sequence: -1 })).toThrow();
    expect(() => decodeAdminCursor("eyJraW5kIjoic2VxdWVuY2UifQ")).toThrow();
    expect(() => decodeAdminCursor("x".repeat(700))).toThrow();
  });
});

describe("project-scoped admin read models", () => {
  it("computes the exact summary with bounded PostgreSQL aggregates", async () => {
    const fixture = await seedFixture();
    const statements: string[] = [];
    const aggregateService = createAdminQueryService({
      clock: () => now,
      db: drizzle({
        client: database.pool,
        logger: { logQuery(query) { statements.push(query); } },
        schema,
      }),
    });

    const summary = await aggregateService.getSummary(fixture.projectA);

    expect(summary).toEqual({
      found: true,
      data: {
        project: expect.objectContaining({ id: fixture.projectA, name: "alpha" }),
        agents: { online: 1, idle: 1, offline: 1, total: 3 },
        messages: { total: 3, unacknowledged: 2 },
        failures_last_24h: 1,
      },
    });
    const aggregateStatements = statements.filter((statement) =>
      statement.includes('from "agents"') || statement.includes('from "messages"') || statement.includes('from "activity_events"'),
    );
    expect(aggregateStatements).toHaveLength(3);
    expect(aggregateStatements.every((statement) => /count\(\*\)/i.test(statement))).toBe(true);
    expect(aggregateStatements.find((statement) => statement.includes('from "agents"'))).toMatch(/filter\s*\(where/i);
    expect(aggregateStatements.find((statement) => statement.includes('from "messages"'))).toMatch(/filter\s*\(where/i);
  });

  it("keeps project rows isolated and returns bounded public DTOs", async () => {
    const fixture = await seedFixture();

    const listedProjects = await service.listProjects({ limit: 50 });
    const listedAgents = await service.listAgents(fixture.projectA, { limit: 50 });
    const listedMessages = await service.listMessages(fixture.projectA, { limit: 50 });
    const listedEvents = await service.listEvents(fixture.projectA, { limit: 50 });
    const detail = await service.getMessage(fixture.projectA, fixture.imageMessage);

    expect(listedProjects.items).toEqual([
      expect.objectContaining({ id: fixture.projectB, name: "beta" }),
      expect.objectContaining({ id: fixture.projectA, name: "alpha" }),
    ]);
    expect(listedAgents).toMatchObject({ found: true });
    if (!listedAgents.found) throw new Error("expected alpha agents");
    expect(listedAgents.data.items).toEqual([
      expect.objectContaining({ id: fixture.alphaRecipient, status: "idle" }),
      expect.objectContaining({ id: fixture.alphaOffline, status: "offline" }),
      expect.objectContaining({ id: fixture.alphaSender, status: "online" }),
    ]);
    expect(JSON.stringify(listedAgents.data.items)).not.toContain("registrationDigest");
    expect(listedAgents.data.items.map((agent) => agent.id)).not.toContain(fixture.betaSender);

    expect(listedMessages).toMatchObject({ found: true });
    if (!listedMessages.found) throw new Error("expected alpha messages");
    expect(listedMessages.data.items.map((message) => message.id)).toEqual([
      fixture.acknowledgedMessage,
      fixture.longMessage,
      fixture.imageMessage,
    ]);
    expect(listedMessages.data.items[1]?.preview).toBe(`${"😀".repeat(160)}…`);
    expect(JSON.stringify(listedMessages.data.items)).not.toContain("idempotencyKey");
    expect(JSON.stringify(listedMessages.data.items)).not.toContain("beta private text");
    expect(listedMessages.data.items.map((message) => message.id)).not.toContain(fixture.betaMessage);

    expect(detail).toEqual({
      found: true,
      data: expect.objectContaining({ id: fixture.imageMessage, text: "<img src=x onerror=alert(1)>" }),
    });
    expect(await service.getMessage(fixture.projectA, randomUUID())).toEqual({ found: false });
    expect(await service.getMessage(fixture.projectA, fixture.longMessage)).toMatchObject({ found: true });
    expect(await service.getMessage(fixture.projectA, fixture.betaMessage)).toEqual({ found: false });

    expect(listedEvents).toMatchObject({ found: true });
    if (!listedEvents.found) throw new Error("expected alpha events");
    expect(listedEvents.data.items).toEqual([
      expect.objectContaining({
        event_type: "message.send_failed",
        actor: { id: fixture.alphaSender, name: "alpha-sender" },
        target: null,
        error_code: "TARGET_AGENT_INVALID",
      }),
      expect.objectContaining({
        event_type: "message.sent",
        actor: { id: fixture.alphaSender, name: "alpha-sender" },
        target: { id: fixture.alphaRecipient, name: "alpha-recipient" },
      }),
    ]);
    expect(JSON.stringify(listedEvents.data.items)).not.toContain("beta private text");
  });

  it("applies message and activity filters on the server and summarizes one project", async () => {
    const fixture = await seedFixture();

    const unacknowledged = await service.listMessages(fixture.projectA, {
      limit: 50,
      agent_id: fixture.alphaSender,
      acknowledged: false,
    });
    const failures = await service.listEvents(fixture.projectA, {
      limit: 50,
      agent_id: fixture.alphaSender,
      event_type: "message.send_failed",
      outcome: "failure",
    });
    const summary = await service.getSummary(fixture.projectA);

    expect(unacknowledged).toMatchObject({ found: true });
    if (!unacknowledged.found) throw new Error("expected alpha messages");
    expect(unacknowledged.data.items.map((message) => message.id)).toEqual([
      fixture.longMessage,
      fixture.imageMessage,
    ]);
    expect(failures).toMatchObject({ found: true });
    if (!failures.found) throw new Error("expected alpha events");
    expect(failures.data.items).toEqual([
      expect.objectContaining({ event_type: "message.send_failed", outcome: "failure" }),
    ]);
    expect(summary).toEqual({
      found: true,
      data: {
        project: expect.objectContaining({ id: fixture.projectA, name: "alpha" }),
        agents: { online: 1, idle: 1, offline: 1, total: 3 },
        messages: { total: 3, unacknowledged: 2 },
        failures_last_24h: 1,
      },
    });
    expect(await service.getSummary(fixture.projectB)).toMatchObject({ found: true });
    expect(await service.getSummary(randomUUID())).toEqual({ found: false });
  });

  it("treats a cross-project agent filter as not found", async () => {
    const fixture = await seedFixture();

    const [filteredMessages, filteredEvents] = await Promise.all([
      service.listMessages(fixture.projectA, { limit: 50, agent_id: fixture.betaSender }),
      service.listEvents(fixture.projectA, { limit: 50, agent_id: fixture.betaSender }),
    ]);

    expect([filteredMessages, filteredEvents]).toEqual([{ found: false }, { found: false }]);
  });

  it("does not skip a project at a sub-millisecond cursor boundary", async () => {
    const olderProjectId = randomUUID();
    const newerProjectId = randomUUID();
    await database.pool.query(
      "INSERT INTO projects (id, name, created_at) VALUES ($1, $2, $3::timestamptz), ($4, $5, $6::timestamptz)",
      [
        olderProjectId,
        "older",
        "2026-08-30T10:00:00.123001Z",
        newerProjectId,
        "newer",
        "2026-08-30T10:00:00.123999Z",
      ],
    );

    const first = await service.listProjects({ limit: 1 });
    const second = await service.listProjects({ limit: 1, cursor: first.next_cursor ?? undefined });

    expect(first.items.map((project) => project.id)).toEqual([newerProjectId]);
    expect(second.items.map((project) => project.id)).toEqual([olderProjectId]);
  });

  it("does not skip an agent at a sub-millisecond cursor boundary", async () => {
    const projectId = randomUUID();
    const olderAgentId = randomUUID();
    const newerAgentId = randomUUID();
    await database.db.insert(projects).values({ id: projectId, name: "alpha" });
    await database.pool.query(
      `INSERT INTO agents (
         id, project_id, registration_digest, name, client, capabilities, last_seen_at, created_at
       ) VALUES
         ($1, $2, $3, $4, $5, ARRAY[]::text[], $6::timestamptz, $7::timestamptz),
         ($8, $2, $9, $10, $5, ARRAY[]::text[], $6::timestamptz, $11::timestamptz)`,
      [
        olderAgentId,
        projectId,
        Buffer.alloc(32, 6),
        "older",
        "codex",
        "2026-08-30T12:00:00.000000Z",
        "2026-08-30T10:00:00.123001Z",
        newerAgentId,
        Buffer.alloc(32, 7),
        "newer",
        "2026-08-30T10:00:00.123999Z",
      ],
    );

    const first = await service.listAgents(projectId, { limit: 1 });
    if (!first.found) throw new Error("expected agent project");
    const second = await service.listAgents(projectId, {
      limit: 1,
      cursor: first.data.next_cursor ?? undefined,
    });

    expect(first.data.items.map((agent) => agent.id)).toEqual([newerAgentId]);
    expect(second).toMatchObject({ found: true });
    if (!second.found) throw new Error("expected second agent page");
    expect(second.data.items.map((agent) => agent.id)).toEqual([olderAgentId]);
  });

  it("uses stable history cursors and drainable ascending live cursors", async () => {
    const fixture = await seedFixture();
    const first = await service.listMessages(fixture.projectA, { limit: 2 });
    expect(first).toMatchObject({ found: true });
    if (!first.found) throw new Error("expected alpha messages");
    const firstIds = first.data.items.map((message) => message.id);
    const newestSequence = first.data.items[0]?.sequence ?? 0;
    expect(first.data.next_cursor).not.toBeNull();

    const insertedId = randomUUID();
    await database.db.insert(messages).values({
      id: insertedId,
      projectId: fixture.projectA,
      senderAgentId: fixture.alphaSender,
      recipientAgentId: fixture.alphaRecipient,
      text: "newer after first page",
      idempotencyKey: randomUUID(),
      createdAt: new Date("2026-08-30T12:01:00.000Z"),
    });
    const second = await service.listMessages(fixture.projectA, {
      limit: 2,
      cursor: first.data.next_cursor ?? undefined,
    });
    expect(second).toMatchObject({ found: true });
    if (!second.found) throw new Error("expected second message page");
    expect(second.data.items.map((message) => message.id)).toEqual([fixture.imageMessage]);
    expect([...firstIds, ...second.data.items.map((message) => message.id)]).not.toContain(insertedId);

    const liveMessages = await service.listMessages(fixture.projectA, {
      limit: 50,
      after: encodeAdminCursor({ kind: "sequence", sequence: newestSequence }),
    });
    expect(liveMessages).toMatchObject({ found: true });
    if (!liveMessages.found) throw new Error("expected live messages");
    expect(liveMessages.data.items.map((message) => message.id)).toEqual([insertedId]);
    expect(liveMessages.data.items.every((message) => message.sequence > newestSequence)).toBe(true);
    expect(liveMessages.data.has_more).toBe(false);

    const after = encodeAdminCursor({ kind: "sequence", sequence: 0 });
    const liveFirst = await service.listEvents(fixture.projectA, { limit: 1, after });
    expect(liveFirst).toMatchObject({ found: true });
    if (!liveFirst.found) throw new Error("expected live events");
    expect(liveFirst.data.items).toHaveLength(1);
    expect(liveFirst.data.has_more).toBe(true);
    expect(liveFirst.data.next_cursor).toBeNull();
    const liveSequence = liveFirst.data.items[0]?.sequence ?? 0;
    const liveSecond = await service.listEvents(fixture.projectA, {
      limit: 50,
      after: encodeAdminCursor({ kind: "sequence", sequence: liveSequence }),
    });
    expect(liveSecond).toMatchObject({ found: true });
    if (!liveSecond.found) throw new Error("expected second live events");
    expect(liveSecond.data.items.every((event) => event.sequence > liveSequence)).toBe(true);
    const liveSequences = liveSecond.data.items.map((event) => event.sequence);
    expect(liveSequences).toEqual(liveSequences.toSorted((a, b) => a - b));
  });
});
