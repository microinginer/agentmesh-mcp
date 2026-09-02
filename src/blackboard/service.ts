import {
  and,
  arrayContains,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { ActivityService } from "../activity/service.js";
import type { OperationContext } from "../activity/types.js";
import type { AgentService } from "../agents/service.js";
import type {
  BlackboardFact,
  BlackboardGetFactsInput,
  BlackboardSetFactInput,
} from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { blackboardEntries, type BlackboardEntry } from "../db/schema.js";
import { AgentMeshError } from "../errors.js";

interface BlackboardServiceDependencies {
  db: AgentMeshDatabase;
  agentService: Pick<AgentService, "authenticateAgent">;
  activity: Pick<ActivityService, "record">;
  clock?: () => Date;
}

export interface BlackboardMutationContext extends OperationContext {
  actorType: "agent" | "user";
  actorId: string;
}

function publicFact(entry: BlackboardEntry): BlackboardFact {
  return {
    id: entry.id,
    project_id: entry.projectId,
    namespace: entry.namespace,
    key: entry.key,
    value: entry.value,
    tags: entry.tags,
    version: entry.version,
    ttl_seconds: entry.ttlSeconds,
    expires_at: entry.expiresAt?.toISOString() ?? null,
    created_by_type: entry.createdByType as "agent" | "user",
    created_by_id: entry.createdById,
    last_updated_by_type: entry.lastUpdatedByType as "agent" | "user",
    last_updated_by_id: entry.lastUpdatedById,
    created_at: entry.createdAt.toISOString(),
    updated_at: entry.updatedAt.toISOString(),
  };
}

export function createBlackboardService(dependencies: BlackboardServiceDependencies) {
  const { db, agentService, activity } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function setFact(
    projectId: string,
    input: BlackboardSetFactInput,
    context: OperationContext,
  ): Promise<BlackboardFact> {
    return db.transaction(async (transaction) => {
      const agent = await agentService.authenticateAgent(
        projectId,
        input.agent_token,
        transaction,
      );
      const now = clock();
      const ttlSeconds = input.ttl_seconds ?? null;
      const expiresAt = ttlSeconds === null
        ? null
        : new Date(now.getTime() + ttlSeconds * 1000);

      let persisted: BlackboardEntry | undefined;
      if (input.expected_version === undefined) {
        [persisted] = await transaction
          .insert(blackboardEntries)
          .values({
            projectId,
            namespace: input.namespace,
            key: input.key,
            value: input.value,
            tags: input.tags,
            version: 1,
            ttlSeconds,
            expiresAt,
            createdByType: "agent",
            createdById: agent.id,
            lastUpdatedByType: "agent",
            lastUpdatedById: agent.id,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              blackboardEntries.projectId,
              blackboardEntries.namespace,
              blackboardEntries.key,
            ],
            set: {
              value: input.value,
              tags: input.tags,
              version: sql`${blackboardEntries.version} + 1`,
              ttlSeconds,
              expiresAt,
              lastUpdatedByType: "agent",
              lastUpdatedById: agent.id,
              updatedAt: now,
            },
          })
          .returning();
      } else {
        [persisted] = await transaction
          .update(blackboardEntries)
          .set({
            value: input.value,
            tags: input.tags,
            version: sql`${blackboardEntries.version} + 1`,
            ttlSeconds,
            expiresAt,
            lastUpdatedByType: "agent",
            lastUpdatedById: agent.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(blackboardEntries.projectId, projectId),
              eq(blackboardEntries.namespace, input.namespace),
              eq(blackboardEntries.key, input.key),
              eq(blackboardEntries.version, input.expected_version),
            ),
          )
          .returning();
      }

      if (persisted === undefined) {
        throw new AgentMeshError(
          "VERSION_CONFLICT",
          "Blackboard fact version conflict",
        );
      }

      await activity.record({
        projectId,
        requestId: context.requestId,
        eventType: "blackboard.fact_set",
        outcome: "success",
        actorAgentId: agent.id,
        metadata: {
          blackboard_namespace: persisted.namespace,
          blackboard_key: persisted.key,
          blackboard_version: persisted.version,
        },
      }, transaction);

      return publicFact(persisted);
    });
  }

  async function getFacts(
    projectId: string,
    input: BlackboardGetFactsInput,
  ): Promise<{ facts: BlackboardFact[] }> {
    await agentService.authenticateAgent(projectId, input.agent_token);

    const conditions: SQL[] = [eq(blackboardEntries.projectId, projectId)];
    const activeAtReadTime = or(
      isNull(blackboardEntries.expiresAt),
      gte(blackboardEntries.expiresAt, clock()),
    );
    if (activeAtReadTime !== undefined) {
      conditions.push(activeAtReadTime);
    }
    if (input.namespace !== undefined) {
      conditions.push(eq(blackboardEntries.namespace, input.namespace));
    }
    if (input.keys !== undefined) {
      conditions.push(inArray(blackboardEntries.key, input.keys));
    }
    if (input.tags !== undefined) {
      conditions.push(arrayContains(blackboardEntries.tags, input.tags));
    }

    const entries = await db
      .select()
      .from(blackboardEntries)
      .where(and(...conditions))
      .orderBy(asc(blackboardEntries.namespace), asc(blackboardEntries.key));

    return { facts: entries.map(publicFact) };
  }

  async function deleteFact(
    projectId: string,
    namespace: string,
    key: string,
    context: BlackboardMutationContext,
  ): Promise<{ deleted: boolean }> {
    return db.transaction(async (transaction) => {
      const [deleted] = await transaction
        .delete(blackboardEntries)
        .where(
          and(
            eq(blackboardEntries.projectId, projectId),
            eq(blackboardEntries.namespace, namespace),
            eq(blackboardEntries.key, key),
          ),
        )
        .returning({ version: blackboardEntries.version });

      if (deleted === undefined) {
        return { deleted: false };
      }

      await activity.record({
        projectId,
        requestId: context.requestId,
        eventType: "blackboard.fact_deleted",
        outcome: "success",
        actorAgentId: context.actorType === "agent" ? context.actorId : null,
        metadata: {
          blackboard_namespace: namespace,
          blackboard_key: key,
          blackboard_version: deleted.version,
        },
      }, transaction);

      return { deleted: true };
    });
  }

  return { setFact, getFacts, deleteFact };
}

export type BlackboardService = ReturnType<typeof createBlackboardService>;
