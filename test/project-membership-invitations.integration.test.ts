import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuditService } from "../src/audit/service.js";
import {
  createProjectMembershipService,
  ProjectMembershipError,
} from "../src/control/membership-service.js";
import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  auditEvents,
  oauthIdentities,
  projectInvitations,
  projectMemberships,
  projects,
  users,
} from "../src/db/schema.js";
import { resetDatabase } from "./support/database.js";

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const now = new Date("2026-09-02T12:00:00.000Z");

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

afterAll(async () => {
  await database.pool.end();
});

async function fixture() {
  const [owner, viewerA, viewerB, outsider] = await database.db.insert(users).values([
    { displayName: "Owner", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
    { displayName: "Viewer A", avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4" },
    { displayName: "Viewer B", avatarUrl: null },
    { displayName: "Outsider", avatarUrl: null },
  ]).returning();
  if (owner === undefined || viewerA === undefined || viewerB === undefined || outsider === undefined) {
    throw new Error("user fixture failed");
  }
  await database.db.insert(oauthIdentities).values([
    { userId: owner.id, provider: "github", providerUserId: "1", login: "owner" },
    { userId: viewerA.id, provider: "github", providerUserId: "2", login: "viewer-a" },
    { userId: viewerB.id, provider: "github", providerUserId: "3", login: "viewer-b" },
    { userId: outsider.id, provider: "github", providerUserId: "4", login: "outsider" },
  ]);
  const [project] = await database.db.insert(projects).values({
    ownerUserId: owner.id,
    name: "Shared project",
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (project === undefined) throw new Error("project fixture failed");
  await database.db.insert(projectMemberships).values({
    projectId: project.id,
    userId: owner.id,
    role: "owner",
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
  });
  const service = createProjectMembershipService({
    db: database.db,
    audit: createAuditService({ db: database.db, clock: () => new Date(now) }),
    publicOrigin: new URL("https://agentmesh.example"),
    clock: () => new Date(now),
  });
  return { owner, viewerA, viewerB, outsider, project, service };
}

function rawToken(invitationUrl: string): string {
  return new URL(invitationUrl).pathname.split("/").at(-1) ?? "";
}

describe("project viewer invitations", () => {
  it("creates a seven-day digest-only invitation and lists safe owner metadata", async () => {
    const { owner, viewerA, project, service } = await fixture();
    await database.db.insert(projectMemberships).values({
      projectId: project.id,
      userId: viewerA.id,
      role: "viewer",
      createdBy: owner.id,
      createdAt: new Date("2026-09-02T12:01:00.000Z"),
      updatedAt: new Date("2026-09-02T12:01:00.000Z"),
    });

    const issued = await service.createInvitation({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });
    const token = rawToken(issued.url);

    expect(issued).toMatchObject({
      role: "viewer",
      createdAt: "2026-09-02T12:00:00.000Z",
      expiresAt: "2026-09-09T12:00:00.000Z",
    });
    expect(issued.url).toMatch(/^https:\/\/agentmesh\.example\/invite\/[A-Za-z0-9_-]{43}$/);
    const [stored] = await database.db.select().from(projectInvitations);
    expect(stored?.tokenDigest).toHaveLength(32);
    expect(stored?.tokenDigest.toString("utf8")).not.toContain(token);

    const listed = await service.list({ ownerUserId: owner.id, projectId: project.id });
    expect(listed.members).toEqual([
      expect.objectContaining({ userId: owner.id, role: "owner", githubLogin: "owner" }),
      expect.objectContaining({ userId: viewerA.id, role: "viewer", githubLogin: "viewer-a" }),
    ]);
    expect(listed.invitations).toEqual([
      expect.objectContaining({ id: issued.id, role: "viewer", expiresAt: "2026-09-09T12:00:00.000Z" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain("tokenDigest");
  });

  it("keeps member administration owner-only", async () => {
    const { owner, viewerA, outsider, project, service } = await fixture();
    await database.db.insert(projectMemberships).values({
      projectId: project.id,
      userId: viewerA.id,
      role: "viewer",
      createdBy: owner.id,
    });

    for (const userId of [viewerA.id, outsider.id]) {
      await expect(service.list({ ownerUserId: userId, projectId: project.id }))
        .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      await expect(service.createInvitation({
        ownerUserId: userId,
        projectId: project.id,
        requestId: randomUUID(),
      })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }
  });

  it("captures only canonical active invitation tokens", async () => {
    const { owner, project, service } = await fixture();
    const active = await service.createInvitation({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });
    const token = rawToken(active.url);

    await expect(service.capture(token)).resolves.toBe(true);
    await expect(service.capture(`${token}=`)).resolves.toBe(false);
    await expect(service.capture("not-a-token")).resolves.toBe(false);

    await database.db.update(projectInvitations).set({ revokedAt: now }).where(eq(projectInvitations.id, active.id));
    await expect(service.capture(token)).resolves.toBe(false);
  });

  it("redeems once and creates only a viewer membership", async () => {
    const { owner, viewerA, viewerB, project, service } = await fixture();
    const issued = await service.createInvitation({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });
    const token = rawToken(issued.url);

    await expect(service.redeem({ userId: viewerA.id, rawToken: token, requestId: randomUUID() }))
      .resolves.toEqual({ projectId: project.id });
    expect(await database.db.select().from(projectMemberships).where(and(
      eq(projectMemberships.projectId, project.id),
      eq(projectMemberships.userId, viewerA.id),
    ))).toEqual([expect.objectContaining({ role: "viewer", createdBy: owner.id })]);
    await expect(service.redeem({ userId: viewerB.id, rawToken: token, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" });
  });

  it("does not consume an invitation when the recipient already has access", async () => {
    const { owner, viewerA, project, service } = await fixture();
    await database.db.insert(projectMemberships).values({
      projectId: project.id,
      userId: viewerA.id,
      role: "viewer",
      createdBy: owner.id,
    });
    const issued = await service.createInvitation({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });

    await expect(service.redeem({
      userId: viewerA.id,
      rawToken: rawToken(issued.url),
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
    const [stored] = await database.db.select().from(projectInvitations).where(eq(projectInvitations.id, issued.id));
    expect(stored).toMatchObject({ redeemedBy: null, redeemedAt: null, revokedAt: null });
  });

  it("revokes pending invitations and removes only viewer memberships", async () => {
    const { owner, viewerA, project, service } = await fixture();
    await database.db.insert(projectMemberships).values({
      projectId: project.id,
      userId: viewerA.id,
      role: "viewer",
      createdBy: owner.id,
    });
    const issued = await service.createInvitation({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });

    await service.revokeInvitation({
      ownerUserId: owner.id,
      projectId: project.id,
      invitationId: issued.id,
      requestId: randomUUID(),
    });
    await expect(service.capture(rawToken(issued.url))).resolves.toBe(false);
    await service.removeViewer({
      ownerUserId: owner.id,
      projectId: project.id,
      userId: viewerA.id,
      requestId: randomUUID(),
    });
    await expect(service.removeViewer({
      ownerUserId: owner.id,
      projectId: project.id,
      userId: owner.id,
      requestId: randomUUID(),
    })).rejects.toBeInstanceOf(ProjectMembershipError);
    expect(await database.db.select().from(projectMemberships).where(eq(projectMemberships.projectId, project.id)))
      .toEqual([expect.objectContaining({ userId: owner.id, role: "owner" })]);
  });

  it("allows only one recipient to win a concurrent redemption", async () => {
    const { owner, viewerA, viewerB, project, service } = await fixture();
    const issued = await service.createInvitation({
      ownerUserId: owner.id,
      projectId: project.id,
      requestId: randomUUID(),
    });
    const token = rawToken(issued.url);

    const results = await Promise.allSettled([
      service.redeem({ userId: viewerA.id, rawToken: token, requestId: randomUUID() }),
      service.redeem({ userId: viewerB.id, rawToken: token, requestId: randomUUID() }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await database.db.select().from(projectMemberships).where(eq(projectMemberships.role, "viewer")))
      .toHaveLength(1);
  });

  it("audits lifecycle identifiers without persisting invitation credentials", async () => {
    const { owner, viewerA, project, service } = await fixture();
    const requestId = randomUUID();
    const redeemRequestId = randomUUID();
    const issued = await service.createInvitation({ ownerUserId: owner.id, projectId: project.id, requestId });
    const token = rawToken(issued.url);
    await service.redeem({ userId: viewerA.id, rawToken: token, requestId: redeemRequestId });

    const events = await database.db.select().from(auditEvents).where(eq(auditEvents.projectId, project.id));
    expect(events.map((event) => event.eventType)).toEqual([
      "project.invitation_created",
      "project.invitation_redeemed",
    ]);
    expect(events[0]?.metadata).toEqual({ invitation_id: issued.id, request_id: requestId });
    expect(events[1]?.metadata).toEqual({ invitation_id: issued.id, request_id: redeemRequestId });
    expect(events[1]?.userId).toBe(viewerA.id);
    expect(JSON.stringify(events)).not.toContain(token);
  });
});
