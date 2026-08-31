import { and, count, desc, eq, getTableColumns, lt, or, sql } from "drizzle-orm";

import { decodeAdminCursor, encodeAdminCursor } from "../admin/contracts.js";
import type { AuditService } from "../audit/service.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { projects, users } from "../db/schema.js";

const RECENT_AUTH_WINDOW_MS = 15 * 60 * 1_000;

export type ControlProjectErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_LIMIT_REACHED"
  | "PROJECT_STATE_CONFLICT"
  | "PROJECT_CONFIRMATION_MISMATCH"
  | "RECENT_AUTH_REQUIRED"
  | "CONTROL_UNAVAILABLE";

export class ControlProjectError extends Error {
  readonly code: ControlProjectErrorCode;

  constructor(code: ControlProjectErrorCode) {
    super(code);
    this.name = "ControlProjectError";
    this.code = code;
  }
}

export interface PublicControlProject {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ControlProjectServiceDependencies {
  db: AgentMeshDatabase;
  audit: AuditService;
  projectLimit: number;
  clock?: () => Date;
}

interface CreateProjectInput {
  ownerUserId: string;
  name: string;
  description: string | null;
  idempotencyKey: string;
  requestId: string;
}

interface OwnedProjectInput {
  ownerUserId: string;
  projectId: string;
  requestId: string;
}

interface DeleteProjectInput extends OwnedProjectInput {
  confirmName: string;
  authenticatedAt: Date;
}

type ProjectRow = typeof projects.$inferSelect;

function publicProject(project: ProjectRow): PublicControlProject {
  if (project.status !== "active" && project.status !== "archived") {
    throw new ControlProjectError("CONTROL_UNAVAILABLE");
  }
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function recentAuthentication(now: Date, authenticatedAt: Date): boolean {
  if (!validDate(now) || !validDate(authenticatedAt)) return false;
  const elapsed = now.getTime() - authenticatedAt.getTime();
  return elapsed >= 0 && elapsed <= RECENT_AUTH_WINDOW_MS;
}

export function createControlProjectService(dependencies: ControlProjectServiceDependencies) {
  const { db, audit, projectLimit } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function lockOwner(
    transaction: Parameters<Parameters<AgentMeshDatabase["transaction"]>[0]>[0],
    ownerUserId: string,
  ): Promise<void> {
    const [owner] = await transaction.select({ id: users.id }).from(users)
      .where(eq(users.id, ownerUserId)).limit(1).for("update");
    if (owner === undefined) throw new ControlProjectError("PROJECT_NOT_FOUND");
  }

  async function enforceLimit(
    transaction: Parameters<Parameters<AgentMeshDatabase["transaction"]>[0]>[0],
    ownerUserId: string,
  ): Promise<void> {
    if (projectLimit === 0) return;
    const [active] = await transaction.select({ value: count() }).from(projects).where(and(
      eq(projects.ownerUserId, ownerUserId),
      eq(projects.status, "active"),
    ));
    if ((active?.value ?? 0) >= projectLimit) {
      throw new ControlProjectError("PROJECT_LIMIT_REACHED");
    }
  }

  async function list(input: { ownerUserId: string; limit: number; cursor?: string }) {
    return db.transaction(async (transaction) => {
      const cursor = input.cursor === undefined ? undefined : decodeAdminCursor(input.cursor);
      const createdAt = sql<string>`to_char(${projects.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      const rows = await transaction.select({
        ...getTableColumns(projects),
        cursorCreatedAt: createdAt,
      }).from(projects).where(
        and(
          eq(projects.ownerUserId, input.ownerUserId),
          cursor?.kind === "created"
            ? or(
                lt(createdAt, cursor.created_at),
                and(eq(createdAt, cursor.created_at), lt(projects.id, cursor.id)),
              )
            : undefined,
        ),
      ).orderBy(desc(projects.createdAt), desc(projects.id)).limit(input.limit + 1);
      const [active] = await transaction.select({ value: count() }).from(projects).where(and(
        eq(projects.ownerUserId, input.ownerUserId),
        eq(projects.status, "active"),
      ));
      const [defaultActiveProject] = await transaction.select().from(projects).where(and(
        eq(projects.ownerUserId, input.ownerUserId),
        eq(projects.status, "active"),
      )).orderBy(desc(projects.createdAt), desc(projects.id)).limit(1);
      const page = rows.slice(0, input.limit);
      const finalProject = page.at(-1);
      return {
        projects: page.map(publicProject),
        activeCount: active?.value ?? 0,
        projectLimit,
        defaultProject: defaultActiveProject === undefined ? null : publicProject(defaultActiveProject),
        nextCursor: rows.length > input.limit && finalProject !== undefined
          ? encodeAdminCursor({
              kind: "created",
              created_at: finalProject.cursorCreatedAt,
              id: finalProject.id,
            })
          : null,
      };
    });
  }

  async function get(input: { ownerUserId: string; projectId: string }): Promise<PublicControlProject | null> {
    const [project] = await db.select().from(projects).where(and(
      eq(projects.id, input.projectId),
      eq(projects.ownerUserId, input.ownerUserId),
    )).limit(1);
    return project === undefined ? null : publicProject(project);
  }

  async function create(input: CreateProjectInput): Promise<PublicControlProject> {
    const now = clock();
    if (!validDate(now)) throw new ControlProjectError("CONTROL_UNAVAILABLE");

    return db.transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const [existing] = await transaction.select().from(projects).where(and(
        eq(projects.ownerUserId, input.ownerUserId),
        eq(projects.createIdempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (existing !== undefined) return publicProject(existing);

      await enforceLimit(transaction, input.ownerUserId);
      const [created] = await transaction.insert(projects).values({
        ownerUserId: input.ownerUserId,
        name: input.name,
        description: input.description,
        status: "active",
        createIdempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      }).returning();
      if (created === undefined) throw new ControlProjectError("CONTROL_UNAVAILABLE");
      await audit.record({
        userId: input.ownerUserId,
        projectId: created.id,
        eventType: "project.created",
        metadata: { project_name: created.name },
      }, transaction);
      return publicProject(created);
    });
  }

  async function archive(input: OwnedProjectInput): Promise<PublicControlProject> {
    const now = clock();
    if (!validDate(now)) throw new ControlProjectError("CONTROL_UNAVAILABLE");

    return db.transaction(async (transaction) => {
      const [project] = await transaction.select().from(projects).where(and(
        eq(projects.id, input.projectId),
        eq(projects.ownerUserId, input.ownerUserId),
      )).limit(1).for("update");
      if (project === undefined) throw new ControlProjectError("PROJECT_NOT_FOUND");
      if (project.status !== "active") throw new ControlProjectError("PROJECT_STATE_CONFLICT");

      const [updated] = await transaction.update(projects).set({
        status: "archived",
        archivedAt: now,
        updatedAt: now,
      }).where(and(
        eq(projects.id, input.projectId),
        eq(projects.ownerUserId, input.ownerUserId),
        eq(projects.status, "active"),
      )).returning();
      if (updated === undefined) throw new ControlProjectError("PROJECT_STATE_CONFLICT");
      await audit.record({
        userId: input.ownerUserId,
        projectId: updated.id,
        eventType: "project.archived",
        metadata: { project_name: updated.name },
      }, transaction);
      return publicProject(updated);
    });
  }

  async function restore(input: OwnedProjectInput): Promise<PublicControlProject> {
    const now = clock();
    if (!validDate(now)) throw new ControlProjectError("CONTROL_UNAVAILABLE");

    return db.transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const [project] = await transaction.select().from(projects).where(and(
        eq(projects.id, input.projectId),
        eq(projects.ownerUserId, input.ownerUserId),
      )).limit(1).for("update");
      if (project === undefined) throw new ControlProjectError("PROJECT_NOT_FOUND");
      if (project.status !== "archived") throw new ControlProjectError("PROJECT_STATE_CONFLICT");
      await enforceLimit(transaction, input.ownerUserId);

      const [updated] = await transaction.update(projects).set({
        status: "active",
        archivedAt: null,
        updatedAt: now,
      }).where(and(
        eq(projects.id, input.projectId),
        eq(projects.ownerUserId, input.ownerUserId),
        eq(projects.status, "archived"),
      )).returning();
      if (updated === undefined) throw new ControlProjectError("PROJECT_STATE_CONFLICT");
      await audit.record({
        userId: input.ownerUserId,
        projectId: updated.id,
        eventType: "project.restored",
        metadata: { project_name: updated.name },
      }, transaction);
      return publicProject(updated);
    });
  }

  async function deleteProject(input: DeleteProjectInput): Promise<void> {
    const now = clock();
    if (!recentAuthentication(now, input.authenticatedAt)) {
      throw new ControlProjectError("RECENT_AUTH_REQUIRED");
    }

    await db.transaction(async (transaction) => {
      const [project] = await transaction.select().from(projects).where(and(
        eq(projects.id, input.projectId),
        eq(projects.ownerUserId, input.ownerUserId),
      )).limit(1).for("update");
      if (project === undefined) throw new ControlProjectError("PROJECT_NOT_FOUND");
      if (input.confirmName !== project.name) {
        throw new ControlProjectError("PROJECT_CONFIRMATION_MISMATCH");
      }
      const [deleted] = await transaction.delete(projects).where(and(
        eq(projects.id, input.projectId),
        eq(projects.ownerUserId, input.ownerUserId),
      )).returning({ id: projects.id });
      if (deleted === undefined) throw new ControlProjectError("PROJECT_NOT_FOUND");
      await audit.record({
        userId: input.ownerUserId,
        projectId: project.id,
        eventType: "project.deleted",
        metadata: { project_name: project.name },
      }, transaction);
    });
  }

  return { list, get, create, archive, restore, delete: deleteProject };
}

export type ControlProjectService = ReturnType<typeof createControlProjectService>;
