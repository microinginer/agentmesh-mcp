import type { AgentMeshDatabase } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import type { AgentMeshErrorCode } from "../errors.js";
import type { ActivityEventType, ActivityMetadata, ActivityOutcome } from "./types.js";

type ActivityExecutor = Pick<AgentMeshDatabase, "insert">;

const agentMeshErrorCodes = new Set<AgentMeshErrorCode>([
  "AGENT_AUTH_INVALID",
  "PROJECT_AUTH_INVALID",
  "REGISTRATION_CONFLICT",
  "TARGET_AGENT_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_ERROR",
]);

export interface RecordActivityInput {
  projectId: string;
  requestId: string;
  eventType: ActivityEventType;
  outcome: ActivityOutcome;
  actorAgentId?: string | null;
  targetAgentId?: string | null;
  messageId?: string | null;
  errorCode?: AgentMeshErrorCode | null;
  metadata?: ActivityMetadata;
}

export interface ActivityPersistFailure {
  event: "activity.persist_failed";
  request_id: string;
}

interface ActivityServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
  onPersistFailure?: (failure: ActivityPersistFailure) => void;
}

function safeMetadata(metadata: unknown): ActivityMetadata {
  const safe: ActivityMetadata = {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return safe;
  }

  const candidate = metadata as Record<string, unknown>;
  if (typeof candidate.message_bytes === "number" && Number.isFinite(candidate.message_bytes)) {
    safe.message_bytes = candidate.message_bytes;
  }
  if (
    typeof candidate.delivered_count === "number" &&
    Number.isFinite(candidate.delivered_count)
  ) {
    safe.delivered_count = candidate.delivered_count;
  }
  if (
    typeof candidate.acknowledged_count === "number" &&
    Number.isFinite(candidate.acknowledged_count)
  ) {
    safe.acknowledged_count = candidate.acknowledged_count;
  }
  if (typeof candidate.poll_limit === "number" && Number.isFinite(candidate.poll_limit)) {
    safe.poll_limit = candidate.poll_limit;
  }
  if (typeof candidate.deduplicated === "boolean") {
    safe.deduplicated = candidate.deduplicated;
  }
  return safe;
}

function safeErrorCode(errorCode: unknown): AgentMeshErrorCode | null {
  if (typeof errorCode !== "string" || !agentMeshErrorCodes.has(errorCode as AgentMeshErrorCode)) {
    return null;
  }
  return errorCode as AgentMeshErrorCode;
}

export function createActivityService(dependencies: ActivityServiceDependencies) {
  const { db } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function record(
    input: RecordActivityInput,
    executor: ActivityExecutor = db,
  ): Promise<void> {
    await executor.insert(activityEvents).values({
      projectId: input.projectId,
      requestId: input.requestId,
      eventType: input.eventType,
      outcome: input.outcome,
      actorAgentId: input.actorAgentId ?? null,
      targetAgentId: input.targetAgentId ?? null,
      messageId: input.messageId ?? null,
      errorCode: safeErrorCode(input.errorCode),
      metadata: safeMetadata(input.metadata),
      createdAt: clock(),
    });
  }

  async function recordBestEffort(input: RecordActivityInput): Promise<void> {
    try {
      await record(input);
    } catch {
      try {
        await dependencies.onPersistFailure?.({
          event: "activity.persist_failed",
          request_id: input.requestId,
        });
      } catch {}
    }
  }

  return { record, recordBestEffort };
}

export type ActivityService = ReturnType<typeof createActivityService>;
