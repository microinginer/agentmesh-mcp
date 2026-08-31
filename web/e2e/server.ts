import { resolve } from "node:path";

import { createAuditService } from "../../src/audit/service.js";
import type { WebAuthConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
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
  callback.searchParams.set("code", fakeCode);
  callback.searchParams.set("state", state);
  return reply.redirect(callback.pathname + callback.search);
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
