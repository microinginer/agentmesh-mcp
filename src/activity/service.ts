import type { AgentMeshDatabase } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import type { AgentMeshErrorCode } from "../errors.js";
import type { ActivityEventType, ActivityMetadata, ActivityOutcome } from "./types.js";

type ActivityExecutor = Pick<AgentMeshDatabase, "insert">;

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
      errorCode: input.errorCode ?? null,
      metadata: input.metadata ?? {},
      createdAt: clock(),
    });
  }

  async function recordBestEffort(input: RecordActivityInput): Promise<void> {
    try {
      await record(input);
    } catch {
      dependencies.onPersistFailure?.({
        event: "activity.persist_failed",
        request_id: input.requestId,
      });
    }
  }

  return { record, recordBestEffort };
}

export type ActivityService = ReturnType<typeof createActivityService>;
