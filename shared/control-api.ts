import { z } from "zod";

const uuid = z.uuidv4();
const timestamp = z.iso.datetime();

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    request_id: z.string().min(1).max(128),
  }).strict(),
}).strict();

export const sessionResponseSchema = z.object({
  user: z.object({
    id: uuid,
    github_id: z.string().min(1).max(64),
    login: z.string().min(1).max(255),
    display_name: z.string().min(1).max(255),
    avatar_url: z.url().nullable(),
  }).strict(),
  operator: z.boolean(),
  authenticated_at: timestamp,
  csrf_token: z.string().min(32).max(512),
}).strict();

export const projectSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable(),
  status: z.enum(["active", "archived"]),
  archived_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
}).strict();

export const projectListResponseSchema = z.object({
  projects: z.array(projectSchema).max(100),
  active_count: z.number().int().nonnegative(),
  project_limit: z.number().int().nonnegative(),
  default_project: projectSchema.nullable().default(null),
  next_cursor: z.string().max(684).nullable().default(null),
}).strict();

export const projectResponseSchema = z.object({ project: projectSchema }).strict();

export const overviewResponseSchema = z.object({
  overview: z.object({
    project: projectSchema,
    agents: z.object({
      online: z.number().int().nonnegative(),
      idle: z.number().int().nonnegative(),
      offline: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }).strict(),
    messages: z.object({
      total: z.number().int().nonnegative(),
      unacknowledged: z.number().int().nonnegative(),
    }).strict(),
    failures_last_24h: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const connectionSchema = z.object({
  id: uuid,
  label: z.string().min(1).max(80),
  status: z.enum(["active", "expired", "revoked"]),
  expires_at: timestamp.nullable(),
  last_used_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  created_at: timestamp,
}).strict();

const connectionProvenanceSchema = z.object({
  id: uuid,
  label: z.string().min(1).max(80),
  status: z.enum(["active", "expired", "revoked"]),
  expires_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
}).strict();

export const agentSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(255),
  client: z.string().min(1).max(255),
  capabilities: z.array(z.string().min(1).max(255)).max(100),
  created_at: timestamp,
  status: z.enum(["online", "idle", "offline"]),
  last_seen_at: timestamp,
  connection: connectionProvenanceSchema.nullable(),
}).strict();

export const agentListResponseSchema = z.object({
  items: z.array(agentSchema).max(100),
  next_cursor: z.string().max(684).nullable(),
}).strict();

const eventActorSchema = z.object({ id: uuid, name: z.string().min(1).max(255) }).strict();

export const eventSchema = z.object({
  sequence: z.number().int().positive(),
  id: uuid,
  request_id: uuid,
  event_type: z.string().min(1).max(255),
  outcome: z.enum(["success", "failure"]),
  actor: eventActorSchema.nullable(),
  target: eventActorSchema.nullable(),
  message_id: uuid.nullable(),
  error_code: z.string().max(255).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: timestamp,
}).strict();

export const eventListResponseSchema = z.object({
  items: z.array(eventSchema).max(100),
  next_cursor: z.string().max(684).nullable(),
  has_more: z.boolean(),
}).strict();

const messagePartySchema = z.object({
  id: uuid,
  name: z.string().min(1).max(255),
}).strict();

export const messageListItemSchema = z.object({
  sequence: z.number().int().positive(),
  id: uuid,
  sender: messagePartySchema,
  recipient: messagePartySchema,
  preview: z.string().max(161),
  created_at: timestamp,
  acknowledged_at: timestamp.nullable(),
}).strict();

export const messageListResponseSchema = z.object({
  items: z.array(messageListItemSchema).max(100),
  next_cursor: z.string().max(684).nullable(),
  has_more: z.boolean(),
}).strict();

export const messageDetailSchema = z.object({
  sequence: z.number().int().positive(),
  id: uuid,
  sender: messagePartySchema,
  recipient: messagePartySchema,
  text: z.string().max(16_384),
  created_at: timestamp,
  acknowledged_at: timestamp.nullable(),
}).strict();

export const messageDetailResponseSchema = z.object({ message: messageDetailSchema }).strict();

export const connectionListResponseSchema = z.object({
  connections: z.array(connectionSchema).max(100),
}).strict();

export const connectionResponseSchema = z.object({ connection: connectionSchema }).strict();

export const issueConnectionResponseSchema = z.object({
  connection: connectionSchema,
  secret: z.string().min(1).max(512).nullable(),
  secret_recoverable: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.secret_recoverable !== (value.secret !== null)) {
    context.addIssue({ code: "custom", message: "secret recovery state is inconsistent" });
  }
});

export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;
export type ActivityEvent = z.infer<typeof eventSchema>;
export type EventListResponse = z.infer<typeof eventListResponseSchema>;
export type MessageListItem = z.infer<typeof messageListItemSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type MessageDetail = z.infer<typeof messageDetailSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type ConnectionListResponse = z.infer<typeof connectionListResponseSchema>;
export type IssueConnectionResponse = z.infer<typeof issueConnectionResponseSchema>;
