import { and, eq, sql } from "drizzle-orm";
import type { ActivityMetadata } from "../activity/types.js";
import type { AuditMetadata } from "../audit/types.js";
import {
  bigserial,
  check,
  customType,
  foreignKey,
  index,
  integer,
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

export const projectStatuses = ["active", "archived"] as const;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  avatarUrl: text("avatar_url"),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthIdentities = pgTable("oauth_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  providerUserId: varchar("provider_user_id", { length: 64 }).notNull(),
  login: varchar("login", { length: 100 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("oauth_identities_provider_user_unique").on(table.provider, table.providerUserId)]);

export const webSessions = pgTable("web_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenDigest: bytea("token_digest").notNull().unique(),
  csrfDigest: bytea("csrf_digest").notNull(),
  authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAttempts = pgTable("oauth_attempts", {
  attemptDigest: bytea("attempt_digest").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("oauth_attempts_digest_length_check", sql`octet_length(${table.attemptDigest}) = 32`),
  index("oauth_attempts_expires_at_idx").on(table.expiresAt),
]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createIdempotencyKey: uuid("create_idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "projects_status_check",
    sql`${table.status} IN ('active', 'archived')`,
  ),
  unique("projects_owner_create_idempotency_unique").on(
    table.ownerUserId,
    table.createIdempotencyKey,
  ),
]);

export const blackboardEntries = pgTable(
  "blackboard_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    namespace: varchar("namespace", { length: 64 }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    value: text("value").notNull(),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    version: integer("version").notNull().default(1),
    ttlSeconds: integer("ttl_seconds"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByType: varchar("created_by_type", { length: 16 }).notNull(),
    createdById: uuid("created_by_id").notNull(),
    lastUpdatedByType: varchar("last_updated_by_type", { length: 16 }).notNull(),
    lastUpdatedById: uuid("last_updated_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("blackboard_entries_project_namespace_key_unique").on(
      table.projectId,
      table.namespace,
      table.key,
    ),
    check("blackboard_entries_version_positive_check", sql`${table.version} > 0`),
    check(
      "blackboard_entries_ttl_positive_check",
      sql`${table.ttlSeconds} IS NULL OR ${table.ttlSeconds} > 0`,
    ),
    check(
      "blackboard_entries_created_by_type_check",
      sql`${table.createdByType} IN ('agent', 'user')`,
    ),
    check(
      "blackboard_entries_last_updated_by_type_check",
      sql`${table.lastUpdatedByType} IN ('agent', 'user')`,
    ),
    index("blackboard_entries_project_namespace_idx").on(
      table.projectId,
      table.namespace,
    ),
    index("blackboard_entries_project_expires_at_idx").on(
      table.projectId,
      table.expiresAt,
    ),
  ],
);

export const projectTokens = pgTable("project_tokens", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  tokenDigest: bytea("token_digest").notNull(),
  label: varchar("label", { length: 80 }).notNull().default("Legacy CLI token"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createIdempotencyKey: uuid("create_idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("project_tokens_project_id_id_unique").on(table.projectId, table.id),
  unique("project_tokens_project_create_idempotency_unique").on(
    table.projectId,
    table.createIdempotencyKey,
  ),
]);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    registeredViaTokenId: uuid("registered_via_token_id"),
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
    foreignKey({
      name: "agents_registered_via_token_project_fk",
      columns: [table.registeredViaTokenId, table.projectId],
      foreignColumns: [projectTokens.id, projectTokens.projectId],
    }),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    projectId: uuid("project_id"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    metadata: jsonb("metadata")
      .$type<AuditMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "audit_events_type_check",
      sql`${table.eventType} IN (
        'auth.login_succeeded', 'auth.login_failed', 'auth.logout',
        'project.created', 'project.archived', 'project.restored', 'project.deleted',
        'connection.created', 'connection.revoked',
        'operator.user_blocked', 'operator.user_unblocked', 'operator.project_archived',
        'operator.project_owner_assigned'
      )`,
    ),
    index("audit_events_user_created_at_idx").on(table.userId, table.createdAt.desc()),
    index("audit_events_project_created_at_idx").on(table.projectId, table.createdAt.desc()),
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
      sql`${table.eventType} IN ('agent.registered', 'agent.registration_failed', 'agent.synced', 'message.sent', 'message.send_failed', 'message.acknowledged', 'blackboard.fact_set', 'blackboard.fact_deleted', 'mcp.request_failed')`,
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
      connectionId: sql<string | null>`${projectTokens.id}`.as("connection_id"),
      connectionLabel: sql<string | null>`${projectTokens.label}`.as("connection_label"),
      connectionExpiresAt: sql<Date | null>`${projectTokens.expiresAt}`.as("connection_expires_at"),
      connectionRevokedAt: sql<Date | null>`${projectTokens.revokedAt}`.as("connection_revoked_at"),
    })
    .from(agents)
    .leftJoin(
      projectTokens,
      and(
        eq(projectTokens.id, agents.registeredViaTokenId),
        eq(projectTokens.projectId, agents.projectId),
      ),
    ),
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

export const observerUsers = observer.view("users").as((query) =>
  query
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      blockedAt: users.blockedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users),
);

export const observerConnections = observer.view("connections").as((query) =>
  query
    .select({
      id: projectTokens.id,
      projectId: projectTokens.projectId,
      label: projectTokens.label,
      createdByUserId: projectTokens.createdByUserId,
      expiresAt: projectTokens.expiresAt,
      lastUsedAt: projectTokens.lastUsedAt,
      revokedAt: projectTokens.revokedAt,
      createdAt: projectTokens.createdAt,
    })
    .from(projectTokens),
);

export const observerAuditEvents = observer.view("audit_events").as((query) =>
  query
    .select({
      id: auditEvents.id,
      userId: auditEvents.userId,
      projectId: auditEvents.projectId,
      eventType: auditEvents.eventType,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents),
);

export type Project = typeof projects.$inferSelect;
export type BlackboardEntry = typeof blackboardEntries.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
