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
const smokeAdminToken = Buffer.alloc(32, 11).toString("base64url");

assert.match(composeProject, /^[a-z0-9][a-z0-9_-]*$/);
assert.match(composeProject, /(?:^|[-_])smoke(?:[-_]|$)/, "Smoke project name must contain 'smoke'");
assert(Number.isInteger(port) && port >= 1 && port <= 65_535, "Invalid smoke-test port");

const childEnvironment = {
  ...process.env,
  AGENTMESH_PORT: String(port),
  AGENTMESH_ADMIN_TOKEN: smokeAdminToken,
  AGENTMESH_ADMIN_COOKIE_SECURE: "0",
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

type AdminSummary = {
  project: { id: string };
  messages: { total: number; unacknowledged: number };
};

type AdminMessages = {
  items: Array<{ id: string; acknowledged_at: string | null }>;
};

type AdminEvents = {
  items: Array<{ id: string; event_type: string; outcome: string; error_code: string | null }>;
};

type AdminState = {
  projects: { items: Array<{ id: string }> };
  summary: AdminSummary;
  messages: AdminMessages;
  events: AdminEvents;
};

function record(value: unknown, description: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${description} must be an object`);
  assert.notEqual(value, null, `${description} must be an object`);
  assert.equal(Array.isArray(value), false, `${description} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, description: string): string {
  assert.equal(typeof value, "string", `${description} must be a string`);
  return value as string;
}

function number(value: unknown, description: string): number {
  assert.equal(typeof value, "number", `${description} must be a number`);
  return value as number;
}

function items(value: unknown, description: string): Record<string, unknown>[] {
  assert.equal(Array.isArray(value), true, `${description} must be an array`);
  return (value as unknown[]).map((item, index) => record(item, `${description}[${index}]`));
}

async function boundedJson(response: Response, description: string): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    assert(Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 256 * 1024, `${description} is too large`);
  }
  const body = await response.text();
  assert(body.length <= 256 * 1024, `${description} is too large`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
  return record(parsed, description);
}

async function adminLogin(): Promise<string> {
  const response = await fetch(new URL("/admin/session", endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: smokeAdminToken }),
  });
  assert.equal(response.status, 204, "Smoke admin login must succeed");
  const setCookie = response.headers.get("set-cookie");
  assert.notEqual(setCookie, null, "Smoke admin login must set a cookie");
  const cookie = (setCookie as string).split(";", 1)[0];
  assert(cookie !== undefined && cookie.includes("="), "Smoke admin login returned an invalid cookie");
  return cookie;
}

async function adminGet(path: string, cookie: string): Promise<Record<string, unknown>> {
  assert.match(path, /^\/api\/admin\//, "Smoke admin requests must target the admin API");
  const response = await fetch(new URL(path, endpoint), {
    headers: { cookie },
  });
  assert.equal(response.status, 200, `Admin API ${path} must return 200`);
  return boundedJson(response, `Admin API ${path}`);
}

function decodeProjects(value: Record<string, unknown>): AdminState["projects"] {
  return {
    items: items(value.items, "Admin projects.items").map((project) => ({
      id: string(project.id, "Admin project.id"),
    })),
  };
}

function decodeSummary(value: Record<string, unknown>): AdminSummary {
  const project = record(value.project, "Admin summary.project");
  const messages = record(value.messages, "Admin summary.messages");
  return {
    project: { id: string(project.id, "Admin summary.project.id") },
    messages: {
      total: number(messages.total, "Admin summary.messages.total"),
      unacknowledged: number(messages.unacknowledged, "Admin summary.messages.unacknowledged"),
    },
  };
}

function decodeMessages(value: Record<string, unknown>): AdminMessages {
  return {
    items: items(value.items, "Admin messages.items").map((message) => ({
      id: string(message.id, "Admin message.id"),
      acknowledged_at:
        message.acknowledged_at === null
          ? null
          : string(message.acknowledged_at, "Admin message.acknowledged_at"),
    })),
  };
}

function decodeEvents(value: Record<string, unknown>): AdminEvents {
  return {
    items: items(value.items, "Admin events.items").map((event) => ({
      id: string(event.id, "Admin event.id"),
      event_type: string(event.event_type, "Admin event.event_type"),
      outcome: string(event.outcome, "Admin event.outcome"),
      error_code: event.error_code === null ? null : string(event.error_code, "Admin event.error_code"),
    })),
  };
}

async function readAdminState(projectId: string, cookie: string): Promise<AdminState> {
  const [projects, summary, messages, events] = await Promise.all([
    adminGet("/api/admin/projects", cookie),
    adminGet(`/api/admin/projects/${projectId}/summary`, cookie),
    adminGet(`/api/admin/projects/${projectId}/messages`, cookie),
    adminGet(`/api/admin/projects/${projectId}/events`, cookie),
  ]);
  return {
    projects: decodeProjects(projects),
    summary: decodeSummary(summary),
    messages: decodeMessages(messages),
    events: decodeEvents(events),
  };
}

function assertSecretFree(value: unknown, secrets: readonly string[]): void {
  const rendered = JSON.stringify(value);
  assert.doesNotMatch(rendered, /am_(?:proj|agent)_[A-Za-z0-9_-]+|authorization/i);
  for (const secret of secrets) {
    assert.equal(rendered.includes(secret), false, "Smoke data must not contain credentials");
  }
}

function assertAdminState(
  state: AdminState,
  expected: { projectId: string; messageIds: readonly string[] },
  secrets: readonly string[],
): void {
  assert.equal(state.projects.items.some((project) => project.id === expected.projectId), true);
  assert.equal(state.summary.project.id, expected.projectId);
  assert.equal(state.summary.messages.total, 2);
  assert.equal(state.summary.messages.unacknowledged, 0);
  assert.deepEqual(state.messages.items.map((message) => message.id).toSorted(), [...expected.messageIds].toSorted());
  assert.equal(state.messages.items.every((message) => message.acknowledged_at !== null), true);
  assert.equal(state.events.items.some((event) => event.event_type === "message.sent"), true);
  assert.equal(state.events.items.some((event) => event.event_type === "message.send_failed"), true);
  assert.equal(state.events.items.some((event) => event.event_type === "message.acknowledged"), true);
  assert.equal(
    state.events.items.some(
      (event) => event.event_type === "message.send_failed" && event.outcome === "failure" && event.error_code === "TARGET_AGENT_INVALID",
    ),
    true,
  );
  assertSecretFree(state, secrets);
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

async function main(): Promise<{
  messages: number;
  unacknowledged: number;
  acknowledged: number;
  activity: { sent: number; send_failed: number; acknowledged: number };
}> {
  await compose("down", "--volumes", "--remove-orphans");
  await compose("up", "--build", "--force-recreate", "-d", "--wait");

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

    const selfSend = await firstA.callTool({
      name: "agentmesh_send",
      arguments: {
        agent_token: agentA.token,
        to_agent_id: agentA.id,
        text: "This message must not be sent",
        idempotency_key: randomUUID(),
      },
    });
    assert.equal(selfSend.isError, true);
    const selfSendPayload = selfSend.structuredContent as {
      ok?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    assert.equal(selfSendPayload.ok, false);
    assert.equal(selfSendPayload.error?.code, "TARGET_AGENT_INVALID");
    assert.equal(selfSendPayload.error?.message, "Target agent is unavailable");

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

  const preRestartCookie = await adminLogin();
  const preRestartState = await readAdminState(projectId, preRestartCookie);
  const secrets = [smokeAdminToken, projectToken, agentA.token, agentB.token];
  assertAdminState(preRestartState, { projectId, messageIds: [outboundMessageId, replyMessageId] }, secrets);

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

  const health = await fetch(new URL("/health", endpoint));
  assert.equal(health.status, 200, "Smoke health endpoint must return 200 after restart");
  const adminPage = await fetch(new URL("/admin", endpoint));
  assert.equal(adminPage.status, 200, "Smoke admin page must return 200 after restart");

  const postRestartCookie = await adminLogin();
  const postRestartState = await readAdminState(projectId, postRestartCookie);
  assertAdminState(postRestartState, { projectId, messageIds: [outboundMessageId, replyMessageId] }, secrets);
  assert.deepEqual(postRestartState, preRestartState, "Admin state must survive the final restart");

  const logs = await compose("logs", "--no-color", "--tail", "200", "agentmesh");
  assertSecretFree(logs, secrets);

  const eventCount = (eventType: string) =>
    postRestartState.events.items.filter((event) => event.event_type === eventType).length;
  return {
    messages: postRestartState.summary.messages.total,
    unacknowledged: postRestartState.summary.messages.unacknowledged,
    acknowledged: postRestartState.messages.items.filter((message) => message.acknowledged_at !== null).length,
    activity: {
      sent: eventCount("message.sent"),
      send_failed: eventCount("message.send_failed"),
      acknowledged: eventCount("message.acknowledged"),
    },
  };
}

let result:
  | {
      messages: number;
      unacknowledged: number;
      acknowledged: number;
      activity: { sent: number; send_failed: number; acknowledged: number };
    }
  | undefined;
let failure: unknown;
try {
  result = await main();
} catch (error) {
  failure = error;
}

try {
  await compose("down", "--volumes", "--remove-orphans");
} catch {
  failure ??= new Error("Smoke Compose cleanup failed");
}

if (failure !== undefined) {
  const message = failure instanceof Error ? failure.message : "Unknown smoke-test failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} else {
  assert(result !== undefined);
  process.stdout.write(`${JSON.stringify({ ok: true, restarts: 2, ...result })}\n`);
}
