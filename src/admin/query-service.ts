import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { createProjectReadService } from "../control/read-service.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { agents, messages, projects } from "../db/schema.js";
import {
  adminListQuerySchema,
  decodeAdminCursor,
  encodeAdminCursor,
  messageListQuerySchema,
  type AdminListQuery,
  type EventListQuery,
  type MessageListQuery,
} from "./contracts.js";

interface AdminQueryServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
}

export function previewMessage(text: string): string {
  const points = [...text];
  return points.length <= 160 ? text : `${points.slice(0, 160).join("")}…`;
}

function sequenceHistoryPage<T extends { sequence: number }>(items: T[], limit: number) {
  const page = items.slice(0, limit);
  const finalItem = page.at(-1);
  return {
    items: page,
    next_cursor: items.length > limit && finalItem !== undefined
      ? encodeAdminCursor({ kind: "sequence", sequence: finalItem.sequence })
      : null,
    has_more: false,
  };
}

function liveSequencePage<T>(items: T[], limit: number) {
  return {
    items: items.slice(0, limit),
    next_cursor: null,
    has_more: items.length > limit,
  };
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
 * The legacy admin keeps its original content-bearing message inspection queries;
 * the authenticated operator surface remains metadata-only in ProjectReadService.
 */
export function createAdminQueryService(dependencies: AdminQueryServiceDependencies) {
  const { db } = dependencies;
  const readService = createProjectReadService(dependencies);
  const operatorScope = { kind: "operator" } as const;

  async function projectExists(projectId: string): Promise<boolean> {
    const [project] = await db.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, projectId)).limit(1);
    return project !== undefined;
  }

  async function projectAgentExists(projectId: string, agentId: string): Promise<boolean> {
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.id, agentId))).limit(1);
    return agent !== undefined;
  }

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
  async function listMessages(projectId: string, input: MessageListQuery) {
    const query = messageListQuerySchema.parse(input);
    if (!(await projectExists(projectId))) return { found: false as const };
    if (query.agent_id !== undefined && !(await projectAgentExists(projectId, query.agent_id))) {
      return { found: false as const };
    }
    const sender = alias(agents, "admin_message_sender");
    const recipient = alias(agents, "admin_message_recipient");
    const cursorValue = query.cursor ?? query.after;
    const cursor = cursorValue === undefined ? undefined : decodeAdminCursor(cursorValue);
    const filters: SQL[] = [eq(messages.projectId, projectId)];
    if (query.agent_id !== undefined) {
      const agentFilter = or(
        eq(messages.senderAgentId, query.agent_id),
        eq(messages.recipientAgentId, query.agent_id),
      );
      if (agentFilter !== undefined) filters.push(agentFilter);
    }
    if (query.acknowledged === true) filters.push(isNotNull(messages.acknowledgedAt));
    if (query.acknowledged === false) filters.push(isNull(messages.acknowledgedAt));
    if (cursor?.kind === "sequence") {
      filters.push(query.after === undefined
        ? lt(messages.sequence, cursor.sequence)
        : gt(messages.sequence, cursor.sequence));
    }
    const rows = await db.select({
      sequence: messages.sequence,
      id: messages.id,
      sender_id: sender.id,
      sender_name: sender.name,
      recipient_id: recipient.id,
      recipient_name: recipient.name,
      text: messages.text,
      created_at: messages.createdAt,
      acknowledged_at: messages.acknowledgedAt,
    }).from(messages)
      .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, projectId)))
      .innerJoin(recipient, and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, projectId)))
      .where(and(...filters))
      .orderBy(query.after === undefined ? desc(messages.sequence) : asc(messages.sequence))
      .limit(query.limit + 1);
    const mapped = rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      sender: { id: row.sender_id, name: row.sender_name },
      recipient: { id: row.recipient_id, name: row.recipient_name },
      preview: previewMessage(row.text),
      created_at: row.created_at.toISOString(),
      acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
    }));
    return {
      found: true as const,
      data: query.after === undefined
        ? sequenceHistoryPage(mapped, query.limit)
        : liveSequencePage(mapped, query.limit),
    };
  }

  async function getMessage(projectId: string, messageId: string) {
    if (!(await projectExists(projectId))) return { found: false as const };
    const sender = alias(agents, "admin_message_detail_sender");
    const recipient = alias(agents, "admin_message_detail_recipient");
    const [row] = await db.select({
      sequence: messages.sequence,
      id: messages.id,
      sender_id: sender.id,
      sender_name: sender.name,
      recipient_id: recipient.id,
      recipient_name: recipient.name,
      text: messages.text,
      created_at: messages.createdAt,
      acknowledged_at: messages.acknowledgedAt,
    }).from(messages)
      .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, projectId)))
      .innerJoin(recipient, and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, projectId)))
      .where(and(eq(messages.projectId, projectId), eq(messages.id, messageId)))
      .limit(1);
    if (row === undefined) return { found: false as const };
    return {
      found: true as const,
      data: {
        sequence: row.sequence,
        id: row.id,
        sender: { id: row.sender_id, name: row.sender_name },
        recipient: { id: row.recipient_id, name: row.recipient_name },
        preview: previewMessage(row.text),
        text: row.text,
        created_at: row.created_at.toISOString(),
        acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
      },
    };
  }
  const listEvents = (projectId: string, input: EventListQuery) =>
    readService.listEvents(operatorScope, projectId, input);

  return { listProjects, getSummary, listAgents, listMessages, getMessage, listEvents };
}

export type AdminQueryService = ReturnType<typeof createAdminQueryService>;
