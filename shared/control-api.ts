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

const operatorUserStateSchema = z.object({
  id: uuid,
  github_user_id: z.string().min(1).max(64),
  github_login: z.string().min(1).max(255),
  display_name: z.string().min(1).max(255),
  avatar_url: z.url().nullable(),
  blocked_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
}).strict();

export const operatorUserMetadataSchema = operatorUserStateSchema.extend({
  project_count: z.number().int().nonnegative(),
  active_project_count: z.number().int().nonnegative(),
}).strict();

export const operatorUserListResponseSchema = z.object({
  items: z.array(operatorUserMetadataSchema).max(100),
  next_cursor: z.string().max(684).nullable(),
}).strict();

export const operatorUserDetailResponseSchema = z.object({ user: operatorUserMetadataSchema }).strict();
export const operatorUserMutationResponseSchema = z.object({ user: operatorUserStateSchema }).strict();

const operatorProjectOwnerSchema = z.object({
  id: uuid,
  github_user_id: z.string().min(1).max(64).nullable(),
  github_login: z.string().min(1).max(255).nullable(),
  display_name: z.string().min(1).max(255).nullable(),
}).strict();

export const operatorProjectMetadataSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(100),
  status: z.enum(["active", "archived"]),
  archived_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  owner: operatorProjectOwnerSchema.nullable(),
  counts: z.object({
    agents: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    connections: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const operatorProjectListResponseSchema = z.object({
  items: z.array(operatorProjectMetadataSchema).max(100),
  next_cursor: z.string().max(684).nullable(),
}).strict();

export const operatorProjectDetailResponseSchema = z.object({ project: operatorProjectMetadataSchema }).strict();
export const operatorProjectArchiveResponseSchema = z.object({
  project: z.object({
    id: uuid,
    status: z.literal("archived"),
    archived_at: timestamp,
    updated_at: timestamp,
  }).strict(),
}).strict();

export const projectSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable(),
  can_edit: z.boolean().default(true),
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

export const pulseTestStatusSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().optional(),
}).strict();

export const pulseProgressReportSchema = z.object({
  id: uuid,
  summary: z.string(),
  state: z.enum(["in_progress", "blocked", "completed", "idle"]),
  blocker_reason: z.string().nullable(),
  test_status: pulseTestStatusSchema.nullable(),
  files_touched: z.array(z.string()),
  reported_at: timestamp,
  resolved_at: timestamp.nullable(),
  resolution_note: z.string().nullable(),
}).strict();

export const pulseHistoryItemSchema = z.object({
  id: z.string(),
  time: z.string(),
  summary: z.string(),
  state: z.enum(["in_progress", "blocked", "completed", "idle"]),
  blocker_reason: z.string().nullable(),
  resolved_at: timestamp.nullable(),
  resolution_note: z.string().nullable(),
}).strict();

export const pulseBlockerResolutionResponseSchema = z.object({
  blocker: z.object({
    id: uuid,
    resolved_at: timestamp,
    resolution_note: z.string().nullable(),
  }).strict(),
}).strict();

export const pulseAgentSchema = z.object({
  agent_id: uuid,
  name: z.string(),
  client: z.string(),
  status: z.enum(["online", "idle", "offline"]),
  last_seen_at: timestamp,
  current_goal: z.string().nullable(),
  latest_progress: pulseProgressReportSchema.nullable(),
  history: z.array(pulseHistoryItemSchema),
}).strict();

export const pulseConnectionSchema = z.object({
  connection_id: uuid.nullable(),
  label: z.string(),
  agents: z.array(pulseAgentSchema),
}).strict();

export const pulseDeveloperSchema = z.object({
  user_id: uuid.nullable(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
  connections: z.array(pulseConnectionSchema),
}).strict();

export const dailyPulseResponseSchema = z.object({
  ok: z.literal(true),
  date: z.string(),
  summary: z.object({
    active_agents_count: z.number().int().nonnegative(),
    total_sessions_count: z.number().int().nonnegative(),
    active_blockers_count: z.number().int().nonnegative(),
    unique_files_touched_count: z.number().int().nonnegative(),
    unique_files_touched: z.array(z.string()),
  }).strict(),
  developers: z.array(pulseDeveloperSchema),
}).strict();

export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type OperatorUserMetadata = z.infer<typeof operatorUserMetadataSchema>;
export type OperatorUserListResponse = z.infer<typeof operatorUserListResponseSchema>;
export type OperatorProjectMetadata = z.infer<typeof operatorProjectMetadataSchema>;
export type OperatorProjectListResponse = z.infer<typeof operatorProjectListResponseSchema>;
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
export type DailyPulseResponse = z.infer<typeof dailyPulseResponseSchema>;
export type PulseBlockerResolutionResponse = z.infer<typeof pulseBlockerResolutionResponseSchema>;
export type PulseDeveloperSummary = z.infer<typeof pulseDeveloperSchema>;
export type PulseConnectionSummary = z.infer<typeof pulseConnectionSchema>;
export type PulseAgentSummary = z.infer<typeof pulseAgentSchema>;
