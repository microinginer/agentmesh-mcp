import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";

import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
} from "@modelcontextprotocol/node";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";

import { registerControlRoutes } from "./control/routes.js";
import { registerOperatorRoutes } from "./control/operator-routes.js";
import type { AgentMeshDatabase } from "./db/client.js";
import { registerAdminRoutes } from "./admin/routes.js";
import type { AdminRouteDependencies } from "./admin/routes.js";
import { AgentMeshError } from "./errors.js";
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from "./config.js";
import { createSafeLogger } from "./logging.js";
import type { SafeLogger } from "./logging.js";
import { buildMcpHandler } from "./mcp/server.js";
import type { ProjectService } from "./projects/service.js";
import { createRateLimitGuards } from "./rate-limits.js";
import { registerWebAuthRoutes } from "./web-auth/routes.js";
import type { WebAuthRouteDependencies } from "./web-auth/routes.js";

interface RateLimitStore {
  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number,
    max: number,
  ): void;
  child(options: unknown): RateLimitStore;
}

type RateLimitStoreConstructor = new (options: unknown) => RateLimitStore;

export interface HttpAppDependencies {
  db: AgentMeshDatabase;
  signingKey: Buffer;
  projectService: Pick<ProjectService, "authenticateProject">;
  host: string;
  allowedHosts: string[];
  admin: AdminRouteDependencies | null;
  web?: WebAuthRouteDependencies | null;
  logger?: SafeLogger;
  rateLimits?: RateLimitConfig;
  rateLimitStore?: RateLimitStoreConstructor;
  readinessCheck?: () => Promise<boolean>;
}

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

function bearerFromHeader(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

const API_CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const READINESS_QUERY_TIMEOUT_MS = 1_000;
const READINESS_TOTAL_TIMEOUT_MS = 1_500;

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("bounded operation timed out")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function databaseReadinessCheck(db: AgentMeshDatabase): () => Promise<boolean> {
  let expected: { hash: string; folderMillis: number } | undefined;
  try {
    expected = readMigrationFiles({ migrationsFolder: resolve(process.cwd(), "drizzle") }).at(-1);
  } catch {
    expected = undefined;
  }
  if (expected === undefined) return async () => false;

  return async () => {
    try {
      return await bounded(db.transaction(async (transaction) => {
        await transaction.execute(sql.raw(`SET LOCAL statement_timeout = '${READINESS_QUERY_TIMEOUT_MS}ms'`));
        await transaction.execute(sql`SELECT 1 AS database_ready`);
        const migration = await transaction.execute(sql`
          SELECT EXISTS (
            SELECT 1
            FROM drizzle.__drizzle_migrations
            WHERE hash = ${expected.hash}
              AND created_at = ${expected.folderMillis}
          ) AS migration_current
        `);
        return migration.rows[0]?.migration_current === true;
      }), READINESS_TOTAL_TIMEOUT_MS);
    } catch {
      return false;
    }
  };
}

function applySecurityHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Content-Security-Policy", API_CONTENT_SECURITY_POLICY);
}

export function buildHttpApp(dependencies: HttpAppDependencies) {
  const logger = dependencies.logger ?? createSafeLogger();
  // Use the MCP package's Fastify factory without its echoing host/origin hooks;
  // the equivalent fixed-message validation below preserves the protection
  // without reflecting hostile header values.
  const app = createMcpFastifyApp({
    host: "agentmesh-explicit-validation",
  });
  const mcpHandler = buildMcpHandler({
    db: dependencies.db,
    signingKey: dependencies.signingKey,
    logger,
  });
  const nodeHandler = toNodeHandler({
    fetch: async (request, options) => {
      const response = await mcpHandler.fetch(request, options);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("Content-Security-Policy", API_CONTENT_SECURITY_POLICY);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });

  app.addHook("onRequest", (_request, reply, done) => {
    applySecurityHeaders(reply);
    done();
  });
  app.addHook("onRequest", async (request, reply) => {
    const host = validateHostHeader(request.headers.host, dependencies.allowedHosts);
    if (!host.ok) {
      await reply.code(403).send({ error: "forbidden" });
      return;
    }
    const origin = validateOriginHeader(request.headers.origin, dependencies.allowedHosts);
    if (!origin.ok) {
      await reply.code(403).send({ error: "forbidden" });
    }
  });

  const ready = dependencies.readinessCheck ?? databaseReadinessCheck(dependencies.db);
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    let available = false;
    try {
      available = await bounded(Promise.resolve(ready()), READINESS_TOTAL_TIMEOUT_MS);
    } catch {
      available = false;
    }
    return available
      ? reply.send({ status: "ready" })
      : reply.code(503).send({ status: "unavailable" });
  });

  registerAdminRoutes(app, dependencies.admin);
  app.register(async (protectedApp) => {
    await protectedApp.register(fastifyRateLimit, {
      global: false,
      cache: 5_000,
      ...(dependencies.rateLimitStore === undefined ? {} : { store: dependencies.rateLimitStore }),
    });
    if (!protectedApp.hasRequestDecorator("rateLimitConnectionId")) {
      protectedApp.decorateRequest("rateLimitConnectionId", null);
    }
    const limits = createRateLimitGuards(
      protectedApp,
      dependencies.rateLimits ?? { ...DEFAULT_RATE_LIMITS },
    );

    if (dependencies.web !== undefined && dependencies.web !== null) {
      await protectedApp.register(fastifyCookie);
      const web = { ...dependencies.web, rateLimits: limits.web };
      registerWebAuthRoutes(protectedApp, web);
      registerControlRoutes(protectedApp, web);
      registerOperatorRoutes(protectedApp, web);
    }

    protectedApp.post("/mcp", async (request, reply) => {
      const bearer = bearerFromHeader(request.headers.authorization);
      if (bearer === null) {
        logger.write({ event: "http.request_failed" });
        return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
      }

      let authenticatedProject: Awaited<ReturnType<ProjectService["authenticateProject"]>>;
      try {
        authenticatedProject = await dependencies.projectService.authenticateProject(bearer);
      } catch (error) {
        if (error instanceof AgentMeshError && error.code === "PROJECT_AUTH_INVALID") {
          logger.write({ event: "http.request_failed" });
          return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
        }
        logger.write({ event: "http.request_failed", error_code: "INTERNAL_ERROR" });
        return reply.code(500).send({ error: "internal_error" });
      }

      request.rateLimitConnectionId = authenticatedProject.connectionTokenId;
      await limits.mcp(request, reply);
      if (reply.sent) return;

      (request.raw as AuthenticatedIncomingMessage).auth = {
        token: "validated-project-token",
        clientId: authenticatedProject.projectId,
        scopes: ["agentmesh"],
        extra: { connectionTokenId: authenticatedProject.connectionTokenId },
      };
      reply.hijack();
      await nodeHandler(
        request.raw as unknown as NodeIncomingMessageLike,
        reply.raw as unknown as NodeServerResponseLike,
        request.body,
      );
    });
  });

  app.addHook("onClose", async () => {
    await mcpHandler.close();
  });

  return app;
}
