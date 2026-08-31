import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  SAFE_HTTP_ERROR,
  assertSecretFree,
  readSecretFreeJson,
  withBoundedResponse,
} from "./compose-smoke-helpers.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const composeProject = process.env.AGENTMESH_SMOKE_PROJECT ?? "agentmesh-mvp-smoke";
const port = Number(process.env.AGENTMESH_SMOKE_PORT ?? "31337");
const smokeAdminToken = Buffer.alloc(32, 11).toString("base64url");
const smokeSigningKey = Buffer.alloc(32, 12).toString("base64url");
const smokePostgresPassword = `smoke-postgres-${randomUUID()}`;
const infrastructureSecrets = [smokeAdminToken, smokeSigningKey, smokePostgresPassword];

assert.match(composeProject, /^[a-z0-9][a-z0-9_-]*$/);
assert.match(composeProject, /(?:^|[-_])smoke(?:[-_]|$)/, "Smoke project name must contain 'smoke'");
assert(Number.isInteger(port) && port >= 1 && port <= 65_535, "Invalid smoke-test port");

const childEnvironment = {
  ...process.env,
  AGENTMESH_PORT: String(port),
  AGENTMESH_ADMIN_TOKEN: smokeAdminToken,
  AGENTMESH_ADMIN_COOKIE_SECURE: "0",
  AGENTMESH_DB_OBSERVER_PASSWORD: "",
  AGENT_SESSION_SIGNING_KEY: smokeSigningKey,
  POSTGRES_PASSWORD: smokePostgresPassword,
  ALLOWED_HOSTS: "agentmesh.smoke.invalid",
  AGENTMESH_TRUSTED_PROXIES: "",
  GITHUB_OAUTH_CLIENT_ID: "",
  GITHUB_OAUTH_CLIENT_SECRET: "",
  GITHUB_OAUTH_CALLBACK_URL: "",
  AGENTMESH_PUBLIC_ORIGIN: "",
  AGENTMESH_WEB_AUTH_KEY: "",
  AGENTMESH_OPERATOR_GITHUB_IDS: "",
  AGENTMESH_PROJECT_LIMIT: "",
  AGENTMESH_TOKEN_TTL_DAYS: "",
  AGENTMESH_RATE_LIMIT_OAUTH_START: "20",
  AGENTMESH_RATE_LIMIT_OWNER_READ: "300",
  AGENTMESH_RATE_LIMIT_OWNER_MUTATION: "60",
  AGENTMESH_RATE_LIMIT_CONNECTION_CREATE: "10",
  AGENTMESH_RATE_LIMIT_MCP: "600",
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
  return execFileText("docker", ["compose", "--env-file", "/dev/null", "-p", composeProject, ...args]);
}

async function requestStatusWithHost(url: URL, host: string): Promise<number> {
  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (error: Error | null, status?: number) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (error !== null || status === undefined) reject(new Error(SAFE_HTTP_ERROR));
        else resolve(status);
      };
      const request = httpRequest(url, { headers: { host } }, (response) => {
        response.destroy();
        finish(null, response.statusCode);
      });
      request.once("error", () => finish(new Error(SAFE_HTTP_ERROR)));
      timeout = setTimeout(() => {
        request.destroy();
        finish(new Error(SAFE_HTTP_ERROR));
      }, 5_000);
      request.end();
    });
  } catch {
    throw new Error(SAFE_HTTP_ERROR);
  }
}

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const [healthy, ready] = await Promise.all([
        withBoundedResponse(new URL("/health", endpoint), {}, async (response) => response.ok, 1_000),
        withBoundedResponse(new URL("/ready", endpoint), {}, async (response) => response.ok, 1_000),
      ]);
      if (healthy && ready) {
        return;
      }
    } catch {
      // A restart briefly makes the listener unavailable.
    }
    await delay(500);
  }
  throw new Error("AgentMesh did not become ready after restart");
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

async function adminLogin(): Promise<string> {
  return withBoundedResponse(
    new URL("/admin/session", endpoint),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: smokeAdminToken }),
    },
    async (response) => {
      if (response.status !== 204) throw new Error(SAFE_HTTP_ERROR);
      const setCookie = response.headers.get("set-cookie");
      if (setCookie === null) throw new Error(SAFE_HTTP_ERROR);
      const cookie = setCookie.split(";", 1)[0];
      if (cookie === undefined || !cookie.includes("=")) throw new Error(SAFE_HTTP_ERROR);
      return cookie;
    },
  );
}

async function adminGet(path: string, cookie: string, secrets: readonly string[]): Promise<Record<string, unknown>> {
  if (!path.startsWith("/api/admin/")) throw new Error(SAFE_HTTP_ERROR);
  return withBoundedResponse(new URL(path, endpoint), { headers: { cookie } }, async (response, signal) => {
    if (response.status !== 200) throw new Error(SAFE_HTTP_ERROR);
    return readSecretFreeJson(response, secrets, signal);
  });
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

async function readAdminState(projectId: string, cookie: string, secrets: readonly string[]): Promise<AdminState> {
  const [projects, summary, messages, events] = await Promise.all([
    adminGet("/api/admin/projects", cookie, secrets),
    adminGet(`/api/admin/projects/${projectId}/summary`, cookie, secrets),
    adminGet(`/api/admin/projects/${projectId}/messages`, cookie, secrets),
    adminGet(`/api/admin/projects/${projectId}/events`, cookie, secrets),
  ]);
  return {
    projects: decodeProjects(projects),
    summary: decodeSummary(summary),
    messages: decodeMessages(messages),
    events: decodeEvents(events),
  };
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
  const startupOutput = await compose("up", "--build", "--force-recreate", "-d", "--wait");
  assertSecretFree(startupOutput, infrastructureSecrets);
  await waitForReady();

  const headlessAuthStatus = await withBoundedResponse(
    new URL("/auth/github/start", endpoint),
    {},
    async (response) => response.status,
  );
  assert.equal(headlessAuthStatus, 404, "Hosted OAuth routes must be absent in headless mode");
  const hostileHostStatus = await requestStatusWithHost(
    new URL("/ready", endpoint),
    "hostile.smoke.invalid",
  );
  assert.equal(hostileHostStatus, 403, "A hostile public Host must remain forbidden");
  const imageId = (await compose("images", "-q", "agentmesh")).trim();
  assert.match(imageId, /^[a-f0-9:]{12,128}$/i, "Compose did not return the application image ID");
  const imageHistory = await execFileText("docker", ["image", "history", "--no-trunc", imageId]);
  assertSecretFree(imageHistory, infrastructureSecrets);

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

  const secondConnectionOutput = await compose(
    "exec",
    "-T",
    "agentmesh",
    "node",
    "--input-type=module",
    "-e",
    [
      "const {createProjectToken}=await import('./dist/auth/project-token.js')",
      "const {createDatabase}=await import('./dist/db/client.js')",
      "const {projectTokens}=await import('./dist/db/schema.js')",
      "const database=createDatabase(process.env.DATABASE_URL)",
      "try {",
      "const token=createProjectToken()",
      "await database.db.insert(projectTokens).values({id:token.tokenId,projectId:process.argv[1],tokenDigest:token.digest,label:'Second smoke computer'})",
      "process.stdout.write(JSON.stringify({token_id:token.tokenId,token:token.token}))",
      "} finally { await database.pool.end() }",
    ].join(";"),
    projectId,
  );
  const secondConnection = JSON.parse(secondConnectionOutput) as { token_id?: unknown; token?: unknown };
  assert.equal(typeof secondConnection.token_id, "string", "Second connection has no token ID");
  assert.equal(typeof secondConnection.token, "string", "Second connection has no token");
  const secondProjectToken = secondConnection.token as string;
  assert.equal(secondProjectToken.startsWith("am_proj_"), true, "Second connection returned an invalid token");
  assert.notEqual(secondProjectToken, projectToken, "Two smoke computers must use separate project tokens");

  const firstA = await connectClient("smoke-agent-a-before-restart", projectToken);
  const firstB = await connectClient("smoke-agent-b-before-restart", secondProjectToken);

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
  await waitForReady();

  const secondA = await connectClient("smoke-agent-a-after-restart", projectToken);
  const secondB = await connectClient("smoke-agent-b-after-restart", secondProjectToken);
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
  const secrets = [
    ...infrastructureSecrets,
    projectToken,
    secondProjectToken,
    agentA.token,
    agentB.token,
  ];
  const preRestartState = await readAdminState(projectId, preRestartCookie, secrets);
  assertAdminState(preRestartState, { projectId, messageIds: [outboundMessageId, replyMessageId] }, secrets);

  await compose("restart", "agentmesh");
  await waitForReady();

  const finalA = await connectClient("smoke-agent-a-final", projectToken);
  const finalB = await connectClient("smoke-agent-b-final", secondProjectToken);
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

  const healthStatus = await withBoundedResponse(new URL("/health", endpoint), {}, async (response) => response.status);
  if (healthStatus !== 200) throw new Error(SAFE_HTTP_ERROR);
  const readyStatus = await withBoundedResponse(new URL("/ready", endpoint), {}, async (response) => response.status);
  if (readyStatus !== 200) throw new Error(SAFE_HTTP_ERROR);
  const adminPageStatus = await withBoundedResponse(new URL("/admin", endpoint), {}, async (response) => response.status);
  if (adminPageStatus !== 200) throw new Error(SAFE_HTTP_ERROR);

  const postRestartCookie = await adminLogin();
  const postRestartState = await readAdminState(projectId, postRestartCookie, secrets);
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
