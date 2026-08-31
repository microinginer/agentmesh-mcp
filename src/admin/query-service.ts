import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { createProjectReadService } from "../control/read-service.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { projects } from "../db/schema.js";
import {
  adminListQuerySchema,
  decodeAdminCursor,
  encodeAdminCursor,
  type AdminListQuery,
  type EventListQuery,
  type MessageListQuery,
} from "./contracts.js";

interface AdminQueryServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
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

/**
 * Compatibility adapter for the emergency admin-token surface.
 * Its message DTOs use operator scope and therefore contain metadata only.
 */
export function createAdminQueryService(dependencies: AdminQueryServiceDependencies) {
  const { db } = dependencies;
  const readService = createProjectReadService(dependencies);
  const operatorScope = { kind: "operator" } as const;

  async function listProjects(input: AdminListQuery) {
    const query = adminListQuerySchema.parse(input);
    const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
    const createdAt = sql<string>`to_char(${projects.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const rows = await db.select({ id: projects.id, name: projects.name, created_at: createdAt })
      .from(projects)
      .where(cursor?.kind === "created"
        ? or(
            lt(createdAt, cursor.created_at),
            and(eq(createdAt, cursor.created_at), lt(projects.id, cursor.id)),
          )
        : undefined)
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(query.limit + 1);
    return createdPage(rows, query.limit);
  }

  const getSummary = (projectId: string) => readService.getOverview(operatorScope, projectId);
  const listAgents = (projectId: string, input: AdminListQuery) =>
    readService.listAgents(operatorScope, projectId, input);
  const listMessages = (projectId: string, input: MessageListQuery) =>
    readService.listMessages(operatorScope, projectId, input);
  const getMessage = (projectId: string, messageId: string) =>
    readService.getMessage(operatorScope, projectId, messageId);
  const listEvents = (projectId: string, input: EventListQuery) =>
    readService.listEvents(operatorScope, projectId, input);

  return { listProjects, getSummary, listAgents, listMessages, getMessage, listEvents };
}

export type AdminQueryService = ReturnType<typeof createAdminQueryService>;
