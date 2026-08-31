import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import type { PoolClient } from "pg";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { auditEvents, oauthIdentities, users } from "../src/db/schema.js";
import { createIdentityService } from "../src/web-auth/identity-service.js";
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

async function waitForIdentityConflictInsert(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await database.pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE '%insert into "oauth_identities"%'
      ) AS waiting
    `);
    if (result.rows[0]?.waiting) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the GitHub identity conflict insert");
}

async function rollbackAndRelease(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

describe("durable GitHub identities", () => {
  it("converges concurrent callbacks on one local user without orphan rows", async () => {
    const service = createIdentityService({ db: database.db });
    const profile = { id: "42", login: "octocat", name: "Octo Cat", avatarUrl: null };

    const [a, b] = await Promise.all([
      service.upsertGitHub(profile),
      service.upsertGitHub(profile),
    ]);

    expect(a.userId).toBe(b.userId);
    const [identityCount] = await database.db.select({ identities: count() }).from(oauthIdentities);
    const [userCount] = await database.db.select({ localUsers: count() }).from(users);
    expect(identityCount?.identities).toBe(1);
    expect(userCount?.localUsers).toBe(1);
  });

  it("refreshes snapshots after an uncooperative writer wins the identity uniqueness race", async () => {
    const now = new Date("2026-08-31T12:05:00.000Z");
    const service = createIdentityService({ db: database.db, clock: () => now });
    const externalWriter = await database.pool.connect();
    let committed = false;

    try {
      await externalWriter.query("BEGIN");
      const externalUser = await externalWriter.query<{ id: string }>(`
        INSERT INTO users (display_name, avatar_url, created_at, updated_at)
        VALUES ($1, $2, $3, $3)
        RETURNING id
      `, ["Stale Octocat", null, new Date("2026-08-31T12:00:00.000Z")]);
      const externalUserId = externalUser.rows[0]?.id;
      expect(externalUserId).toEqual(expect.any(String));
      await externalWriter.query(`
        INSERT INTO oauth_identities (
          user_id, provider, provider_user_id, login, created_at, updated_at, last_login_at
        ) VALUES ($1, 'github', '42', 'stale-octocat', $2, $2, $2)
      `, [externalUserId, new Date("2026-08-31T12:00:00.000Z")]);

      const profile = {
        id: "42",
        login: "current-octocat",
        name: "Current Octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
      };
      const upsert = service.upsertGitHub(profile);
      await waitForIdentityConflictInsert();
      await externalWriter.query("COMMIT");
      committed = true;

      const result = await upsert;
      expect(result.userId).toBe(externalUserId);
      const [identity] = await database.db.select().from(oauthIdentities).where(and(
        eq(oauthIdentities.provider, "github"),
        eq(oauthIdentities.providerUserId, "42"),
      ));
      const [user] = await database.db.select().from(users).where(eq(users.id, externalUserId!));
      const [identityCount] = await database.db.select({ identities: count() }).from(oauthIdentities);
      const [userCount] = await database.db.select({ localUsers: count() }).from(users);
      const [audit] = await database.db.select().from(auditEvents).where(eq(auditEvents.eventType, "auth.login_succeeded"));
      expect(identity).toMatchObject({
        userId: externalUserId,
        login: "current-octocat",
        updatedAt: now,
        lastLoginAt: now,
      });
      expect(user).toMatchObject({
        id: externalUserId,
        displayName: "Current Octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
        updatedAt: now,
      });
      expect(identityCount?.identities).toBe(1);
      expect(userCount?.localUsers).toBe(1);
      expect(audit).toMatchObject({
        userId: externalUserId,
        eventType: "auth.login_succeeded",
        metadata: { provider: "github" },
      });
      expect(JSON.stringify(audit?.metadata)).not.toContain("current-octocat");
    } finally {
      if (!committed) {
        await rollbackAndRelease(externalWriter);
      } else {
        externalWriter.release();
      }
    }
  });

  it("refreshes mutable snapshots and last-login timestamps while using the login as the display fallback", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    const service = createIdentityService({ db: database.db, clock: () => now });

    const first = await service.upsertGitHub({
      id: "42",
      login: "octocat",
      name: null,
      avatarUrl: null,
    });
    now = new Date("2026-08-31T12:05:00.000Z");
    const second = await service.upsertGitHub({
      id: "42",
      login: "octocat-renamed",
      name: "Octo Cat",
      avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
    });

    expect(second.userId).toBe(first.userId);
    const [identity] = await database.db.select().from(oauthIdentities).where(and(
      eq(oauthIdentities.provider, "github"),
      eq(oauthIdentities.providerUserId, "42"),
    ));
    const [user] = await database.db.select().from(users).where(eq(users.id, first.userId));
    expect(identity).toMatchObject({
      userId: first.userId,
      login: "octocat-renamed",
      lastLoginAt: now,
      updatedAt: now,
    });
    expect(user).toMatchObject({
      id: first.userId,
      displayName: "Octo Cat",
      avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
      updatedAt: now,
    });
  });

  it("writes safe audit metadata for successful identity persistence", async () => {
    const service = createIdentityService({ db: database.db });
    await service.upsertGitHub({ id: "42", login: "octocat", name: null, avatarUrl: null });

    const [success] = await database.db.select().from(auditEvents).where(eq(auditEvents.eventType, "auth.login_succeeded"));
    expect(success).toMatchObject({
      eventType: "auth.login_succeeded",
      metadata: { provider: "github" },
    });
    expect(JSON.stringify(success?.metadata)).not.toContain("octocat");
  });

  it("writes only provider metadata when identity persistence fails", async () => {
    const service = createIdentityService({ db: database.db });
    const unsafeDisplayName = "name-that-must-not-enter-the-audit-event-".repeat(4);

    await expect(service.upsertGitHub({
      id: "42",
      login: "octocat",
      name: unsafeDisplayName,
      avatarUrl: null,
    })).rejects.toThrow();

    const [failure] = await database.db.select().from(auditEvents).where(eq(auditEvents.eventType, "auth.login_failed"));
    expect(failure).toMatchObject({
      userId: null,
      eventType: "auth.login_failed",
      metadata: { provider: "github" },
    });
    expect(JSON.stringify(failure?.metadata)).not.toContain(unsafeDisplayName);
    const [userCount] = await database.db.select({ localUsers: count() }).from(users);
    expect(userCount?.localUsers).toBe(0);
  });
});
