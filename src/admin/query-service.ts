import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ActivityMetadata } from "../activity/types.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { activityEvents, agents, messages, projects } from "../db/schema.js";
import {
  adminListQuerySchema,
  decodeAdminCursor,
  encodeAdminCursor,
  eventListQuerySchema,
  messageListQuerySchema,
  type AdminListQuery,
  type EventListQuery,
  type MessageListQuery,
} from "./contracts.js";

const ONLINE_WINDOW_MS = 5 * 60 * 1_000;
const IDLE_WINDOW_MS = 30 * 60 * 1_000;

interface AdminQueryServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
}

type Presence = "online" | "idle" | "offline";

function presenceAt(lastSeenAt: Date, now: Date): Presence {
  const elapsed = now.getTime() - lastSeenAt.getTime();
  if (elapsed <= ONLINE_WINDOW_MS) return "online";
  if (elapsed <= IDLE_WINDOW_MS) return "idle";
  return "offline";
}

export function previewMessage(text: string): string {
  const points = [...text];
  return points.length <= 160 ? text : `${points.slice(0, 160).join("")}…`;
}

function createdPage<T extends { created_at: string; id: string }>(items: T[], limit: number) {
  const page = items.slice(0, limit);
  const finalItem = page.at(-1);
  return {
    items: page,
    next_cursor:
      items.length > limit && finalItem !== undefined
        ? encodeAdminCursor({
            kind: "created",
            created_at: finalItem.created_at,
            id: finalItem.id,
          })
        : null,
  };
}

function sequenceHistoryPage<T extends { sequence: number }>(items: T[], limit: number) {
  const page = items.slice(0, limit);
  const finalItem = page.at(-1);
  return {
    items: page,
    next_cursor:
      items.length > limit && finalItem !== undefined
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

export function createAdminQueryService(dependencies: AdminQueryServiceDependencies) {
  const { db } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function projectExists(projectId: string): Promise<boolean> {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return project !== undefined;
  }

  async function listProjects(input: AdminListQuery) {
    const query = adminListQuerySchema.parse(input);
    const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
    const rows = await db
      .select({ id: projects.id, name: projects.name, created_at: projects.createdAt })
      .from(projects)
      .where(
        cursor?.kind === "created"
          ? or(
              lt(projects.createdAt, new Date(cursor.created_at)),
              and(eq(projects.createdAt, new Date(cursor.created_at)), lt(projects.id, cursor.id)),
            )
          : undefined,
      )
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(query.limit + 1);
    return createdPage(
      rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
      query.limit,
    );
  }

  async function getSummary(projectId: string) {
    const [project] = await db
      .select({ id: projects.id, name: projects.name, created_at: projects.createdAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project === undefined) return { found: false as const };

    const now = clock();
    const [projectAgents, projectMessages, failures] = await Promise.all([
      db
        .select({ last_seen_at: agents.lastSeenAt })
        .from(agents)
        .where(eq(agents.projectId, projectId)),
      db
        .select({ acknowledged_at: messages.acknowledgedAt })
        .from(messages)
        .where(eq(messages.projectId, projectId)),
      db
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.projectId, projectId),
            eq(activityEvents.outcome, "failure"),
            gte(activityEvents.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1_000)),
          ),
        ),
    ]);
    const presence = { online: 0, idle: 0, offline: 0, total: projectAgents.length };
    for (const agent of projectAgents) presence[presenceAt(agent.last_seen_at, now)] += 1;

    return {
      found: true as const,
      data: {
        project: { ...project, created_at: project.created_at.toISOString() },
        agents: presence,
        messages: {
          total: projectMessages.length,
          unacknowledged: projectMessages.filter((message) => message.acknowledged_at === null)
            .length,
        },
        failures_last_24h: failures.length,
      },
    };
  }

  async function listAgents(projectId: string, input: AdminListQuery) {
    const query = adminListQuerySchema.parse(input);
    if (!(await projectExists(projectId))) return { found: false as const };
    const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        client: agents.client,
        capabilities: agents.capabilities,
        last_seen_at: agents.lastSeenAt,
        created_at: agents.createdAt,
      })
      .from(agents)
      .where(
        and(
          eq(agents.projectId, projectId),
          cursor?.kind === "created"
            ? or(
                lt(agents.createdAt, new Date(cursor.created_at)),
                and(eq(agents.createdAt, new Date(cursor.created_at)), lt(agents.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(query.limit + 1);
    const now = clock();
    return {
      found: true as const,
      data: createdPage(
        rows.map((row) => ({
          ...row,
          status: presenceAt(row.last_seen_at, now),
          last_seen_at: row.last_seen_at.toISOString(),
          created_at: row.created_at.toISOString(),
        })),
        query.limit,
      ),
    };
  }

  async function listMessages(projectId: string, input: MessageListQuery) {
    const query = messageListQuerySchema.parse(input);
    if (!(await projectExists(projectId))) return { found: false as const };
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
      filters.push(query.after === undefined ? lt(messages.sequence, cursor.sequence) : gt(messages.sequence, cursor.sequence));
    }
    const rows = await db
      .select({
        sequence: messages.sequence,
        id: messages.id,
        sender_id: sender.id,
        sender_name: sender.name,
        recipient_id: recipient.id,
        recipient_name: recipient.name,
        text: messages.text,
        created_at: messages.createdAt,
        acknowledged_at: messages.acknowledgedAt,
      })
      .from(messages)
      .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, projectId)))
      .innerJoin(
        recipient,
        and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, projectId)),
      )
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
      data: query.after === undefined ? sequenceHistoryPage(mapped, query.limit) : liveSequencePage(mapped, query.limit),
    };
  }

  async function getMessage(projectId: string, messageId: string) {
    if (!(await projectExists(projectId))) return { found: false as const };
    const sender = alias(agents, "admin_message_detail_sender");
    const recipient = alias(agents, "admin_message_detail_recipient");
    const [row] = await db
      .select({
        sequence: messages.sequence,
        id: messages.id,
        sender_id: sender.id,
        sender_name: sender.name,
        recipient_id: recipient.id,
        recipient_name: recipient.name,
        text: messages.text,
        created_at: messages.createdAt,
        acknowledged_at: messages.acknowledgedAt,
      })
      .from(messages)
      .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, projectId)))
      .innerJoin(
        recipient,
        and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, projectId)),
      )
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

  async function listEvents(projectId: string, input: EventListQuery) {
    const query = eventListQuerySchema.parse(input);
    if (!(await projectExists(projectId))) return { found: false as const };
    const actor = alias(agents, "admin_event_actor");
    const target = alias(agents, "admin_event_target");
    const cursorValue = query.cursor ?? query.after;
    const cursor = cursorValue === undefined ? undefined : decodeAdminCursor(cursorValue);
    const filters: SQL[] = [eq(activityEvents.projectId, projectId)];
    if (query.agent_id !== undefined) filters.push(eq(activityEvents.actorAgentId, query.agent_id));
    if (query.event_type !== undefined) filters.push(eq(activityEvents.eventType, query.event_type));
    if (query.outcome !== undefined) filters.push(eq(activityEvents.outcome, query.outcome));
    if (cursor?.kind === "sequence") {
      filters.push(
        query.after === undefined
          ? lt(activityEvents.sequence, cursor.sequence)
          : gt(activityEvents.sequence, cursor.sequence),
      );
    }
    const rows = await db
      .select({
        sequence: activityEvents.sequence,
        id: activityEvents.id,
        request_id: activityEvents.requestId,
        event_type: activityEvents.eventType,
        outcome: activityEvents.outcome,
        actor_id: actor.id,
        actor_name: actor.name,
        target_id: target.id,
        target_name: target.name,
        message_id: activityEvents.messageId,
        error_code: activityEvents.errorCode,
        metadata: activityEvents.metadata,
        created_at: activityEvents.createdAt,
      })
      .from(activityEvents)
      .leftJoin(actor, and(eq(actor.id, activityEvents.actorAgentId), eq(actor.projectId, projectId)))
      .leftJoin(target, and(eq(target.id, activityEvents.targetAgentId), eq(target.projectId, projectId)))
      .where(and(...filters))
      .orderBy(query.after === undefined ? desc(activityEvents.sequence) : asc(activityEvents.sequence))
      .limit(query.limit + 1);
    const mapped = rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      request_id: row.request_id,
      event_type: row.event_type,
      outcome: row.outcome,
      actor: row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name as string },
      target: row.target_id === null ? null : { id: row.target_id, name: row.target_name as string },
      message_id: row.message_id,
      error_code: row.error_code,
      metadata: row.metadata as ActivityMetadata,
      created_at: row.created_at.toISOString(),
    }));
    return {
      found: true as const,
      data: query.after === undefined ? sequenceHistoryPage(mapped, query.limit) : liveSequencePage(mapped, query.limit),
    };
  }

  return { listProjects, getSummary, listAgents, listMessages, getMessage, listEvents };
}

export type AdminQueryService = ReturnType<typeof createAdminQueryService>;
