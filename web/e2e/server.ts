import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { eq, isNull } from "drizzle-orm";

import { createAuditService } from "../../src/audit/service.js";
import type { WebAuthConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { activityEvents, agents, messages, projects, webSessions } from "../../src/db/schema.js";
import { buildHttpApp } from "../../src/http.js";
import { createProjectService } from "../../src/projects/service.js";
import type { GitHubOAuthClient } from "../../src/web-auth/github-client.js";
import { createIdentityService } from "../../src/web-auth/identity-service.js";
import { createWebSessionService } from "../../src/web-auth/session-service.js";
import { deriveWebAuthKeys } from "../../src/web-auth/session-token.js";
import { resetDatabase } from "../../test/support/database.js";

const port = 43_123;
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const fakeCode = "agentmesh-browser-e2e-code";
const fakeAccessToken = "agentmesh-browser-e2e-provider-token";
type OAuthMode = "success" | "denial" | "exchange-failure";
let oauthMode: OAuthMode = "success";

function webConfig(): WebAuthConfig {
  const config = {
    clientId: "agentmesh-browser-e2e-client",
    callbackUrl: new URL(`${origin}/auth/github/callback`),
    publicOrigin: new URL(origin),
    operatorGitHubIds: new Set(["4242"]),
    projectLimit: 5,
    tokenTtlDays: 90,
    secureCookies: false,
  } as Omit<WebAuthConfig, "clientSecret" | "authKey">;
  Object.defineProperties(config, {
    clientSecret: { value: "browser-e2e-client-secret", enumerable: false },
    authKey: { value: Buffer.alloc(32, 23), enumerable: false },
  });
  return config as WebAuthConfig;
}

const githubClient: GitHubOAuthClient = {
  authorizationUrl: (state, challenge) => {
    const url = new URL("/e2e/github/authorize", origin);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    return url;
  },
  exchangeCode: async (code, verifier) => {
    if (code !== fakeCode || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) {
      throw new Error("Invalid browser OAuth exchange");
    }
    if (oauthMode === "exchange-failure") {
      throw new Error(`Provider rejected ${fakeAccessToken}`);
    }
    return fakeAccessToken;
  },
  fetchProfile: async (accessToken) => {
    if (accessToken !== fakeAccessToken) throw new Error("Invalid browser OAuth token");
    return {
      id: "4242",
      login: "agentmesh-e2e-owner",
      name: "AgentMesh E2E Owner",
      avatarUrl: null,
    };
  },
};

const database = createDatabase(databaseUrl);
await migrateDatabase(database.db);
await resetDatabase(database.pool);
const config = webConfig();
const app = buildHttpApp({
  db: database.db,
  signingKey: Buffer.from("agentmesh-browser-e2e-signing-key-32-bytes", "utf8"),
  projectService: createProjectService({ db: database.db }),
  host: "127.0.0.1",
  allowedHosts: ["127.0.0.1", "localhost"],
  rateLimits: {
    oauthStart: 10_000,
    ownerRead: 10_000,
    ownerMutation: 10_000,
    connectionCreate: 10_000,
    mcp: 10_000,
  },
  admin: null,
  logger: { write: () => {} },
  web: {
    db: database.db,
    config,
    githubClient,
    identityService: createIdentityService({ db: database.db }),
    sessionService: createWebSessionService({
      db: database.db,
      keys: deriveWebAuthKeys(config.authKey),
    }),
    auditService: createAuditService({ db: database.db }),
  },
  webAssetsPath: resolve(process.cwd(), "dist/web"),
});

app.get("/e2e/github/authorize", async (request, reply) => {
  const query = request.query;
  if (query === null || typeof query !== "object" || Array.isArray(query)) return reply.code(400).send();
  const state = "state" in query ? query.state : undefined;
  const challenge = "code_challenge" in query ? query.code_challenge : undefined;
  if (
    typeof state !== "string"
    || typeof challenge !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(state)
    || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
  ) {
    return reply.code(400).send();
  }
  const callback = new URL(config.callbackUrl);
  if (oauthMode === "denial") {
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("error_description", fakeAccessToken);
    callback.searchParams.set("state", state);
    return reply.redirect(callback.pathname + callback.search);
  }
  callback.searchParams.set("code", fakeCode);
  callback.searchParams.set("state", state);
  callback.searchParams.set("iss", "https://github.com");
  return reply.redirect(callback.pathname + callback.search);
});

function bodyRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

app.post("/e2e/reset", async (_request, reply) => {
  oauthMode = "success";
  await resetDatabase(database.pool);
  return reply.code(204).send();
});

app.post("/e2e/control", async (request, reply) => {
  const body = bodyRecord(request.body);
  const action = body?.action;
  if (action === "age-session") {
    await database.db.update(webSessions).set({
      authenticatedAt: new Date(Date.now() - 16 * 60 * 1_000),
    }).where(isNull(webSessions.revokedAt));
    return reply.code(204).send();
  }
  if (action === "revoke-session") {
    await database.db.update(webSessions).set({ revokedAt: new Date() }).where(isNull(webSessions.revokedAt));
    return reply.code(204).send();
  }
  if (action === "expire-session") {
    await database.db.update(webSessions).set({ idleExpiresAt: new Date(Date.now() - 1_000) })
      .where(isNull(webSessions.revokedAt));
    return reply.code(204).send();
  }
  if (action === "oauth-mode" && (
    body?.mode === "success"
    || body?.mode === "denial"
    || body?.mode === "exchange-failure"
  )) {
    oauthMode = body.mode;
    return reply.code(204).send();
  }
  return reply.code(400).send();
});

app.post("/e2e/seed-observability", async (request, reply) => {
  const body = bodyRecord(request.body);
  const projectId = body?.project_id;
  const count = body?.count;
  if (
    typeof projectId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)
    || !Number.isInteger(count)
    || typeof count !== "number"
    || count < 1
    || count > 100
  ) {
    return reply.code(400).send();
  }
  const [project] = await database.db.select({ id: projects.id }).from(projects)
    .where(eq(projects.id, projectId)).limit(1);
  if (project === undefined) return reply.code(404).send();

  const baseTime = Date.now() - count * 1_000;
  const [sender, recipient] = await database.db.insert(agents).values([
    {
      projectId,
      registrationDigest: Buffer.alloc(32, 1),
      name: "browser-agent-a",
      client: "playwright",
      capabilities: ["messages", "review"],
      lastSeenAt: new Date(),
      createdAt: new Date(baseTime - 2_000),
    },
    {
      projectId,
      registrationDigest: Buffer.alloc(32, 2),
      name: "browser-agent-b",
      client: "playwright",
      capabilities: ["implementation"],
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1_000),
      createdAt: new Date(baseTime - 1_000),
    },
  ]).returning({ id: agents.id });
  if (sender === undefined || recipient === undefined) return reply.code(500).send();

  const insertedMessages = await database.db.insert(messages).values(Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      projectId,
      senderAgentId: sender.id,
      recipientAgentId: recipient.id,
      text: number === count
        ? `<img src=x onerror="window.agentmeshPeerExecuted=true"> peer-message-${String(number).padStart(3, "0")}`
        : `peer-message-${String(number).padStart(3, "0")}`,
      idempotencyKey: randomUUID(),
      createdAt: new Date(baseTime + number * 1_000),
    };
  })).returning({ id: messages.id, createdAt: messages.createdAt });

  await database.db.insert(activityEvents).values(insertedMessages.map((message, index) => ({
    projectId,
    requestId: randomUUID(),
    eventType: "message.sent",
    outcome: "success",
    actorAgentId: sender.id,
    targetAgentId: recipient.id,
    messageId: message.id,
    metadata: {},
    createdAt: message.createdAt ?? new Date(baseTime + (index + 1) * 1_000),
  })));
  return reply.code(204).send();
});

await app.listen({ host: "127.0.0.1", port });

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void app.close().finally(async () => {
    await database.pool.end();
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
