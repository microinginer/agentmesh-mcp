import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";

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
