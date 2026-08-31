import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { FastifyInstance } from "fastify";

import { createAdminAuth, type AdminAuth } from "./admin/auth.js";
import { createAdminQueryService } from "./admin/query-service.js";
import { loadConfig, type AgentMeshConfig } from "./config.js";
import { createDatabase, type DatabaseConnection } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { buildHttpApp } from "./http.js";
import { createProjectService } from "./projects/service.js";
import { createAuditService } from "./audit/service.js";
import { createGitHubClient } from "./web-auth/github-client.js";
import { createIdentityService } from "./web-auth/identity-service.js";
import { createWebSessionService } from "./web-auth/session-service.js";
import { deriveWebAuthKeys } from "./web-auth/session-token.js";

export interface AgentMeshRuntime {
  app: FastifyInstance;
  database: DatabaseConnection;
  adminAuth: AdminAuth | null;
  close: () => Promise<void>;
}

export async function startServer(config: AgentMeshConfig): Promise<AgentMeshRuntime> {
  const adminAuth = config.admin === null ? null : createAdminAuth(config.admin);
  const database = createDatabase(config.databaseUrl);
  try {
    await migrateDatabase(database.db);
    const projectService = createProjectService({ db: database.db });
    const web = config.web === null ? null : (() => {
      const webConfig = config.web;
      const keys = deriveWebAuthKeys(webConfig.authKey);
      return {
        config: webConfig,
        githubClient: createGitHubClient({
          clientId: webConfig.clientId,
          clientSecret: webConfig.clientSecret,
          callbackUrl: webConfig.callbackUrl,
        }),
        identityService: createIdentityService({ db: database.db }),
        sessionService: createWebSessionService({ db: database.db, keys }),
        auditService: createAuditService({ db: database.db }),
      };
    })();
    const app = buildHttpApp({
      db: database.db,
      signingKey: config.signingKey,
      projectService,
      host: config.host,
      allowedHosts: config.allowedHosts,
      admin:
        adminAuth === null
          ? null
          : { auth: adminAuth, queryService: createAdminQueryService({ db: database.db }) },
      web,
    });
    await app.listen({ host: config.host, port: config.port });

    let closed = false;
    return {
      app,
      database,
      adminAuth,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await app.close();
        } finally {
          await database.pool.end();
        }
      },
    };
  } catch (error) {
    await database.pool.end();
    throw error;
  }
}

async function main(): Promise<void> {
  const runtime = await startServer(loadConfig(process.env));
  const shutdown = (): void => {
    void runtime.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  try {
    await main();
  } catch {
    process.stderr.write("AgentMesh failed to start\n");
    process.exitCode = 1;
  }
}
