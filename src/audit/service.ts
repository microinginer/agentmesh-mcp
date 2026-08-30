import type { AgentMeshDatabase } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import type { AuditEventType, AuditMetadata } from "./types.js";

type AuditExecutor = Pick<AgentMeshDatabase, "insert">;

export interface RecordAuditInput {
  userId?: string | null;
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

export function createAuditService(dependencies: AuditServiceDependencies) {
  const { db } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function record(
    input: RecordAuditInput,
    executor: AuditExecutor = db,
  ): Promise<void> {
    await executor.insert(auditEvents).values({
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      eventType: input.eventType,
      metadata: safeMetadata(input.metadata),
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
