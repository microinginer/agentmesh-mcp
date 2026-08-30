import { sql } from "drizzle-orm";
import type { ActivityMetadata } from "../activity/types.js";
import {
  bigserial,
  check,
  customType,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectTokens = pgTable("project_tokens", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  tokenDigest: bytea("token_digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    registrationDigest: bytea("registration_digest").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    client: varchar("client", { length: 64 }).notNull(),
    capabilities: text("capabilities")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("agents_project_registration_unique").on(
      table.projectId,
      table.registrationDigest,
    ),
    unique("agents_id_project_unique").on(table.id, table.projectId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
    id: uuid("id").notNull().defaultRandom().unique(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    senderAgentId: uuid("sender_agent_id").notNull(),
    recipientAgentId: uuid("recipient_agent_id").notNull(),
    text: text("text").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => [
    unique("messages_project_sender_idempotency_unique").on(
      table.projectId,
      table.senderAgentId,
      table.idempotencyKey,
    ),
    unique("messages_id_project_unique").on(table.id, table.projectId),
    foreignKey({
      name: "messages_sender_project_fk",
      columns: [table.senderAgentId, table.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "messages_recipient_project_fk",
      columns: [table.recipientAgentId, table.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("cascade"),
    check(
      "messages_sender_recipient_different",
      sql`${table.senderAgentId} <> ${table.recipientAgentId}`,
    ),
  ],
);

export const activityEvents = pgTable(
  "activity_events",
  {
    sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
    id: uuid("id").notNull().defaultRandom().unique(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    actorAgentId: uuid("actor_agent_id"),
    targetAgentId: uuid("target_agent_id"),
    messageId: uuid("message_id"),
    errorCode: varchar("error_code", { length: 64 }),
    metadata: jsonb("metadata")
      .$type<ActivityMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "activity_events_type_check",
      sql`${table.eventType} IN ('agent.registered', 'agent.registration_failed', 'agent.synced', 'message.sent', 'message.send_failed', 'message.acknowledged', 'mcp.request_failed')`,
    ),
    check(
      "activity_events_outcome_check",
      sql`${table.outcome} IN ('success', 'failure')`,
    ),
    foreignKey({
      name: "activity_events_actor_project_fk",
      columns: [table.actorAgentId, table.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_events_target_project_fk",
      columns: [table.targetAgentId, table.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_events_message_project_fk",
      columns: [table.messageId, table.projectId],
      foreignColumns: [messages.id, messages.projectId],
    }).onDelete("cascade"),
    index("activity_events_project_sequence_idx").on(
      table.projectId,
      table.sequence.desc(),
    ),
    index("activity_events_project_type_sequence_idx").on(
      table.projectId,
      table.eventType,
      table.sequence.desc(),
    ),
    index("activity_events_project_actor_sequence_idx").on(
      table.projectId,
      table.actorAgentId,
      table.sequence.desc(),
    ),
  ],
);

export const observer = pgSchema("observer");

export const observerProjects = observer.view("projects").as((query) =>
  query
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
    })
    .from(projects),
);

export const observerAgents = observer.view("agents").as((query) =>
  query
    .select({
      id: agents.id,
      projectId: agents.projectId,
      name: agents.name,
      client: agents.client,
      capabilities: agents.capabilities,
      lastSeenAt: agents.lastSeenAt,
      createdAt: agents.createdAt,
    })
    .from(agents),
);

export const observerMessages = observer.view("messages").as((query) =>
  query
    .select({
      sequence: messages.sequence,
      id: messages.id,
      projectId: messages.projectId,
      senderAgentId: messages.senderAgentId,
      recipientAgentId: messages.recipientAgentId,
      text: messages.text,
      createdAt: messages.createdAt,
      acknowledgedAt: messages.acknowledgedAt,
    })
    .from(messages),
);

export const observerActivityEvents = observer.view("activity_events").as((query) =>
  query
    .select({
      sequence: activityEvents.sequence,
      id: activityEvents.id,
      projectId: activityEvents.projectId,
      requestId: activityEvents.requestId,
      eventType: activityEvents.eventType,
      outcome: activityEvents.outcome,
      actorAgentId: activityEvents.actorAgentId,
      targetAgentId: activityEvents.targetAgentId,
      messageId: activityEvents.messageId,
      errorCode: activityEvents.errorCode,
      metadata: activityEvents.metadata,
      createdAt: activityEvents.createdAt,
    })
    .from(activityEvents),
);

export type Project = typeof projects.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
