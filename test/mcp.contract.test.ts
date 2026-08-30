import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { activityEvents } from "../src/db/schema.js";
import { buildHttpApp } from "../src/http.js";
import { createProjectService } from "../src/projects/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const projectService = createProjectService({ db: database.db });
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await database.pool.query(
    "TRUNCATE TABLE activity_events, messages, agents, project_tokens, projects RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await database.pool.end();
});

function structured<T>(result: CallToolResult): T {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

describe("AgentMesh MCP over Streamable HTTP", () => {
  it("lets two official SDK clients discover each other and exchange an acknowledged reply", async () => {
    const project = await projectService.createProject("MCP contract");
    const app = buildHttpApp({
      db: database.db,
      signingKey,
      projectService,
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1", "localhost"],
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP test listener");
    }
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

    const health = await fetch(new URL("/health", endpoint));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const unauthorizedHeaders = [
      undefined,
      "Basic Zm9vOmJhcg==",
      "Bearer not-a-token",
      `Bearer am_proj_${randomUUID()}.${"a".repeat(43)}`,
      `Bearer ${project.token.slice(0, -1)}${project.token.endsWith("A") ? "B" : "A"}`,
    ];
    for (const authorization of unauthorizedHeaders) {
      const unauthorized = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
    }

    const createClient = async (name: string) => {
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { Authorization: `Bearer ${project.token}` },
        },
      });
      const client = new Client({ name, version: "1.0.0" });
      await client.connect(transport);
      return client;
    };

    const clientA = await createClient("agent-a-test");
    const clientB = await createClient("agent-b-test");
    try {
      const toolNames = (await clientA.listTools()).tools.map((tool) => tool.name).toSorted();
      expect(toolNames).toEqual([
        "agentmesh_list_agents",
        "agentmesh_send",
        "agentmesh_sync",
      ]);

      const registeredA = structured<{
        ok: true;
        data: { agent: { id: string }; agent_token: string };
      }>(
        await clientA.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "register",
            session_instance_id: randomUUID(),
            name: "codex-backend",
            client: "codex",
            capabilities: ["backend"],
          },
        }),
      );
      const registeredB = structured<{
        ok: true;
        data: { agent: { id: string }; agent_token: string };
      }>(
        await clientB.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "register",
            session_instance_id: randomUUID(),
            name: "claude-review",
            client: "claude-code",
            capabilities: ["review"],
          },
        }),
      );
      expect(Object.keys(registeredA.data).toSorted()).toEqual(["agent", "agent_token", "mode"]);
      expect(Object.keys(registeredB.data).toSorted()).toEqual(["agent", "agent_token", "mode"]);

      const discovered = structured<{
        ok: true;
        data: { agents: Array<{ id: string }> };
      }>(
        await clientA.callTool({
          name: "agentmesh_list_agents",
          arguments: { agent_token: registeredA.data.agent_token },
        }),
      );
      expect(discovered.data.agents.map((agent) => agent.id).toSorted()).toEqual(
        [registeredA.data.agent.id, registeredB.data.agent.id].toSorted(),
      );

      const idempotencyKey = randomUUID();
      const sent = structured<{
        ok: true;
        data: { message: { id: string }; deduplicated: boolean };
      }>(
        await clientA.callTool({
          name: "agentmesh_send",
          arguments: {
            agent_token: registeredA.data.agent_token,
            to_agent_id: registeredB.data.agent.id,
            text: "Use parser contract v2",
            idempotency_key: idempotencyKey,
          },
        }),
      );
      const retried = structured<typeof sent>(
        await clientA.callTool({
          name: "agentmesh_send",
          arguments: {
            agent_token: registeredA.data.agent_token,
            to_agent_id: registeredB.data.agent.id,
            text: "Use parser contract v2",
            idempotency_key: idempotencyKey,
          },
        }),
      );
      expect(retried.data.message.id).toBe(sent.data.message.id);
      expect(retried.data.deduplicated).toBe(true);

      const firstPoll = structured<{
        ok: true;
        data: { messages: Array<{ id: string; text: string }> };
      }>(
        await clientB.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "poll",
            agent_token: registeredB.data.agent_token,
            acknowledge: [],
            limit: 50,
          },
        }),
      );
      const redelivery = structured<typeof firstPoll>(
        await clientB.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "poll",
            agent_token: registeredB.data.agent_token,
            acknowledge: [],
            limit: 50,
          },
        }),
      );
      expect(firstPoll.data.messages).toEqual([
        expect.objectContaining({
          id: sent.data.message.id,
          text: "Use parser contract v2",
        }),
      ]);
      expect(redelivery.data.messages).toEqual(firstPoll.data.messages);

      const afterAck = structured<{
        ok: true;
        data: { messages: unknown[]; acknowledged: number };
      }>(
        await clientB.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "poll",
            agent_token: registeredB.data.agent_token,
            acknowledge: [sent.data.message.id],
            limit: 50,
          },
        }),
      );
      expect(afterAck.data).toMatchObject({ acknowledged: 1, messages: [] });

      const reply = structured<{
        ok: true;
        data: { message: { id: string } };
      }>(
        await clientB.callTool({
          name: "agentmesh_send",
          arguments: {
            agent_token: registeredB.data.agent_token,
            to_agent_id: registeredA.data.agent.id,
            text: "Parser contract applied",
            idempotency_key: randomUUID(),
          },
        }),
      );
      const receivedReply = structured<{
        ok: true;
        data: { messages: Array<{ id: string; text: string }> };
      }>(
        await clientA.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "poll",
            agent_token: registeredA.data.agent_token,
            acknowledge: [],
            limit: 50,
          },
        }),
      );
      expect(receivedReply.data.messages).toEqual([
        expect.objectContaining({
          id: reply.data.message.id,
          text: "Parser contract applied",
        }),
      ]);
      const afterReplyAck = structured<{
        ok: true;
        data: { messages: unknown[]; acknowledged: number };
      }>(
        await clientA.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "poll",
            agent_token: registeredA.data.agent_token,
            acknowledge: [reply.data.message.id],
            limit: 50,
          },
        }),
      );
      expect(afterReplyAck.data).toMatchObject({ acknowledged: 1, messages: [] });
      expect(Object.keys(afterReplyAck.data).toSorted()).toEqual([
        "acknowledged",
        "agent",
        "has_more",
        "messages",
        "mode",
      ]);

      const recordedEvents = await database.db
        .select({
          requestId: activityEvents.requestId,
          eventType: activityEvents.eventType,
          outcome: activityEvents.outcome,
          messageId: activityEvents.messageId,
        })
        .from(activityEvents)
        .where(eq(activityEvents.projectId, project.project.id));
      expect(recordedEvents.filter((event) => event.eventType === "agent.registered")).toHaveLength(2);
      expect(
        recordedEvents.filter(
          (event) => event.eventType === "agent.synced" && event.outcome === "success",
        ),
      ).toHaveLength(5);
      const acknowledgements = recordedEvents.filter(
        (event) => event.eventType === "message.acknowledged",
      );
      expect(acknowledgements).toHaveLength(2);
      expect(acknowledgements).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageId: sent.data.message.id }),
        expect.objectContaining({ messageId: reply.data.message.id }),
      ]));
      for (const acknowledgement of acknowledgements) {
        expect(
          recordedEvents.some(
            (event) =>
              event.eventType === "agent.synced" && event.requestId === acknowledgement.requestId,
          ),
        ).toBe(true);
      }
    } finally {
      await clientA.close();
      await clientB.close();
      await app.close();
    }
  });
});
