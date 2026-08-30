import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { FastifyInstance } from "fastify";

import { createAdminAuth, type AdminAuth } from "./admin/auth.js";
import { loadConfig, type AgentMeshConfig } from "./config.js";
import { createDatabase, type DatabaseConnection } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { buildHttpApp } from "./http.js";
import { createProjectService } from "./projects/service.js";

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
    const app = buildHttpApp({
      db: database.db,
      signingKey: config.signingKey,
      projectService,
      host: config.host,
      allowedHosts: config.allowedHosts,
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
