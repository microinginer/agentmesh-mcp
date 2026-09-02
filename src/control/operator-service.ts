import { and, count, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import {
  adminListQuerySchema,
  decodeAdminCursor,
  encodeAdminCursor,
  type AdminListQuery,
} from "../admin/contracts.js";
import type { AuditService } from "../audit/service.js";
import { uuidV4Schema } from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import {
  agents,
  messages,
  oauthIdentities,
  projectMemberships,
  projectTokens,
  projects,
  users,
  webSessions,
} from "../db/schema.js";

const GITHUB_PROVIDER = "github";
const GITHUB_ID_PATTERN = /^[1-9]\d{0,63}$/;

export type OperatorControlErrorCode =
  | "INVALID_REQUEST"
  | "USER_NOT_FOUND"
  | "USER_BLOCKED"
  | "USER_STATE_CONFLICT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_STATE_CONFLICT"
  | "PROJECT_LIMIT_REACHED"
  | "CONTROL_UNAVAILABLE";

export class OperatorControlError extends Error {
  readonly code: OperatorControlErrorCode;

  constructor(code: OperatorControlErrorCode) {
    super(code);
    this.name = "OperatorControlError";
    this.code = code;
  }
}

interface OperatorServiceDependencies {
  db: AgentMeshDatabase;
  audit: AuditService;
  projectLimit: number;
  clock?: () => Date;
}

interface UserMutationInput {
  operatorUserId: string;
  targetUserId: string;
  requestId: string;
}

interface ProjectMutationInput {
  operatorUserId: string;
  projectId: string;
  requestId: string;
}

interface AssignOwnerInput {
  projectId: string;
  githubUserId: string;
  requestId: string;
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function validUuid(value: string): boolean {
  return uuidV4Schema.safeParse(value).success;
}

function createdPage<T extends { created_at: string; id: string }>(items: T[], limit: number) {
  const page = items.slice(0, limit);
  const finalItem = page.at(-1);
  return {
    items: page,
    next_cursor: items.length > limit && finalItem !== undefined
      ? encodeAdminCursor({ kind: "created", created_at: finalItem.created_at, id: finalItem.id })
      : null,
  };
}

function publicUser(row: {
  id: string;
  github_user_id: string;
  github_login: string;
  display_name: string;
  avatar_url: string | null;
  blocked_at: Date | null;
  created_at: string;
  updated_at: Date;
  project_count: number;
  active_project_count: number;
}) {
  return {
    ...row,
    blocked_at: row.blocked_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  };
}

function publicProject(row: {
  id: string;
  name: string;
  status: string;
  archived_at: Date | null;
  created_at: string;
  updated_at: Date;
  owner_user_id: string | null;
  owner_github_user_id: string | null;
  owner_github_login: string | null;
  owner_display_name: string | null;
  agent_count: number;
  message_count: number;
  connection_count: number;
}) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at.toISOString(),
    owner: row.owner_user_id === null ? null : {
      id: row.owner_user_id,
      github_user_id: row.owner_github_user_id,
      github_login: row.owner_github_login,
      display_name: row.owner_display_name,
    },
    counts: {
      agents: row.agent_count,
      messages: row.message_count,
      connections: row.connection_count,
    },
  };
}

function mutationUser(row: {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  blockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  githubUserId: string;
  githubLogin: string;
}) {
  return {
    id: row.id,
    github_user_id: row.githubUserId,
    github_login: row.githubLogin,
    display_name: row.displayName,
    avatar_url: row.avatarUrl,
    blocked_at: row.blockedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function createOperatorService(dependencies: OperatorServiceDependencies) {
  const { db, audit, projectLimit } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  const userProjectCount = sql<number>`(
    select count(*)::integer from ${projects}
    where ${projects.ownerUserId} = ${users.id}
  )`;
  const userActiveProjectCount = sql<number>`(
    select count(*)::integer from ${projects}
    where ${projects.ownerUserId} = ${users.id} and ${projects.status} = 'active'
  )`;

  const safeUserSelection = {
    id: users.id,
    github_user_id: oauthIdentities.providerUserId,
    github_login: oauthIdentities.login,
    display_name: users.displayName,
    avatar_url: users.avatarUrl,
    blocked_at: users.blockedAt,
    created_at: sql<string>`to_char(${users.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    updated_at: users.updatedAt,
    project_count: userProjectCount,
    active_project_count: userActiveProjectCount,
  };

  function userQuery() {
    return db.select(safeUserSelection).from(users).innerJoin(oauthIdentities, and(
      eq(oauthIdentities.userId, users.id),
      eq(oauthIdentities.provider, GITHUB_PROVIDER),
    ));
  }

  async function listUsers(input: AdminListQuery) {
    const query = adminListQuerySchema.parse(input);
    const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
    const createdAt = safeUserSelection.created_at;
    const rows = await userQuery().where(cursor?.kind === "created"
      ? or(
          lt(createdAt, cursor.created_at),
          and(eq(createdAt, cursor.created_at), lt(users.id, cursor.id)),
        )
      : undefined)
      .orderBy(desc(users.createdAt), desc(users.id)).limit(query.limit + 1);
    return createdPage(rows.map(publicUser), query.limit);
  }

  async function getUser(userId: string) {
    if (!validUuid(userId)) return { found: false as const };
    const [row] = await userQuery().where(eq(users.id, userId)).limit(1);
    return row === undefined
      ? { found: false as const }
      : { found: true as const, data: publicUser(row) };
  }

  const ownerIdentity = oauthIdentities;
  const projectAgentCount = sql<number>`(
    select count(*)::integer from ${agents}
    where ${agents.projectId} = ${projects.id}
  )`;
  const projectMessageCount = sql<number>`(
    select count(*)::integer from ${messages}
    where ${messages.projectId} = ${projects.id}
  )`;
  const projectConnectionCount = sql<number>`(
    select count(*)::integer from ${projectTokens}
    where ${projectTokens.projectId} = ${projects.id}
  )`;

  const safeProjectSelection = {
    id: projects.id,
    name: projects.name,
    status: projects.status,
    archived_at: projects.archivedAt,
    created_at: sql<string>`to_char(${projects.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    updated_at: projects.updatedAt,
    owner_user_id: users.id,
    owner_github_user_id: ownerIdentity.providerUserId,
    owner_github_login: ownerIdentity.login,
    owner_display_name: users.displayName,
    agent_count: projectAgentCount,
    message_count: projectMessageCount,
    connection_count: projectConnectionCount,
  };

  function projectQuery() {
    return db.select(safeProjectSelection).from(projects)
      .leftJoin(users, eq(users.id, projects.ownerUserId))
      .leftJoin(ownerIdentity, and(
        eq(ownerIdentity.userId, users.id),
        eq(ownerIdentity.provider, GITHUB_PROVIDER),
      ));
  }

  async function listProjects(input: AdminListQuery) {
    const query = adminListQuerySchema.parse(input);
    const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
    const createdAt = safeProjectSelection.created_at;
    const rows = await projectQuery().where(cursor?.kind === "created"
      ? or(
          lt(createdAt, cursor.created_at),
          and(eq(createdAt, cursor.created_at), lt(projects.id, cursor.id)),
        )
      : undefined)
      .orderBy(desc(projects.createdAt), desc(projects.id)).limit(query.limit + 1);
    return createdPage(rows.map(publicProject), query.limit);
  }

  async function getProject(projectId: string) {
    if (!validUuid(projectId)) return { found: false as const };
    const [row] = await projectQuery().where(eq(projects.id, projectId)).limit(1);
    return row === undefined
      ? { found: false as const }
      : { found: true as const, data: publicProject(row) };
  }

  async function loadMutationUser(
    transaction: Parameters<Parameters<AgentMeshDatabase["transaction"]>[0]>[0],
    userId: string,
  ) {
    const [row] = await transaction.select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      blockedAt: users.blockedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      githubUserId: oauthIdentities.providerUserId,
      githubLogin: oauthIdentities.login,
    }).from(users).innerJoin(oauthIdentities, and(
      eq(oauthIdentities.userId, users.id),
      eq(oauthIdentities.provider, GITHUB_PROVIDER),
    )).where(eq(users.id, userId)).limit(1).for("update", { of: users });
    return row;
  }

  async function blockUser(input: UserMutationInput) {
    if (!validUuid(input.operatorUserId) || !validUuid(input.targetUserId)) {
      throw new OperatorControlError("INVALID_REQUEST");
    }
    if (input.operatorUserId === input.targetUserId) {
      throw new OperatorControlError("USER_STATE_CONFLICT");
    }
    const now = clock();
    if (!validDate(now)) throw new OperatorControlError("CONTROL_UNAVAILABLE");
    return db.transaction(async (transaction) => {
      const current = await loadMutationUser(transaction, input.targetUserId);
      if (current === undefined) throw new OperatorControlError("USER_NOT_FOUND");
      if (current.blockedAt !== null) throw new OperatorControlError("USER_STATE_CONFLICT");
      const [updated] = await transaction.update(users).set({ blockedAt: now, updatedAt: now }).where(and(
        eq(users.id, input.targetUserId),
        isNull(users.blockedAt),
      )).returning({ blockedAt: users.blockedAt, updatedAt: users.updatedAt });
      if (updated === undefined) throw new OperatorControlError("USER_STATE_CONFLICT");
      await transaction.update(webSessions).set({ revokedAt: now }).where(and(
        eq(webSessions.userId, input.targetUserId),
        isNull(webSessions.revokedAt),
      ));
      await audit.record({
        subjectUserId: input.targetUserId,
        actor: { kind: "user", userId: input.operatorUserId },
        requestId: input.requestId,
        eventType: "operator.user_blocked",
      }, transaction);
      return mutationUser({ ...current, ...updated });
    });
  }

  async function unblockUser(input: UserMutationInput) {
    if (!validUuid(input.operatorUserId) || !validUuid(input.targetUserId)) {
      throw new OperatorControlError("INVALID_REQUEST");
    }
    const now = clock();
    if (!validDate(now)) throw new OperatorControlError("CONTROL_UNAVAILABLE");
    return db.transaction(async (transaction) => {
      const current = await loadMutationUser(transaction, input.targetUserId);
      if (current === undefined) throw new OperatorControlError("USER_NOT_FOUND");
      if (current.blockedAt === null) throw new OperatorControlError("USER_STATE_CONFLICT");
      const [updated] = await transaction.update(users).set({ blockedAt: null, updatedAt: now }).where(and(
        eq(users.id, input.targetUserId),
        isNotNull(users.blockedAt),
      )).returning({ blockedAt: users.blockedAt, updatedAt: users.updatedAt });
      if (updated === undefined) throw new OperatorControlError("USER_STATE_CONFLICT");
      await audit.record({
        subjectUserId: input.targetUserId,
        actor: { kind: "user", userId: input.operatorUserId },
        requestId: input.requestId,
        eventType: "operator.user_unblocked",
      }, transaction);
      return mutationUser({ ...current, ...updated });
    });
  }

  async function archiveProject(input: ProjectMutationInput) {
    if (!validUuid(input.operatorUserId) || !validUuid(input.projectId)) {
      throw new OperatorControlError("INVALID_REQUEST");
    }
    const now = clock();
    if (!validDate(now)) throw new OperatorControlError("CONTROL_UNAVAILABLE");
    return db.transaction(async (transaction) => {
      const [project] = await transaction.select({
        id: projects.id,
        ownerUserId: projects.ownerUserId,
        name: projects.name,
        status: projects.status,
      }).from(projects).where(eq(projects.id, input.projectId)).limit(1).for("update");
      if (project === undefined) throw new OperatorControlError("PROJECT_NOT_FOUND");
      if (project.status !== "active") throw new OperatorControlError("PROJECT_STATE_CONFLICT");
      const [updated] = await transaction.update(projects).set({
        status: "archived",
        archivedAt: now,
        updatedAt: now,
      }).where(and(eq(projects.id, input.projectId), eq(projects.status, "active")))
        .returning({
          id: projects.id,
          status: projects.status,
          archivedAt: projects.archivedAt,
          updatedAt: projects.updatedAt,
        });
      if (updated === undefined) throw new OperatorControlError("PROJECT_STATE_CONFLICT");
      await audit.record({
        subjectUserId: project.ownerUserId,
        actor: { kind: "user", userId: input.operatorUserId },
        requestId: input.requestId,
        projectId: project.id,
        eventType: "operator.project_archived",
        metadata: { project_name: project.name },
      }, transaction);
      return {
        id: updated.id,
        status: updated.status,
        archived_at: updated.archivedAt?.toISOString() ?? null,
        updated_at: updated.updatedAt.toISOString(),
      };
    });
  }

  async function assignOwner(input: AssignOwnerInput) {
    if (!validUuid(input.projectId) || !GITHUB_ID_PATTERN.test(input.githubUserId)) {
      throw new OperatorControlError("INVALID_REQUEST");
    }
    const [preflight] = await db.select({ ownerUserId: projects.ownerUserId }).from(projects)
      .where(eq(projects.id, input.projectId)).limit(1);
    if (preflight === undefined || preflight.ownerUserId !== null) {
      throw new OperatorControlError("PROJECT_NOT_FOUND");
    }
    const now = clock();
    if (!validDate(now)) throw new OperatorControlError("CONTROL_UNAVAILABLE");
    return db.transaction(async (transaction) => {
      const [destination] = await transaction.select({
        id: users.id,
        blockedAt: users.blockedAt,
      }).from(users).innerJoin(oauthIdentities, and(
        eq(oauthIdentities.userId, users.id),
        eq(oauthIdentities.provider, GITHUB_PROVIDER),
        eq(oauthIdentities.providerUserId, input.githubUserId),
      )).limit(1).for("update", { of: users });
      if (destination === undefined) throw new OperatorControlError("USER_NOT_FOUND");
      if (destination.blockedAt !== null) throw new OperatorControlError("USER_BLOCKED");

      const [stillOwnerless] = await transaction.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.id, input.projectId), isNull(projects.ownerUserId)))
        .limit(1);
      if (stillOwnerless === undefined) throw new OperatorControlError("PROJECT_NOT_FOUND");

      const [project] = await transaction.select({
        id: projects.id,
        name: projects.name,
        ownerUserId: projects.ownerUserId,
        status: projects.status,
      }).from(projects).where(eq(projects.id, input.projectId)).limit(1).for("update");
      if (project === undefined || project.ownerUserId !== null) {
        throw new OperatorControlError("PROJECT_NOT_FOUND");
      }
      if (project.status === "active" && projectLimit !== 0) {
        const [active] = await transaction.select({ value: count() }).from(projects).where(and(
          eq(projects.ownerUserId, destination.id),
          eq(projects.status, "active"),
        ));
        if ((active?.value ?? 0) >= projectLimit) {
          throw new OperatorControlError("PROJECT_LIMIT_REACHED");
        }
      }
      const [assigned] = await transaction.update(projects).set({
        ownerUserId: destination.id,
        updatedAt: now,
      }).where(and(eq(projects.id, project.id), isNull(projects.ownerUserId)))
        .returning({ id: projects.id, ownerUserId: projects.ownerUserId });
      if (assigned === undefined || assigned.ownerUserId === null) {
        throw new OperatorControlError("PROJECT_NOT_FOUND");
      }
      await transaction.insert(projectMemberships).values({
        projectId: assigned.id,
        userId: assigned.ownerUserId,
        role: "owner",
        createdBy: assigned.ownerUserId,
        createdAt: now,
        updatedAt: now,
      });
      await audit.record({
        subjectUserId: destination.id,
        actor: { kind: "headless_cli" },
        requestId: input.requestId,
        projectId: project.id,
        eventType: "operator.project_owner_assigned",
        metadata: { project_name: project.name },
      }, transaction);
      return {
        projectId: assigned.id,
        ownerUserId: assigned.ownerUserId,
        githubUserId: input.githubUserId,
      };
    });
  }

  return {
    listUsers,
    getUser,
    listProjects,
    getProject,
    blockUser,
    unblockUser,
    archiveProject,
    assignOwner,
  };
}

export type OperatorService = ReturnType<typeof createOperatorService>;
