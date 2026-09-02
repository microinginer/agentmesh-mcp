import { createHash, randomBytes } from "node:crypto";

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";

import type { AuditService } from "../audit/service.js";
import type { AgentMeshDatabase } from "../db/client.js";
import {
  oauthIdentities,
  projectInvitations,
  projectMemberships,
  projects,
  users,
} from "../db/schema.js";

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ProjectMembershipErrorCode =
  | "PROJECT_NOT_FOUND"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_UNAVAILABLE"
  | "MEMBER_NOT_FOUND"
  | "ALREADY_MEMBER"
  | "CONTROL_UNAVAILABLE";

export class ProjectMembershipError extends Error {
  readonly code: ProjectMembershipErrorCode;

  constructor(code: ProjectMembershipErrorCode) {
    super(code);
    this.name = "ProjectMembershipError";
    this.code = code;
  }
}

export interface PublicProjectMember {
  userId: string;
  role: "owner" | "viewer";
  githubLogin: string;
  displayName: string;
  avatarUrl: string | null;
  joinedAt: string;
}

export interface PublicProjectInvitation {
  id: string;
  role: "viewer";
  createdAt: string;
  expiresAt: string;
}

export interface IssuedProjectInvitation extends PublicProjectInvitation {
  url: string;
}

interface ProjectMembershipServiceDependencies {
  db: AgentMeshDatabase;
  audit: AuditService;
  publicOrigin: URL;
  clock?: () => Date;
}

interface OwnerProjectInput {
  ownerUserId: string;
  projectId: string;
}

interface OwnerMutationInput extends OwnerProjectInput {
  requestId: string;
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function digest(rawToken: string): Buffer {
  return createHash("sha256").update(rawToken, "utf8").digest();
}

function databaseCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? databaseCode(error.cause) : undefined;
}

export function createProjectMembershipService(dependencies: ProjectMembershipServiceDependencies) {
  const { db, audit } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function requireOwner(
    executor: Parameters<Parameters<AgentMeshDatabase["transaction"]>[0]>[0] | AgentMeshDatabase,
    input: OwnerProjectInput,
    lock = false,
  ) {
    let query = executor.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, input.projectId),
      eq(projects.ownerUserId, input.ownerUserId),
    )).limit(1);
    const rows = lock ? await query.for("update") : await query;
    if (rows[0] === undefined) throw new ProjectMembershipError("PROJECT_NOT_FOUND");
  }

  async function list(input: OwnerProjectInput): Promise<{
    members: PublicProjectMember[];
    invitations: PublicProjectInvitation[];
  }> {
    const now = clock();
    if (!validDate(now)) throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    try {
      return await db.transaction(async (transaction) => {
        await requireOwner(transaction, input);
        const memberRows = await transaction.select({
          userId: projectMemberships.userId,
          role: projectMemberships.role,
          githubLogin: oauthIdentities.login,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          joinedAt: projectMemberships.createdAt,
        }).from(projectMemberships)
          .innerJoin(users, eq(users.id, projectMemberships.userId))
          .innerJoin(oauthIdentities, and(
            eq(oauthIdentities.userId, users.id),
            eq(oauthIdentities.provider, "github"),
          ))
          .where(eq(projectMemberships.projectId, input.projectId))
          .orderBy(
            asc(sql<number>`CASE WHEN ${projectMemberships.role} = 'owner' THEN 0 ELSE 1 END`),
            asc(projectMemberships.createdAt),
            asc(projectMemberships.userId),
          );
        const invitationRows = await transaction.select({
          id: projectInvitations.id,
          role: projectInvitations.role,
          createdAt: projectInvitations.createdAt,
          expiresAt: projectInvitations.expiresAt,
        }).from(projectInvitations).where(and(
          eq(projectInvitations.projectId, input.projectId),
          isNull(projectInvitations.redeemedAt),
          isNull(projectInvitations.revokedAt),
          gt(projectInvitations.expiresAt, now),
        )).orderBy(asc(projectInvitations.createdAt), asc(projectInvitations.id));
        return {
          members: memberRows.map((row) => {
            if (row.role !== "owner" && row.role !== "viewer") {
              throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
            }
            return {
              userId: row.userId,
              role: row.role,
              githubLogin: row.githubLogin,
              displayName: row.displayName,
              avatarUrl: row.avatarUrl,
              joinedAt: row.joinedAt.toISOString(),
            };
          }),
          invitations: invitationRows.map((row) => {
            if (row.role !== "viewer") throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
            return {
              id: row.id,
              role: row.role,
              createdAt: row.createdAt.toISOString(),
              expiresAt: row.expiresAt.toISOString(),
            };
          }),
        };
      });
    } catch (error) {
      if (error instanceof ProjectMembershipError) throw error;
      throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    }
  }

  async function createInvitation(input: OwnerMutationInput): Promise<IssuedProjectInvitation> {
    const now = clock();
    const expiresAtMillis = now.getTime() + INVITATION_LIFETIME_MS;
    if (!validDate(now) || !Number.isSafeInteger(expiresAtMillis)) {
      throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    }
    const expiresAt = new Date(expiresAtMillis);
    const rawToken = randomBytes(32).toString("base64url");
    try {
      return await db.transaction(async (transaction) => {
        await requireOwner(transaction, input, true);
        const [created] = await transaction.insert(projectInvitations).values({
          projectId: input.projectId,
          role: "viewer",
          tokenDigest: digest(rawToken),
          createdBy: input.ownerUserId,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        }).returning({
          id: projectInvitations.id,
          role: projectInvitations.role,
          createdAt: projectInvitations.createdAt,
          expiresAt: projectInvitations.expiresAt,
        });
        if (created === undefined || created.role !== "viewer") {
          throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
        }
        await audit.record({
          userId: input.ownerUserId,
          projectId: input.projectId,
          requestId: input.requestId,
          eventType: "project.invitation_created",
          metadata: { invitation_id: created.id },
        }, transaction);
        return {
          id: created.id,
          role: created.role,
          createdAt: created.createdAt.toISOString(),
          expiresAt: created.expiresAt.toISOString(),
          url: new URL(`/invite/${rawToken}`, dependencies.publicOrigin).toString(),
        };
      });
    } catch (error) {
      if (error instanceof ProjectMembershipError) throw error;
      throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    }
  }

  async function capture(rawToken: string): Promise<boolean> {
    const now = clock();
    if (!RAW_TOKEN_PATTERN.test(rawToken) || !validDate(now)) return false;
    try {
      const [invitation] = await db.select({ id: projectInvitations.id }).from(projectInvitations).where(and(
        eq(projectInvitations.tokenDigest, digest(rawToken)),
        isNull(projectInvitations.redeemedAt),
        isNull(projectInvitations.revokedAt),
        gt(projectInvitations.expiresAt, now),
      )).limit(1);
      return invitation !== undefined;
    } catch {
      return false;
    }
  }

  async function redeem(input: { userId: string; rawToken: string; requestId: string }): Promise<{ projectId: string }> {
    const now = clock();
    if (!RAW_TOKEN_PATTERN.test(input.rawToken) || !validDate(now)) {
      throw new ProjectMembershipError("INVITATION_UNAVAILABLE");
    }
    try {
      return await db.transaction(async (transaction) => {
        const [invitation] = await transaction.select({
          id: projectInvitations.id,
          projectId: projectInvitations.projectId,
          createdBy: projectInvitations.createdBy,
        }).from(projectInvitations).where(and(
          eq(projectInvitations.tokenDigest, digest(input.rawToken)),
          isNull(projectInvitations.redeemedAt),
          isNull(projectInvitations.revokedAt),
          gt(projectInvitations.expiresAt, now),
        )).limit(1).for("update");
        if (invitation === undefined) throw new ProjectMembershipError("INVITATION_UNAVAILABLE");

        const [existing] = await transaction.select({ id: projectMemberships.id }).from(projectMemberships)
          .where(and(
            eq(projectMemberships.projectId, invitation.projectId),
            eq(projectMemberships.userId, input.userId),
          )).limit(1);
        const [owned] = await transaction.select({ id: projects.id }).from(projects).where(and(
          eq(projects.id, invitation.projectId),
          eq(projects.ownerUserId, input.userId),
        )).limit(1);
        if (existing !== undefined || owned !== undefined) {
          throw new ProjectMembershipError("ALREADY_MEMBER");
        }

        const [claimed] = await transaction.update(projectInvitations).set({
          redeemedBy: input.userId,
          redeemedAt: now,
          updatedAt: now,
        }).where(and(
          eq(projectInvitations.id, invitation.id),
          isNull(projectInvitations.redeemedAt),
          isNull(projectInvitations.revokedAt),
          gt(projectInvitations.expiresAt, now),
        )).returning({ id: projectInvitations.id });
        if (claimed === undefined) throw new ProjectMembershipError("INVITATION_UNAVAILABLE");

        await transaction.insert(projectMemberships).values({
          projectId: invitation.projectId,
          userId: input.userId,
          role: "viewer",
          createdBy: invitation.createdBy,
          createdAt: now,
          updatedAt: now,
        });
        await audit.record({
          userId: input.userId,
          projectId: invitation.projectId,
          requestId: input.requestId,
          eventType: "project.invitation_redeemed",
          metadata: { invitation_id: invitation.id },
        }, transaction);
        return { projectId: invitation.projectId };
      });
    } catch (error) {
      if (error instanceof ProjectMembershipError) throw error;
      if (databaseCode(error) === "23505") throw new ProjectMembershipError("ALREADY_MEMBER");
      throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    }
  }

  async function revokeInvitation(input: OwnerMutationInput & { invitationId: string }): Promise<void> {
    const now = clock();
    if (!validDate(now)) throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    try {
      await db.transaction(async (transaction) => {
        await requireOwner(transaction, input, true);
        const [revoked] = await transaction.update(projectInvitations).set({
          revokedAt: now,
          updatedAt: now,
        }).where(and(
          eq(projectInvitations.id, input.invitationId),
          eq(projectInvitations.projectId, input.projectId),
          isNull(projectInvitations.redeemedAt),
          isNull(projectInvitations.revokedAt),
          gt(projectInvitations.expiresAt, now),
        )).returning({ id: projectInvitations.id });
        if (revoked === undefined) throw new ProjectMembershipError("INVITATION_NOT_FOUND");
        await audit.record({
          userId: input.ownerUserId,
          projectId: input.projectId,
          requestId: input.requestId,
          eventType: "project.invitation_revoked",
          metadata: { invitation_id: input.invitationId },
        }, transaction);
      });
    } catch (error) {
      if (error instanceof ProjectMembershipError) throw error;
      throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    }
  }

  async function removeViewer(input: OwnerMutationInput & { userId: string }): Promise<void> {
    const now = clock();
    if (!validDate(now)) throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    try {
      await db.transaction(async (transaction) => {
        await requireOwner(transaction, input, true);
        const [removed] = await transaction.delete(projectMemberships).where(and(
          eq(projectMemberships.projectId, input.projectId),
          eq(projectMemberships.userId, input.userId),
          eq(projectMemberships.role, "viewer"),
        )).returning({ id: projectMemberships.id });
        if (removed === undefined) throw new ProjectMembershipError("MEMBER_NOT_FOUND");
        await audit.record({
          userId: input.ownerUserId,
          subjectUserId: input.userId,
          projectId: input.projectId,
          requestId: input.requestId,
          eventType: "project.viewer_removed",
        }, transaction);
      });
    } catch (error) {
      if (error instanceof ProjectMembershipError) throw error;
      throw new ProjectMembershipError("CONTROL_UNAVAILABLE");
    }
  }

  return { list, createInvitation, capture, redeem, revokeInvitation, removeViewer };
}
