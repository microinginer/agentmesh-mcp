import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import { createAgentService } from "../agents/service.js";
import {
  listAgentsInputSchema,
  listAgentsOutputSchema,
  sendInputSchema,
  sendOutputSchema,
  syncInputSchema,
  syncOutputSchema,
} from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { AgentMeshError } from "../errors.js";
import { createMessageService } from "../messages/service.js";

interface McpHandlerDependencies {
  db: AgentMeshDatabase;
  signingKey: Buffer;
}

function toolResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

async function runTool(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return toolResult(await operation());
  } catch (error) {
    if (error instanceof AgentMeshError) {
      return toolResult(
        { ok: false, error: { code: error.code, message: error.message } },
        true,
      );
    }

    return toolResult(
      {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "AgentMesh could not complete the request" },
      },
      true,
    );
  }
}

export function buildMcpHandler({ db, signingKey }: McpHandlerDependencies): McpHttpHandler {
  const agentService = createAgentService({ db, signingKey });
  const messageService = createMessageService({ db, agentService });

  return createMcpHandler(({ authInfo }) => {
    const projectId = authInfo?.clientId;
    const requireProjectId = (): string => {
      if (projectId === undefined) {
        throw new AgentMeshError("PROJECT_AUTH_INVALID", "Project authentication failed");
      }
      return projectId;
    };

    const server = new McpServer({ name: "agentmesh", version: "0.0.1" });

    server.registerTool(
      "agentmesh_sync",
      {
        description:
          "Register this agent, or poll and acknowledge its durable AgentMesh inbox.",
        inputSchema: syncInputSchema,
        outputSchema: syncOutputSchema,
      },
      async (input) =>
        runTool(async () => {
          if (input.mode === "register") {
            const registered = await agentService.registerAgent(requireProjectId(), input);
            return { ok: true, data: { mode: "registered", ...registered } };
          }

          const synced = await agentService.syncAgent(requireProjectId(), input);
          return { ok: true, data: { mode: "synced", ...synced } };
        }),
    );

    server.registerTool(
      "agentmesh_send",
      {
        description: "Send one durable direct message to another agent in this project.",
        inputSchema: sendInputSchema,
        outputSchema: sendOutputSchema,
      },
      async (input) =>
        runTool(async () => ({
          ok: true,
          data: await messageService.sendMessage(requireProjectId(), input),
        })),
    );

    server.registerTool(
      "agentmesh_list_agents",
      {
        description: "List agents known to this project and their derived presence.",
        inputSchema: listAgentsInputSchema,
        outputSchema: listAgentsOutputSchema,
      },
      async (input) =>
        runTool(async () => ({
          ok: true,
          data: await agentService.listAgents(requireProjectId(), input.agent_token),
        })),
    );

    return server;
  });
}
