import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
  foreignKey,
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

export type Project = typeof projects.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Message = typeof messages.$inferSelect;
