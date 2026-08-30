import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { AgentService } from "../agents/service.js";
import type { SendInput } from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { agents, messages, type Message } from "../db/schema.js";
import { AgentMeshError } from "../errors.js";

interface MessageServiceDependencies {
  db: AgentMeshDatabase;
  agentService: Pick<AgentService, "authenticateAgent">;
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
  const { db, agentService } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function sendMessage(projectId: string, input: SendInput) {
    return db.transaction(async (transaction) => {
      const sender = await agentService.authenticateAgent(
        projectId,
        input.agent_token,
        transaction,
      );
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

      if (inserted !== undefined) {
        return { message: publicMessage(inserted), deduplicated: false };
      }

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
      if (
        existing.recipientAgentId !== target.id ||
        existing.text !== input.text
      ) {
        throw new AgentMeshError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for another message",
        );
      }

      return { message: publicMessage(existing), deduplicated: true };
    });
  }

  return { sendMessage };
}

export type MessageService = ReturnType<typeof createMessageService>;
