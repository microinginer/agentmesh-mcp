import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const composeProject = process.env.AGENTMESH_SMOKE_PROJECT ?? "agentmesh-mvp-smoke";
const port = Number(process.env.AGENTMESH_SMOKE_PORT ?? "31337");

assert.match(composeProject, /^[a-z0-9][a-z0-9_-]*$/);
assert(Number.isInteger(port) && port >= 1 && port <= 65_535, "Invalid smoke-test port");

const childEnvironment = {
  ...process.env,
  AGENTMESH_PORT: String(port),
};
const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: childEnvironment,
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`Command failed: ${file} ${args.slice(0, 4).join(" ")}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function compose(...args: string[]): Promise<string> {
  return execFileText("docker", ["compose", "-p", composeProject, ...args]);
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(new URL("/health", endpoint), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // A restart briefly makes the listener unavailable.
    }
    await delay(500);
  }
  throw new Error("AgentMesh did not become healthy after restart");
}

function structured<T>(result: CallToolResult): T {
  assert.notEqual(result.isError, true, "MCP tool returned an error result");
  assert(result.structuredContent !== undefined, "MCP result has no structured content");
  return result.structuredContent as T;
}

async function connectClient(name: string, projectToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { Authorization: `Bearer ${projectToken}` },
    },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  const provisionedOutput = await compose(
    "exec",
    "-T",
    "agentmesh",
    "node",
    "dist/cli.js",
    "project",
    "create",
    "--name",
    "Compose restart smoke",
  );
  const provisioned = JSON.parse(provisionedOutput) as {
    project_id?: unknown;
    token?: unknown;
  };
  if (typeof provisioned.project_id !== "string") {
    throw new Error("CLI did not return a project ID");
  }
  if (typeof provisioned.token !== "string") {
    throw new Error("CLI did not return a project token");
  }
  const projectId = provisioned.project_id;
  const projectToken = provisioned.token;
  assert.equal(projectToken.startsWith("am_proj_"), true, "CLI returned an invalid project token");

  const firstA = await connectClient("smoke-agent-a-before-restart", projectToken);
  const firstB = await connectClient("smoke-agent-b-before-restart", projectToken);

  let agentA!: { id: string; token: string };
  let agentB!: { id: string; token: string };
  let outboundMessageId!: string;
  try {
    const registeredA = structured<{
      ok: true;
      data: { agent: { id: string }; agent_token: string };
    }>(
      await firstA.callTool({
        name: "agentmesh_sync",
        arguments: {
          mode: "register",
          session_instance_id: randomUUID(),
          name: "smoke-a",
          client: "codex",
          capabilities: ["implementation"],
        },
      }),
    );
    const registeredB = structured<typeof registeredA>(
      await firstB.callTool({
        name: "agentmesh_sync",
        arguments: {
          mode: "register",
          session_instance_id: randomUUID(),
          name: "smoke-b",
          client: "claude-code",
          capabilities: ["review"],
        },
      }),
    );
    agentA = { id: registeredA.data.agent.id, token: registeredA.data.agent_token };
    agentB = { id: registeredB.data.agent.id, token: registeredB.data.agent_token };

    const sent = structured<{
      ok: true;
      data: { message: { id: string } };
    }>(
      await firstA.callTool({
        name: "agentmesh_send",
        arguments: {
          agent_token: agentA.token,
          to_agent_id: agentB.id,
          text: "This message must survive the server restart",
          idempotency_key: randomUUID(),
        },
      }),
    );
    outboundMessageId = sent.data.message.id;

    const delivered = structured<{
      ok: true;
      data: { messages: Array<{ id: string }> };
    }>(
      await firstB.callTool({
        name: "agentmesh_sync",
        arguments: {
          mode: "poll",
          agent_token: agentB.token,
          acknowledge: [],
          limit: 50,
        },
      }),
    );
    assert.deepEqual(delivered.data.messages.map((message) => message.id), [outboundMessageId]);
  } finally {
    await firstA.close();
    await firstB.close();
  }

  await compose("restart", "agentmesh");
  await waitForHealth();

  const secondA = await connectClient("smoke-agent-a-after-restart", projectToken);
  const secondB = await connectClient("smoke-agent-b-after-restart", projectToken);
  let replyMessageId!: string;
  try {
    const redelivered = structured<{
      ok: true;
      data: { messages: Array<{ id: string }> };
    }>(
      await secondB.callTool({
        name: "agentmesh_sync",
        arguments: {
          mode: "poll",
          agent_token: agentB.token,
          acknowledge: [],
          limit: 50,
        },
      }),
    );
    assert.deepEqual(redelivered.data.messages.map((message) => message.id), [outboundMessageId]);

    const acknowledged = structured<{
      ok: true;
      data: { acknowledged: number; messages: unknown[] };
    }>(
      await secondB.callTool({
        name: "agentmesh_sync",
        arguments: {
          mode: "poll",
          agent_token: agentB.token,
          acknowledge: [outboundMessageId],
          limit: 50,
        },
      }),
    );
    assert.equal(acknowledged.data.acknowledged, 1);
    assert.deepEqual(acknowledged.data.messages, []);

    const reply = structured<{
      ok: true;
      data: { message: { id: string } };
    }>(
      await secondB.callTool({
        name: "agentmesh_send",
        arguments: {
          agent_token: agentB.token,
          to_agent_id: agentA.id,
          text: "Restart persistence confirmed",
          idempotency_key: randomUUID(),
        },
      }),
    );
    replyMessageId = reply.data.message.id;

    const replyDelivered = structured<{
      ok: true;
      data: { messages: Array<{ id: string }> };
    }>(
      await secondA.callTool({
        name: "agentmesh_sync",
        arguments: {
          mode: "poll",
          agent_token: agentA.token,
          acknowledge: [],
          limit: 50,
        },
      }),
    );
    assert.deepEqual(replyDelivered.data.messages.map((message) => message.id), [replyMessageId]);

    const replyAcknowledged = structured<{
      ok: true;
      data: { acknowledged: number; messages: unknown[] };
    }>(
      await secondA.callTool({
        name: "agentmesh_sync",
        arguments: {
          mode: "poll",
          agent_token: agentA.token,
          acknowledge: [replyMessageId],
          limit: 50,
        },
      }),
    );
    assert.equal(replyAcknowledged.data.acknowledged, 1);
    assert.deepEqual(replyAcknowledged.data.messages, []);
  } finally {
    await secondA.close();
    await secondB.close();
  }

  await compose("restart", "agentmesh");
  await waitForHealth();

  const finalA = await connectClient("smoke-agent-a-final", projectToken);
  const finalB = await connectClient("smoke-agent-b-final", projectToken);
  try {
    for (const [client, token] of [
      [finalA, agentA.token],
      [finalB, agentB.token],
    ] as const) {
      const finalInbox = structured<{
        ok: true;
        data: { messages: unknown[] };
      }>(
        await client.callTool({
          name: "agentmesh_sync",
          arguments: {
            mode: "poll",
            agent_token: token,
            acknowledge: [],
            limit: 50,
          },
        }),
      );
      assert.deepEqual(finalInbox.data.messages, []);
    }
  } finally {
    await finalA.close();
    await finalB.close();
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      project_id: projectId,
      agent_ids: [agentA.id, agentB.id],
      persisted_message_id: outboundMessageId,
      reply_message_id: replyMessageId,
      restart_count: 2,
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown smoke-test failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
