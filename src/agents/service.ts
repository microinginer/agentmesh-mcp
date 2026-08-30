import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import {
  deriveAgentToken,
  digestRegistrationId,
  parseAgentToken,
  verifyAgentToken,
} from "../auth/agent-token.js";
import type { PollInput, RegisterInput } from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { agents, messages, type Agent } from "../db/schema.js";
import { AgentMeshError } from "../errors.js";

export type Presence = "online" | "idle" | "offline";

export interface PublicAgent {
  id: string;
  name: string;
  client: string;
  capabilities: string[];
  status: Presence;
  is_self: boolean;
  last_seen_at: string;
}

export interface InboxMessage {
  id: string;
  sequence: number;
  from_agent_id: string;
  text: string;
  created_at: string;
}

interface AgentServiceDependencies {
  db: AgentMeshDatabase;
  signingKey: Buffer;
  clock?: () => Date;
}

function presenceAt(lastSeenAt: Date, now: Date): Presence {
  const elapsed = now.getTime() - lastSeenAt.getTime();
  if (elapsed <= 5 * 60 * 1_000) {
    return "online";
  }
  if (elapsed <= 30 * 60 * 1_000) {
    return "idle";
  }
  return "offline";
}

function publicAgent(agent: Agent, callerId: string, now: Date): PublicAgent {
  return {
    id: agent.id,
    name: agent.name,
    client: agent.client,
    capabilities: agent.capabilities,
    status: presenceAt(agent.lastSeenAt, now),
    is_self: agent.id === callerId,
    last_seen_at: agent.lastSeenAt.toISOString(),
  };
}

function sameProfile(agent: Agent, input: RegisterInput, capabilities: string[]): boolean {
  return (
    agent.name === input.name &&
    agent.client === input.client &&
    agent.capabilities.length === capabilities.length &&
    agent.capabilities.every((value, index) => value === capabilities[index])
  );
}

export function createAgentService(dependencies: AgentServiceDependencies) {
  const { db, signingKey } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function authenticateAgent(
    projectId: string,
    token: string,
    reader: Pick<AgentMeshDatabase, "select"> = db,
  ): Promise<Agent> {
    const parsed = parseAgentToken(token);
    if (parsed === null) {
      throw new AgentMeshError("AGENT_AUTH_INVALID", "Agent authentication failed");
    }

    const [agent] = await reader
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.id, parsed.agentId)))
      .limit(1);

    if (
      agent === undefined ||
      !verifyAgentToken(token, {
        projectId,
        agentId: agent.id,
        registrationDigest: agent.registrationDigest,
        signingKey,
      })
    ) {
      throw new AgentMeshError("AGENT_AUTH_INVALID", "Agent authentication failed");
    }

    return agent;
  }

  async function registerAgent(projectId: string, input: RegisterInput) {
    const now = clock();
    const registrationDigest = digestRegistrationId(projectId, input.session_instance_id);
    const capabilities = input.capabilities.toSorted();

    const agent = await db.transaction(async (transaction) => {
      const [inserted] = await transaction
        .insert(agents)
        .values({
          id: randomUUID(),
          projectId,
          registrationDigest,
          name: input.name,
          client: input.client,
          capabilities,
          lastSeenAt: now,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [agents.projectId, agents.registrationDigest],
        })
        .returning();

      if (inserted !== undefined) {
        return inserted;
      }

      const [existing] = await transaction
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.projectId, projectId),
            eq(agents.registrationDigest, registrationDigest),
          ),
        )
        .limit(1);

      if (existing === undefined) {
        throw new Error("Registration conflict row disappeared");
      }
      if (!sameProfile(existing, input, capabilities)) {
        throw new AgentMeshError(
          "REGISTRATION_CONFLICT",
          "This session identifier is already registered with another profile",
        );
      }

      const [refreshed] = await transaction
        .update(agents)
        .set({ lastSeenAt: now })
        .where(and(eq(agents.projectId, projectId), eq(agents.id, existing.id)))
        .returning();
      if (refreshed === undefined) {
        throw new Error("Registered agent disappeared during refresh");
      }
      return refreshed;
    });

    return {
      agent: publicAgent(agent, agent.id, now),
      agent_token: deriveAgentToken({
        projectId,
        agentId: agent.id,
        registrationDigest: agent.registrationDigest,
        signingKey,
      }),
    };
  }

  async function syncAgent(projectId: string, input: PollInput) {
    const caller = await authenticateAgent(projectId, input.agent_token);
    const now = clock();

    return db.transaction(async (transaction) => {
      const acknowledged =
        input.acknowledge.length === 0
          ? []
          : await transaction
              .update(messages)
              .set({ acknowledgedAt: now })
              .where(
                and(
                  eq(messages.projectId, projectId),
                  eq(messages.recipientAgentId, caller.id),
                  inArray(messages.id, input.acknowledge),
                  isNull(messages.acknowledgedAt),
                ),
              )
              .returning({ id: messages.id });

      const [refreshed] = await transaction
        .update(agents)
        .set({ lastSeenAt: now })
        .where(and(eq(agents.projectId, projectId), eq(agents.id, caller.id)))
        .returning();
      if (refreshed === undefined) {
        throw new AgentMeshError("AGENT_AUTH_INVALID", "Agent authentication failed");
      }

      const rows = await transaction
        .select({
          id: messages.id,
          sequence: messages.sequence,
          senderAgentId: messages.senderAgentId,
          text: messages.text,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.projectId, projectId),
            eq(messages.recipientAgentId, caller.id),
            isNull(messages.acknowledgedAt),
          ),
        )
        .orderBy(asc(messages.sequence))
        .limit(input.limit + 1);

      return {
        agent: publicAgent(refreshed, caller.id, now),
        acknowledged: acknowledged.length,
        messages: rows.slice(0, input.limit).map(
          (message): InboxMessage => ({
            id: message.id,
            sequence: message.sequence,
            from_agent_id: message.senderAgentId,
            text: message.text,
            created_at: message.createdAt.toISOString(),
          }),
        ),
        has_more: rows.length > input.limit,
      };
    });
  }

  async function listAgents(projectId: string, agentToken: string) {
    const caller = await authenticateAgent(projectId, agentToken);
    const now = clock();
    const projectAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.projectId, projectId))
      .orderBy(asc(agents.createdAt), asc(agents.id));

    return {
      agents: projectAgents.map((agent) => publicAgent(agent, caller.id, now)),
    };
  }

  return {
    authenticateAgent,
    registerAgent,
    syncAgent,
    listAgents,
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
