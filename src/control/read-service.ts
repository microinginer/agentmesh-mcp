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
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ActivityMetadata } from "../activity/types.js";
import {
  adminListQuerySchema,
  decodeAdminCursor,
  encodeAdminCursor,
  eventListQuerySchema,
  messageListQuerySchema,
  type AdminListQuery,
  type EventListQuery,
  type MessageListQuery,
} from "../admin/contracts.js";
import { uuidV4Schema } from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { activityEvents, agents, messages, projects, projectTokens } from "../db/schema.js";
import { projectReadPredicate } from "./project-access.js";

const ONLINE_WINDOW_MS = 5 * 60 * 1_000;
const IDLE_WINDOW_MS = 30 * 60 * 1_000;

export type ProjectReadScope =
  | { kind: "user"; userId: string }
  | { kind: "operator" };

type Presence = "online" | "idle" | "offline";
type ConnectionStatus = "active" | "expired" | "revoked";

interface ProjectReadServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
}

export class ProjectReadUnavailableError extends Error {
  constructor() {
    super("Project reads are unavailable");
    this.name = "ProjectReadUnavailableError";
  }
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function presenceAt(lastSeenAt: Date, now: Date): Presence {
  const elapsed = now.getTime() - lastSeenAt.getTime();
  if (elapsed <= ONLINE_WINDOW_MS) return "online";
  if (elapsed <= IDLE_WINDOW_MS) return "idle";
  return "offline";
}

function connectionStatusAt(
  expiresAt: Date | null,
  revokedAt: Date | null,
  now: Date,
): ConnectionStatus {
  if (revokedAt !== null) return "revoked";
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

function previewMessage(text: string): string {
  const points = [...text];
  return points.length <= 160 ? text : `${points.slice(0, 160).join("")}…`;
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

function validScope(scope: ProjectReadScope): boolean {
  return scope.kind === "operator" || uuidV4Schema.safeParse(scope.userId).success;
}

function scopePredicate(scope: ProjectReadScope, projectId: string): SQL {
  return scope.kind === "user"
    ? projectReadPredicate(scope.userId, projectId)
    : eq(projects.id, projectId);
}

export function createProjectReadService(dependencies: ProjectReadServiceDependencies) {
  const { db } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function projectExists(scope: ProjectReadScope, projectId: string): Promise<boolean> {
    if (!validScope(scope) || !uuidV4Schema.safeParse(projectId).success) return false;
    const [project] = await db.select({ id: projects.id }).from(projects)
      .where(scopePredicate(scope, projectId)).limit(1);
    return project !== undefined;
  }

  async function projectAgentExists(
    scope: ProjectReadScope,
    projectId: string,
    agentId: string,
  ): Promise<boolean> {
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .innerJoin(projects, eq(projects.id, agents.projectId))
      .where(and(
        scopePredicate(scope, projectId),
        eq(agents.projectId, projectId),
        eq(agents.id, agentId),
      )).limit(1);
    return agent !== undefined;
  }

  async function getOverview(scope: ProjectReadScope, projectId: string) {
    if (!validScope(scope) || !uuidV4Schema.safeParse(projectId).success) {
      return { found: false as const };
    }
    const createdAt = sql<string>`to_char(${projects.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const [project] = await db.select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      archived_at: projects.archivedAt,
      created_at: createdAt,
      updated_at: projects.updatedAt,
    }).from(projects).where(scopePredicate(scope, projectId)).limit(1);
    if (project === undefined) return { found: false as const };

    const now = clock();
    if (!validDate(now)) throw new ProjectReadUnavailableError();
    const onlineThreshold = new Date(now.getTime() - ONLINE_WINDOW_MS);
    const idleThreshold = new Date(now.getTime() - IDLE_WINDOW_MS);
    const scoped = scopePredicate(scope, projectId);
    const [[agentCounts], [messageCounts], [failureCounts]] = await Promise.all([
      db.select({
        online: sql<number>`count(*) filter (where ${agents.lastSeenAt} >= ${onlineThreshold})::integer`,
        idle: sql<number>`count(*) filter (where ${agents.lastSeenAt} < ${onlineThreshold} and ${agents.lastSeenAt} >= ${idleThreshold})::integer`,
        offline: sql<number>`count(*) filter (where ${agents.lastSeenAt} < ${idleThreshold})::integer`,
        total: sql<number>`count(*)::integer`,
      }).from(agents).innerJoin(projects, eq(projects.id, agents.projectId)).where(and(
        scoped,
        eq(agents.projectId, projectId),
      )),
      db.select({
        total: sql<number>`count(*)::integer`,
        unacknowledged: sql<number>`count(*) filter (where ${messages.acknowledgedAt} is null)::integer`,
      }).from(messages).innerJoin(projects, eq(projects.id, messages.projectId)).where(and(
        scopePredicate(scope, projectId),
        eq(messages.projectId, projectId),
      )),
      db.select({ total: sql<number>`count(*)::integer` }).from(activityEvents)
        .innerJoin(projects, eq(projects.id, activityEvents.projectId))
        .where(and(
          scopePredicate(scope, projectId),
          eq(activityEvents.projectId, projectId),
          eq(activityEvents.outcome, "failure"),
          gte(activityEvents.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1_000)),
        )),
    ]);

    return {
      found: true as const,
      data: {
        project: {
          ...project,
          archived_at: project.archived_at?.toISOString() ?? null,
          updated_at: project.updated_at.toISOString(),
        },
        agents: agentCounts ?? { online: 0, idle: 0, offline: 0, total: 0 },
        messages: messageCounts ?? { total: 0, unacknowledged: 0 },
        failures_last_24h: failureCounts?.total ?? 0,
      },
    };
  }

  async function listAgents(scope: ProjectReadScope, projectId: string, input: AdminListQuery) {
    if (!validScope(scope) || !uuidV4Schema.safeParse(projectId).success) {
      return { found: false as const };
    }
    const query = adminListQuerySchema.parse(input);
    const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
    const createdAt = sql<string>`to_char(${agents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const rows = await db.select({
      id: agents.id,
      name: agents.name,
      client: agents.client,
      capabilities: agents.capabilities,
      last_seen_at: agents.lastSeenAt,
      created_at: createdAt,
      connection_id: projectTokens.id,
      connection_label: projectTokens.label,
      connection_expires_at: projectTokens.expiresAt,
      connection_revoked_at: projectTokens.revokedAt,
    }).from(agents)
      .innerJoin(projects, eq(projects.id, agents.projectId))
      .leftJoin(projectTokens, and(
        eq(projectTokens.id, agents.registeredViaTokenId),
        eq(projectTokens.projectId, agents.projectId),
      ))
      .where(and(
      scopePredicate(scope, projectId),
      eq(agents.projectId, projectId),
      cursor?.kind === "created"
        ? or(
            lt(createdAt, cursor.created_at),
            and(eq(createdAt, cursor.created_at), lt(agents.id, cursor.id)),
          )
        : undefined,
    )).orderBy(desc(agents.createdAt), desc(agents.id)).limit(query.limit + 1);
    if (rows.length === 0 && !(await projectExists(scope, projectId))) {
      return { found: false as const };
    }
    const now = clock();
    if (!validDate(now)) throw new ProjectReadUnavailableError();
    return {
      found: true as const,
      data: createdPage(rows.map((row) => ({
        id: row.id,
        name: row.name,
        client: row.client,
        capabilities: row.capabilities,
        created_at: row.created_at,
        status: presenceAt(row.last_seen_at, now),
        last_seen_at: row.last_seen_at.toISOString(),
        connection: row.connection_id === null
          ? null
          : {
              id: row.connection_id,
              label: row.connection_label as string,
              status: connectionStatusAt(
                row.connection_expires_at,
                row.connection_revoked_at,
                now,
              ),
              expires_at: row.connection_expires_at?.toISOString() ?? null,
              revoked_at: row.connection_revoked_at?.toISOString() ?? null,
            },
      })), query.limit),
    };
  }

  function messageFilters(
    scope: ProjectReadScope,
    projectId: string,
    query: MessageListQuery,
  ): SQL[] {
    const cursorValue = query.cursor ?? query.after;
    const cursor = cursorValue === undefined ? undefined : decodeAdminCursor(cursorValue);
    const filters: SQL[] = [scopePredicate(scope, projectId), eq(messages.projectId, projectId)];
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
    return filters;
  }

  async function listMessages(scope: ProjectReadScope, projectId: string, input: MessageListQuery) {
    if (!validScope(scope) || !uuidV4Schema.safeParse(projectId).success) {
      return { found: false as const };
    }
    const query = messageListQuerySchema.parse(input);
    if (
      query.agent_id !== undefined
      && !(await projectAgentExists(scope, projectId, query.agent_id))
    ) {
      return { found: false as const };
    }
    const sender = alias(agents, scope.kind === "user" ? "user_message_sender" : "operator_message_sender");
    const recipient = alias(agents, scope.kind === "user" ? "user_message_recipient" : "operator_message_recipient");
    const order = query.after === undefined ? desc(messages.sequence) : asc(messages.sequence);
    const filters = messageFilters(scope, projectId, query);

    const baseSelection = {
      sequence: messages.sequence,
      id: messages.id,
      sender_id: sender.id,
      sender_name: sender.name,
      recipient_id: recipient.id,
      recipient_name: recipient.name,
      created_at: messages.createdAt,
      acknowledged_at: messages.acknowledgedAt,
    };
    const rows = scope.kind === "user"
      ? await db.select({ ...baseSelection, text: messages.text }).from(messages)
          .innerJoin(projects, eq(projects.id, messages.projectId))
          .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, messages.projectId)))
          .innerJoin(recipient, and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, messages.projectId)))
          .where(and(...filters)).orderBy(order).limit(query.limit + 1)
      : await db.select(baseSelection).from(messages)
          .innerJoin(projects, eq(projects.id, messages.projectId))
          .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, messages.projectId)))
          .innerJoin(recipient, and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, messages.projectId)))
          .where(and(...filters)).orderBy(order).limit(query.limit + 1);

    if (rows.length === 0 && !(await projectExists(scope, projectId))) {
      return { found: false as const };
    }
    const mapped = rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      sender: { id: row.sender_id, name: row.sender_name },
      recipient: { id: row.recipient_id, name: row.recipient_name },
      ...(scope.kind === "user" && "text" in row && typeof row.text === "string"
        ? { preview: previewMessage(row.text) }
        : {}),
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

  async function getMessage(scope: ProjectReadScope, projectId: string, messageId: string) {
    if (
      !validScope(scope)
      || !uuidV4Schema.safeParse(projectId).success
      || !uuidV4Schema.safeParse(messageId).success
    ) {
      return { found: false as const };
    }
    const sender = alias(agents, scope.kind === "user" ? "user_message_detail_sender" : "operator_message_detail_sender");
    const recipient = alias(agents, scope.kind === "user" ? "user_message_detail_recipient" : "operator_message_detail_recipient");
    const baseSelection = {
      sequence: messages.sequence,
      id: messages.id,
      sender_id: sender.id,
      sender_name: sender.name,
      recipient_id: recipient.id,
      recipient_name: recipient.name,
      created_at: messages.createdAt,
      acknowledged_at: messages.acknowledgedAt,
    };
    const rows = scope.kind === "user"
      ? await db.select({ ...baseSelection, text: messages.text }).from(messages)
          .innerJoin(projects, eq(projects.id, messages.projectId))
          .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, messages.projectId)))
          .innerJoin(recipient, and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, messages.projectId)))
          .where(and(
            scopePredicate(scope, projectId),
            eq(messages.projectId, projectId),
            eq(messages.id, messageId),
          )).limit(1)
      : await db.select(baseSelection).from(messages)
          .innerJoin(projects, eq(projects.id, messages.projectId))
          .innerJoin(sender, and(eq(sender.id, messages.senderAgentId), eq(sender.projectId, messages.projectId)))
          .innerJoin(recipient, and(eq(recipient.id, messages.recipientAgentId), eq(recipient.projectId, messages.projectId)))
          .where(and(
            scopePredicate(scope, projectId),
            eq(messages.projectId, projectId),
            eq(messages.id, messageId),
          )).limit(1);
    const [row] = rows;
    if (row === undefined) return { found: false as const };
    return {
      found: true as const,
      data: {
        sequence: row.sequence,
        id: row.id,
        sender: { id: row.sender_id, name: row.sender_name },
        recipient: { id: row.recipient_id, name: row.recipient_name },
        ...(scope.kind === "user" && "text" in row && typeof row.text === "string"
          ? { text: row.text }
          : {}),
        created_at: row.created_at.toISOString(),
        acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
      },
    };
  }

  async function listEvents(scope: ProjectReadScope, projectId: string, input: EventListQuery) {
    if (!validScope(scope) || !uuidV4Schema.safeParse(projectId).success) {
      return { found: false as const };
    }
    const query = eventListQuerySchema.parse(input);
    if (
      query.agent_id !== undefined
      && !(await projectAgentExists(scope, projectId, query.agent_id))
    ) {
      return { found: false as const };
    }
    const actor = alias(agents, scope.kind === "user" ? "user_event_actor" : "operator_event_actor");
    const target = alias(agents, scope.kind === "user" ? "user_event_target" : "operator_event_target");
    const cursorValue = query.cursor ?? query.after;
    const cursor = cursorValue === undefined ? undefined : decodeAdminCursor(cursorValue);
    const filters: SQL[] = [scopePredicate(scope, projectId), eq(activityEvents.projectId, projectId)];
    if (query.agent_id !== undefined) filters.push(eq(activityEvents.actorAgentId, query.agent_id));
    if (query.event_type !== undefined) filters.push(eq(activityEvents.eventType, query.event_type));
    if (query.outcome !== undefined) filters.push(eq(activityEvents.outcome, query.outcome));
    if (cursor?.kind === "sequence") {
      filters.push(query.after === undefined
        ? lt(activityEvents.sequence, cursor.sequence)
        : gt(activityEvents.sequence, cursor.sequence));
    }
    const rows = await db.select({
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
    }).from(activityEvents)
      .innerJoin(projects, eq(projects.id, activityEvents.projectId))
      .leftJoin(actor, and(eq(actor.id, activityEvents.actorAgentId), eq(actor.projectId, activityEvents.projectId)))
      .leftJoin(target, and(eq(target.id, activityEvents.targetAgentId), eq(target.projectId, activityEvents.projectId)))
      .where(and(...filters))
      .orderBy(query.after === undefined ? desc(activityEvents.sequence) : asc(activityEvents.sequence))
      .limit(query.limit + 1);
    if (rows.length === 0 && !(await projectExists(scope, projectId))) {
      return { found: false as const };
    }
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
      data: query.after === undefined
        ? sequenceHistoryPage(mapped, query.limit)
        : liveSequencePage(mapped, query.limit),
    };
  }

  return { getOverview, listAgents, listMessages, getMessage, listEvents };
}

export type ProjectReadService = ReturnType<typeof createProjectReadService>;
