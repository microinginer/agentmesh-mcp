import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  auditEvents,
  agents,
  oauthIdentities,
  oauthAttempts,
  projectTokens,
  projects,
  users,
  webSessions,
} from "../src/db/schema.js";
import { createAuditService } from "../src/audit/service.js";
import { resetDatabase } from "./support/database.js";
import { createLegacyMigrationFixture } from "./support/legacy-migrations.js";

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
    const [otherUser] = await database.db.insert(users).values({
      displayName: "Hubot",
    }).returning();
    await expect(database.db.insert(oauthIdentities).values({
      userId: otherUser!.id,
      provider: "github",
      providerUserId: "1",
      login: "duplicate",
    })).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint: "oauth_identities_provider_user_unique",
      },
    });
  });

  it("backfills legacy connection labels while preserving owner and agent provenance nulls", async () => {
    const fixture = await createLegacyMigrationFixture(databaseUrl);
    const projectId = randomUUID();
    const tokenId = randomUUID();
    const agentId = randomUUID();

    try {
      await fixture.database.pool.query(
        "INSERT INTO projects (id, name) VALUES ($1, $2)",
        [projectId, "legacy"],
      );
      await fixture.database.pool.query(
        "INSERT INTO project_tokens (id, project_id, token_digest) VALUES ($1, $2, $3)",
        [tokenId, projectId, Buffer.alloc(32, 1)],
      );
      await fixture.database.pool.query(
        `INSERT INTO agents (
           id, project_id, registration_digest, name, client, capabilities
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [agentId, projectId, Buffer.alloc(32, 2), "legacy-agent", "codex", []],
      );

      await fixture.migrateHosted();

      const [project] = await fixture.database.db.select().from(projects);
      const [token] = await fixture.database.db.select().from(projectTokens);
      const [agent] = await fixture.database.db.select().from(agents);
      expect(project?.ownerUserId).toBeNull();
      expect(token).toMatchObject({
        id: tokenId,
        label: "Legacy CLI token",
        createdByUserId: null,
      });
      expect(agent).toMatchObject({
        id: agentId,
        registeredViaTokenId: null,
      });
    } finally {
      await fixture.destroy();
    }
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

  it("stores only a fixed-length OAuth attempt digest and lifecycle timestamps", async () => {
    const rawCookie = "v1.this-is-sealed-state-and-verifier-material";
    const digest = Buffer.alloc(32, 9);
    const now = new Date("2026-08-31T12:00:00.000Z");
    await database.db.insert(oauthAttempts).values({
      attemptDigest: digest,
      expiresAt: new Date("2026-08-31T12:05:00.000Z"),
      createdAt: now,
    });

    const [stored] = await database.db.select().from(oauthAttempts);
    expect(stored).toEqual({
      attemptDigest: digest,
      expiresAt: new Date("2026-08-31T12:05:00.000Z"),
      consumedAt: null,
      createdAt: now,
    });
    expect(JSON.stringify(stored)).not.toContain(rawCookie);
    await expect(database.db.insert(oauthAttempts).values({
      attemptDigest: digest,
      expiresAt: now,
      createdAt: now,
    })).rejects.toThrow();
    await expect(database.db.insert(oauthAttempts).values({
      attemptDigest: Buffer.alloc(31, 9),
      expiresAt: now,
      createdAt: now,
    })).rejects.toMatchObject({
      cause: { constraint: "oauth_attempts_digest_length_check" },
    });
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

  it("derives reserved actor, subject, and bounded request metadata instead of trusting caller metadata", async () => {
    const [actor, subject] = await database.db.insert(users).values([
      { displayName: "Audit actor" },
      { displayName: "Audit subject" },
    ]).returning();
    if (actor === undefined || subject === undefined) throw new Error("audit users insert failed");
    const requestId = "req-operator-123";
    const plantedSecret = "must-not-persist-reserved-spoof";
    const service = createAuditService({
      db: database.db,
      clock: () => new Date("2026-08-31T12:00:00.000Z"),
    });

    await service.record({
      subjectUserId: subject.id,
      actor: { kind: "user", userId: actor.id },
      requestId,
      eventType: "operator.user_blocked",
      metadata: {
        project_name: "Safe project",
        actor_kind: "headless_cli",
        actor_user_id: plantedSecret,
        subject_user_id: plantedSecret,
        request_id: plantedSecret,
        token: plantedSecret,
      } as unknown as import("../src/audit/types.js").AuditMetadata,
    });
    await service.record({
      actor: { kind: "headless_cli" },
      requestId: `unsafe ${plantedSecret} ${"x".repeat(160)}`,
      eventType: "operator.project_owner_assigned",
    });

    const events = await database.db.select().from(auditEvents);
    expect(events).toEqual([
      expect.objectContaining({
        userId: subject.id,
        eventType: "operator.user_blocked",
        metadata: {
          project_name: "Safe project",
          actor_kind: "user",
          actor_user_id: actor.id,
          subject_user_id: subject.id,
          request_id: requestId,
        },
      }),
      expect.objectContaining({
        userId: null,
        eventType: "operator.project_owner_assigned",
        metadata: { actor_kind: "headless_cli" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(plantedSecret);
  });

  it("fails closed for explicitly malformed structured audit attribution while preserving legacy calls", async () => {
    const service = createAuditService({ db: database.db });
    await expect(service.record({
      actor: { kind: "user", userId: "not-a-uuid" },
      eventType: "operator.user_blocked",
    })).rejects.toThrow("Invalid audit attribution");
    await expect(service.record({
      subjectUserId: "not-a-uuid",
      eventType: "operator.user_blocked",
    })).rejects.toThrow("Invalid audit attribution");
    expect(await database.db.select().from(auditEvents)).toHaveLength(0);

    await service.record({
      userId: null,
      eventType: "auth.login_failed",
      metadata: { provider: "github" },
    });
    expect(await database.db.select().from(auditEvents)).toEqual([
      expect.objectContaining({
        userId: null,
        eventType: "auth.login_failed",
        metadata: { provider: "github" },
      }),
    ]);
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

  it("upgrades a legacy database idempotently with the additive owner-assignment audit event", async () => {
    const fixture = await createLegacyMigrationFixture(databaseUrl);
    try {
      const projectId = randomUUID();
      await fixture.database.pool.query(
        "INSERT INTO projects (id, name) VALUES ($1, $2)",
        [projectId, "legacy-assignment-target"],
      );

      await fixture.migrateHosted();
      await fixture.migrateHosted();

      const service = createAuditService({
        db: fixture.database.db,
        clock: () => new Date("2026-08-31T12:00:00.000Z"),
      });
      await service.record({
        projectId,
        eventType: "operator.project_owner_assigned",
        metadata: { project_name: "legacy-assignment-target" },
      });
      const [event] = await fixture.database.db.select().from(auditEvents).where(
        eq(auditEvents.eventType, "operator.project_owner_assigned"),
      );
      expect(event).toMatchObject({
        projectId,
        eventType: "operator.project_owner_assigned",
        metadata: { project_name: "legacy-assignment-target" },
      });
    } finally {
      await fixture.destroy();
    }
  });
});
