import type { AgentMeshDatabase } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import type { AuditActor, AuditEventType, AuditMetadata } from "./types.js";

type AuditExecutor = Pick<AgentMeshDatabase, "insert">;

export interface RecordAuditInput {
  userId?: string | null;
  subjectUserId?: string | null;
  actor?: AuditActor;
  requestId?: string;
  projectId?: string | null;
  eventType: AuditEventType;
  metadata?: AuditMetadata;
}

export interface AuditPersistFailure {
  event: "audit.persist_failed";
  event_type: AuditEventType;
}

interface AuditServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
  onPersistFailure?: (failure: AuditPersistFailure) => void;
}

function safeMetadata(metadata: unknown): AuditMetadata {
  const safe: AuditMetadata = {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return safe;
  }

  const candidate = metadata as Record<string, unknown>;
  if (candidate.provider === "github") {
    safe.provider = "github";
  }
  if (typeof candidate.connection_label === "string") {
    safe.connection_label = candidate.connection_label;
  }
  if (typeof candidate.project_name === "string") {
    safe.project_name = candidate.project_name;
  }
  return safe;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function safeUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_V4_PATTERN.test(value) ? value : undefined;
}

function attributedMetadata(input: RecordAuditInput): AuditMetadata {
  const safe = safeMetadata(input.metadata);
  if (input.actor?.kind === "headless_cli") {
    safe.actor_kind = "headless_cli";
  } else if (input.actor?.kind === "user") {
    const actorUserId = safeUuid(input.actor.userId);
    if (actorUserId !== undefined) {
      safe.actor_kind = "user";
      safe.actor_user_id = actorUserId;
    }
  }
  const subjectUserId = safeUuid(input.subjectUserId);
  if (subjectUserId !== undefined) safe.subject_user_id = subjectUserId;
  if (typeof input.requestId === "string" && REQUEST_ID_PATTERN.test(input.requestId)) {
    safe.request_id = input.requestId;
  }
  return safe;
}

export function createAuditService(dependencies: AuditServiceDependencies) {
  const { db } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function record(
    input: RecordAuditInput,
    executor: AuditExecutor = db,
  ): Promise<void> {
    const explicitSubject = input.subjectUserId === undefined
      ? undefined
      : safeUuid(input.subjectUserId);
    await executor.insert(auditEvents).values({
      userId: explicitSubject ?? (input.subjectUserId === undefined ? input.userId ?? null : null),
      projectId: input.projectId ?? null,
      eventType: input.eventType,
      metadata: attributedMetadata(input),
      createdAt: clock(),
    });
  }

  async function recordBestEffort(input: RecordAuditInput): Promise<void> {
    try {
      await record(input);
    } catch {
      try {
        await dependencies.onPersistFailure?.({
          event: "audit.persist_failed",
          event_type: input.eventType,
        });
      } catch {}
    }
  }

  return { record, recordBestEffort };
}

export type AuditService = ReturnType<typeof createAuditService>;
