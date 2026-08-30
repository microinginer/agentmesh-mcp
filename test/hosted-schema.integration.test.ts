import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  auditEvents,
  oauthIdentities,
  projects,
  users,
  webSessions,
} from "../src/db/schema.js";
import { createAuditService } from "../src/audit/service.js";
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

describe("hosted control-plane schema", () => {
  it("preserves legacy projects while enforcing durable hosted identities", async () => {
    const legacyId = randomUUID();
    await database.db.insert(projects).values({ id: legacyId, name: "legacy" });
    const [legacy] = await database.db.select().from(projects);
    expect(legacy?.ownerUserId).toBeNull();

    const [user] = await database.db.insert(users).values({
      displayName: "Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    }).returning();
    expect(user).toBeDefined();

    await database.db.insert(oauthIdentities).values({
      userId: user!.id,
      provider: "github",
      providerUserId: "1",
      login: "octocat",
    });
    await expect(database.db.insert(oauthIdentities).values({
      userId: randomUUID(),
      provider: "github",
      providerUserId: "1",
      login: "duplicate",
    })).rejects.toThrow();
  });

  it("stores only session digests in a durable session row", async () => {
    const [user] = await database.db.insert(users).values({ displayName: "Octocat" }).returning();
    const now = new Date("2026-08-31T12:00:00.000Z");
    await database.db.insert(webSessions).values({
      userId: user!.id,
      tokenDigest: Buffer.alloc(32, 1),
      csrfDigest: Buffer.alloc(32, 2),
      authenticatedAt: now,
      lastSeenAt: now,
      idleExpiresAt: now,
      absoluteExpiresAt: now,
    });

    const [stored] = await database.db.select().from(webSessions);
    expect(stored?.tokenDigest).toEqual(Buffer.alloc(32, 1));
    await expect(database.db.insert(webSessions).values({
      userId: user!.id,
      tokenDigest: Buffer.alloc(32, 1),
      csrfDigest: Buffer.alloc(32, 3),
      authenticatedAt: now,
      lastSeenAt: now,
      idleExpiresAt: now,
      absoluteExpiresAt: now,
    })).rejects.toThrow();
  });

  it("persists only allowlisted audit metadata without a project row", async () => {
    const service = createAuditService({
      db: database.db,
      clock: () => new Date("2026-08-31T12:00:00.000Z"),
    });

    await service.record({
      userId: null,
      projectId: randomUUID(),
      eventType: "connection.created",
      metadata: {
        connection_label: "Main Mac",
        token: "must-not-persist",
        nested: { secret: "must-not-persist" },
      } as unknown as import("../src/audit/types.js").AuditMetadata,
    });

    const [event] = await database.db.select().from(auditEvents);
    expect(event).toMatchObject({
      userId: null,
      projectId: expect.any(String),
      eventType: "connection.created",
      metadata: { connection_label: "Main Mac" },
      createdAt: new Date("2026-08-31T12:00:00.000Z"),
    });
    expect(JSON.stringify(event?.metadata)).not.toContain("must-not-persist");
  });

  it("keeps an audit write failure out of the caller path", async () => {
    const failures: unknown[] = [];
    const service = createAuditService({
      db: {
        insert: () => {
          throw new Error("database unavailable");
        },
      } as never,
      onPersistFailure: (failure) => failures.push(failure),
    });

    await expect(service.recordBestEffort({ eventType: "auth.logout" })).resolves.toBeUndefined();

    expect(failures).toEqual([
      { event: "audit.persist_failed", event_type: "auth.logout" },
    ]);
  });
});
