import { and, eq, isNull } from "drizzle-orm";

import type { AuditService } from "../audit/service.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { agentProgressReports, agents, projects } from "../db/schema.js";

const OFFLINE_AFTER_MS = 30 * 60 * 1_000;

export type PulseResolutionErrorCode =
  | "PROJECT_NOT_FOUND"
  | "BLOCKER_NOT_FOUND"
  | "BLOCKER_STATE_CONFLICT";

export class PulseResolutionError extends Error {
  readonly code: PulseResolutionErrorCode;

  constructor(code: PulseResolutionErrorCode) {
    super(code);
    this.name = "PulseResolutionError";
    this.code = code;
  }
}

interface PulseResolutionServiceDependencies {
  db: AgentMeshDatabase;
  audit: AuditService;
  clock?: () => Date;
}

export function createPulseResolutionService(dependencies: PulseResolutionServiceDependencies) {
  const now = dependencies.clock ?? (() => new Date());

  async function resolveBlocker(input: {
    projectId: string;
    reportId: string;
    ownerUserId: string;
    note: string | null;
    requestId: string;
  }) {
    return await dependencies.db.transaction(async (transaction) => {
      const [ownedProject] = await transaction
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.ownerUserId, input.ownerUserId)))
        .for("update");
      if (ownedProject === undefined) throw new PulseResolutionError("PROJECT_NOT_FOUND");

      const [blocker] = await transaction
        .select({
          id: agentProgressReports.id,
          state: agentProgressReports.state,
          resolvedAt: agentProgressReports.resolvedAt,
          lastSeenAt: agents.lastSeenAt,
        })
        .from(agentProgressReports)
        .innerJoin(
          agents,
          and(
            eq(agents.id, agentProgressReports.agentId),
            eq(agents.projectId, agentProgressReports.projectId),
          ),
        )
        .where(and(
          eq(agentProgressReports.id, input.reportId),
          eq(agentProgressReports.projectId, input.projectId),
        ))
        .for("update");
      if (blocker === undefined) throw new PulseResolutionError("BLOCKER_NOT_FOUND");

      const resolvedAt = now();
      const offlineBefore = new Date(resolvedAt.getTime() - OFFLINE_AFTER_MS);
      if (
        blocker.state !== "blocked"
        || blocker.resolvedAt !== null
        || blocker.lastSeenAt.getTime() >= offlineBefore.getTime()
      ) {
        throw new PulseResolutionError("BLOCKER_STATE_CONFLICT");
      }

      const [updated] = await transaction
        .update(agentProgressReports)
        .set({
          resolvedAt,
          resolvedByUserId: input.ownerUserId,
          resolutionNote: input.note,
        })
        .where(and(
          eq(agentProgressReports.id, input.reportId),
          eq(agentProgressReports.projectId, input.projectId),
          eq(agentProgressReports.state, "blocked"),
          isNull(agentProgressReports.resolvedAt),
        ))
        .returning({
          id: agentProgressReports.id,
          resolvedAt: agentProgressReports.resolvedAt,
          resolutionNote: agentProgressReports.resolutionNote,
        });
      if (updated === undefined || updated.resolvedAt === null) {
        throw new PulseResolutionError("BLOCKER_STATE_CONFLICT");
      }

      await dependencies.audit.record({
        userId: input.ownerUserId,
        actor: { kind: "user", userId: input.ownerUserId },
        projectId: input.projectId,
        requestId: input.requestId,
        eventType: "pulse.blocker_resolved",
      }, transaction);

      return {
        blocker: {
          id: updated.id,
          resolved_at: updated.resolvedAt.toISOString(),
          resolution_note: updated.resolutionNote,
        },
      };
    });
  }

  return { resolveBlocker };
}
