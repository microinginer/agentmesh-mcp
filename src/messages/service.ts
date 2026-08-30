import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { AgentService } from "../agents/service.js";
import type { ActivityService } from "../activity/service.js";
import type { OperationContext } from "../activity/types.js";
import type { SendInput } from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { agents, messages, type Message } from "../db/schema.js";
import { AgentMeshError } from "../errors.js";

interface MessageServiceDependencies {
  db: AgentMeshDatabase;
  agentService: Pick<AgentService, "authenticateAgent">;
  activity: Pick<ActivityService, "record" | "recordBestEffort">;
  clock?: () => Date;
}

function publicMessage(message: Message) {
  return {
    id: message.id,
    sequence: message.sequence,
    from_agent_id: message.senderAgentId,
    to_agent_id: message.recipientAgentId,
    text: message.text,
    created_at: message.createdAt.toISOString(),
  };
}

export function createMessageService(dependencies: MessageServiceDependencies) {
  const { db, agentService, activity } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function sendMessage(projectId: string, input: SendInput, context: OperationContext) {
    let senderId: string | null = null;
    let targetId: string | null = null;

    try {
      return await db.transaction(async (transaction) => {
        const sender = await agentService.authenticateAgent(
          projectId,
          input.agent_token,
          transaction,
        );
        senderId = sender.id;
        if (sender.id === input.to_agent_id) {
          throw new AgentMeshError("TARGET_AGENT_INVALID", "Target agent is unavailable");
        }

        const [target] = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.projectId, projectId),
              eq(agents.id, input.to_agent_id),
            ),
          )
          .limit(1);
        if (target === undefined) {
          throw new AgentMeshError("TARGET_AGENT_INVALID", "Target agent is unavailable");
        }
        targetId = target.id;

        const [inserted] = await transaction
          .insert(messages)
          .values({
            id: randomUUID(),
            projectId,
            senderAgentId: sender.id,
            recipientAgentId: target.id,
            text: input.text,
            idempotencyKey: input.idempotency_key,
            createdAt: clock(),
          })
          .onConflictDoNothing({
            target: [messages.projectId, messages.senderAgentId, messages.idempotencyKey],
          })
          .returning();

        let persisted = inserted;
        const deduplicated = persisted === undefined;
        if (persisted === undefined) {
          const [existing] = await transaction
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.projectId, projectId),
                eq(messages.senderAgentId, sender.id),
                eq(messages.idempotencyKey, input.idempotency_key),
              ),
            )
            .limit(1);
          if (existing === undefined) {
            throw new Error("Idempotent message row disappeared");
          }
          if (existing.recipientAgentId !== target.id || existing.text !== input.text) {
            throw new AgentMeshError(
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used for another message",
            );
          }
          persisted = existing;
        }

        await activity.record({
          projectId,
          requestId: context.requestId,
          eventType: "message.sent",
          outcome: "success",
          actorAgentId: sender.id,
          targetAgentId: target.id,
          messageId: persisted.id,
          metadata: {
            message_bytes: Buffer.byteLength(input.text, "utf8"),
            deduplicated,
          },
        }, transaction);
        return { message: publicMessage(persisted), deduplicated };
      });
    } catch (error) {
      if (error instanceof AgentMeshError) {
        await activity.recordBestEffort({
          projectId,
          requestId: context.requestId,
          eventType: "message.send_failed",
          outcome: "failure",
          actorAgentId: senderId,
          targetAgentId: targetId,
          errorCode: error.code,
          metadata: { message_bytes: Buffer.byteLength(input.text, "utf8") },
        });
      }
      throw error;
    }
  }

  return { sendMessage };
}

export type MessageService = ReturnType<typeof createMessageService>;
